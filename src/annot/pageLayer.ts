/**
 * pageLayer.ts —— 每页一个 SVG 绘制层
 *
 * ── 为什么是 SVG 而不是 canvas ──────────────────────────────────────
 * canvas 要自己管重绘、管命中、管"选择性擦除"；批注是**稀疏、可编辑、可命中**
 * 的对象，SVG 天然支持：一个批注 = 一个节点，改颜色只改属性，删除只 remove()。
 * 手绘在 canvas 上更顺手，但一支笔的实时重绘只有几百个点，SVG 每帧重建路径
 * 也稳在 60fps 以内 —— 可编辑性比那 2ms 更值钱。
 *
 * ── 关键设计：viewBox = 页面 pt 尺寸 ─────────────────────────────────
 *   <svg viewBox="0 0 595 842" style="width:100%;height:100%">
 * 于是 **SVG 用户单位 ≡ PDF pt ≡ BASE 空间**，坐标不用换算就能直接写进属性，
 * 缩放时浏览器自己把整层等比放大，批注零重算。
 * 唯一例外是便签图钉：它是 UI 控件，视觉尺寸应当恒定，所以半径要除以 scale。
 *
 * ── 事件与穿透 ──────────────────────────────────────────────────────
 *   · 默认整层 pointer-events: none —— 否则会盖住 TextLayer，文本选不中；
 *   · 只有"拖拽类工具"激活时临时改 auto（.is-drawing），此时才吃指针；
 *   · 便签点击、右键删除不用 DOM 命中，改用**几何命中检测**挂在页面容器上，
 *     这样即使整层 pointer-events: none，也照样能点到图钉。
 */

import type { PageGeometry, Rect } from "../coords";
import type {
  Annotation,
  BacklinkMark,
  InkAnnotation,
  InkMode,
  NoteAnnotation,
  Point,
  ShapeAnnotation,
  ToolId,
} from "./types";
import { ANNOT_DEFAULTS, NOTE_PIN_RADIUS, createAnnotationId } from "./types";
import { TOOL_META, ToolState } from "./toolState";
import { StrokeBuilder, renderSamples } from "./ink";
import { arrowGeometry, boxFromPoints, clampPoint, distanceToSegment, fmt, pointInBox } from "./geometry";
import { svgEl } from "../dom";
import { attachPointer, capturePointer, type PointerSample } from "../ui/pointer";
import { isLightColor } from "./palettes";
import { annotationRects } from "./commentTarget";

export interface PageLayerHooks {
  /** 拖拽绘制完成，交给上层入 store */
  onCreate(anno: Annotation): void;
  /** 便签工具单击落点（由上层创建 NoteAnnotation 并立即打开编辑器） */
  onPlaceNote(at: Point): void;
  /** 点中已有便签 */
  onOpenNote(anno: NoteAnnotation): void;
  /**
   * 单击（不是拖选、不是右键）某条批注 → 上层弹出「添加评论」气泡。
   * 这是"先画标记、再点它写评论"的主路径，见 commentTarget.ts 的说明。
   */
  onMarkTap?(anno: Annotation, pos: ClientPos): void;
  /** Ctrl/⌘ 点图钉：跳到伴生笔记里那条 Callout（= 图钉的锚点链接） */
  onOpenNoteAnchor?(anno: NoteAnnotation): void;
  /** 右键 / 长按点中某条批注 */
  onContextMenu(anno: Annotation, pos: ClientPos): void;
  /** 双击 / Ctrl+点击 / 双击 tap 回链高亮：跳回源笔记 */
  onBacklinkActivate?(mark: BacklinkMark, pos: ClientPos): void;
  /** 指针在回链高亮上移动（用于显示"双击跳转"提示）；移出传 null */
  onBacklinkHover?(mark: BacklinkMark | null, pos: ClientPos | null): void;
  /**
   * Alt + 按下某条批注 → 开始"拖出链接"。
   * 用 Alt 是因为普通拖拽已经被"选中文字"占用，不能抢。
   */
  onDragStart?(anno: Annotation, pos: ClientPos): void;
}

/**
 * 只需要屏幕坐标的"位置"对象。
 * 刻意不用 PointerEvent/MouseEvent：移动端的长按菜单是**合成**出来的，
 * 根本没有对应的原生事件；把契约收窄到 `{clientX, clientY}` 才能两边通用。
 */
export interface ClientPos {
  clientX: number;
  clientY: number;
}

type Draft =
  | {
      kind: "shape";
      tool: "rect" | "arrow";
      from: Point;
      to: Point;
      color: string;
      width: number;
      node: SVGGElement;
    }
  | {
      kind: "ink";
      mode: InkMode;
      color: string;
      opacity: number;
      builder: StrokeBuilder;
      node: SVGPathElement;
    };

/** 命中检测的宽容度（CSS px）：手指/触控板都不够精确，给 6px 余量 */
const HIT_SLOP = 6;
/** 小于这个尺寸的拖拽当作误触（只点了一下） */
const MIN_SHAPE_SIZE = 2.5;
/**
 * "点一下"与"拖选文字"的分界（CSS px）。
 * 松手时位移超过它就算拖拽 —— 拖选完不该再弹评论气泡。
 */
const TAP_SLOP = 4;

export class PageLayer {
  readonly svg: SVGSVGElement;

  /** 回链高亮层：在所有批注**之下**（真身是笔记里的链接，视觉上应当是底纹） */
  private readonly blGroup: SVGGElement;
  private readonly committed: SVGGElement;
  private readonly draftLayer: SVGGElement;
  private readonly debugLayer: SVGGElement;

