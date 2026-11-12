/**
 * main.ts —— 插件入口
 *
 * 阶段一：注册一个**补充式**视图（不接管 .pdf 打开行为）+ 坐标自检。
 * 阶段二：工具栏、绘制层、批注 Store。
 * 阶段三：Markdown 链接即存储 —— 解析、扫描、双向跳转、拖拽/复制。
 *
 * ── 一条设计红线（阶段三仍然守着）──────────────────────────────────
 * 不调用 registerExtensions(["pdf"], ...)：那会把系统级的 .pdf 打开方式抢过来。
 * 本插件是「按需打开的批注视图」，默认打开行为完全交给 Obsidian 原生查看器。
 * 但为了让 `[[x.pdf#page=3&selection=…]]` 能跳进本视图，我们需要在
 * **捕获阶段**拦下点击 —— 见 onInternalLinkClick。这是唯一"侵入"原生行为的地方，
 * 而且只对带 `page=` 的 PDF 链接生效，其余一律放行。
 */

import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PDF_VIEW_TYPE, PDFFileView } from "./view";
import { parsePdfLink } from "./link/format";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type PluginSettings } from "./ai/settings";
import { PdfAnnotatorSettingTab } from "./ai/settingsTab";
import { AI_TASKS } from "./ai/types";
import { repairedCopyPath, trailingJunkLength, trimTrailingJunk } from "./pdf/trailer";

export default class PdfAnnotatorPlugin extends Plugin {
  /** 全部设置（AI + 便签）；UI 层直接读，改完调 saveSettings() */
  settings: PluginSettings = DEFAULT_SETTINGS;

  /**
   * 最近编辑过的 Markdown 笔记路径。
   *
   * 为什么需要它：AI 弹窗是 Modal，打开后 activeLeaf 仍是 PDF 视图，
   * `getActiveViewOfType(MarkdownView)` 会返回 null —— 那样"插入到当前笔记"
   * 就永远插不进用户刚才在写的那篇。所以在这里记一手。
   */
  lastMarkdownPath: string | null = null;

