/**
 * selectionToolbar.ts —— 选区浮动工具栏
 *
 * ── 两个必须踩对的点 ────────────────────────────────────────────────
 * ① **不能弄丢选区**。
 *    浏览器在 mousedown 的默认行为里会把当前选区折叠掉，所以工具栏根节点
 *    必须 `mousedown → preventDefault()`。否则用户点"高亮"的瞬间，
 *    选区先没了，我们再去读 window.getSelection() 就是空 —— 这是这类
 *    工具最常见的翻车点。
 *
 * ② **定位要贴着选区，但不能飞出视口**。
 *    选区可能在屏幕最上方（此时要翻到下方）或最右侧（要夹回来）。
 *    统一交给 dom.placeFloating，别在三个地方各写一套。
 */

import { setIcon } from "obsidian";
import type { ToolState } from "../annot/toolState";
import type { SurfaceKey } from "../annot/palettes";
import { h, placeFloating, type RectLike } from "../dom";

export type ToolbarAction =
  | "highlight"
  | "underline"
  | "rect"
  | "arrow"
  | "note"
  | "pencil"
  | "marker"
  | "ai"
  | "link";

export interface SelectionToolbarOptions {
  tool: ToolState;
  /** anchor = 被点的那个按钮（AI 的二级菜单要贴着它弹） */
  onAction(action: ToolbarAction, anchor: HTMLElement): void;
  /** 点名要开取色器；弹层实例由 view 统一持有，避免每次点击都新建 */
  onPickColor(anchor: HTMLElement, surface: SurfaceKey): void;
}

interface BtnSpec {
  action: ToolbarAction;
  icon: string;
  label: string;
  /** 在该按钮前插入分隔线 */
  divider?: boolean;
}

const BUTTONS: BtnSpec[] = [
  { action: "highlight", icon: "highlighter", label: "高亮" },
  { action: "underline", icon: "underline", label: "下划线" },
  { action: "rect", icon: "square", label: "矩形框（拖拽绘制）", divider: true },
  { action: "arrow", icon: "arrow-up-right", label: "箭头（拖拽绘制）" },
  { action: "note", icon: "sticky-note", label: "便签" },
  { action: "pencil", icon: "pencil", label: "手绘 · 铅笔", divider: true },
  { action: "marker", icon: "brush", label: "手绘 · 马克笔" },
  /*
   * AI 伴读：放在"链接"之前，因为它的结果**会顺带产出链接**
   * （插入笔记时自动带上选区链接），逻辑上是同一条链路的上一环。
   */
  { action: "ai", icon: "sparkles", label: "AI 伴读：翻译 / 解释 / 总结", divider: true },
  /*
   * 「高亮并复制链接」——阶段三的主入口。
   * 放在最后而不是最前：老用户的手已经记住了高亮在第一个，
   * 别为了新功能挪动肌肉记忆。
   */
  { action: "link", icon: "link", label: "高亮并复制链接（粘到笔记里就是永久高亮）" },
];

export class SelectionToolbar {
  private el: HTMLElement | null = null;
  private dotEl: HTMLElement | null = null;

  constructor(private readonly opts: SelectionToolbarOptions) {}

  get visible(): boolean {
    return this.el !== null;
  }

  show(anchor: RectLike): void {
    const el = this.ensure();
    placeFloating(el, anchor, { placement: "above", gap: 9 });
    this.refresh();
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
    this.dotEl = null;
  }

  destroy(): void {
    this.hide();
  }

  /** 颜色变了（取色器选完）时同步圆点 */
  refresh(): void {
    if (!this.el || !this.dotEl) return;
    this.dotEl.style.background = this.opts.tool.getColor("highlight");
  }

  /* ---------------------------------------------------------------- */

  private ensure(): HTMLElement {
    if (this.el) return this.el;

    const el = h("div", { cls: "pdfa-float-toolbar", parent: document.body });
    // ★ 保住选区：这条不能删
    el.addEventListener("mousedown", (ev) => ev.preventDefault());
    // 点工具栏不应该被"点外部"的逻辑当成点到了外面
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());

    /* 取色圆点 */
    const colorBtn = h("button", {
      cls: "pdfa-ft-btn pdfa-ft-color",
      attr: { type: "button", title: "选择高亮颜色", "aria-label": "选择高亮颜色" },
      parent: el,
    });
    const dot = h("span", { cls: "pdfa-ft-dot", parent: colorBtn });
    const caret = h("span", { cls: "pdfa-ft-caret", parent: colorBtn });
    setIcon(caret, "chevron-down");
    this.dotEl = dot;
    colorBtn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.opts.onPickColor(colorBtn, "highlight");
    };

    for (const spec of BUTTONS) {
      if (spec.divider) h("span", { cls: "pdfa-ft-sep", parent: el });
      const btn = h("button", {
        cls: "pdfa-ft-btn",
        attr: { type: "button", title: spec.label, "aria-label": spec.label },
        parent: el,
      });
      setIcon(btn, spec.icon);
      btn.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.opts.onAction(spec.action, btn);
      };
    }

    this.el = el;
    return el;
  }
}