  private geo: PageGeometry;
  private annos: Annotation[] = [];
  private nodes = new Map<string, SVGGElement>();
  /** 已渲染版本号：只重建真正变过的批注，避免一次改动重画整页 */
  private signatures = new Map<string, string>();
  private noteIds = new Set<string>();

  private backlinks: BacklinkMark[] = [];
  private blNodes = new Map<string, SVGGElement>();
  private blSigs = new Map<string, string>();
  private hoverKey: string | null = null;

  private draft: Draft | null = null;
  private rafId = 0;
  private destroyed = false;
  /** 指针适配层的解绑函数（svg 与宿主各一个） */
  private detachers: Array<() => void> = [];

  /**
   * 「点一下」的判定素材。
   * 不能用 dblclick / click 的 detail 判断，也不能只看 selection 是否为空：
   * 在文字上单击，浏览器同样会把光标放进文本层（选区是 collapsed 的）。
   * 唯一可靠的办法是自己记起点、自己量位移。
   */
  private tapStart: { x: number; y: number } | null = null;
  private tapMoved = false;
  /** 这次按下已经被图钉 / Ctrl 点锚点消费掉，click 不该再弹气泡 */
  private tapConsumed = false;

  constructor(
    private readonly host: HTMLElement,
    geo: PageGeometry,
    private readonly tool: ToolState,
    private readonly hooks: PageLayerHooks,
  ) {
    this.geo = geo;

    this.svg = svgEl("svg", {
      class: "pdfa-draw-layer",
      // 坐标系即 pt；preserveAspectRatio=none 防止 ceil 造成的亚像素留白
      viewBox: `0 0 ${fmt(geo.baseWidth)} ${fmt(geo.baseHeight)}`,
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    });
    this.blGroup = svgEl("g", { class: "pdfa-layer-backlinks" }, this.svg);
    this.committed = svgEl("g", { class: "pdfa-layer-annots" }, this.svg);
    this.draftLayer = svgEl("g", { class: "pdfa-layer-draft" }, this.svg);
    this.debugLayer = svgEl("g", { class: "pdfa-layer-debug" }, this.svg);
    host.appendChild(this.svg);

    /*
     * ★ 事件全部走 pointer.ts 适配层，而不是直接 addEventListener("pointerdown")。
     * 差别在于适配层会额外提供：长按（移动端右键）、双击 tap（移动端双击跳转）、
     * 多指中止（双指缩放不该画出鬼线），以及没有 PointerEvent 时的 Touch 兜底。
     * 绘制层要 preventDefault：否则拖拽会变成"选中文字 / 页面滚动"。
     */
    this.detachers.push(
      attachPointer(
        this.svg,
        {
          onDown: this.onPointerDown,
          onMove: this.onPointerMove,
          onUp: this.onPointerUp,
          onCancel: this.onPointerCancel,
        },
        { preventDefaultOnDown: true },
      ),
    );

    // 便签与右键菜单：挂在容器上做几何命中（SVG 整层可能是 pointer-events: none）
    this.detachers.push(
      attachPointer(
        this.host,
        {
          onDown: this.onHostPointerDown,
          onMove: this.onHostPointerMove,
          onUp: this.onHostTapUp,
          onLongPress: this.onHostLongPress,
          onDoubleTap: this.onHostDoubleTap,
        },
        // 宿主层的 down 不能 preventDefault：那会把"拖选文字"杀掉
        { preventDefaultOnDown: false },
      ),
    );

    host.addEventListener("pointerleave", this.onHostPointerLeave);
    host.addEventListener("dblclick", this.onHostDoubleClick);
    host.addEventListener("contextmenu", this.onContextMenu);
    host.addEventListener("click", this.onHostClick);

    this.syncToolClass();
  }

  /* ================================================================ *
   * 外部接口
   * ================================================================ */

  setGeometry(geo: PageGeometry): void {
    const scaleChanged = Math.abs(geo.scale - this.geo.scale) > 1e-6;
    this.geo = geo;
    this.svg.setAttribute("viewBox", `0 0 ${fmt(geo.baseWidth)} ${fmt(geo.baseHeight)}`);
    if (scaleChanged) this.rebuildNotePins();
  }

  setAnnotations(list: Annotation[]): void {
    this.annos = list;
    const alive = new Set<string>();

    for (const a of list) {
      alive.add(a.id);
      const sig = this.signature(a);
      if (this.signatures.get(a.id) !== sig) {
        this.nodes.get(a.id)?.remove();
        const node = this.buildNode(a);
        this.committed.appendChild(node);
        this.nodes.set(a.id, node);
        this.signatures.set(a.id, sig);
        if (a.kind === "note") this.noteIds.add(a.id);
        else this.noteIds.delete(a.id);
      } else {
        const node = this.nodes.get(a.id);
        // 保持 DOM 顺序 = 绘制顺序，后创建的在上面
        if (node) this.committed.appendChild(node);
      }
    }

    for (const [id, node] of Array.from(this.nodes)) {
      if (alive.has(id)) continue;
      node.remove();
      this.nodes.delete(id);
      this.signatures.delete(id);
      this.noteIds.delete(id);
    }
  }

  /**
   * 让某条批注闪一下（点卡片时用）。
   * 只是加一个 class 再摘掉，不进签名、不重建节点 —— 闪烁不该被当成内容变化。
   */
  flashAnnotation(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.classList.add("is-flash");
    window.setTimeout(() => node.classList.remove("is-flash"), 900);
  }

