/**
 * view.ts —— Obsidian 视图层（ItemView）
 *
 * 设计红线（与 PDF++ 对齐）：
 *  · 这是「补充视图」，不是「替代原生查看器」。
 *    插件默认**不注册** .pdf 扩展名，用户原有的双击打开行为完全不变；
 *    批注视图由命令 / 功能区图标 / 侧栏链接按需打开。
 *  · 不写 PDF 文件。批注全部落在内存（阶段三再写 Markdown）。
 *
 * ── DOM 分层（决定事件能否正确穿透）──────────────────────────────────
 *
 *   .pdfa-page                  position: relative
 *     ├─ canvas                z-index 0   视觉
 *     ├─ .textLayer            z-index 1   ★ 可选中文字的透明层
 *     └─ svg.pdfa-draw-layer   z-index 2   ★ 绘制层
 *
 * 绘制层默认 `pointer-events: none`，只有拖拽类工具激活时才临时改 auto：
 *   · 不激活 → 指针穿过 SVG 命中文本层，拖选文字正常；
 *   · 激活铅笔/矩形 → SVG 吃指针，进入绘制；
 *   · 便签与右键删除不用 DOM 命中，走**几何命中检测**挂在页面容器上，
 *     所以即使整层是 none 也照样点得到图钉。
 *
 * ── 事件总览（谁在什么时候做什么）────────────────────────────────────
 *
 *   pointerdown(页面)     → 记录"手指按下"，防止拖选过程中反复弹工具栏
 *   pointerup(页面)       → 选区落定 → syncSelection() 决定"弹工具栏"还是"直接高亮"
 *   selectionchange       → 键盘选择（Shift+方向键）时的兜底，防抖 140ms
 *   pointerdown/move/up(绘制层) → 矩形/箭头/手绘的完整生命周期，见 pageLayer.ts
 *   mouseup               → 选区检测入口
 */

import { ItemView, MarkdownView, Notice, TFile, ViewStateResult, WorkspaceLeaf, setIcon } from "obsidian";
import type { Editor, EventRef } from "obsidian";
import type PdfAnnotatorPlugin from "./main";
import { PDFRenderer } from "./renderer";
import {
  type PageGeometry,
  type Rect,
  clampNormRect,
  cssRectToNorm,
  mergeLineRects,
  normRectToBase,
  roundRect,
} from "./coords";
import {
  type Annotation,
  type BacklinkMark,
  type NoteAnnotation,
  type Point,
  type ToolId,
  ANNOT_DEFAULTS,
  createAnnotationId,
  isTextMark,
} from "./annot/types";
import { AnnotationStore } from "./annot/annotationStore";
import { TOOL_META, TOOL_ORDER, ToolState } from "./annot/toolState";
import { PageLayer, isDrawingTool } from "./annot/pageLayer";
import type { ClientPos } from "./annot/pageLayer";
import { getColorGroup, type SurfaceKey } from "./annot/palettes";
import { boxFromPoints } from "./annot/geometry";
import {
  type PdfLinkTarget,
  DEFAULT_LINK_COLOR,
  buildPdfCallout,
  buildPdfLink,
  colorParam,
  defaultAlias,
  parsePdfLink,
} from "./link/format";
import {
  type TextPageIndex,
  applyTransform,
  buildTextIndex,
  linkRectsOnPage,
  rectToPdfQuad,
  rectsToSelection,
  selectionText,
} from "./link/textIndex";
import { type BacklinkEntry, type ScanHost, createAppScanHost, scanBacklinks } from "./link/scan";
import { findPdfLeaf, openNoteAt } from "./link/navigate";
import { SelectionToolbar, type ToolbarAction } from "./ui/selectionToolbar";
import { ColorPopover } from "./ui/colorPopover";
import { NoteEditor } from "./ui/noteEditor";
import { ContextMenu, type MenuItem } from "./ui/contextMenu";
import { BacklinkPanel } from "./ui/backlinkPanel";
import { FloatingHint } from "./ui/hint";
import { LinkDrag } from "./ui/linkDrag";
import { AiModal } from "./ui/aiModal";
import { AI_TASKS, taskMeta, type AiTask, type AiResult } from "./ai/types";
import {
  quadCenterToNorm,
  renderAiBlock,
  type StoredNote,
} from "./note/noteFormat";
import { NoteFileStore } from "./note/noteStore";
import type { RectLike } from "./dom";
import { h } from "./dom";

export const PDF_VIEW_TYPE = "pdf-annotator-view";

/** 回链高亮的填充透明度：比自建高亮淡一点，因为可能好几条叠在同一处 */
const BACKLINK_OPACITY = 0.28;
/** 元数据变化后的重扫延迟：连续粘贴多条链接时不必每条都扫一遍 */
const RESCAN_DEBOUNCE = 300;

/** 在一组已快照的页面矩形里找出包含某点的那个 */
function hitPage(
  pageRects: Array<{ n: number; rect: DOMRect }>,
  clientX: number,
  clientY: number,
): { n: number; rect: DOMRect } | null {
  for (const p of pageRects) {
    const r = p.rect;
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return p;
  }
  return null;
}

/**
 * 两组 NORM 矩形是否有「实质重合」。
 * 用「交叠面积 / 较小矩形面积」而不是 IoU：草稿与回链的高度可能差几个像素
 * （一个来自 DOM 选中框、一个来自文本索引），IoU 会被这点差异稀释掉。
 */
function rectsOverlap(a: Rect[], b: Rect[]): boolean {
  for (const r1 of a) {
    const area = r1.w * r1.h;
    if (area <= 0) continue;
    for (const r2 of b) {
      const w = Math.min(r1.x + r1.w, r2.x + r2.w) - Math.max(r1.x, r2.x);
      const h = Math.min(r1.y + r1.h, r2.y + r2.h) - Math.max(r1.y, r2.y);
      if (w <= 0 || h <= 0) continue;
      if ((w * h) / Math.min(area, r2.w * r2.h) > 0.55) return true;
    }
  }
  return false;
}

/** 给链接补上显示别名：`[[x.pdf#…]]` → `[[x.pdf#…|x, p.3]]` */
function withAlias(link: string, path: string, page: number): string {
  if (!link.endsWith("]]") || link.slice(0, -2).includes("|")) return link;
  return `${link.slice(0, -2)}|${defaultAlias(path, page)}]]`;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const SCALE_STEP = 1.15;
/** 预渲染范围：视口上下各多渲染 1.5 屏，滚动时不至于露白 */
const PRELOAD_MARGIN_SCREENS = 1.5;
/** selectionchange 的防抖：拖选过程中它每帧都触发，等手停再处理 */
const SELECTION_DEBOUNCE = 140;

interface PageElements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  layer: PageLayer;
  geometry: PageGeometry | null;
  state: "idle" | "queued" | "rendering" | "done";
}

interface SelectionCapture {
  /** 每页各自的归一化矩形（一页可能多个） */
  pages: Array<{ page: number; rects: Rect[] }>;
  /** 工具栏锚点：选区末尾那一行的 client 矩形 */
  anchor: RectLike;
  /** 选区末尾的归一化落点，用于放便签 */
  tail: { page: number; point: Point };
}

/** AI 会话的定位上下文：链接负责"指哪"，quote 负责"读什么" */
interface AiContext {
  link: string;
  quote: string;
  page: number;
}

export class PDFFileView extends ItemView {
  private readonly renderer = new PDFRenderer();
  private readonly store = new AnnotationStore();
  private readonly tool = new ToolState();

  private filePath: string | null = null;
  private scale = 1.25;

  private titleEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;
  private scrollerEl!: HTMLElement;
  private pagesEl!: HTMLElement;
  private toolButtons = new Map<ToolId, HTMLElement>();
  private colorBtnEl!: HTMLElement;
  private undoBtnEl!: HTMLElement;
  private redoBtnEl!: HTMLElement;

  private readonly selectionToolbar: SelectionToolbar;
  private readonly colorPopover: ColorPopover;
  private readonly noteEditor: NoteEditor;
  private readonly contextMenu = new ContextMenu();

  /* --- 阶段三：回链（Markdown 里的链接 → PDF 上的高亮）--- */
  private readonly scanHost: ScanHost = createAppScanHost(this.app);
  private readonly hint = new FloatingHint();
  private readonly linkDrag: LinkDrag = new LinkDrag(this.app, (inserted) => {
    if (!inserted) new Notice("没有落在 Markdown 编辑器上，链接未插入");
  });
  private backlinkPanel: BacklinkPanel | null = null;
  private backlinkBtnEl!: HTMLElement;
  private aiBtnEl!: HTMLElement;
  /** 扫描结果（真身都在 .md 里，这里只是快照） */
  private backlinkEntries: BacklinkEntry[] = [];
  /** 页 → 文本索引（Promise 缓存，避免同一页并发构建） */
  private textIndexes = new Map<number, Promise<TextPageIndex | null>>();
  /** 页 → 已解析的回链矩形，用于草稿去重 */
  private marksByPage = new Map<number, BacklinkMark[]>();
  /** 扫描代际：晚到的旧结果直接丢弃 */
  private scanToken = 0;
  private rescanTimer = 0;
  /** 来自 Markdown 链接的跳转目标，等页面就绪后再执行 */
  private pendingTarget: PdfLinkTarget | null = null;
  private eventRefs: EventRef[] = [];
  /** 当前悬停的回链（只更新这两层，别全页刷） */
  private hover: { page: number; key: string } | null = null;