  async onload(): Promise<void> {
    this.settings = await loadSettings(this);
    this.addSettingTab(new PdfAnnotatorSettingTab(this.app, this));

    /*
     * 记录最近活跃的 Markdown 笔记。
     * 只认 file 视图（MarkdownView），不看 leaf 类型 —— 同一种视图可以被
     * 用户在设置里换成别的编辑模式，但 file 一定在。
     */
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file) this.lastMarkdownPath = view.file.path;
      }),
    );
    // 启动时补一次：否则"刚打开 Obsidian 就点 AI"时还不知道当前笔记
    const initial = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (initial?.file) this.lastMarkdownPath = initial.file.path;

    /*
     * ★ registerView
     * 回调必须每次返回一个**新的**视图实例 —— Obsidian 会在分屏、
     * 拖拽到新窗口时对同一个 viewType 多次调用它。
     * 绝不能复用一个单例，否则两个 pane 会互相抢 DOM。
     */
    this.registerView(PDF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new PDFFileView(leaf, this));

    /* 功能区图标：把当前选中的 PDF 用批注视图打开 */
    this.addRibbonIcon("file-text", "在批注视图中打开 PDF", () => {
      void this.openActivePdf();
    });

    /*
     * ── 为什么这里的命令都用 callback 而不是 checkCallback ─────────────
     * Obsidian 的规则：checkCallback 返回 false 的命令**不会出现在命令面板**。
     * 最初 9 条命令全用 checkCallback（条件是"当前有 PDF 批注视图"），
     * 结果是没打开 PDF 时在命令面板搜插件名一片空白 —— 用户以为插件没装上。
     * 所以改成常驻可见，条件不满足时给一句能照着做的 Notice，
     * 让"插件到底有没有加载"这件事在面板里直接可见。
     */

    /* 命令 1：打开当前 PDF（唯一的常驻入口，也是加载成功的活证据） */
    this.addCommand({
      id: "open-in-annotator-view",
      name: "用批注视图打开当前 PDF",
      callback: () => {
        void this.openActivePdf();
      },
    });

    /* 命令 2：复制链接（阶段三的主命令，对应 PDF++ 的 Copy link to selection） */
    this.addCommand({
      id: "copy-selection-link",
      name: "复制选中文字的 PDF 链接",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "C" }],
      callback: () => {
        const view = this.requirePdfView();
        if (view) void view.copySelectionLink(false);
      },
    });

    /* 命令 3：复制成 Callout（带引用原文，适合做阅读笔记） */
    this.addCommand({
      id: "copy-selection-callout",
      name: "复制选中文字为 PDF Callout",
      callback: () => {
        const view = this.requirePdfView();
        if (view) void view.copySelectionLink(true);
      },
    });

    /* 命令 4：反向链接面板 */
    this.addCommand({
      id: "toggle-backlinks-panel",
      name: "显示 / 隐藏反向链接面板",
      callback: () => {
        const view = this.requirePdfView();
        if (view) view.toggleBacklinkPanel();
      },
    });

    /* 命令 5：坐标自检（阶段一验收用，之后只是调试工具） */
    this.addCommand({
      id: "debug-selection-coords",
      name: "调试：打印当前选区的归一化坐标",
      callback: () => {
        const view = this.requirePdfView();
        if (view) this.dumpSelection(view);
      },
    });

    /* 命令 6 / 7：清空内存里的草稿批注（真正的高亮在笔记里，删链接即可） */
    this.addCommand({
      id: "clear-page-annotations",
      name: "清除当前页的草稿批注",
      callback: () => {
        const view = this.requirePdfView();
        if (view) view.clearCurrentPage();
      },
    });

    this.addCommand({
      id: "clear-all-annotations",
      name: "清除本文档的全部草稿批注",
      callback: () => {
        const view = this.requirePdfView();
        if (view) view.clearAllAnnotations();
      },
    });

    /* 命令 8：排查用 —— 一眼确认插件加载了没有、加载的是哪个版本 */
    this.addCommand({
      id: "show-status",
      name: "显示插件状态（排查用）",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        const lines = [
          `PDF View for Obsidian v${this.manifest.version}`,
          `当前库：${this.app.vault.getName()}`,
          `批注视图：${view ? "已打开" : "未打开"}`,
          `接管 .pdf：${this.settings.openPdfInPlugin ? "开" : "关"}`,
          ...this.describeStyles(),
        ];
        new Notice(lines.join("\n"), 8000);
        console.info("[PDF View]", lines.join(" | "));
      },
    });

    /*
     * PDF 尾部垃圾诊断（知网/万方常见）。
     *
     * 为什么值得单独一条命令：这类文件的"病"在文件本身，不在插件。
     * 用户看到的是"原生查看器空白 + 0/0"，但 Edge / 新版 pdf.js 打开同一个文件却正常，
     * 于是所有排查都指向"插件坏了"。这条命令一次给出结论，并且直接产出可用的副本。
     */
    this.addCommand({
      id: "repair-pdf-trailer",
      name: "诊断 PDF 尾部垃圾并生成修复版",
      callback: () => void this.repairPdfTrailer(),
    });

    /*
     * 命令：关掉侧栏里误开的 PDF 标签
     *
     * 有些版本的侧栏标签条把关闭 × 压在了窗口按钮下面（看起来"关不了"），
     * 而侧栏里多一个 PDF 标签会把文件浏览器顶到后台 —— 图标就"跑到上面去了"。
     * 给一个明确的出口，比让用户去猜右键菜单可靠。
     */
    this.addCommand({
      id: "close-sidebar-pdf-tabs",
      name: "关掉侧栏里误开的 PDF 标签",
      callback: () => this.closeSidebarPdfLeaves(false),
    });

    /*
     * 命令：全屏阅读（收起两侧边栏）
     *
     * 侧栏的折叠按钮在自定义标题栏下常被窗口按钮压住，用户"关不掉右边那一栏"，
     * 于是 PDF 永远只占中间一条 —— 看起来就是"只能分屏"。给一个命令做同一件事。
     */
    this.addCommand({
      id: "toggle-focus-mode",
      name: "全屏阅读：收起 / 展开两侧边栏",
      callback: () => this.requirePdfView()?.toggleFocusMode(),
    });

    /*
     * ★ 拦截 Markdown 里的 PDF 链接点击
     *
     * 必须在**捕获阶段**：Obsidian 自己的 click 处理挂在编辑器/预览的冒泡链上，
     * 等冒泡到 document 时它已经把 PDF 用原生查看器打开了。
     * 捕获阶段先拿到事件，preventDefault + stopPropagation 才拦得住。
     */
    this.registerDomEvent(document, "click", this.onInternalLinkClick, true);

    /*
     * ── AI 伴读（阶段四）──
     * 三条独立命令而不是一条带参数的：Obsidian 命令没有参数，
     * 拆成三条才能各自绑快捷键（翻译设 Ctrl+Alt+T 这类肌肉记忆很自然）。
     */
    for (const task of AI_TASKS) {
      this.addCommand({
        id: `ai-${task.id}`,
        name: `AI ${task.label}选中文字`,
        callback: () => {
          const view = this.requirePdfView();
          if (view) void view.runAiTask(task.id);
        },
      });
    }

    /*
     * 默认**不**调用 registerExtensions(["pdf"], PDF_VIEW_TYPE)
     * 见文件头注释：那等于替换原生查看器，违背本项目第一原则。
     *
     * 唯一的例外是用户在设置里显式勾选「接管 .pdf 打开方式」。理由是真实
     * 场景里遇到过原生查看器读不了的 PDF（只有空白页、页码 0/0），这时若
     * 不给出口，用户就只能把文件拖到别的软件里看 —— 那是插件的失职。
     * 开关默认关，且随时能关回去（改完需重启 Obsidian）。
     *
     * 两条路一起走，因为 registerExtensions 对 "pdf" 这种内置类型不保证生效：
     * ① 注册默认视图 —— 有的版本/主题下会被核心插件盖掉；
     * ② 监听 file-open 兜底 —— 发现当前 leaf 打开的是原生 PDF 视图，
     *    就地把它 setViewState 成我们的视图（同一个 leaf，不会多开标签）。
     */
    if (this.settings.openPdfInPlugin) {
      try {
        this.registerExtensions(["pdf"], PDF_VIEW_TYPE);
      } catch (err) {
        console.warn("[PDF View] registerExtensions 失败，改用 file-open 兜底", err);
      }
      this.registerEvent(this.app.workspace.on("file-open", (file) => this.maybeRedirectPdf(file)));
    }

    /*
     * 开机自愈：清理"侧栏里重复打开的同一份 PDF"。
     *
     * 只清重复项 —— 用户真的想把某个 PDF 钉在侧栏里是合理需求，
     * 那种情况主区域没有同一个文件，这里不会动它。
     */
    this.app.workspace.onLayoutReady(() => this.closeSidebarPdfLeaves(true));

    // 一行日志：出问题时让用户能在控制台（Ctrl+Shift+I）确认到底加载了没有
    console.info(`[PDF View] v${this.manifest.version} loaded · vault=${this.app.vault.getName()}`);
  }

  /** 重定向冷却到什么时候（毫秒时间戳），防止 setViewState 再触发 file-open 形成回环 */
  private redirectUntil = 0;

  /**
   * 接管 .pdf 的兜底：把"刚被原生查看器打开"的 leaf 就地换成批注视图。
   *
   * 为什么不用 `registerExtensions` 一条路走到底：Obsidian 对 pdf 这类内置
   * 扩展名有核心视图，插件的注册可能被覆盖（实测 1.15 上就没生效），而
   * `setViewState` 是确定有效的。
   */
  private maybeRedirectPdf(file: TFile | null): void {
    if (!this.settings.openPdfInPlugin) return;
    if (!file || !(file instanceof TFile) || file.extension !== "pdf") return;
    if (Date.now() < this.redirectUntil) return;

    /*
     * 找"真正在显示这个 PDF 的那个 leaf"，而不是 activeLeaf。
     *
     * 0.8.0 的写法是拿 activeLeaf 直接 setViewState，结果踩了两个坑：
     *   ① 用户点文件列表时焦点在侧栏，activeLeaf 是侧栏的叶子 ——
     *      PDF 被塞进侧栏，文件浏览器被顶到后台标签（"文件夹图标跑上面去了"）；
     *   ② 侧栏里堆出关不掉的 PDF 标签（侧栏标签条的 × 常被窗口按钮压住）。
     * 现在只认主区域里正在显示该文件的 leaf；找不到就新开一个主区域标签。
     */
    const leaf = this.findPdfLeafFor(file.path) ?? this.mainAreaLeaf();
    if (!leaf) return;
    // 已经是我们的视图（或用户手动切过来的），不动
    if (leaf.view.getViewType() === PDF_VIEW_TYPE) return;

    this.redirectUntil = Date.now() + 1000;
    void this.openPdf(file, leaf).catch((err) => {
      console.error("[PDF View] 切换到批注视图失败", err);
      new Notice("切换到批注视图失败，已保留原生查看器。详情见控制台（Ctrl+Shift+I）。");
    });
  }

  /* ------------------------------------------------------------------ *
   * 侧栏保护
   * ------------------------------------------------------------------ */

  /** 这个 leaf 是不是待在左右侧栏里（而不是主编辑区） */
  private isInSidebar(leaf: WorkspaceLeaf): boolean {
    const root = (leaf as unknown as { getRoot?: () => unknown }).getRoot?.();
    if (!root) return false;
    const ws = this.app.workspace;
    return root === ws.leftSplit || root === ws.rightSplit;
  }

  /** leaf 当前显示的文件路径（拿不到就是空串） */
  private filePathOf(leaf: WorkspaceLeaf): string {
    const state = leaf.getViewState().state as { file?: unknown } | null;
    return typeof state?.file === "string" ? state.file : "";
  }

  /** 主区域里正在显示这个 PDF 的 leaf（侧栏一律不算） */
  private findPdfLeafFor(path: string): WorkspaceLeaf | null {
    for (const type of ["pdf", PDF_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (this.isInSidebar(leaf)) continue;
        if (this.filePathOf(leaf) === path) return leaf;
      }
    }
    return null;
  }

  /** 打开 PDF 时该落在哪个 leaf：焦点在侧栏上就另开一个主区域标签 */
  private mainAreaLeaf(): WorkspaceLeaf | null {
    const active = this.app.workspace.activeLeaf;
    if (active && !this.isInSidebar(active)) return active;
    return this.app.workspace.getLeaf("tab");
  }

  /**
   * 关掉侧栏里的 PDF 标签。
   *
   * @param onlyDuplicates true = 只关"主区域已经打开了同一份"的（开机自愈用，
   *   免得把用户特意钉在侧栏里的那份也关掉）；false = 全关（命令面板手动触发）。
   */
  private closeSidebarPdfLeaves(onlyDuplicates: boolean): void {
    const ws = this.app.workspace;
    const types = ["pdf", PDF_VIEW_TYPE];

    // 先记下主区域有哪些 PDF —— 迭代中 detach 会改动工作区，必须先取快照
    const inMain = new Set<string>();
    for (const type of types) {
      for (const leaf of ws.getLeavesOfType(type)) {
        if (this.isInSidebar(leaf)) continue;
        const path = this.filePathOf(leaf);
        if (path) inMain.add(path);
      }
    }

    const doomed: WorkspaceLeaf[] = [];
    for (const type of types) {
      for (const leaf of ws.getLeavesOfType(type)) {
        if (!this.isInSidebar(leaf)) continue;
        const path = this.filePathOf(leaf);
        if (onlyDuplicates && (!path || !inMain.has(path))) continue;
        doomed.push(leaf);
      }
    }

    for (const leaf of doomed) leaf.detach();

    if (doomed.length > 0) {
      new Notice(`已关掉侧栏里 ${doomed.length} 个 PDF 标签（文件本身没动）`, 4000);
    } else if (!onlyDuplicates) {
      new Notice("侧栏里没有 PDF 标签，不用清理", 3000);
    }
  }

  /**
   * 命令的公共前置检查。
   *
   * 命令常驻可见后，就必须替用户兜住"条件不满足"的情况：
   * 给一句能照着做的提示（去哪、点什么），而不是静默什么都不发生。
   */
  private requirePdfView(): PDFFileView | null {
    const view = this.app.workspace.getActiveViewOfType(PDFFileView);
    if (!view) {
      new Notice("请先用批注视图打开一个 PDF：选中 PDF → 命令面板搜「用批注视图打开当前 PDF」");
      return null;
    }
    return view;
  }

  /** 统一的保存入口：所有 UI 改完设置都调它 */
  async saveSettings(): Promise<void> {
    await saveSettings(this, this.settings);
  }

  onunload(): void {
    // 卸载插件时清掉残留视图，避免留下无法交互的空壳 pane
    this.app.workspace.detachLeavesOfType(PDF_VIEW_TYPE);
  }

  /* ------------------------------------------------------------------ */

  /**
   * 自检样式是否真的生效。
   *
   * 起因：有过一次「工具栏竖着堆成一列」的现场，排查发现是插件的 styles.css
   * 根本没被加载（页面完全用 Obsidian 默认样式）。这种事在界面上很难自证，
   * 于是把「样式表在不在 → 容器算出来的 display 是什么」直接打到弹窗里。
   */
  private describeStyles(): string[] {
    const loaded = Array.from(document.styleSheets).some((sheet) => {
      const href = sheet.href ?? "";
      return href.includes("pdf-annotator") || href.includes(this.manifest.id);
    });

    const shell = document.querySelector(".pdfa-shell");
    if (!shell) {
      return [`样式表：${loaded ? "已加载" : "未加载"}`, "布局壳：当前无（先打开一次批注视图再看）"];
    }

    const cs = getComputedStyle(shell);
    const bar = shell.querySelector<HTMLElement>(".pdfa-toolbar");
    const barInfo = bar
      ? (() => {
          const b = getComputedStyle(bar);
          return `${b.display} / ${b.flexDirection} / 宽 ${Math.round(bar.getBoundingClientRect().width)}px`;
        })()
      : "无";
    return [
      `样式表：${loaded ? "已加载" : "未加载"}`,
      `布局壳 display：${cs.display} / ${cs.flexDirection}`,
      `工具栏 display：${barInfo}`,
    ];
  }

  private getActivePdfFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension.toLowerCase() === "pdf" ? file : null;
  }

  /**
   * 诊断当前 PDF 的尾部垃圾，命中就生成一份修复版副本。
   *
   * 只写副本、绝不改原文件：用户的论文不该被插件动过。
   * 副本名带（修复版），重名自动加序号。
   */
  private async repairPdfTrailer(): Promise<void> {
    const file = this.getActivePdfFile();
    if (!file) {
      new Notice("请先在文件列表中选中一个 PDF（或先把它打开）");
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await this.app.vault.readBinary(file));
    } catch (err) {
      console.error("[PDF View] 读取 PDF 失败", err);
      new Notice("读取 PDF 失败，详见控制台（Ctrl+Shift+I）");
      return;
    }

    const junk = trailingJunkLength(bytes);
    if (junk < 0) {
      new Notice(`这个文件里找不到 %%EOF 标记，可能不是 PDF 或已损坏：\n${file.path}`, 8000);
      return;
    }
    if (junk === 0) {
      new Notice(
        "尾部是干净的（没有多余元数据），问题不在文件尾。\n" +
          "另外两个常见原因：① 文件还没下载/复制完（字节数明显偏小）；② 把 .caj / .nh 改名成了 .pdf",
        9000,
      );
      return;
    }

    const fixed = trimTrailingJunk(bytes);
    if (!fixed) {
      new Notice("没有可裁剪的内容");
      return;
    }

    const target = repairedCopyPath(file.path, (p) => this.app.vault.getAbstractFileByPath(p) !== null);
    try {
      const buf = fixed.buffer.slice(fixed.byteOffset, fixed.byteOffset + fixed.byteLength) as ArrayBuffer;
      await this.app.vault.createBinary(target, buf);
    } catch (err) {
      console.error("[PDF View] 写入修复版失败", err);
      new Notice("写入修复版失败，详见控制台（Ctrl+Shift+I）");
      return;
    }

    const before = (bytes.length / 1024).toFixed(0);
    const after = (fixed.length / 1024).toFixed(0);
    new Notice(
      `已生成修复版：${target}\n` +
        `去掉了 %%EOF 之后的 ${junk} 字节（${before} KB → ${after} KB）\n` +
        "用这份副本替代原文件后，Obsidian 内置查看器就能正常打开",
      12000,
    );
    console.info(`[PDF View] 尾部垃圾 ${junk} 字节 → 已生成 ${target}`);
  }

  private async openActivePdf(): Promise<void> {
    const file = this.getActivePdfFile();
    if (!file) {
      new Notice("请先在文件列表中选中一个 PDF 文件");
      return;
    }
    await this.openPdf(file);
  }

  /**
   * 在标签页中打开批注视图。
   *
   * @param link 可选的子路径链接（`x.pdf#page=3&selection=…`）。
   *   注意：已经打开同一个 PDF 时**不重建视图**（那会重新解析整个 PDF），
   *   而是让现有视图滚动过去。
   */
  async openPdf(file: TFile, leaf?: WorkspaceLeaf, link?: string): Promise<void> {
    if (link && !leaf) {
      const existing = this.findOpenPdfView(file.path);
      if (existing) {
        this.app.workspace.setActiveLeaf(existing.leaf, { focus: true });
        await existing.view.navigateToLink(link);
        return;
      }
    }

    // 侧栏 leaf 不接受：那里是文件浏览器/搜索的地盘，塞 PDF 进去会顶掉用户的布局
    const target = leaf && !this.isInSidebar(leaf) ? leaf : this.app.workspace.getLeaf("tab");
    await target.setViewState({
      type: PDF_VIEW_TYPE,
      state: link ? { file: file.path, link } : { file: file.path },
      active: true,
    });
  }

  private findOpenPdfView(path: string): { leaf: WorkspaceLeaf; view: PDFFileView } | null {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof PDFFileView)) continue;
      const state = leaf.getViewState().state as { file?: unknown } | null;
      if (state?.file === path) return { leaf, view };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 链接点击拦截
   * ------------------------------------------------------------------ */

  private readonly onInternalLinkClick = (ev: MouseEvent): void => {
    if (ev.defaultPrevented || ev.button !== 0) return;

    const anchor = (ev.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
    if (!href || !/\.pdf(#|$)/i.test(href)) return;

    const target = parsePdfLink(href);
    // 没有 page= 的链接（只是"打开这个 PDF"）交回 Obsidian：
    // 用户装这个插件不是为了让所有 PDF 都从批注视图打开
    if (!target) return;

    const sourcePath =
      (anchor.closest("[data-path]") as HTMLElement | null)?.getAttribute("data-path") ??
      this.app.workspace.getActiveFile()?.path ??
      "";
    const file = this.app.metadataCache.getFirstLinkpathDest(target.linkpath, sourcePath);
    if (!(file instanceof TFile)) return;

    ev.preventDefault();
    ev.stopPropagation();
    // Ctrl/Cmd 点 = 新标签页打开；普通点击 = 复用已经打开的那个
    void this.openPdf(file, ev.ctrlKey || ev.metaKey ? this.app.workspace.getLeaf("tab") : undefined, href);
  };

  private dumpSelection(view: PDFFileView): void {
    const items = view.getSelectionAsNormRects();
    if (items.length === 0) {
      new Notice("没有选中任何文本（或该页尚未完成渲染）");
      return;
    }
    view.flashNormRects(items);
    console.log("[pdf-annotator] 选区归一化坐标", items);
    const count = items.reduce((acc, it) => acc + it.rects.length, 0);
    new Notice(`已捕获 ${items.length} 页 / ${count} 个矩形，详见控制台`);
  }
}