  /** 工具切换时由上层调用：决定这一层是否吃指针 */
  refreshTool(): void {
    this.syncToolClass();
    // 切走工具时把画了一半的东西收掉，避免残留半截线
    if (TOOL_META[this.tool.active].interaction !== "drag") this.cancelDraft();
  }

  /* ---------------------------------------------------------------- *
   * 回链高亮（只读投影）
   * ---------------------------------------------------------------- */

  /**
   * 覆盖本页的回链高亮。
   *
   * 和 setAnnotations 一样做增量：扫描结果是「全量替换」，但页面上通常只有几条
   * 变了。全量重建会让 hover 状态、CSS transition 全部重置，视觉上闪一下。
   */
  setBacklinks(marks: BacklinkMark[]): void {
    this.backlinks = marks;
    const alive = new Set<string>();

    for (const mark of marks) {
      alive.add(mark.key);
      const sig = `${mark.color}|${mark.opacity}|${mark.rects.length}|${mark.rects
        .map((r) => `${r.x.toFixed(4)},${r.y.toFixed(4)},${r.w.toFixed(4)},${r.h.toFixed(4)}`)
        .join(";")}`;
      if (this.blSigs.get(mark.key) === sig) {
        // 顺序也要保持一致，否则重叠的高亮谁压谁不确定
        const node = this.blNodes.get(mark.key);
        if (node) this.blGroup.appendChild(node);
        continue;
      }
      this.blNodes.get(mark.key)?.remove();
      const node = this.buildBacklinkNode(mark);
      this.blGroup.appendChild(node);
      this.blNodes.set(mark.key, node);
      this.blSigs.set(mark.key, sig);
    }

    for (const [key, node] of Array.from(this.blNodes)) {
      if (alive.has(key)) continue;
      node.remove();
      this.blNodes.delete(key);
      this.blSigs.delete(key);
    }

    if (this.hoverKey && !alive.has(this.hoverKey)) this.hoverKey = null;
    this.applyHoverClass();
  }

  /** 回链的几何命中（整层 pointer-events: none，只能靠算） */
  hitTestBacklink(bx: number, by: number): BacklinkMark | null {
    const { baseWidth: bw, baseHeight: bh } = this.geo;
    for (let i = this.backlinks.length - 1; i >= 0; i--) {
      const mark = this.backlinks[i];
      for (const r of mark.rects) {
        if (pointInBox(bx, by, { x: r.x * bw, y: r.y * bh, w: r.w * bw, h: r.h * bh })) return mark;
      }
    }
    return null;
  }

  /** 面板 hover 联动：让页面上对应的那块高亮亮起来 */
  setHoverBacklink(key: string | null): void {
    if (this.hoverKey === key) return;
    this.hoverKey = key;
    this.applyHoverClass();
  }

  private applyHoverClass(): void {
    for (const [key, node] of this.blNodes) {
      node.classList.toggle("is-hover", key === this.hoverKey);
    }
  }

  private buildBacklinkNode(mark: BacklinkMark): SVGGElement {
    const g = svgEl("g", { class: "pdfa-backlink", "data-backlink-key": mark.key });
    const { baseWidth: bw, baseHeight: bh } = this.geo;
    for (const r of mark.rects) {
      svgEl(
        "rect",
        {
          x: fmt(r.x * bw),
          y: fmt(r.y * bh),
          width: fmt(r.w * bw),
          height: fmt(r.h * bh),
          rx: 1.2,
          fill: mark.color,
          "fill-opacity": fmt(mark.opacity),
        },
        g,
      );
    }
    return g;
  }

