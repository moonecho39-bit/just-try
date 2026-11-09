/**
 * colorPopover.ts —— 取色弹层（色组切换 + 自定义色）
 *
 * 结构：顶部色组页签 → 当前色组的色卡 → 底部自定义色。
 * 「当前色组」是**每个色槽各自记住**的（写在 ToolState.palettes 里），
 * 所以画框时切到莫兰迪，不会影响高亮用的原生色组。
 */

import type { ToolState } from "../annot/toolState";
import type { PaletteId, SurfaceKey } from "../annot/palettes";
import {
  COLOR_GROUPS,
  SURFACE_LABELS,
  getColorGroup,
  loadCustomColors,
  rememberCustomColor,
} from "../annot/palettes";
import { h, onOutsidePointerDown, placeFloating, type RectLike } from "../dom";

export interface ColorPopoverOptions {
  tool: ToolState;
  /**
   * 选定颜色后回调。
   * 必须带回 surface：弹层可能是从"选区工具栏"打开的（固定为 highlight），
   * 而此时当前激活工具可能是铅笔 —— 只回传颜色就会写进错误的色槽。
   */
  onPick(color: string, surface: SurfaceKey): void;
}

export class ColorPopover {
  private el: HTMLElement | null = null;
  private detach: (() => void) | null = null;
  private surface: SurfaceKey = "highlight";

  constructor(private readonly opts: ColorPopoverOptions) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(anchor: HTMLElement | RectLike, surface: SurfaceKey): void {
    this.close();
    this.surface = surface;

    const el = h("div", { cls: "pdfa-pop pdfa-color-pop", parent: document.body });
    // 弹层内的按下不能冒泡到“点外部关闭”的逻辑里
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.el = el;

    this.render(el);
    placeFloating(el, anchor, { placement: "below", gap: 6 });

    this.detach = onOutsidePointerDown(el, () => this.close());
    // 滚动时锚点位置失效，直接关掉比飘在错误位置好
    window.addEventListener("scroll", this.onScroll, true);
  }

  close(): void {
    this.detach?.();
    this.detach = null;
    window.removeEventListener("scroll", this.onScroll, true);
    this.el?.remove();
    this.el = null;
  }

  destroy(): void {
    this.close();
  }

  private readonly onScroll = (): void => {
    this.close();
  };

  /* ---------------------------------------------------------------- */

  private render(el: HTMLElement): void {
    const { tool } = this.opts;
    const surface = this.surface;
    const activePalette = tool.getPalette(surface);
    const current = tool.getColor(surface);

    el.textContent = "";

    const head = h("div", { cls: "pdfa-pop-head", parent: el });
    h("span", { cls: "pdfa-pop-title", text: `取色 · ${SURFACE_LABELS[surface]}`, parent: head });

    /* --- 色组页签 --- */
    const tabs = h("div", { cls: "pdfa-color-tabs", parent: el });
    for (const group of COLOR_GROUPS) {
      const tab = h("button", {
        cls: `pdfa-color-tab${group.id === activePalette ? " is-active" : ""}`,
        text: group.label,
        attr: { type: "button", title: group.hint },
        parent: tabs,
      });
      tab.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        tool.setPalette(surface, group.id as PaletteId);
        this.render(el);
      };
    }

    /* --- 色卡 --- */
    const group = getColorGroup(activePalette);
    const grid = h("div", { cls: "pdfa-swatches", parent: el });

    if (group.id === "custom") {
      const customs = loadCustomColors();
      if (customs.length === 0) {
        h("div", { cls: "pdfa-color-empty", text: "还没有自定义颜色，用下面的取色器选一个", parent: el });
      } else {
        for (const color of customs) grid.appendChild(this.swatch(color, current, el));
      }
    } else {
      for (const color of group.colors) grid.appendChild(this.swatch(color, current, el));
    }

    /* --- 自定义色 --- */
    const custom = h("div", { cls: "pdfa-color-custom", parent: el });
    h("label", { cls: "pdfa-color-custom-label", text: "自定义", parent: custom });

    const input = h("input", {
      cls: "pdfa-color-input",
      attr: { type: "color", value: current },
      parent: custom,
    });

    // change 而非 input：拖色轮时不要每帧都改批注颜色
    input.onchange = () => {
      const color = input.value.toLowerCase();
      rememberCustomColor(color);
      this.pick(color);
    };

    const recent = loadCustomColors();
    if (recent.length > 0) {
      const row = h("div", { cls: "pdfa-swatches pdfa-swatches-recent", parent: el });
      for (const color of recent) row.appendChild(this.swatch(color, current, el));
    }
  }

  private swatch(color: string, current: string, host: HTMLElement): HTMLElement {
    const isActive = color.toLowerCase() === current.toLowerCase();
    const btn = h("button", {
      cls: `pdfa-swatch${isActive ? " is-active" : ""}`,
      attr: {
        type: "button",
        title: color,
        "aria-label": color,
        "data-color": color,
      },
      parent: host,
    });
    btn.style.background = color;
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.pick(color);
    };
    return btn;
  }

  private pick(color: string): void {
    this.opts.onPick(color, this.surface);
    this.close();
  }
}
