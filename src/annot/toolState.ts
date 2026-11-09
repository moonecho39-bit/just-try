/**
 * toolState.ts —— 工具状态机（唯一真源）
 *
 * 状态只有三块，全部集中在这里，UI 与绘制层都只读它、只改它：
 *   ① 当前激活的工具（select / highlight / rect / pencil …）
 *   ② 每个“色槽”当前的颜色与色组偏好
 *   ③ 每种笔的粗细
 *
 * 为什么不让工具栏、绘制层各自记一份：
 *   工具栏在页面顶部、浮动工具栏在选区旁边、绘制层在每页 SVG 上，三处都要
 *   显示“当前是高亮 + 黄色”。一旦各自持有副本，就必然出现工具栏显示黄、
 *   画出来是红的错位。所以这里只允许一个真源 + 订阅。
 *
 * 交互语义（与 Acrobat 一致，别改）：
 *   · 从顶部工具栏「激活」某个工具 = 粘滞模式，做完一笔仍然保持，
 *     直到按 Esc 或点回「选择」；
 *   · 从选区浮动工具栏「点一下」= 一次性动作，做完立刻回到 select，
 *     避免用户下次想复制文字时被自动高亮。
 */

import type { ToolId } from "./types";
import { ANNOT_DEFAULTS } from "./types";
import type { PaletteId, SurfaceKey } from "./palettes";
import { DEFAULT_COLORS, DEFAULT_PALETTES } from "./palettes";
import { Emitter } from "./emitter";

export interface ToolMeta {
  id: ToolId;
  label: string;
  /** Lucide 图标名，交给 Obsidian 的 setIcon */
  icon: string;
  /** 该工具从哪个色槽取色 */
  surface: SurfaceKey | null;
  /**
   * 交互类型：
   *  select 仅选择；text 依赖文本选区；drag 拖拽绘制；click 单击落点
   */
  interaction: "select" | "text" | "drag" | "click";
  cursor: string;
}

export const TOOL_META: Record<ToolId, ToolMeta> = {
  select: { id: "select", label: "选择", icon: "mouse-pointer-2", surface: null, interaction: "select", cursor: "default" },
  highlight: { id: "highlight", label: "高亮", icon: "highlighter", surface: "highlight", interaction: "text", cursor: "text" },
  underline: { id: "underline", label: "下划线", icon: "underline", surface: "highlight", interaction: "text", cursor: "text" },
  rect: { id: "rect", label: "矩形框", icon: "square", surface: "shape", interaction: "drag", cursor: "crosshair" },
  arrow: { id: "arrow", label: "箭头", icon: "arrow-up-right", surface: "shape", interaction: "drag", cursor: "crosshair" },
  note: { id: "note", label: "便签", icon: "sticky-note", surface: "note", interaction: "click", cursor: "copy" },
  pencil: { id: "pencil", label: "铅笔", icon: "pencil", surface: "ink", interaction: "drag", cursor: "crosshair" },
  marker: { id: "marker", label: "马克笔", icon: "brush", surface: "marker", interaction: "drag", cursor: "crosshair" },
};

/** 顶部工具栏里按这个顺序排 */
export const TOOL_ORDER: ToolId[] = ["select", "highlight", "underline", "rect", "arrow", "note", "pencil", "marker"];

export interface ToolWidths {
  pencil: number;
  marker: number;
  shape: number;
}

const DEFAULT_WIDTHS: ToolWidths = {
  pencil: ANNOT_DEFAULTS.pencilWidth,
  marker: ANNOT_DEFAULTS.markerWidth,
  shape: ANNOT_DEFAULTS.shapeStrokeWidth,
};

export interface ToolSnapshot {
  active: ToolId;
  colors: Record<SurfaceKey, string>;
  palettes: Record<SurfaceKey, PaletteId>;
  widths: ToolWidths;
}

export class ToolState {
  private _active: ToolId = "select";
  private _colors: Record<SurfaceKey, string> = { ...DEFAULT_COLORS };
  private _palettes: Record<SurfaceKey, PaletteId> = { ...DEFAULT_PALETTES };
  private _widths: ToolWidths = { ...DEFAULT_WIDTHS };

  readonly change = new Emitter<ToolSnapshot>();

  get active(): ToolId {
    return this._active;
  }

  get activeMeta(): ToolMeta {
    return TOOL_META[this._active];
  }

  /** 激活工具；重复点同一个工具 = 回到 select（"再点一下取消"的直觉） */
  toggle(tool: ToolId): void {
    this.setActive(this._active === tool ? "select" : tool);
  }

  setActive(tool: ToolId): void {
    if (this._active === tool) return;
    this._active = tool;
    this.emit();
  }

  getColor(surface: SurfaceKey): string {
    return this._colors[surface];
  }

  /** 工具当前使用的颜色（select 没有色槽，返回高亮色以方便显示） */
  get activeColor(): string {
    const surface = this.activeMeta.surface;
    return surface ? this._colors[surface] : this._colors.highlight;
  }

  setColor(surface: SurfaceKey, color: string): void {
    if (this._colors[surface] === color) return;
    this._colors[surface] = color;
    this.emit();
  }

  getPalette(surface: SurfaceKey): PaletteId {
    return this._palettes[surface];
  }

  setPalette(surface: SurfaceKey, palette: PaletteId): void {
    if (this._palettes[surface] === palette) return;
    this._palettes[surface] = palette;
    this.emit();
  }

  getWidth(tool: "pencil" | "marker" | "shape"): number {
    return this._widths[tool];
  }

  setWidth(tool: keyof ToolWidths, width: number): void {
    const clamped = Math.min(40, Math.max(0.5, width));
    if (this._widths[tool] === clamped) return;
    this._widths[tool] = clamped;
    this.emit();
  }

  snapshot(): ToolSnapshot {
    return {
      active: this._active,
      colors: { ...this._colors },
      palettes: { ...this._palettes },
      widths: { ...this._widths },
    };
  }

  private emit(): void {
    this.change.emit(this.snapshot());
  }
}