  /** 阶段一的坐标自检：把**归一化**矩形闪一下（内部换算成 pt） */
  flash(rects: Rect[]): void {
    const { baseWidth, baseHeight } = this.geo;
    for (const r of rects) {
      const node = svgEl(
        "rect",
        {
          class: "pdfa-debug-rect",
          x: r.x * baseWidth,
          y: r.y * baseHeight,
          width: r.w * baseWidth,
          height: r.h * baseHeight,
        },
        this.debugLayer,
      );
      window.setTimeout(() => node.remove(), 1800);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    for (const off of this.detachers) off();
    this.detachers = [];
    this.host.removeEventListener("pointerleave", this.onHostPointerLeave);
    this.host.removeEventListener("dblclick", this.onHostDoubleClick);
    this.host.removeEventListener("contextmenu", this.onContextMenu);
    this.host.removeEventListener("click", this.onHostClick);
    this.svg.remove();
    this.nodes.clear();
    this.signatures.clear();
    this.blNodes.clear();
    this.blSigs.clear();
    this.backlinks = [];
  }

  /* ================================================================ *
   * 命中检测（几何，不依赖 DOM）
   * ================================================================ */

  /**
   * 图钉的命中半径（BASE 空间）。
   * 图钉是"控件"，视觉尺寸恒定，所以半径要除以 scale。
   */
  private pinRadius(): number {
    return NOTE_PIN_RADIUS / (this.geo.scale || 1) + 3;
  }

  /**
   * 只命中图钉 —— 不含它底下的底纹。
   * 「点图钉 = 开富文本编辑器」与「点底纹 = 弹评论气泡」是两件事，
   * 混用一个 hitTest 会让点高亮中间也跳出编辑器。
   *
   * 带 rects 的批注没有图钉（buildNode 里不画），这里也必须跳过：
   * 否则它的锚点（首行右端）虽然看不见，却仍然会吃掉那一下点击，
   * 变成"点字弹出编辑器"。
   */
  hitPin(bx: number, by: number): NoteAnnotation | null {
    const { baseWidth, baseHeight } = this.geo;
    for (let i = this.annos.length - 1; i >= 0; i--) {
      const a = this.annos[i];
      if (a.kind !== "note") continue;
      if (a.rects && a.rects.length > 0) continue;
      const cx = a.at.x * baseWidth;
      const cy = a.at.y * baseHeight;
      if (Math.hypot(bx - cx, by - cy) <= this.pinRadius()) return a;
    }
    return null;
  }

  hitTest(bx: number, by: number): Annotation | null {
    const slop = HIT_SLOP / (this.geo.scale || 1);
    const { baseWidth, baseHeight } = this.geo;

    // 倒序：后画的盖在上面，先命中最上层
    for (let i = this.annos.length - 1; i >= 0; i--) {
      const a = this.annos[i];
      switch (a.kind) {
        case "note": {
          /*
           * 带底纹的批注（高亮 / 下划线 / 框选升级而来）整块都要能命中：
           * 用户想的是"点我画的那段字"，不是"精确点中那枚 20px 的图钉"。
           * 图钉仍然保留 —— 它是唯一一个点了直接开富文本编辑器的入口。
           */
          if (a.rects && a.rects.length > 0) {
            for (const r of a.rects) {
              const box = { x: r.x * baseWidth, y: r.y * baseHeight, w: r.w * baseWidth, h: r.h * baseHeight };
              if (pointInBox(bx, by, box)) return a;
            }
          }
          const cx = a.at.x * baseWidth;
          const cy = a.at.y * baseHeight;
          if (Math.hypot(bx - cx, by - cy) <= this.pinRadius()) return a;
          break;
        }
        case "highlight":
        case "underline": {
          for (const r of a.rects) {
            const box = { x: r.x * baseWidth, y: r.y * baseHeight, w: r.w * baseWidth, h: r.h * baseHeight };
            if (pointInBox(bx, by, box)) return a;
          }
          break;
        }
        case "rect": {
          const box = this.shapeBox(a);
          if (pointInBox(bx, by, box)) return a;
          break;
        }
        case "arrow": {
          const from = { x: a.from.x * baseWidth, y: a.from.y * baseHeight };
          const to = { x: a.to.x * baseWidth, y: a.to.y * baseHeight };
          if (distanceToSegment(bx, by, from.x, from.y, to.x, to.y) <= a.strokeWidth / 2 + slop * 2) return a;
          break;
        }
        case "ink": {
          const tol = slop * 2;
          for (let p = 1; p < a.points.length; p++) {
            const [x1, y1, w1] = a.points[p - 1];
            const [x2, y2, w2] = a.points[p];
            const d = distanceToSegment(
              bx,
              by,
              x1 * baseWidth,
              y1 * baseHeight,
              x2 * baseWidth,
              y2 * baseHeight,
            );
            if (d <= Math.max(w1, w2) / 2 + tol) return a;
          }
          break;
        }
      }
    }
    return null;
  }

  /* ================================================================ *
   * 指针：绘制
   * ================================================================ */

  private readonly onPointerDown = (ev: PointerSample): void => {
    if (this.destroyed || this.draft || ev.button !== 0) return;

    const tool = this.tool.active;
    const meta = TOOL_META[tool];
    if (meta.interaction !== "drag" && meta.interaction !== "click") return;

    const base = this.toBase(ev);
    // 必须拦住：否则拖动会触发原生图片/文本拖拽，笔迹断成几截
    ev.native.preventDefault();
    ev.native.stopPropagation();

    if (meta.interaction === "click") {
      this.hooks.onPlaceNote(this.toNorm(base));
      return;
    }

    // 捕获指针：手快速甩出页面边界时，move/up 仍然回到这里
    capturePointer(this.svg, ev);

    if (tool === "rect" || tool === "arrow") this.startShape(tool, base);
    else if (tool === "pencil" || tool === "marker") this.startInk(tool, base);
  };

  private readonly onPointerMove = (ev: PointerSample): void => {
    const draft = this.draft;
    if (!draft) return;
    ev.native.preventDefault();

    const base = this.toBase(ev);

    if (draft.kind === "shape") {
      draft.to = base;
      this.paintShape(draft);
      return;
    }

    // 手绘：抽稀后的真实入列才安排重绘，避免高频指针对 SVG 造成每帧多次写
    if (draft.builder.add(base.x, base.y, now())) {
      this.scheduleInkPaint();
    }
  };

  private readonly onPointerUp = (ev: PointerSample): void => {
    const draft = this.draft;
    if (!draft) return;
    ev.native.preventDefault();

    const base = clampPoint(this.toBase(ev), this.geo.baseWidth, this.geo.baseHeight);

    if (draft.kind === "shape") {
      draft.to = base;
      this.finishShape(draft);
      return;
    }

    // 补最后一个点：rAF 可能还没跑到，pointerup 的位置必须收进笔迹
    draft.builder.add(base.x, base.y, now());
    this.finishInk(draft);
  };

  private readonly onPointerCancel = (): void => {
    this.cancelDraft();
  };

  /* ------------------------------ 形状 ------------------------------ */

  private startShape(tool: "rect" | "arrow", base: Point): void {
    const color = this.tool.getColor("shape");
    const width = this.tool.getWidth("shape");
    const node = svgEl("g", { class: "pdfa-shape pdfa-draft-shape" }, this.draftLayer);
    const draft: Draft = { kind: "shape", tool, from: base, to: base, color, width, node };
    if (tool === "rect") svgEl("rect", { class: "pdfa-rect" }, node);
    else {
      svgEl("path", { class: "pdfa-arrow-line" }, node);
      svgEl("path", { class: "pdfa-arrow-head" }, node);
    }
    this.draft = draft;
    this.paintShape(draft);
  }

  private paintShape(draft: Extract<Draft, { kind: "shape" }>): void {
    const { from, to, color, width, node, tool } = draft;
    if (tool === "rect") {
      const box = boxFromPoints(from, to);
      const rect = node.firstElementChild as SVGRectElement | null;
      rect?.setAttribute("x", fmt(box.x));
      rect?.setAttribute("y", fmt(box.y));
      rect?.setAttribute("width", fmt(box.w));
      rect?.setAttribute("height", fmt(box.h));
      rect?.setAttribute("stroke", color);
      rect?.setAttribute("stroke-width", fmt(width));
      rect?.setAttribute("fill", "none");
      return;
    }

    const geo = arrowGeometry(from, to, Math.max(8, width * 5));
    const line = node.children[0] as SVGPathElement;
    const head = node.children[1] as SVGPathElement;
    line.setAttribute("d", geo.line);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", fmt(width));
    line.setAttribute("fill", "none");
    head.setAttribute("d", geo.head);
    head.setAttribute("fill", color);
  }

  private finishShape(draft: Extract<Draft, { kind: "shape" }>): void {
    draft.node.remove();
    this.draft = null;

    const { from, to, tool, color, width } = draft;
    const box = boxFromPoints(from, to);
    const length = Math.hypot(to.x - from.x, to.y - from.y);

    // 误触（单击/极短拖拽）不产生批注，否则页面上会堆满看不见的 1pt 垃圾
    const tooSmall = tool === "rect" ? box.w < MIN_SHAPE_SIZE && box.h < MIN_SHAPE_SIZE : length < MIN_SHAPE_SIZE;
    if (tooSmall) return;

    const anno: ShapeAnnotation = {
      id: createAnnotationId(),
      kind: tool,
      page: this.geo.pageNumber,
      color,
      strokeWidth: width,
      from: this.toNorm(from),
      to: this.toNorm(to),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.hooks.onCreate(anno);
  }

  /* ------------------------------ 手绘 ------------------------------ */

  private startInk(mode: InkMode, base: Point): void {
    const color = this.tool.getColor(mode === "marker" ? "marker" : "ink");
    const width = this.tool.getWidth(mode === "marker" ? "marker" : "pencil");
    const opacity = mode === "marker" ? ANNOT_DEFAULTS.markerOpacity : 1;

    const builder = new StrokeBuilder({
      width,
      mode,
      baseWidth: this.geo.baseWidth,
      baseHeight: this.geo.baseHeight,
    });
    builder.add(base.x, base.y, now());

    const node = svgEl("path", { class: `pdfa-ink pdfa-ink-${mode} pdfa-draft-ink` }, this.draftLayer);
    this.draft = { kind: "ink", mode, color, opacity, builder, node };
    this.paintInk();
  }

  private scheduleInkPaint(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.paintInk();
    });
  }