  /* --- 阶段四 / 五：AI 伴读 + 便签落盘 --- */
  /** 伴生笔记读写器（每个 PDF 一个；加载时重建） */
  private noteStore: NoteFileStore | null = null;
  /** 批注 id → 已落盘的位置（用于"在笔记中打开"与删除） */
  private noteLocations = new Map<string, { path: string; line: number }>();
  /** 防止 hydrate 与用户新建便签互相覆盖 */
  private notesHydrated = false;

  private pages = new Map<number, PageElements>();
  /** 自增代际号：切换文件 / 重建页面后，旧的异步任务据此自我作废 */
  private generation = 0;
  /** 串行渲染队列：避免同一时刻多个 page.render 抢主线程 */
  private queue: Promise<void> = Promise.resolve();
  private rafId = 0;

  private pointerDown = false;
  private selTimer = 0;
  /** 订阅退订句柄：视图可能被重复 onOpen，别让监听器越挂越多 */
  private unsubscribes: Array<() => void> = [];
  /** 程序性清空选区时不要把 selectionchange 当成用户操作 */
  private mutatingSelection = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: PdfAnnotatorPlugin,
  ) {
    super(leaf);

    this.selectionToolbar = new SelectionToolbar({
      tool: this.tool,
      onAction: (action, anchor) => this.onToolbarAction(action, anchor),
      onPickColor: (anchor, surface) => this.colorPopover.open(anchor, surface),
    });

    this.colorPopover = new ColorPopover({
      tool: this.tool,
      onPick: (color, surface) => {
        this.tool.setColor(surface, color);
        this.selectionToolbar.refresh();
      },
    });

    this.noteEditor = new NoteEditor({
      app: this.app,
      // 预览里的相对图片按"伴生笔记所在目录"解析 —— 附件默认落在同目录时才对得上
      sourcePath: () => (this.filePath ? (this.noteStore?.pathFor(this.filePath) ?? this.filePath) : ""),
      onCommit: (anno, body) => {
        const cur = this.store.get(anno.id);
        if (cur?.kind !== "note") return;
        const next = { ...cur, body, updatedAt: Date.now() };
        this.store.update(next);
        // 正文一变就立刻写回伴生笔记：便签是"随手记"，不该等到关闭视图才落盘
        void this.persistNote(next);
      },
      onDelete: (anno) => {
        this.store.remove(anno.id);
        void this.deleteNoteBlock(anno.id);
      },
      onOpenInNote: (anno) => void this.openNoteBlock(anno),
    });
  }

  getViewType(): string {
    return PDF_VIEW_TYPE;
  }

  getDisplayText(): string {
    if (!this.filePath) return "PDF 批注";
    const name = this.filePath.split("/").pop() ?? this.filePath;
    return name.replace(/\.pdf$/i, "");
  }

  getIcon(): string {
    return "file-text";
  }

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("pdf-annotator-view");

    this.buildToolbar(root);

    // 横向两栏：左滚动区 + 右反向链接面板。
    // 面板常驻 DOM、用 class 控制显隐（`.is-open`），而不是增删节点 ——
    // 增删会让 scrollTop / hover 状态在开关面板时全部丢失。
    const body = root.createDiv({ cls: "pdfa-body" });
    this.scrollerEl = body.createDiv({ cls: "pdfa-scroller" });
    this.pagesEl = this.scrollerEl.createDiv({ cls: "pdfa-pages" });

    this.backlinkPanel = new BacklinkPanel({
      onActivate: (entry) => void this.jumpToNote(entry),
      onHover: (entry) => this.setHoverBacklink(entry ? { page: entry.page, key: entry.key } : null),
      onFilterChange: () => undefined,
      onClose: () => this.setPanelOpen(false),
    });
    body.appendChild(this.backlinkPanel.el);

    this.scrollerEl.addEventListener("scroll", this.onScroll, { passive: true });
    // Ctrl / Cmd + 滚轮缩放，与 Obsidian 内其他视图习惯一致
    this.scrollerEl.addEventListener("wheel", this.onWheel, { passive: false });
    this.scrollerEl.addEventListener("pointerdown", this.onPointerDownCapture, true);
    this.scrollerEl.addEventListener("mouseup", this.onMouseUp);

    document.addEventListener("pointerup", this.onWindowPointerUp, true);
    document.addEventListener("selectionchange", this.onSelectionChange);
    document.addEventListener("keydown", this.onKeyDown);

    this.unsubscribes.push(
      this.store.change.on((change) => {
        for (const page of change.pages) {
          this.pages.get(page)?.layer.setAnnotations(this.store.getPage(page));
        }
        this.syncHistoryButtons();
      }),
    );
    this.unsubscribes.push(this.tool.change.on(() => this.syncToolUi()));

    // 笔记一变（粘贴了链接 / 删了链接）就重扫。防抖是必须的：
    // 用户粘贴一条 Callout 会触发 1~2 次 metadataCache 变更。
    this.eventRefs.push(
      this.app.metadataCache.on("changed", (file) => {
        if (file.extension === "md") this.scheduleRescan();
      }),
    );
    this.eventRefs.push(
      this.app.metadataCache.on("deleted", () => this.scheduleRescan()),
    );
    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file.path === this.filePath || oldPath === this.filePath) void this.loadPdf(file.path);
        else this.scheduleRescan();
      }),
    );

    this.syncToolUi();
    this.updateZoomLabel();
    this.syncHistoryButtons();
    this.syncBacklinkButton();
  }

  async onClose(): Promise<void> {
    this.scrollerEl?.removeEventListener("scroll", this.onScroll);
    this.scrollerEl?.removeEventListener("wheel", this.onWheel);
    this.scrollerEl?.removeEventListener("pointerdown", this.onPointerDownCapture, true);
    this.scrollerEl?.removeEventListener("mouseup", this.onMouseUp);

    document.removeEventListener("pointerup", this.onWindowPointerUp, true);
    document.removeEventListener("selectionchange", this.onSelectionChange);
    document.removeEventListener("keydown", this.onKeyDown);

    for (const ref of this.eventRefs) this.app.metadataCache.offref(ref);
    this.eventRefs = [];

    for (const off of this.unsubscribes) off();
    this.unsubscribes = [];

    window.clearTimeout(this.selTimer);
    window.clearTimeout(this.rescanTimer);
    if (this.rafId) cancelAnimationFrame(this.rafId);

    this.selectionToolbar.destroy();
    this.colorPopover.destroy();
    this.noteEditor.destroy();
    this.contextMenu.destroy();
    this.hint.destroy();
    this.linkDrag.destroy();
    this.backlinkPanel?.destroy();
    this.backlinkPanel = null;

    for (const el of this.pages.values()) el.layer.destroy();
    this.pages.clear();
    this.textIndexes.clear();
    this.marksByPage.clear();
    this.backlinkEntries = [];
    this.generation++;

    await this.renderer.dispose();
  }

  /* ---------------------------------------------------------------- *
   * 顶部工具栏
   * ---------------------------------------------------------------- */

  private buildToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "pdfa-toolbar" });
    this.titleEl = bar.createDiv({ cls: "pdfa-title", text: "PDF 批注" });

    const zoomBox = bar.createDiv({ cls: "pdfa-zoom" });
    const zoomOut = zoomBox.createEl("button", { cls: "pdfa-icon-btn", attr: { "aria-label": "缩小" } });
    setIcon(zoomOut, "minus");
    zoomOut.onclick = () => void this.setScale(this.scale / SCALE_STEP);

    this.zoomLabelEl = zoomBox.createDiv({ cls: "pdfa-zoom-label", text: "100%" });
    this.zoomLabelEl.onclick = () => void this.setScale(1);

    const zoomIn = zoomBox.createEl("button", { cls: "pdfa-icon-btn", attr: { "aria-label": "放大" } });
    setIcon(zoomIn, "plus");
    zoomIn.onclick = () => void this.setScale(this.scale * SCALE_STEP);

    /* --- 第二行：工具组 --- */
    const row = root.createDiv({ cls: "pdfa-toolrow" });
    const tools = row.createDiv({ cls: "pdfa-tools" });

    for (const id of TOOL_ORDER) {
      const meta = TOOL_META[id];
      const btn = tools.createEl("button", {
        cls: "pdfa-icon-btn pdfa-tool-btn",
        attr: { type: "button", "aria-label": meta.label, title: meta.label },
      });
      setIcon(btn, meta.icon);
      btn.onclick = () => this.tool.toggle(id);
      this.toolButtons.set(id, btn);
    }

    row.createDiv({ cls: "pdfa-toolrow-divider" });

    this.colorBtnEl = row.createEl("button", {
      cls: "pdfa-icon-btn pdfa-color-btn",
      attr: { type: "button", title: "当前颜色 / 色组" },
    });
    this.colorBtnEl.createSpan({ cls: "pdfa-color-dot" });
    this.colorBtnEl.onclick = () => {
      const surface = this.activeSurface();
      this.colorPopover.open(this.colorBtnEl, surface);
    };

    row.createDiv({ cls: "pdfa-toolrow-divider" });

    this.undoBtnEl = row.createEl("button", { cls: "pdfa-icon-btn", attr: { type: "button", title: "撤销 (Ctrl+Z)" } });
    setIcon(this.undoBtnEl, "undo-2");
    this.undoBtnEl.onclick = () => this.store.undo();

    this.redoBtnEl = row.createEl("button", { cls: "pdfa-icon-btn", attr: { type: "button", title: "重做 (Ctrl+Shift+Z)" } });
    setIcon(this.redoBtnEl, "redo-2");
    this.redoBtnEl.onclick = () => this.store.redo();

    row.createDiv({ cls: "pdfa-toolrow-divider" });

    /* 反向链接面板开关：带一个数量角标，否则用户不知道这篇 PDF 有没有回链 */
    this.backlinkBtnEl = row.createEl("button", {
      cls: "pdfa-icon-btn pdfa-backlink-btn",
      attr: { type: "button", title: "反向链接：笔记里指向这篇 PDF 的高亮" },
    });
    setIcon(this.backlinkBtnEl, "link-2");
    this.backlinkBtnEl.createSpan({ cls: "pdfa-backlink-count", text: "0" });
    this.backlinkBtnEl.onclick = () => this.setPanelOpen(!this.panelOpen);

    /*
     * AI 伴读入口。放在顶部而不是只放浮动工具栏：
     * 移动端拖选文字后浮动工具栏可能被选区挡住，顶部按钮是稳定入口。
     */
    this.aiBtnEl = row.createEl("button", {
      cls: "pdfa-icon-btn pdfa-ai-btn",
      attr: { type: "button", title: "AI 伴读：翻译 / 解释 / 总结（先选中文字）" },
    });
    setIcon(this.aiBtnEl, "sparkles");
    this.aiBtnEl.onclick = () => this.showAiMenu(this.aiBtnEl);

    const hint = row.createDiv({ cls: "pdfa-toolrow-hint" });
    hint.setText("Esc 退出工具");
  }

  /** 工具切换后同步：按钮高亮、光标、色点、绘制层的指针开关 */
  private syncToolUi(): void {
    for (const [id, btn] of this.toolButtons) {
      btn.toggleClass("is-active", id === this.tool.active);
    }
    const surface = this.activeSurface();
    const dot = this.colorBtnEl?.querySelector<HTMLElement>(".pdfa-color-dot");
    if (dot) dot.style.background = this.tool.getColor(surface);
    this.colorBtnEl?.setAttr("title", `当前颜色：${this.tool.getColor(surface)}（${getColorGroup(this.tool.getPalette(surface)).label}）`);

    this.scrollerEl?.setAttr("data-tool", this.tool.active);
    this.scrollerEl?.toggleClass("is-drawing", isDrawingTool(this.tool.active));
    for (const el of this.pages.values()) el.layer.refreshTool();

    // 切进绘制工具时把选区工具栏收掉，避免"两套操作同时在场"的歧义
    if (this.tool.active !== "select") this.selectionToolbar.hide();
  }

  /** 当前工具用哪个色槽；select / 文本工具都归到 highlight，方便取色器复用 */
  private activeSurface(): SurfaceKey {
    return TOOL_META[this.tool.active].surface ?? "highlight";
  }

  /**
   * 浮动工具栏的动作分发。
   *
   * 两类语义，别混：
   *  · 高亮 / 下划线 / 便签 → **立即执行**，然后回到 select（一次性）；
   *  · 矩形 / 箭头 / 铅笔 / 马克笔 → 只是**切换到该工具**，等用户在页面上拖，
   *    因为这几个动作需要"起点和终点"，而选区只给出了一个框。
   */
  private onToolbarAction(action: ToolbarAction, anchor?: HTMLElement): void {
    switch (action) {
      case "highlight":
      case "underline":
        this.applyTextMark(action, null, true);
        return;

      case "ai":
        // 不先清选区：AI 需要选区里的文字，Modal 打开后选区被遮住也不影响
        this.showAiMenu(anchor ?? this.aiBtnEl);
        return;

      case "link": {
        // 「链接」= 高亮 + 复制链接。为什么不是"只复制"：
        // 如果只复制不高亮，用户会以为刚才那一下没生效；
        // 而高亮之后链接粘进笔记，重扫时草稿会被回链顶替（视觉上无缝）。
        const created = this.applyTextMark("highlight", null, true);
        void this.copyAnnotationLinks(created);
        return;
      }

      case "rect":
      case "arrow":
      case "pencil":
      case "marker":
        this.clearSelection();
        this.selectionToolbar.hide();
        this.tool.setActive(action);
        // 绘制工具是"去页面上画"，给一句提示，否则用户不知道接下来要拖
        new Notice(
          action === "rect" || action === "arrow" ? "在页面上拖拽绘制（Esc 退出）" : "直接在页面上书写（Esc 退出）",
          1800,
        );
        return;

      case "note": {
        const cap = this.captureSelection();
        const tail = cap?.tail;
        this.clearSelection();
        this.selectionToolbar.hide();
        if (!tail) {
          new Notice("请先选中一段文字，便签会钉在选区末尾");
          return;
        }
        // 往右偏一点点：图钉不要正好压住最后一个字
        this.createNote(tail.page, { x: Math.min(0.995, tail.point.x + 0.012), y: tail.point.y });
        return;
      }
    }
  }

  private syncHistoryButtons(): void {
    this.undoBtnEl?.toggleClass("is-disabled", !this.store.canUndo);
    this.redoBtnEl?.toggleClass("is-disabled", !this.store.canRedo);
  }

  /* ---------------------------------------------------------------- *
   * 状态：文件路径随视图状态持久化，重启 Obsidian 后能恢复
   * ---------------------------------------------------------------- */

  getState(): Record<string, unknown> {
    return { file: this.filePath };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const s = (state ?? {}) as { file?: unknown; link?: unknown };
    // 链接跳转目标只在这一次打开时有效，所以放 eState 侧的 `link`，
    // 不进 getState（否则每次重启 Obsidian 都会重新跳一次，很烦）
    if (typeof s.link === "string") {
      const target = parsePdfLink(s.link);
      if (target) this.pendingTarget = target;
    }
    if (typeof s.file === "string" && s.file.length > 0) {
      await this.loadPdf(s.file);
    }
  }

  /* ---------------------------------------------------------------- *
   * 加载
   * ---------------------------------------------------------------- */

  async loadPdf(path: string): Promise<void> {
    const gen = ++this.generation;

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice(`找不到文件：${path}`);
      return;
    }

    this.selectionToolbar.hide();
    this.noteEditor.close(false);
    this.contextMenu.close();
    this.hint.hide();
    this.store.reset();
    // 换文件：文本索引、回链、进行中的扫描全部作废
    this.scanToken++;
    this.textIndexes.clear();
    this.marksByPage.clear();
    this.backlinkEntries = [];
    this.backlinkPanel?.setEntries([], null);

    for (const el of this.pages.values()) el.layer.destroy();
    this.filePath = path;
    this.titleEl.setText(file.basename);
    this.pagesEl.empty();
    this.pages.clear();

    /*
     * 伴生笔记读写器：每个 PDF 一个。
     * 路径规则来自设置（同目录 / 统一文件夹），所以换设置后要重新构造。
     */
    this.noteStore = new NoteFileStore({
      app: this.app,
      noteLocation: this.plugin.settings.noteLocation,
      noteFolder: this.plugin.settings.noteFolder,
      noteSuffix: this.plugin.settings.noteSuffix,
    });
    this.noteLocations.clear();
    this.notesHydrated = false;

    const buffer = await this.app.vault.readBinary(file);
    const numPages = await this.renderer.load(buffer);
    if (gen !== this.generation) return;

    await this.buildPlaceholders(numPages, gen);
    if (gen !== this.generation) return;

    this.scrollerEl.scrollTop = 0;
    this.refreshVisible();

    // 回链扫描与页面渲染并行：只取文本，不用等位图
    void this.refreshBacklinks();
    // 便签正文在伴生笔记里，需要按 rect= 反算回 NORM 才能画出图钉
    void this.hydrateNotes(gen);

    // 从 Markdown 链接点进来时，等占位骨架搭好再滚动
    const target = this.pendingTarget;
    if (target) {
      this.pendingTarget = null;
      void this.navigateTo(target);
    }
  }

  /**
   * 先按 scale 的尺寸把每一页的占位骨架搭出来，再按需填内容。
   * 好处：滚动条长度立刻正确，用户不会看到“越滚越长”的抖动。
   */
  private async buildPlaceholders(numPages: number, gen: number): Promise<void> {
    for (let n = 1; n <= numPages; n++) {
      const metrics = await this.renderer.getPageMetrics(n);
      if (gen !== this.generation) return;

      const root = this.pagesEl.createDiv({ cls: "pdfa-page" });
      root.dataset.page = String(n);
      root.style.width = `${metrics.baseWidth * this.scale}px`;
      root.style.height = `${metrics.baseHeight * this.scale}px`;

      const canvas = root.createEl("canvas", { cls: "pdfa-canvas" });
      const textLayer = root.createDiv({ cls: "textLayer pdfa-text-layer" });

      const geometry: PageGeometry = {
        pageNumber: n,
        baseWidth: metrics.baseWidth,
        baseHeight: metrics.baseHeight,
        scale: this.scale,
        rotation: metrics.rotation,
      };

      const layer = new PageLayer(root, geometry, this.tool, {
        onCreate: (anno) => this.store.add(anno),
        onPlaceNote: (at) => this.createNote(n, at),
        onOpenNote: (anno) => this.openNoteEditor(anno),
        onOpenNoteAnchor: (anno) => void this.openNoteBlock(anno),
        onContextMenu: (anno, ev) => this.showAnnotationMenu(anno, ev),
        onBacklinkActivate: (mark) => void this.activateBacklink(mark),
        onBacklinkHover: (mark, ev) => this.onPageBacklinkHover(mark, ev),
        onDragStart: (anno, ev) => void this.beginLinkDrag(anno, ev),
      });

      this.pages.set(n, { root, canvas, textLayer, layer, geometry, state: "idle" });
      layer.setAnnotations(this.store.getPage(n));
      layer.setBacklinks(this.marksByPage.get(n) ?? []);
    }
  }

  /* ---------------------------------------------------------------- *
   * 渲染调度
   * ---------------------------------------------------------------- */

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err) => {
      console.error("[pdf-annotator] 渲染失败", err);
    });
  }

  private ensureRender(pageNumber: number): void {
    const el = this.pages.get(pageNumber);
    if (!el || el.state !== "idle") return;

    el.state = "queued";
    this.enqueue(async () => {
      const current = this.pages.get(pageNumber);
      // 排队期间页面可能已被重建（缩放 / 换文件），此时静默丢弃
      if (current !== el || el.state !== "queued") return;

      el.state = "rendering";
      try {
        const result = await this.renderer.renderPage(pageNumber, el.canvas, el.textLayer, {
          scale: this.scale,
        });
        if (!result) {
          el.state = "idle";
          return;
        }
        el.geometry = result.geometry;
        el.layer.setGeometry(result.geometry);
        el.state = "done";
      } catch (err) {
        el.state = "idle";
        console.error(`[pdf-annotator] 第 ${pageNumber} 页渲染失败`, err);
      }
    });
  }

  private unloadPage(pageNumber: number): void {
    const el = this.pages.get(pageNumber);
    if (!el || el.state === "idle") return;
    this.renderer.releasePage(pageNumber);
    // 把位图尺寸归零才能真正释放显存，仅清空样式没用
    el.canvas.width = 0;
    el.canvas.height = 0;
    el.textLayer.textContent = "";
    el.state = "idle";
  }

  private readonly onScroll = (): void => {
    // 选区工具栏是 fixed 定位，滚动后位置就飘了，直接收掉
    this.selectionToolbar.hide();
    // 悬停高亮停在旧页上会让人迷惑
    if (this.hover) this.setHoverBacklink(null);
    this.hint.hide();

    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.refreshVisible();
      // 「仅本页」过滤依赖当前页，滚动时同步一下（面板没开就跳过）
      if (this.panelOpen) this.backlinkPanel?.setCurrentPage(this.currentPageNumber());
    });
  };

  private readonly onWheel = (ev: WheelEvent): void => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP;
    void this.setScale(this.scale * factor, ev);
  };

  /**
   * 计算当前可视范围，触发应渲染的页、回收远处的页。
   * 手写命中检测而不用 IntersectionObserver：缩放后我们会一次性改动
   * 所有页的高度，IO 的回调时机在新尺寸落盘前后并不确定，容易漏页。
   */
  private refreshVisible(): void {
    if (this.pages.size === 0) return;
    const viewport = this.scrollerEl.getBoundingClientRect();
    const margin = viewport.height * PRELOAD_MARGIN_SCREENS;
    const firstVisible: number[] = [];

    for (const [n, el] of this.pages) {
      const rect = el.root.getBoundingClientRect();
      const near = rect.bottom > viewport.top - margin && rect.top < viewport.bottom + margin;
      if (near) {
        firstVisible.push(n);
        this.ensureRender(n);
      }
    }

    // 回收与可视区隔了 8 页以上的位图，控制内存（A4@dpr2 单页约 12MB）
    if (firstVisible.length > 0) {
      const lo = Math.min(...firstVisible) - 8;
      const hi = Math.max(...firstVisible) + 8;
      for (const n of this.pages.keys()) {
        if (n < lo || n > hi) this.unloadPage(n);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 缩放
   * ---------------------------------------------------------------- */

  async setScale(next: number, anchorEvent?: WheelEvent | MouseEvent): Promise<void> {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    if (Math.abs(clamped - this.scale) < 1e-4) return;

    // ① 先记住“当前视口顶部正对着哪一页的什么位置”
    const anchor = this.captureAnchor();
    const cursor = anchorEvent ? this.captureCursor(anchorEvent) : null;

    this.selectionToolbar.hide();
    this.colorPopover.close();
    this.noteEditor.close(true);
    this.scale = clamped;
    this.updateZoomLabel();

    // ② 所有页面按新 scale 改尺寸，并作废已有位图（绘制层不清：它是矢量的）
    for (const [, el] of this.pages) {
      const geo = el.geometry;
      if (!geo) continue;
      geo.scale = clamped;
      el.root.style.width = `${geo.baseWidth * clamped}px`;
      el.root.style.height = `${geo.baseHeight * clamped}px`;
      el.layer.setGeometry(geo);
      el.state = "idle";
      el.canvas.width = 0;
      el.canvas.height = 0;
      el.textLayer.textContent = "";
    }

    // ③ 还原滚动位置（强制读一次布局，确保新高度已生效）
    if (anchor) {
      const el = this.pages.get(anchor.page);
      if (el) {
        void el.root.offsetHeight;
        this.scrollerEl.scrollTop = el.root.offsetTop + anchor.ratio * el.root.offsetHeight;
      }
    }

    // ④ 光标锚定：以指针下的页面点为不动点缩放
    if (cursor) this.applyCursorAnchor(cursor);
  }

  private captureAnchor(): { page: number; ratio: number } | null {
    const top = this.scrollerEl.scrollTop;
    for (const [n, el] of this.pages) {
      const pageTop = el.root.offsetTop;
      const h = el.root.offsetHeight;
      if (top >= pageTop && top < pageTop + h && h > 0) {
        return { page: n, ratio: (top - pageTop) / h };
      }
    }
    return null;
  }

  private captureCursor(ev: WheelEvent | MouseEvent): { page: number; nx: number; ny: number; cx: number; cy: number } | null {
    const scrollerRect = this.scrollerEl.getBoundingClientRect();
    const pointerX = ev.clientX - scrollerRect.left;
    const pointerY = ev.clientY - scrollerRect.top;

    for (const [n, el] of this.pages) {
      const r = el.root.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (x >= 0 && y >= 0 && x <= r.width && y <= r.height) {
        return { page: n, nx: x / r.width, ny: y / r.height, cx: pointerX, cy: pointerY };
      }
    }
    return null;
  }

  private applyCursorAnchor(c: { page: number; nx: number; ny: number; cx: number; cy: number }): void {
    const el = this.pages.get(c.page);
    if (!el) return;
    const targetY = el.root.offsetTop + c.ny * el.root.offsetHeight - c.cy;
    this.scrollerEl.scrollTop = Math.max(0, targetY);
    const targetX = c.nx * el.root.offsetWidth - c.cx;
    this.scrollerEl.scrollLeft = Math.max(0, targetX);
  }

  private updateZoomLabel(): void {
    this.zoomLabelEl.setText(`${Math.round(this.scale * 100)}%`);
  }

  /* ================================================================ *
   * 选区 → 工具栏
   * ================================================================ */

  private readonly onPointerDownCapture = (): void => {
    this.pointerDown = true;
  };

  private readonly onWindowPointerUp = (): void => {
    this.pointerDown = false;
  };

  private readonly onMouseUp = (ev: MouseEvent): void => {
    if (ev.button !== 0) return;
    // 让浏览器先把选区落定，再读 getSelection()
    window.setTimeout(() => this.syncSelection(), 0);
  };

  private readonly onSelectionChange = (): void => {
    if (this.mutatingSelection) return;
    window.clearTimeout(this.selTimer);
    this.selTimer = window.setTimeout(() => this.syncSelection(), SELECTION_DEBOUNCE);
  };

  /**
   * 选区状态 → UI 决策：
   *   · 没选中任何东西        → 收工具栏
   *   · 当前是文本工具        → 直接落批注（Acrobat 语义）
   *   · 当前是选择工具        → 在选区旁弹工具栏
   *   · 当前是绘制工具        → 收工具栏，别打扰
   */
  private syncSelection(): void {
    // 手指还按着 = 用户正在拖，别在拖到一半时弹/落
    if (this.pointerDown) return;

    const cap = this.captureSelection();
    if (!cap) {
      this.selectionToolbar.hide();
      return;
    }

    const active = this.tool.active;
    if (active === "highlight" || active === "underline") {
      this.applyTextMark(active, cap);
      return;
    }
    if (active !== "select") {
      this.selectionToolbar.hide();
      return;
    }

    this.selectionToolbar.show(cap.anchor);
  }

  /**
   * 把当前选区换成 { 每页归一化矩形 + 工具栏锚点 + 便签落点 }。
   *
   * 阶段一只用其中的矩形做坐标自检，阶段二多要了两样：
   *   anchor —— 工具栏要贴着**选区最后一行**，而不是整个选区的外接框
   *             （跨十几行时外接框会大到屏幕外）
   *   tail   —— 便签默认钉在选区末尾，符合"我在这段话旁边记一笔"的直觉
   */
  private captureSelection(): SelectionCapture | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

    // 选区起点不在本视图里（可能是别的面板/编辑器），一律不管
    const anchorNode = sel.anchorNode;
    const anchorEl = anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
    if (!anchorEl || !this.scrollerEl.contains(anchorEl)) return null;

    // ★ 先把每页的位置快照一次。
    //   否则每个 Range 矩形都要把所有页 getBoundingClientRect 一遍，
    //   500 页的文档里一次选区就是上万次布局查询（掉帧的元凶）。
    const pageRects: Array<{ n: number; rect: DOMRect }> = [];
    for (const [n, el] of this.pages) {
      pageRects.push({ n, rect: el.root.getBoundingClientRect() });
    }
    if (pageRects.length === 0) return null;

    const perPage = new Map<number, { css: Rect[]; pageRect: DOMRect }>();
    let best: { page: number; rect: DOMRect } | null = null;

    for (let i = 0; i < sel.rangeCount; i++) {
      const rects = sel.getRangeAt(i).getClientRects();
      for (const cr of Array.from(rects)) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;

        const page = hitPage(pageRects, cr.left + cr.width / 2, cr.top + cr.height / 2);
        if (!page) continue;

        const entry = perPage.get(page.n) ?? { css: [], pageRect: page.rect };
        entry.css.push({
          x: cr.left - page.rect.left,
          y: cr.top - page.rect.top,
          w: cr.width,
          h: cr.height,
        });
        perPage.set(page.n, entry);

        // 锚点取"最靠下"的那个矩形：它就是用户松手的地方
        if (!best || cr.bottom > best.rect.bottom) best = { page: page.n, rect: cr };
      }
    }

    if (!best) return null;

    const pages: Array<{ page: number; rects: Rect[] }> = [];
    for (const [page, entry] of perPage) {
      const geo = this.pages.get(page)?.geometry;
      if (!geo) continue;
      const merged = mergeLineRects(entry.css);
      pages.push({ page, rects: merged.map((r) => roundRect(cssRectToNorm(r, geo))) });
    }
    if (pages.length === 0) return null;

    const geo = this.pages.get(best.page)?.geometry;
    const pr = this.pages.get(best.page)?.root.getBoundingClientRect();
    if (!geo || !pr) return null;

    const tail: Point = {
      x: (best.rect.right - pr.left) / pr.width,
      y: (best.rect.bottom - pr.top) / pr.height,
    };

    return {
      pages,
      anchor: {
        left: best.rect.left,
        top: best.rect.top,
        right: best.rect.right,
        bottom: best.rect.bottom,
        width: best.rect.width,
        height: best.rect.height,
      },
      tail: { page: best.page, point: tail },
    };
  }

  private pageAtClientPoint(clientX: number, clientY: number): { n: number; rect: DOMRect } | null {
    for (const [n, el] of this.pages) {
      const r = el.root.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return { n, rect: r };
      }
    }
    return null;
  }

  /* ================================================================ *
   * 落批注
   * ================================================================ */

  /**
   * @param fromToolbar 来自浮动工具栏（一次性）还是激活的文本工具（持续）
   * @returns 本次新建的批注（"高亮并复制链接"要用）
   */
  private applyTextMark(
    kind: "highlight" | "underline",
    cap: SelectionCapture | null,
    fromToolbar = false,
  ): Annotation[] {
    const capture = cap ?? this.captureSelection();
    if (!capture) {
      this.selectionToolbar.hide();
      return [];
    }

    const color = this.tool.getColor("highlight");
    const now = Date.now();
    const created: Annotation[] = [];
    for (const item of capture.pages) {
      const base = {
        id: createAnnotationId(),
        page: item.page,
        color,
        createdAt: now,
        updatedAt: now,
      };
      if (kind === "highlight") {
        created.push(
          this.store.add({
            ...base,
            kind: "highlight",
            rects: item.rects,
            opacity: ANNOT_DEFAULTS.highlightOpacity,
          }),
        );
      } else {
        created.push(
          this.store.add({
            ...base,
            kind: "underline",
            rects: item.rects,
            thickness: ANNOT_DEFAULTS.underlineThickness,
          }),
        );
      }
    }

    this.clearSelection();
    this.selectionToolbar.hide();
    if (fromToolbar) this.tool.setActive("select");
    return created;
  }

  private createNote(page: number, at: Point): void {
    const now = Date.now();
    const anno: NoteAnnotation = {
      id: createAnnotationId(),
      kind: "note",
      page,
      at,
      body: "",
      color: this.tool.getColor("note"),
      createdAt: now,
      updatedAt: now,
    };
    this.store.add(anno);
    // 先落盘（写进伴生笔记）再开编辑器：用户如果直接关掉浮层，这条便签也不会丢
    void this.persistNote(anno);
    // 等一帧再开编辑器：让图钉先渲染出来，也避开当前 pointerdown 的事件流
    window.requestAnimationFrame(() => this.openNoteEditor(anno));
  }

  private openNoteEditor(anno: NoteAnnotation): void {
    const anchor = this.clientBoxFor(anno.page, anno.at);
    if (!anchor) return;
    this.selectionToolbar.hide();
    this.noteEditor.open(anno, anchor);
  }

  /** 归一化点 → 屏幕上的小方块（用作浮层锚点） */
  private clientBoxFor(page: number, point: Point, size = 22): RectLike | null {
    const el = this.pages.get(page);
    if (!el) return null;
    const r = el.root.getBoundingClientRect();
    const x = r.left + point.x * r.width;
    const y = r.top + point.y * r.height;
    return { left: x - size / 2, top: y - size / 2, right: x + size / 2, bottom: y + size / 2, width: size, height: size };
  }

  private showAnnotationMenu(anno: Annotation, ev: ClientPos): void {
    const items: MenuItem[] = [];
    if (anno.kind === "note") {
      items.push({ label: "编辑便签", icon: "pencil", onClick: () => this.openNoteEditor(anno) });
      items.push({ label: "在笔记中打开这一条", icon: "external-link", onClick: () => void this.openNoteBlock(anno) });
    }
    items.push({ label: "复制链接", icon: "link", onClick: () => void this.copyAnnotationLink(anno, false) });
    items.push({ label: "复制为 Callout", icon: "quote", onClick: () => void this.copyAnnotationLink(anno, true) });

    /*
     * AI 三项平铺而不是二级菜单：
     * 右键菜单本来就是"我已经知道要做什么"的入口，多一层点击只是摩擦。
     * 手绘没有对应链接语法，所以不给 AI 入口（结果插进笔记会缺定位信息）。
     */
    if (anno.kind !== "ink") {
      for (const task of AI_TASKS) {
        items.push({
          label: `AI ${task.label}`,
          icon: task.icon,
          onClick: () => void this.runAiTaskForAnnotation(task.id, anno),
        });
      }
    }

    items.push({
      label: "删除批注",
      icon: "trash-2",
      danger: true,
      onClick: () => {
        this.store.remove(anno.id);
        if (anno.kind === "note") {
          this.noteEditor.close(false);
          void this.deleteNoteBlock(anno.id);
        }
      },
    });
    this.contextMenu.show(items, ev.clientX, ev.clientY);
  }

  private clearSelection(): void {
    this.mutatingSelection = true;
    window.getSelection()?.removeAllRanges();
    // 同步复位：selectionchange 是异步派发的，用微任务让"自己触发的清空"被忽略
    window.setTimeout(() => {
      this.mutatingSelection = false;
    }, 0);
  }

  /* ================================================================ *
   * 阶段三 · 文本索引
   * ================================================================ */

  /**
   * 取某页的文本索引（带 Promise 缓存）。
   * 回链解析与链接生成共用它 —— 这是两条方向相反的路，
   * 共用同一个索引才能保证"写出去再读回来"落回原处。
   */
  private getTextIndex(page: number): Promise<TextPageIndex | null> {
    const cached = this.textIndexes.get(page);
    if (cached) return cached;

    const gen = this.generation;
    const task = (async () => {
      const info = await this.renderer.getPageText(page);
      if (!info || gen !== this.generation) return null;
      return buildTextIndex(page, info.content, info.transform, info.width, info.height);
    })();
    this.textIndexes.set(page, task);
    return task;
  }

  /* ================================================================ *
   * 阶段三 · 反向链接扫描
   * ================================================================ */

  private scheduleRescan(): void {
    if (!this.filePath) return;
    window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = 0;
      void this.refreshBacklinks();
    }, RESCAN_DEBOUNCE);
  }

  private async refreshBacklinks(): Promise<void> {
    const path = this.filePath;
    if (!path) return;

    const token = ++this.scanToken;
    let result;
    try {
      result = await scanBacklinks(this.scanHost, path);
    } catch (err) {
      console.error("[pdf-annotator] 回链扫描失败", err);
      return;
    }
    if (token !== this.scanToken || this.filePath !== path) return;

    this.backlinkEntries = result.entries;
    await this.resolveBacklinks(token);
    if (token !== this.scanToken) return;

    this.backlinkPanel?.setEntries(this.backlinkEntries, this.currentPageNumber());
    this.updateBacklinkBadge();
  }

  /**
   * 把链接解析成屏幕矩形，下发到每一页的绘制层。
   *
   * 注意这里是**逐页串行**的：每页都要 await 一次文本内容。
   * 不并发是故意的 —— 一次并行几十个 getTextContent 会跟渲染抢主线程，
   * 用户看到的是滚动卡顿；串行只是"回链晚几十毫秒出现"。
   */
  private async resolveBacklinks(token: number): Promise<void> {
    const byPage = new Map<number, BacklinkMark[]>();

    for (const entry of this.backlinkEntries) {
      const idx = await this.getTextIndex(entry.page);
      if (token !== this.scanToken) return;
      if (!idx) continue;

      const rects = linkRectsOnPage(entry.target, idx)
        .map((r) => roundRect(clampNormRect(r)))
        .filter((r) => r.w > 0.0004 && r.h > 0.0004);
      if (rects.length === 0) continue;

      const mark: BacklinkMark = {
        key: entry.key,
        page: entry.page,
        rects,
        color: entry.target.color?.hex ?? DEFAULT_LINK_COLOR.hex,
        opacity: BACKLINK_OPACITY,
        title: `${entry.sourceName} · 第 ${entry.position.start.line + 1} 行`,
        sourcePath: entry.sourcePath,
        line: entry.position.start.line,
      };
      const list = byPage.get(mark.page);
      if (list) list.push(mark);
      else byPage.set(mark.page, [mark]);
    }

    if (token !== this.scanToken) return;
    this.marksByPage = byPage;
    for (const [n, el] of this.pages) el.layer.setBacklinks(byPage.get(n) ?? []);
    this.dedupeDraftHighlights();
  }

  /**
   * 草稿去重：用户高亮 → 链接粘进笔记 → 重扫发现同位置已有回链，
   * 这时内存里那条草稿就成了重复（两层叠在一起颜色明显变深）。
   * 判定用几何重合率而不是链接参数，因为草稿没有链接参数。
   */
  private dedupeDraftHighlights(): void {
    const victims: string[] = [];
    for (const anno of this.store.all()) {
      if (!isTextMark(anno)) continue;
      const marks = this.marksByPage.get(anno.page);
      if (!marks) continue;
      if (marks.some((m) => rectsOverlap(anno.rects, m.rects))) victims.push(anno.id);
    }
    if (victims.length > 0) this.store.removeSilently(victims);
  }

  /* ---------------------------------------------------------------- *
   * 面板
   * ---------------------------------------------------------------- */

  private get panelOpen(): boolean {
    return this.backlinkPanel?.el.classList.contains("is-open") ?? false;
  }

  private setPanelOpen(open: boolean): void {
    const panel = this.backlinkPanel;
    if (!panel) return;
    panel.el.classList.toggle("is-open", open);
    this.backlinkBtnEl?.classList.toggle("is-active", open);
    if (open) {
      panel.setEntries(this.backlinkEntries, this.currentPageNumber());
      if (this.backlinkEntries.length === 0) void this.refreshBacklinks();
    }
  }

  private syncBacklinkButton(): void {
    this.backlinkBtnEl?.classList.toggle("is-active", this.panelOpen);
    this.updateBacklinkBadge();
  }

  /** 命令入口 */
  toggleBacklinkPanel(): void {
    this.setPanelOpen(!this.panelOpen);
  }

  private updateBacklinkBadge(): void {
    const count = this.backlinkEntries.length;
    const badge = this.backlinkBtnEl?.querySelector<HTMLElement>(".pdfa-backlink-count");
    if (!badge) return;
    badge.setText(String(count));
    badge.toggleClass("is-zero", count === 0);
  }

  /* ---------------------------------------------------------------- *
   * 跳转（PDF → 笔记 / 笔记 → PDF）
   * ---------------------------------------------------------------- */

  /**
   * 定位到链接指向的页与选区。
   * 来自 Markdown 链接点击，也可能来自命令（"跳到某页"）。
   */
  async navigateTo(target: PdfLinkTarget): Promise<void> {
    const page = target.page;
    const el = this.pages.get(page);
    if (!el) {
      new Notice(`第 ${page} 页不存在`);
      return;
    }

    const gen = this.generation;
    this.selectionToolbar.hide();

    // ① 先把目标页滚进预渲染窗口，否则下面算出来的 offsetTop 可能是旧布局
    this.scrollerEl.scrollTop = Math.max(0, el.root.offsetTop - 24);
    this.refreshVisible();

    // ② 解析选区
    const idx = target.selection || target.rect ? await this.getTextIndex(page) : null;
    if (gen !== this.generation) return;
    const rects = idx ? linkRectsOnPage(target, idx) : [];

    // ③ 精确垂直居中：让选区落在视口上 1/3 处，留出上下文
    if (rects.length > 0) {
      const r = rects[0];
      const top = el.root.offsetTop + r.y * el.root.offsetHeight;
      this.scrollerEl.scrollTop = Math.max(0, top - Math.max(60, this.scrollerEl.clientHeight * 0.32));
    }

    // ④ 闪一下，告诉用户"就是这一段"
    this.pages.get(page)?.layer.flash(rects);
  }

  private async activateBacklink(mark: BacklinkMark): Promise<void> {
    // 双击已经顺带选中了一个词，不清掉会弹出选区工具栏
    this.clearSelection();
    this.selectionToolbar.hide();
    this.hint.hide();
    const ok = await openNoteAt(this.app, mark.sourcePath, mark.line);
    if (!ok) new Notice(`找不到笔记：${mark.sourcePath}`);
  }

  private async jumpToNote(entry: BacklinkEntry): Promise<void> {
    const ok = await openNoteAt(this.app, entry.sourcePath, entry.position.start.line);
    if (!ok) new Notice(`找不到笔记：${entry.sourcePath}`);
  }

  /* ---------------------------------------------------------------- *
   * 悬停联动（页面 ⇄ 面板）
   * ---------------------------------------------------------------- */

  private setHoverBacklink(next: { page: number; key: string } | null): void {
    const prev = this.hover;
    if (prev && (!next || prev.page !== next.page || prev.key !== next.key)) {
      this.pages.get(prev.page)?.layer.setHoverBacklink(null);
    }
    this.hover = next;
    if (!next) {
      this.backlinkPanel?.setActiveKey(null);
      return;
    }
    this.pages.get(next.page)?.layer.setHoverBacklink(next.key);
    this.backlinkPanel?.setActiveKey(next.key);
  }

  private onPageBacklinkHover(mark: BacklinkMark | null, ev: ClientPos | null): void {
    if (!mark) {
      if (!this.hover) return;
      this.setHoverBacklink(null);
      this.hint.hide();
      return;
    }
    this.setHoverBacklink({ page: mark.page, key: mark.key });
    if (ev) this.hint.show(`双击跳到 ${mark.title}`, ev.clientX, ev.clientY);
  }

  /* ================================================================ *
   * 阶段三 · 生成链接（复制 / 拖拽）
   * ================================================================ */

  /** 文本类批注 → selection 链接 */
  private async buildLinkForRects(
    page: number,
    rectsNorm: Rect[],
    color: string,
  ): Promise<{ link: string; quote: string } | null> {
    if (!this.filePath) return null;
    const geo = this.pages.get(page)?.geometry;
    const idx = await this.getTextIndex(page);
    if (!geo || !idx) return null;

    const sel = rectsToSelection(
      idx,
      rectsNorm.map((r) => normRectToBase(r, geo)),
    );
    if (!sel) return null;

    return {
      link: buildPdfLink({ path: this.filePath, page, selection: sel, color }),
      quote: selectionText(idx, sel),
    };
  }

  /** 区域类批注（矩形/箭头/便签锚点）→ rect 链接（PDF 坐标，y 向上） */
  private async buildLinkForRegion(
    page: number,
    boxNorm: Rect,
    color: string,
  ): Promise<{ link: string } | null> {
    if (!this.filePath) return null;
    const geo = this.pages.get(page)?.geometry;
    if (!geo) return null;
    // 用文本索引里的 viewport 变换做逆变换：rect= 必须是 PDF 用户空间坐标，
    // 而页面容器是 viewport 空间，两者差一个 CropBox 偏移
    const idx = await this.getTextIndex(page);
    if (!idx) return null;
    const rect = rectToPdfQuad(normRectToBase(boxNorm, geo), idx.transform);
    return { link: buildPdfLink({ path: this.filePath, page, rect, color }) };
  }

  private async linkForAnnotation(
    anno: Annotation,
  ): Promise<{ link: string; quote: string; note: string; page: number } | null> {
    if (!this.filePath) return null;

    if (isTextMark(anno)) {
      const built = await this.buildLinkForRects(anno.page, anno.rects, anno.color);
      return built ? { ...built, note: "", page: anno.page } : null;
    }

    if (anno.kind === "rect" || anno.kind === "arrow") {
      const box = boxFromPoints(anno.from, anno.to);
      const built = await this.buildLinkForRegion(anno.page, box, anno.color);
      return built ? { ...built, quote: "", note: "", page: anno.page } : null;
    }

    if (anno.kind === "note") {
      // 便签没有选区：在锚点处取一个 4pt 的小方块当 rect=，
      // 这样它的位置在链接里是确定的（否则笔记里的链接就丢了"钉在哪"）
      const geo = this.pages.get(anno.page)?.geometry;
      if (!geo) return null;
      const box: Rect = { x: anno.at.x, y: anno.at.y, w: 4 / geo.baseWidth, h: 4 / geo.baseHeight };
      const built = await this.buildLinkForRegion(anno.page, box, anno.color);
      return built ? { ...built, quote: "", note: anno.body, page: anno.page } : null;
    }

    // 手绘目前没有对应的链接语法（PDF++ 也没有），明确拒绝而不是瞎猜
    return null;
  }

  private async copyAnnotationLink(anno: Annotation, callout: boolean): Promise<void> {
    const built = await this.linkForAnnotation(anno);
    if (!built || !this.filePath) {
      new Notice("这条批注没有对应的链接语法（手绘暂不支持）");
      return;
    }
    const text = callout
      ? buildPdfCallout({
          link: withAlias(built.link, this.filePath, built.page),
          color: anno.color,
          quote: built.quote || null,
          note: built.note || null,
        })
      : built.link;
    await this.copyText(text);
    new Notice(callout ? "已复制 Callout" : "已复制链接");
  }

  /** 命令入口：复制当前选区（不创建批注） */
  async copySelectionLink(callout: boolean): Promise<void> {
    const cap = this.captureSelection();
    if (!cap || cap.pages.length === 0 || !this.filePath) {
      new Notice("请先在 PDF 上选中一段文字");
      return;
    }
    if (cap.pages.length > 1) {
      new Notice("选区跨了多页，只生成第一页的链接", 2200);
    }

    const first = cap.pages[0];
    const color = this.tool.getColor("highlight");
    const built = await this.buildLinkForRects(first.page, first.rects, color);
    if (!built) {
      new Notice("这一页取不到文本层（可能是扫描件），无法生成精确链接");
      return;
    }

    const text = callout
      ? buildPdfCallout({
          link: withAlias(built.link, this.filePath, first.page),
          color,
          quote: built.quote || null,
        })
      : built.link;
    await this.copyText(text);
    new Notice(callout ? "已复制 Callout，粘贴到笔记即可" : "已复制链接，粘贴到笔记即可");
  }

  private async copyAnnotationLinks(annos: Annotation[]): Promise<void> {
    const links: string[] = [];
    for (const anno of annos) {
      const built = await this.linkForAnnotation(anno);
      if (built) links.push(built.link);
    }
    if (links.length === 0) {
      new Notice("这些批注无法生成链接");
      return;
    }
    await this.copyText(links.join("\n"));
    new Notice(links.length > 1 ? `已复制 ${links.length} 条链接` : "已复制链接，粘贴到笔记即可");
  }

  private async copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Electron 里一般不会失败，但隐私模式 / 权限拒绝时要有兜底
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        new Notice("复制失败，请手动选择文本复制");
        return false;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Alt + 拖拽出链接
   * ---------------------------------------------------------------- */

  private async beginLinkDrag(anno: Annotation, ev: ClientPos): Promise<void> {
    const pos = { clientX: ev.clientX, clientY: ev.clientY };
    const built = await this.linkForAnnotation(anno);
    if (!built || !this.filePath) {
      new Notice("这条批注没有对应的链接语法（手绘暂不支持）");
      return;
    }

    const payload =
      anno.kind === "note" && built.note.trim()
        ? {
            text: buildPdfCallout({
              link: withAlias(built.link, this.filePath, built.page),
              color: anno.color,
              note: built.note,
            }),
            label: "📌 便签 → 笔记",
          }
        : { text: built.link, label: "🔗 PDF 链接" };

    this.hint.hide();
    this.linkDrag.begin(pos, payload);
  }

  /* ================================================================ *
   * 阶段四 · AI 伴读
   * ================================================================ */

  /** AI 二级菜单：三个任务贴着入口按钮弹出 */
  private showAiMenu(anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const items: MenuItem[] = AI_TASKS.map((t) => ({
      label: `${t.label}选中的文字`,
      icon: t.icon,
      onClick: () => void this.runAiTask(t.id),
    }));
    // 没有选区时也给提示：点下去会退化成"按当前页提问"
    this.contextMenu.show(items, r.left + r.width / 2, r.bottom + 6);
  }

  /**
   * 跑一次 AI 任务。
   *
   * 顺序是刻意的：先取文本索引（拿到选区的字符坐标）→ 再拼链接，
   * 因为链接里的 `selection=` 和"要喂给模型的原文"必须是**同一份**选区，
   * 否则用户在笔记里点链接跳回来，高亮的位置和 AI 解读的文字会对不上。
   */
  async runAiTask(task: AiTask): Promise<void> {
    if (!this.filePath) return;
    if (!this.plugin.settings.ai.model.trim()) {
      new Notice("还没配置 AI 模型：设置 → PDF View for Obsidian → AI 伴读");
      return;
    }

    const cap = this.captureSelection();
    const first = cap?.pages[0];
    let page = this.currentPageNumber() ?? 1;
    let quote = "";
    let link = "";

    if (first) {
      page = first.page;
      const built = await this.buildLinkForRects(first.page, first.rects, this.tool.getColor("highlight"));
      if (built) {
        quote = built.quote;
        link = withAlias(built.link, this.filePath, first.page);
      }
    }

    // 没有选区（或扫描件取不到文本）：退化成"当前页"级别的提问
    if (!link) link = withAlias(buildPdfLink({ path: this.filePath, page, color: this.tool.getColor("highlight") }), this.filePath, page);

    this.openAiModal(task, { link, quote, page });
  }

  /** 对某条已有批注跑 AI（右键菜单入口） */
  private async runAiTaskForAnnotation(task: AiTask, anno: Annotation): Promise<void> {
    if (!this.filePath) return;
    if (!this.plugin.settings.ai.model.trim()) {
      new Notice("还没配置 AI 模型：设置 → PDF View for Obsidian → AI 伴读");
      return;
    }
    const built = await this.linkForAnnotation(anno);
    if (!built) {
      new Notice("这条批注没有可用的链接（手绘暂不支持）");
      return;
    }
    this.openAiModal(task, {
      link: withAlias(built.link, this.filePath, built.page),
      quote: built.quote ?? "",
      page: built.page,
    });
  }

  private openAiModal(task: AiTask, ctx: AiContext): void {
    const meta = taskMeta(task);
    const modal = new AiModal(this.app, {
      // 结果里的相对图片按伴生笔记目录解析
      sourcePath: this.filePath ? (this.noteStore?.pathFor(this.filePath) ?? this.filePath) : "",
      request: {
        task,
        quote: ctx.quote,
        context: { documentTitle: this.getDisplayText(), page: ctx.page },
        settings: this.plugin.settings.ai,
      },
      onInsert: (result) => this.insertAiResult(meta.heading, result, ctx),
    });
    modal.open();
    this.selectionToolbar.hide();
  }

  /**
   * 插入结果：**引用 + 解读**。
   *
   * 插到哪：
   *   ① 有打开的 Markdown 笔记 → 插到它的光标处（"当前笔记"的字面含义）；
   *   ② 没有 → 追加到伴生笔记并打开它。
   * 之所以优先 ①：用户常常一边看 PDF 一边在旁边那篇文献综述里写东西，
   * 结果飞到另一篇笔记里会让人找半天。
   */
  private async insertAiResult(heading: string, result: AiResult, ctx: AiContext): Promise<void> {
    if (!this.filePath) return;
    const block = renderAiBlock({
      link: ctx.link,
      color: this.tool.getColor("highlight"),
      quote: this.plugin.settings.ai.includeQuote ? ctx.quote : null,
      heading,
      text: result.text,
    });

    const editor = this.findTargetEditor();
    if (editor) {
      const cursor = editor.getCursor();
      // 前后各留一个空行：Callout 紧贴上一段时，Obsidian 会把它并进上一块
      editor.replaceSelection(`${cursor.line > 0 ? "\n" : ""}${block}\n`);
      new Notice("已插入到当前笔记");
      return;
    }

    const path = await this.noteStore?.append(this.filePath, block);
    if (!path) {
      throw new Error("找不到伴生笔记位置");
    }
    new Notice("没有打开的笔记，已追加到伴生笔记");
    await this.openFileAtLine(path, 0);
  }

  /** 找"当前笔记"的编辑器：优先用户最近编辑过的那篇，否则任意一篇 */
  private findTargetEditor(): Editor | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    if (leaves.length === 0) return null;
    const preferred = this.plugin.lastMarkdownPath;
    const ordered = preferred
      ? [...leaves].sort((a, b) => {
          const av = (a.view as MarkdownView).file?.path === preferred ? 0 : 1;
          const bv = (b.view as MarkdownView).file?.path === preferred ? 0 : 1;
          return av - bv;
        })
      : leaves;
    for (const leaf of ordered) {
      const view = leaf.view as MarkdownView;
      if (view.getMode?.() === "preview") continue;
      return view.editor;
    }
    return null;
  }

  private async openFileAtLine(path: string, line: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, { eState: { line, ch: 0 }, active: true, state: { mode: "source" } });
  }

  /* ================================================================ *
   * 阶段五 · 便签落盘（伴生笔记）
   * ================================================================ */

  /**
   * 把伴生笔记里的便签读回来，变成页面上的图钉。
   *
   * 位置信息只在链接的 `rect=`（PDF 用户空间）里，必须借该页的 viewport 变换
   * 反算成 NORM —— 这也是为什么先 await 一次文本索引：
   * 图钉没有文本层也能画，但**位置**要靠它。
   */
  private async hydrateNotes(gen: number): Promise<void> {
    const store = this.noteStore;
    const path = this.filePath;
    if (!store || !path || this.notesHydrated) return;

    let stored: StoredNote[] = [];
    try {
      stored = await store.list(path);
    } catch (err) {
      console.warn("[pdf-annotator] 读取伴生笔记失败", err);
      return;
    }
    if (gen !== this.generation) return;

    for (const note of stored) {
      this.noteLocations.set(note.id, { path: store.pathFor(path), line: note.startLine });
      // 用户刚建的便签已经在 store 里了，别被磁盘版本覆盖
      if (this.store.get(note.id)) continue;

      const idx = await this.getTextIndex(note.page);
      if (gen !== this.generation) return;
      const target = parsePdfLink(note.link);
      const at =
        idx && target?.rect
          ? quadCenterToNorm(target.rect, idx.transform, idx.width, idx.height, applyTransform)
          : { x: 0.5, y: 0.5 };

      const now = Date.now();
      // silent：从笔记读回来的便签不占撤销栈（否则 Ctrl+Z 要先撤掉一堆历史便签）
      this.store.add(
        {
          id: note.id,
          kind: "note",
          page: note.page,
          at,
          body: note.body,
          color: note.color,
          createdAt: now,
          updatedAt: now,
        },
        true,
      );
    }
    this.notesHydrated = true;
  }

  /** 便签 → 伴生笔记（新建或更新那一块） */
  private async persistNote(anno: NoteAnnotation): Promise<void> {
    const store = this.noteStore;
    const path = this.filePath;
    if (!store || !path) return;
    const built = await this.linkForAnnotation(anno);
    if (!built) return;
    try {
      const loc = await store.upsert(path, {
        id: anno.id,
        page: anno.page,
        color: anno.color,
        link: built.link,
        body: anno.body,
      });
      this.noteLocations.set(anno.id, loc);
    } catch (err) {
      console.error("[pdf-annotator] 便签落盘失败", err);
      new Notice("便签没能写进笔记（磁盘错误），内容仍留在内存里");
    }
  }

  private async deleteNoteBlock(id: string): Promise<void> {
    const store = this.noteStore;
    const path = this.filePath;
    if (!store || !path) return;
    this.noteLocations.delete(id);
    try {
      await store.remove(path, id);
    } catch (err) {
      console.warn("[pdf-annotator] 删除便签块失败", err);
    }
  }

  /** 「在笔记中打开」：跳到伴生笔记里那条 Callout */
  private async openNoteBlock(anno: NoteAnnotation): Promise<void> {
    const path = this.filePath;
    if (!path) return;
    // 刚落盘过的位置最准；没落盘就现写一次
    if (!this.noteLocations.has(anno.id)) await this.persistNote(anno);
    const loc = this.noteLocations.get(anno.id);
    if (!loc) {
      new Notice("这条便签还没有写入笔记");
      return;
    }
    await openNoteAt(this.app, loc.path, loc.line, 0);
  }

  /* ================================================================ *
   * 快捷键
   * ================================================================ */

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.isActiveView()) return;

    const target = ev.target as HTMLElement | null;
    // 编辑器 / 输入框里的按键归输入框
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

    if (ev.key === "Escape") {
      this.tool.setActive("select");
      this.selectionToolbar.hide();
      this.colorPopover.close();
      this.contextMenu.close();
      this.noteEditor.close(true);
      this.hint.hide();
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
      ev.preventDefault();
      if (ev.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }

    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const map: Record<string, ToolId> = {
      v: "select",
      h: "highlight",
      u: "underline",
      r: "rect",
      a: "arrow",
      n: "note",
      p: "pencil",
      m: "marker",
    };
    const tool = map[ev.key.toLowerCase()];
    if (tool) {
      ev.preventDefault();
      this.tool.setActive(tool);
    }
  };

  private isActiveView(): boolean {
    return this.app.workspace.activeLeaf?.view === this;
  }

  /* ================================================================ *
   * 对外的动作（命令面板 / 测试用）
   * ================================================================ */

  /** 供阶段一自检命令使用：把当前选区换算成归一化坐标 */
  getSelectionAsNormRects(): Array<{ page: number; rects: Rect[] }> {
    return this.captureSelection()?.pages ?? [];
  }

  /**
   * 外部入口（命令 / Markdown 链接点击）：按链接文本跳到目标。
   * 返回 false 表示链接不是我们能处理的形式，调用方应回退到原生行为。
   */
  async navigateToLink(link: string): Promise<boolean> {
    const target = parsePdfLink(link);
    if (!target) return false;
    await this.navigateTo(target);
    return true;
  }

  /** 调试用：把归一化坐标再画回屏幕，肉眼确认是否贴合原文 */
  flashNormRects(items: Array<{ page: number; rects: Rect[] }>): void {
    for (const item of items) {
      this.pages.get(item.page)?.layer.flash(item.rects);
    }
  }

  /** 命令：删除当前页的所有批注 */
  clearCurrentPage(): void {
    const page = this.currentPageNumber();
    if (!page) {
      new Notice("找不到当前页");
      return;
    }
    this.store.clearPage(page);
    new Notice(`已清除第 ${page} 页的批注`);
  }

  clearAllAnnotations(): void {
    const count = this.store.count;
    this.store.clearAll();
    new Notice(`已清除 ${count} 条批注`);
  }

  private currentPageNumber(): number | null {
    const scrollerRect = this.scrollerEl.getBoundingClientRect();
    const probeY = scrollerRect.top + Math.min(80, scrollerRect.height / 2);
    const hit = this.pageAtClientPoint(scrollerRect.left + scrollerRect.width / 2, probeY);
    return hit?.n ?? null;
  }

  /** 命令：切到某个工具（阶段四接快捷键设置用） */
  setTool(tool: ToolId): void {
    this.tool.setActive(tool);
  }
}
