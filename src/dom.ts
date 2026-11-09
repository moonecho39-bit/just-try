/**
 * dom.ts —— 一点点 DOM 工具（只做“少写几行样板”，不封装框架）
 *
 * 尤其 `placeFloating`：选区工具栏、取色弹层、便签编辑器三处都要
 * “贴着某个锚点浮起来 + 贴边翻转 + 不出视口”，写三遍必然三种行为。
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string | number | undefined | null>;

/** 创建 SVG 元素（必须用 createElementNS，createElement 造出来的不渲染） */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  parent?: Element | null,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) setAttrs(el, attrs);
  if (parent) parent.appendChild(el);
  return el;
}

export function setAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    el.setAttribute(k, typeof v === "number" ? trimNum(v) : v);
  }
}

/** 属性里的数字保留 2 位，避免 `12.000000000000002` 这种脏字符串 */
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export interface HTMLElOptions {
  cls?: string;
  text?: string;
  attr?: Attrs;
  parent?: Element | null;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, opts: HTMLElOptions = {}): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (opts.cls) el.className = opts.cls;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.attr) setAttrs(el, opts.attr);
  if (opts.parent) opts.parent.appendChild(el);
  return el;
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export type Placement = "above" | "below" | "auto";

export interface FloatOptions {
  placement?: Placement;
  /** 与锚点的间距（px） */
  gap?: number;
  /** 视口安全边距 */
  margin?: number;
}

/**
 * 把 fixed 定位的浮层贴到锚点旁。
 *
 * 必须在元素已插入 DOM 且可见之后调用（要读 offsetWidth/Height）；
 * 因此内部先设 visibility:hidden，量完再显示，避免“先出现在左上角再跳过去”的闪烁。
 */
export function toRectLike(anchor: HTMLElement | RectLike): RectLike {
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  return anchor;
}

export function placeFloating(el: HTMLElement, anchorInput: HTMLElement | RectLike, options: FloatOptions = {}): void {
  const anchor = toRectLike(anchorInput);
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const placement = options.placement ?? "auto";

  el.style.position = "fixed";
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";

  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceAbove = anchor.top - margin;
  const spaceBelow = vh - anchor.bottom - margin;

  let above: boolean;
  if (placement === "above") above = true;
  else if (placement === "below") above = false;
  else above = h + gap <= spaceAbove || spaceAbove >= spaceBelow;

  const top = above ? anchor.top - h - gap : anchor.bottom + gap;

  // 水平居中于锚点，再夹进视口
  let left = anchor.left + anchor.width / 2 - w / 2;
  left = Math.max(margin, Math.min(left, vw - w - margin));

  el.style.left = `${Math.round(left)}px`;
  // 上方放不下时强制下移，宁可盖住选区也不要飞出视口
  el.style.top = `${Math.round(Math.max(margin, Math.min(top, vh - h - margin)))}px`;
  el.style.visibility = "visible";
  el.dataset.placement = above ? "above" : "below";
}

/**
 * 监听“浮层外的按下”。
 * 用 pointerdown 而不是 click：点击工具栏按钮时不会先触发隐藏，
 * 用户的一次点击不会被拆成“先关掉再点空”。
 */
export function onOutsidePointerDown(
  el: HTMLElement,
  handler: (ev: PointerEvent) => void,
  ignore?: () => boolean,
): () => void {
  const listener = (ev: PointerEvent): void => {
    const target = ev.target as Node | null;
    if (!target) return;
    if (el.contains(target)) return;
    if (ignore?.()) return;
    handler(ev);
  };
  document.addEventListener("pointerdown", listener, true);
  return () => document.removeEventListener("pointerdown", listener, true);
}