  private paintInk(): void {
    const draft = this.draft;
    if (!draft || draft.kind !== "ink") return;

    const render = renderSamples(draft.builder.baseSamples(), draft.mode);
    applyInkPaint(draft.node, render.d, render.filled, render.strokeWidth, draft.color, draft.opacity);
  }

  private finishInk(draft: Extract<Draft, { kind: "ink" }>): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.paintInk();
    draft.node.remove();
    this.draft = null;

    // 只有一个点 = 单击误触，不留墨点
    if (draft.builder.count < 2) return;

    const anno: InkAnnotation = {
      id: createAnnotationId(),
      kind: "ink",
      page: this.geo.pageNumber,
      color: draft.color,
      mode: draft.mode,
      points: draft.builder.toInkPoints(),
      width: this.tool.getWidth(draft.mode === "marker" ? "marker" : "pencil"),
      opacity: draft.opacity,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.hooks.onCreate(anno);
  }

  private cancelDraft(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (!this.draft) return;
    this.draft.node.remove();
    this.draft = null;
  }

  /* ================================================================ *
   * 便签 / 右键
   * ================================================================ */

  private readonly onHostPointerDown = (ev: PointerSample): void => {
    if (this.destroyed || ev.button !== 0) return;
    // 拖拽类工具激活时，指针事件由 SVG 自己接管
    if (TOOL_META[this.tool.active].interaction === "drag") return;
    if (this.tool.active !== "select") return;

    // 记录"这一次按下"的起点：松手时靠位移判断是点选还是拖选
    this.tapStart = { x: ev.clientX, y: ev.clientY };
    this.tapMoved = false;
    this.tapConsumed = false;

    const base = this.toBase(ev);

    /*
     * 触屏没有 Alt/Ctrl，所以移动端只做"点中图钉就开编辑器"这一件事；
     * 右键由长按提供（onHostLongPress），双击由双击 tap 提供（onHostDoubleTap）。
     * 桌面端保留 Alt+拖拽出链接、Ctrl+点击回链。
     */
    const touch = ev.pointerType !== "mouse";

    // Alt + 拖拽 = 把这条批注拖成链接（普通拖拽留给"选文字"）
    if (!touch && ev.altKey) {
      const anno = this.hitTest(base.x, base.y);
      if (anno) {
        ev.native.preventDefault();
        ev.native.stopPropagation();
        this.tapConsumed = true;
        this.hooks.onDragStart?.(anno, ev);
        return;
      }
    }

    // Ctrl/Cmd + 单击回链高亮 = 跳回源笔记（与"双击"等价的快捷方式）
    if (!touch && (ev.ctrlKey || ev.metaKey)) {
      const mark = this.hitTestBacklink(base.x, base.y);
      if (mark) {
        ev.native.preventDefault();
        ev.native.stopPropagation();
        this.tapConsumed = true;
        this.hooks.onBacklinkActivate?.(mark, ev);
        return;
      }
    }

    /*
     * 只认图钉本身，不认它底下那层底纹。
     * hitTest 现在也会命中带底纹批注的整块矩形（为了"点标记弹评论"），
     * 如果这里沿用 hitTest，点在高亮中间就会被当成"点中图钉" → 直接开富文本编辑器，
     * 文字也就选不中了。所以图钉单独算一次半径命中。
     */
    const pin = this.hitPin(base.x, base.y);
    if (!pin) return;

    // 点中图钉：拦住文本选择，直接开编辑器
    ev.native.preventDefault();
    ev.native.stopPropagation();
    // 这一次点击已经有归宿了（开编辑器 / 跳锚点），别再弹评论气泡
    this.tapConsumed = true;

    // Ctrl/⌘ 点 = 跳到笔记里那条 Callout（图钉等价于一条块引用链接）。
    // 单击开编辑器、Ctrl 点跳笔记，两个动作都保留：读的时候多半想改，写完多半想看上下文。
    if (!touch && (ev.ctrlKey || ev.metaKey)) {
      this.hooks.onOpenNoteAnchor?.(pin);
      return;
    }
    this.hooks.onOpenNote(pin);
  };

