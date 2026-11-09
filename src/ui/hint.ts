/**
 * hint.ts —— 跟着指针的小提示条
 *
 * 回链高亮默认和普通高亮长得一样，用户不会知道"这块能双击跳走"。
 * 悬停时在指针旁边浮一句提示，是最轻的解释成本。
 *
 * 两个细节：
 *  · `pointer-events: none` —— 否则提示条会挡住鼠标，导致 pointerleave 抖动闪烁；
 *  · 合并到 rAF 里改位置 —— 指针事件 120Hz，直接写 style 会造成多余的重排。
 */

import { h } from "../dom";

export class FloatingHint {
  private el: HTMLElement | null = null;
  private raf = 0;
  private pending: { text: string; x: number; y: number } | null = null;

  show(text: string, x: number, y: number): void {
    this.pending = { text, x, y };
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const p = this.pending;
      if (!p) return;
      this.paint(p.text, p.x, p.y);
    });
  }

  hide(): void {
    this.pending = null;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.el?.remove();
    this.el = null;
  }

  destroy(): void {
    this.hide();
  }

  private paint(text: string, x: number, y: number): void {
    let el = this.el;
    if (!el) {
      el = h("div", { cls: "pdfa-hint", parent: document.body });
      this.el = el;
    }
    if (el.textContent !== text) el.textContent = text;

    // 先量尺寸再定位：贴右/贴底时往回收，避免被视口切掉
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const left = Math.min(Math.max(4, x + 14), window.innerWidth - w - 6);
    const top = Math.min(Math.max(4, y - hgt - 12), window.innerHeight - hgt - 6);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}
