/**
 * contextMenu.ts —— 批注右键菜单
 *
 * 为什么不直接用 Obsidian 的 Menu：
 *   Obsidian 的 Menu 走它自己的浮层栈，关闭时机、层级、点击穿透都不受我们控制；
 *   而这里要在 SVG 上做几何命中，事件本身就比较"贴身"，自带一个轻量菜单更可控。
 * 功能只有两三项，不值得为它引入状态机。
 */

import { setIcon } from "obsidian";
import { h, onOutsidePointerDown } from "../dom";

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick(): void;
}

export class ContextMenu {
  private el: HTMLElement | null = null;
  private detach: (() => void) | null = null;

  show(items: MenuItem[], clientX: number, clientY: number): void {
    this.close();
    if (items.length === 0) return;

    const el = h("div", { cls: "pdfa-pop pdfa-menu", parent: document.body });
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.el = el;

    for (const item of items) {
      const row = h("button", {
        cls: `pdfa-menu-item${item.danger ? " is-danger" : ""}`,
        attr: { type: "button" },
        parent: el,
      });
      if (item.icon) {
        const icon = h("span", { cls: "pdfa-menu-icon", parent: row });
        setIcon(icon, item.icon);
      }
      h("span", { cls: "pdfa-menu-label", text: item.label, parent: row });
      row.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.close();
        item.onClick();
      };
    }

    // 量完尺寸再定位，避免菜单从左上角“飞”到鼠标处
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    el.style.left = "0px";
    el.style.top = "0px";
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const margin = 6;
    el.style.left = `${Math.round(Math.max(margin, Math.min(clientX, window.innerWidth - w - margin)))}px`;
    el.style.top = `${Math.round(Math.max(margin, Math.min(clientY, window.innerHeight - hgt - margin)))}px`;
    el.style.visibility = "visible";

    this.detach = onOutsidePointerDown(el, () => this.close());
    document.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("scroll", this.onScroll, true);
  }

  close(): void {
    this.detach?.();
    this.detach = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("scroll", this.onScroll, true);
    this.el?.remove();
    this.el = null;
  }

  destroy(): void {
    this.close();
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.close();
    }
  };

  private readonly onScroll = (): void => {
    this.close();
  };
}