  /**
   * 悬停：给回链高亮一个"这里可以跳"的提示。
   * 必须自己算，因为整层 pointer-events: none，拿不到 mouseenter。
   * 触屏上这条基本不会触发（没有悬停态），所以里面的样式切换都是无害的。
   */
  private readonly onHostPointerMove = (ev: PointerSample): void => {
    if (this.destroyed) return;

    // Alt 按住时，指向任意批注都显示"可以拖走"的光标
    if (this.tool.active === "select" && ev.pointerType === "mouse") {
      const base = this.toBase(ev);
      const canDrag = ev.altKey && this.hitTest(base.x, base.y) !== null;
      this.host.classList.toggle("can-drag-link", canDrag);
    } else if (ev.pointerType === "mouse") {
      this.host.classList.remove("can-drag-link");
    }

    if (!this.hooks.onBacklinkHover) return;
    if (this.backlinks.length === 0) return;
    if (this.tool.active !== "select") {
      if (this.hoverKey) this.hooks.onBacklinkHover(null, null);
      return;
    }
    const base = this.toBase(ev);
    const mark = this.hitTestBacklink(base.x, base.y);
    this.hooks.onBacklinkHover(mark, mark ? ev : null);
  };

  /**
   * 触屏的"抬起"。
   * 单指轻点已经在 onHostPointerDown 里处理过了（点图钉开编辑器），
   * 这里负责两件事：松开时清掉 hover 态（否则点过的回链会一直带着描边），
   * 以及给"这次到底算不算拖拽"下结论 —— click 紧随其后，要用这个结论。
   */
  private readonly onHostTapUp = (ev: PointerSample): void => {
    if (this.destroyed) return;
    if (this.tapStart) {
      const dx = ev.clientX - this.tapStart.x;
      const dy = ev.clientY - this.tapStart.y;
      this.tapMoved = Math.hypot(dx, dy) > TAP_SLOP;
      this.tapStart = null;
    }
    if (ev.pointerType === "mouse") return;
    this.host.classList.remove("can-drag-link");
  };

  /**
   * 单击某条批注 → 让上层弹出「添加评论」气泡（WPS / Zotero 的那种）。
   *
   * 为什么非要等到 click、而不是在 pointerdown 里做：
   *   在 pointerdown 里弹，会把"从这条高亮上开始拖选文字"也当成点击，
   *   气泡一闪一闪，还会抢走拖拽起点。等到 click 且位移很小，才是真的点了一下。
   *
   * 三条排除：拖过（tapMoved）、这次按下已有归宿（tapConsumed，如点中图钉）、
   * 松手时确实选中了文字（拖选 / 三击选段）。
   */
  private readonly onHostClick = (ev: MouseEvent): void => {
    if (this.destroyed || !this.hooks.onMarkTap) return;
    if (this.tool.active !== "select") return;
    if (this.tapMoved || this.tapConsumed) return;

    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const base = this.toBase(ev);
    const hit = this.hitTest(base.x, base.y);
    if (!hit) return;
    this.hooks.onMarkTap(hit, ev);
  };

  /**
   * 长按 = 移动端的右键。
   *
   * 优先级与桌面右键一致：图钉 > 批注 > 回链。
   * 图钉长按不给菜单（菜单里只有"编辑便签"，直接打开更省事）。
   */
  private readonly onHostLongPress = (ev: PointerSample): void => {
    if (this.destroyed) return;
    if (this.tool.active !== "select") return;

    const base = this.toBase(ev);
    // 图钉优先：长按图钉 = 直接编辑，长按底纹 = 弹菜单（与桌面右键一致）
    const pin = this.hitPin(base.x, base.y);
    if (pin) {
      this.hooks.onOpenNote(pin);
      return;
    }
    const hit = this.hitTest(base.x, base.y);
    if (hit) {
      this.hooks.onContextMenu(hit, ev);
      return;
    }
    const mark = this.hitTestBacklink(base.x, base.y);
    if (mark) this.hooks.onBacklinkActivate?.(mark, ev);
  };

