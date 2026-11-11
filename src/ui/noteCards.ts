/**
 * noteCards.ts —— 页面外侧的「批注卡片」浮层（PDF++ 那种看得见的批注）
 *
 * 位置：挂在**滚动区**上，而不是挂在页面容器里。
 *   页面容器为了性能和裁切设了 `overflow: hidden` + `contain: paint`，
 *   卡片画在它外面会被直接切掉；挂到滚动区上，卡片就落在页面两侧的空白里，
 *   既不挡正文，也不会被裁。
 *
 * 坐标：卡片用**内容坐标**（相对浮层原点），所以滚动时不用重算 ——
 *   只有缩放、窗口尺寸变化、正文变化（高度变了）才需要重排。
 */

import { setIcon } from "obsidian";
import {
  CARD_MAX_W,

  chooseLane,
  packCards,
  type CardMetric,
  type CardSide,
} from "../annot/cardLayout";

export interface CardVM {
  id: string;
  page: number;
  /** 色点颜色，取自批注色 */
  color: string;
  /** 卡片标题，如「批注 · p.2」 */
  title: string;
  /** Markdown 正文 */
  body: string;
  /** 锚点相对页面顶部的纵向位置（CSS px） */
  anchorTop: number;
}

export interface CardHooks {
  pageEl(page: number): HTMLElement | null;
  onEdit(id: string): void;
  onDelete(id: string): void;
  /** 点卡片本身：把对应批注闪一下，让人知道它对应哪段文字 */
  onSelect(id: string): void;
  /** 正文渲染。返回 Promise 时，浮层会在渲染完成后重新量高度 */
  renderBody(el: HTMLElement, body: string): Promise<void> | void;
}

/** 低于这个宽度就切到"窄卡"排版（省内边距、字号更小） */
const NARROW_W = 190;

interface CardRec {
  el: HTMLElement;
  titleEl: HTMLElement;
  dotEl: HTMLElement;
  bodyEl: HTMLElement;
  sig: string;
  /** 上一次布局给出的宽度（画连线时要用） */
  w: number;
  anchor: { side: CardSide; pageLeft: number; pageRight: number; y: number } | null;
}

export class CardOverlay {
  private readonly root: HTMLElement;
  private readonly linkSvg: SVGSVGElement;
  private readonly recs = new Map<string, CardRec>();
  private vms = new Map<string, CardVM>();
  private collapsed = new Set<string>();
  private visible = true;
  private rafId = 0;
  private destroyed = false;
  private readonly ro: ResizeObserver | null;