  /**
   * 双击 tap = 移动端的"双击跳转"。
   * 浏览器在触屏上不会为普通元素派发 dblclick（会先当缩放处理），只能自己数。
   */
  private readonly onHostDoubleTap = (ev: PointerSample): void => {
    if (this.destroyed || this.tool.active !== "select") return;
    const base = this.toBase(ev);
    if (this.hitPin(base.x, base.y)) return;
    const mark = this.hitTestBacklink(base.x, base.y);
    if (mark) this.hooks.onBacklinkActivate?.(mark, ev);
  };

  private readonly onHostPointerLeave = (): void => {
    if (this.destroyed) return;
    this.host.classList.remove("can-drag-link");
    this.hooks.onBacklinkHover?.(null, null);
  };

  /**
   * 双击回链高亮 → 跳回引用它的笔记。
   *
   * 注意浏览器在 dblclick 之前已经把那个词选中了，所以上层处理完必须
   * 清掉选区，否则会顺带弹出选区工具栏，视觉上像"跳转失败还留了个尾巴"。
   */
  private readonly onHostDoubleClick = (ev: MouseEvent): void => {
    if (this.destroyed || this.tool.active !== "select") return;
    const base = this.toBase(ev);
    // 图钉压在回链上时，让图钉优先
    if (this.hitPin(base.x, base.y)) return;

    const mark = this.hitTestBacklink(base.x, base.y);
    if (!mark) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.hooks.onBacklinkActivate?.(mark, ev);
  };

  private readonly onContextMenu = (ev: MouseEvent): void => {
    if (this.destroyed) return;
    const base = this.toBase(ev);
    const hit = this.hitTest(base.x, base.y);
    if (!hit) return; // 空白处右键 → 交回 Obsidian，别抢它的原生菜单
    ev.preventDefault();
    ev.stopPropagation();
    this.hooks.onContextMenu(hit, ev);
  };

  /* ================================================================ *
   * 渲染
   * ================================================================ */

  private signature(a: Annotation): string {
    // 便签图钉要按 scale 换算半径，缩放后必须重建；其余节点靠 viewBox 自动缩放
    return a.kind === "note" ? `${a.updatedAt}@${this.geo.scale}` : String(a.updatedAt);
  }

  private rebuildNotePins(): void {
    for (const id of this.noteIds) {
      const anno = this.annos.find((a) => a.id === id);
      if (!anno) continue;
      this.nodes.get(id)?.remove();
      const node = this.buildNode(anno);
      this.committed.appendChild(node);
      this.nodes.set(id, node);
      this.signatures.set(id, this.signature(anno));
    }
  }

  private buildNode(a: Annotation): SVGGElement {
    const g = svgEl("g", { class: `pdfa-anno pdfa-anno-${a.kind}`, "data-anno-id": a.id });
    const { baseWidth: bw, baseHeight: bh } = this.geo;

    switch (a.kind) {
      case "highlight":
      case "underline": {
        for (const r of a.rects) {
          if (a.kind === "highlight") {
            svgEl(
              "rect",
              {
                class: "pdfa-hl",
                x: r.x * bw,
                y: r.y * bh,
                width: r.w * bw,
                height: r.h * bh,
                fill: a.color,
                "fill-opacity": a.opacity,
              },
              g,
            );
          } else {
            const y = (r.y + r.h) * bh - a.thickness / 2;
            svgEl(
              "line",
              {
                class: "pdfa-ul",
                x1: r.x * bw,
                y1: y,
                x2: (r.x + r.w) * bw,
                y2: y,
                stroke: a.color,
                "stroke-width": a.thickness,
                "stroke-linecap": "butt",
              },
              g,
            );
          }
        }
        break;
      }
      case "rect": {
        const box = this.shapeBox(a);
        svgEl(
          "rect",
          {
            x: box.x,
            y: box.y,
            width: box.w,
            height: box.h,
            fill: "none",
            stroke: a.color,
            "stroke-width": a.strokeWidth,
          },
          g,
        );
        break;
      }
      case "arrow": {
        const from = { x: a.from.x * bw, y: a.from.y * bh };
        const to = { x: a.to.x * bw, y: a.to.y * bh };
        const geo = arrowGeometry(from, to, Math.max(8, a.strokeWidth * 5));
        svgEl("path", { d: geo.line, stroke: a.color, "stroke-width": a.strokeWidth, fill: "none" }, g);
        svgEl("path", { d: geo.head, fill: a.color }, g);
        break;
      }
      case "ink": {
        const render = renderSamples(
          a.points.map(([x, y, w]) => ({ x: x * bw, y: y * bh, w })),
          a.mode,
        );
        const path = svgEl("path", { class: `pdfa-ink pdfa-ink-${a.mode}` }, g);
        applyInkPaint(path, render.d, render.filled, render.strokeWidth, a.color, a.opacity);
        break;
      }
      case "note": {
        /*
         * 有 rects = 「给这段文字加的批注」，页面上只画底纹，不再画图钉。
         * 底纹本身就说明"这段被批注了"，图钉是钉在首行右端的一个 20px 圆点，
         * 正好压住用户要看的字（还会挡住选中文字），所以整块底纹才是点击入口。
         * 纯图钉（无 rects，钉在页面上某个点）依然保留 —— 它没有别的可视标识。
         *
         * 底纹按 `mark` 画回原样：从下划线、框选升级来的批注，不该突然变成
         * 一块实心色块 —— 那会让人以为"我原来画的东西被改掉了"。
         */
        if (a.rects && a.rects.length > 0) {
          const mark = svgEl("g", { class: "pdfa-note-mark" }, g);
          const style = a.mark ?? "highlight";
          const opacity = a.opacity ?? ANNOT_DEFAULTS.highlightOpacity;

          for (const r of a.rects) {
            const x = r.x * bw;
            const y = r.y * bh;
            const w = r.w * bw;
            const h = r.h * bh;

            if (style === "underline") {
              const ly = y + h - ANNOT_DEFAULTS.underlineThickness / 2;
              svgEl(
                "line",
                {
                  class: "pdfa-ul",
                  x1: x,
                  y1: ly,
                  x2: x + w,
                  y2: ly,
                  stroke: a.color,
                  "stroke-width": ANNOT_DEFAULTS.underlineThickness,
                  "stroke-linecap": "butt",
                },
                mark,
              );
              continue;
            }

            svgEl(
              "rect",
              {
                class: style === "box" ? "pdfa-box" : "pdfa-hl",
                x,
                y,
                width: w,
                height: h,
                fill: a.color,
                "fill-opacity": style === "box" ? 0.08 : opacity,
                stroke: style === "box" ? a.color : undefined,
                "stroke-width": style === "box" ? ANNOT_DEFAULTS.shapeStrokeWidth : undefined,
              },
              mark,
            );
          }
        }
        // 只有"无底纹的纯图钉"才画图钉；带 rects 的批注靠底纹说话
        if (!a.rects || a.rects.length === 0) this.buildPin(svgEl("g", {}, g), a);
        break;
      }
    }
    return g;
  }

  /**
   * 便签图钉：圆心 + 白描边 + 📌。只用于「钉在页面上某个点」的纯便签。
   * 半径用 CSS px / scale，保证 100% 和 300% 下看起来一样大 ——
   * 图钉是"控件"不是"内容"，跟着页面放大反而会盖住正文。
   */
  private buildPin(g: SVGGElement, a: NoteAnnotation): void {
    const s = this.geo.scale || 1;
    const r = NOTE_PIN_RADIUS / s;
    g.setAttribute("transform", `translate(${fmt(a.at.x * this.geo.baseWidth)} ${fmt(a.at.y * this.geo.baseHeight)})`);
    g.setAttribute("class", "pdfa-anno pdfa-anno-note pdfa-note-pin");
    // 锚点是这条便签在伴生笔记里的落点：`^pdfa-note-<id>`。
    // 写成属性而不是包一层 <a>：SVG 里的 <a> 会抢走指针事件，破坏几何命中。
    g.setAttribute("data-note-anchor", `^pdfa-note-${a.id}`);
    svgEl("circle", { class: "pdfa-pin-shadow", cy: 1.5 / s, r: r + 1.5 / s, fill: "rgba(0,0,0,.18)" }, g);
    // 浅色图钉配深描边，否则马卡龙色在白色纸面上没有轮廓
    const ring = isLightColor(a.color) ? "rgba(0,0,0,.35)" : "#fff";
    svgEl("circle", { r, fill: a.color, stroke: ring, "stroke-width": 1.6 / s }, g);
    const label = svgEl(
      "text",
      {
        y: 0.5 / s,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": 10 / s,
        "pointer-events": "none",
      },
      g,
    );
    label.textContent = "📌";
  }

  private shapeBox(a: ShapeAnnotation) {
    const bw = this.geo.baseWidth;
    const bh = this.geo.baseHeight;
    return boxFromPoints({ x: a.from.x * bw, y: a.from.y * bh }, { x: a.to.x * bw, y: a.to.y * bh });
  }

  /* ================================================================ *
   * 坐标系
   * ================================================================ */

  private syncToolClass(): void {
    const meta = TOOL_META[this.tool.active];
    const drawing = meta.interaction === "drag" || meta.interaction === "click";
    this.svg.classList.toggle("is-drawing", drawing);
    this.svg.dataset.tool = this.tool.active;
  }

  /** 客户端坐标 → BASE（pt）。用 rect 比例而不是 scale，规避 floor 造成的 0.5px 偏差 */
  private toBase(ev: { clientX: number; clientY: number }): Point {
    const r = this.svg.getBoundingClientRect();
    const sx = r.width > 0 ? this.geo.baseWidth / r.width : 1;
    const sy = r.height > 0 ? this.geo.baseHeight / r.height : 1;
    return { x: (ev.clientX - r.left) * sx, y: (ev.clientY - r.top) * sy };
  }

  private toNorm(p: Point): Point {
    return { x: p.x / this.geo.baseWidth, y: p.y / this.geo.baseHeight };
  }
}

/* ------------------------------------------------------------------ *
 * 描边 / 填充的统一切换
 * ★ 两边（实时预览、重建）必须走同一个函数，
 *   否则会出现"画的时候是描边、松手变填充"的跳变。
 * ------------------------------------------------------------------ */
function applyInkPaint(
  node: SVGPathElement,
  d: string,
  filled: boolean,
  strokeWidth: number,
  color: string,
  opacity: number,
): void {
  node.setAttribute("d", d);
  if (filled) {
    node.setAttribute("fill", color);
    node.setAttribute("fill-opacity", fmt(opacity));
    node.removeAttribute("stroke");
    node.removeAttribute("stroke-width");
    node.removeAttribute("stroke-opacity");
  } else {
    node.setAttribute("fill", "none");
    node.removeAttribute("fill-opacity");
    node.setAttribute("stroke", color);
    node.setAttribute("stroke-width", fmt(Math.max(0.35, strokeWidth)));
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
    node.setAttribute("stroke-opacity", fmt(opacity));
  }
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/** 便于上层判断某个工具是否会占用指针 */
export function isDrawingTool(tool: ToolId): boolean {
  const meta = TOOL_META[tool];
  return meta.interaction === "drag" || meta.interaction === "click";
}