  constructor(
    private readonly scroller: HTMLElement,
    private readonly hooks: CardHooks,
  ) {
    const doc = scroller.ownerDocument;
    this.root = doc.createElement("div");
    this.root.className = "pdfa-cards";

    this.linkSvg = doc.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
    this.linkSvg.setAttribute("class", "pdfa-card-links");
    this.root.appendChild(this.linkSvg);
    scroller.appendChild(this.root);

    // 窗口/面板宽度一变，横向"有没有地方放卡片"就变了，必须重排
    this.ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => this.scheduleLayout())
        : null;
    this.ro?.observe(scroller);
  }

  setCards(list: readonly CardVM[]): void {
    if (this.destroyed) return;
    const next = new Map<string, CardVM>();
    for (const vm of list) next.set(vm.id, vm);

    for (const vm of list) {
      let rec = this.recs.get(vm.id);
      if (!rec) {
        rec = this.buildCard(vm);
        this.root.appendChild(rec.el);
        this.recs.set(vm.id, rec);
      }
      const sig = `${vm.title}|${vm.color}|${vm.body}`;
      if (rec.sig !== sig) {
        rec.sig = sig;
        rec.titleEl.textContent = vm.title;
        rec.dotEl.style.background = vm.color;
        const out = this.hooks.renderBody(rec.bodyEl, vm.body);
        if (out && typeof out.then === "function") {
          void out.then(() => this.scheduleLayout());
        }
      }
    }

    for (const [id, rec] of Array.from(this.recs)) {
      if (next.has(id)) continue;
      rec.el.remove();
      this.recs.delete(id);
    }
    this.vms = next;
    this.scheduleLayout();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.classList.toggle("is-hidden", !on);
    if (on) this.scheduleLayout();
  }

  destroy(): void {
    this.destroyed = true;
    this.ro?.disconnect();
    if (this.rafId) window.cancelAnimationFrame(this.rafId);
    this.root.remove();
    this.recs.clear();
    this.vms.clear();
  }

  /* ---------------------------------------------------------------- *
   * DOM
   * ---------------------------------------------------------------- */

  private buildCard(vm: CardVM): CardRec {
    const doc = this.root.ownerDocument;
    const el = doc.createElement("div");
    el.className = "pdfa-card";
    el.dataset.id = vm.id;

    const head = doc.createElement("div");
    head.className = "pdfa-card-head";

    const dotEl = doc.createElement("span");
    dotEl.className = "pdfa-card-dot";

    const titleEl = doc.createElement("span");
    titleEl.className = "pdfa-card-title";

    const tools = doc.createElement("span");
    tools.className = "pdfa-card-tools";

    const mkBtn = (icon: string, label: string, onClick: () => void): HTMLButtonElement => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "pdfa-card-btn";
      b.setAttribute("aria-label", label);
      b.title = label;
      setIcon(b, icon);
      b.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      return b;
    };

    const foldBtn = mkBtn("chevron-up", "折叠 / 展开", () => {
      const on = this.collapsed.has(vm.id);
      if (on) this.collapsed.delete(vm.id);
      else this.collapsed.add(vm.id);
      const rec = this.recs.get(vm.id);
      rec?.el.classList.toggle("is-collapsed", !on);
      this.scheduleLayout();
    });

    tools.append(
      foldBtn,
      mkBtn("pencil", "编辑批注", () => this.hooks.onEdit(vm.id)),
      mkBtn("x", "删除批注", () => this.hooks.onDelete(vm.id)),
    );

    head.append(dotEl, titleEl, tools);

    const bodyEl = doc.createElement("div");
    bodyEl.className = "pdfa-card-body";

    el.append(head, bodyEl);

    // 卡片是浮层里的"控件"：不许把按下事件传给下面的绘制层，否则会拖出一条线
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    el.addEventListener("click", () => this.hooks.onSelect(vm.id));

    const rec: CardRec = { el, titleEl, dotEl, bodyEl, sig: "", w: CARD_MAX_W, anchor: null };
    if (this.collapsed.has(vm.id)) el.classList.add("is-collapsed");
    el.classList.toggle("is-hidden-card", false);
    return rec;
  }

  /* ---------------------------------------------------------------- *
   * 布局
   * ---------------------------------------------------------------- */

  private scheduleLayout(): void {
    if (this.destroyed || this.rafId) return;
    this.rafId = window.requestAnimationFrame(() => {
      this.rafId = 0;
      this.layout();
    });
  }

  private layout(): void {
    if (this.destroyed || !this.visible) return;
    const rootRect = this.root.getBoundingClientRect();
    /*
     * 取**滚动区**的可视宽，而不是浮层自己（浮层是 width:100% 的 0 高度盒子，
     * 在极端主题下可能继承到别的宽度）。用错宽度会让"两侧还有没有空"判断失真，
     * 卡片就会被判定放不下、退回页面内侧去压正文 —— 0.8.0 的现场就是这样。
     */
    const viewWidth = this.scroller.clientWidth || this.root.clientWidth;
    if (viewWidth <= 0) return;

    const metrics: CardMetric[] = [];

    for (const [id, rec] of this.recs) {
      const vm = this.vms.get(id);
      const page = vm ? this.hooks.pageEl(vm.page) : null;
      if (!vm || !page) {
        rec.el.style.visibility = "hidden";
        continue;
      }
      rec.el.style.visibility = "";

      const pr = page.getBoundingClientRect();
      const pageLeft = pr.left - rootRect.left;
      const pageRight = pr.right - rootRect.left;

      // 卡片宽度跟着"页面外侧还剩多少空"走：宁可窄一点待在空白里，也不压正文
      const lane = chooseLane({ pageLeft, pageRight, viewWidth });
      rec.w = lane.width;
      rec.el.style.width = `${lane.width}px`;
      rec.el.style.left = `${lane.left}px`;
      rec.el.dataset.side = lane.side;
      rec.el.classList.toggle("is-narrow", lane.width < NARROW_W);

      // 宽度定下来之后量高度才准（正文换行数取决于宽度）
      const height = rec.el.offsetHeight;
      const y = pr.top - rootRect.top + vm.anchorTop;
      rec.anchor = { side: lane.side, pageLeft, pageRight, y };

      // 卡片的"头"对齐锚点；-6 让色点大致落在高亮那一行的中线上
      metrics.push({ id, top: y - 6, height });
    }

    const placed = packCards(metrics);
    for (const p of placed) {
      const rec = this.recs.get(p.id);
      if (rec) rec.el.style.top = `${p.top}px`;
    }

    this.drawLinks(rootRect);
  }

  /** 从高亮引一条虚线到卡片：这是"哪张卡对应哪段字"的唯一线索，不能省 */
  private drawLinks(rootRect: DOMRect): void {
    while (this.linkSvg.firstChild) this.linkSvg.removeChild(this.linkSvg.firstChild);
    const doc = this.root.ownerDocument;

    for (const [id, rec] of this.recs) {
      const a = rec.anchor;
      if (!a || a.side === "inside") continue; // 压在页面里时线会横穿正文，宁可不画
      const left = parseFloat(rec.el.style.left || "0");
      const top = parseFloat(rec.el.style.top || "0");
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;

      const x1 = a.side === "right" ? a.pageRight : a.pageLeft;
      const x2 = a.side === "right" ? left : left + rec.w;
      const y2 = top + 16;
      const color = this.vms.get(id)?.color ?? "#888";

      const path = doc.createElementNS("http://www.w3.org/2000/svg", "path") as SVGPathElement;
      // 水平出发再接斜线：视觉上像"从这行拉出来"，比直连更好读
      const midX = x1 + (x2 - x1) * 0.45;
      path.setAttribute("d", `M ${x1} ${a.y} H ${midX} L ${x2} ${y2}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-dasharray", "4 3");
      path.setAttribute("opacity", "0.85");
      this.linkSvg.appendChild(path);

      const dot = doc.createElementNS("http://www.w3.org/2000/svg", "circle") as SVGCircleElement;
      dot.setAttribute("cx", String(x1));
      dot.setAttribute("cy", String(a.y));
      dot.setAttribute("r", "3");
      dot.setAttribute("fill", color);
      this.linkSvg.appendChild(dot);
    }
    void rootRect;
  }
}
