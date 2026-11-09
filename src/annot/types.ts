/**
 * types.ts —— 批注数据模型
 *
 * 单位约定（与 coords.ts 的四套坐标系对齐，别混用）：
 *  · 点 / 矩形：一律 **NORM**（0~1 的浮点，相对页面左上角，y 向下）
 *      —— 只有 NORM 能进 Markdown、能跨设备复现，这条红线从阶段一就定了。
 *  · 线宽 / 笔宽：**pt**（= scale=1 时的 CSS px，也是 PDF 用户空间单位）
 *      —— 线宽不该跟着页面比例缩放，所以单独用绝对单位，渲染时乘 scale。
 *  · 手绘点序：`[x, y, w]` 三元组，x/y 是 NORM，w 是该点的笔宽（pt）。
 *
 * 为什么 ink 要逐点存宽度而不是整条一个 width：
 *   铅笔的“笔锋”来自速度调制（写快则细），宽度是逐点变化的；
 *   只存一个 width 就没法在缩放/重开之后还原同一笔的粗细变化。
 */

import type { Rect } from "../coords";

/** 归一化点（0~1） */
export interface Point {
  x: number;
  y: number;
}

export type ToolId =
  | "select"
  | "highlight"
  | "underline"
  | "rect"
  | "arrow"
  | "note"
  | "pencil"
  | "marker";

export type AnnotationKind = "highlight" | "underline" | "rect" | "arrow" | "ink" | "note";

export type InkMode = "pencil" | "marker";

/** 手绘点：[x(NORM), y(NORM), w(pt)] */
export type InkPoint = [number, number, number];

interface AnnotationBase {
  id: string;
  page: number;
  color: string;
  createdAt: number;
  updatedAt: number;
}

/** 文本标记类：矩形来自 Range.getClientRects() 合并后的行级矩形 */
export interface HighlightAnnotation extends AnnotationBase {
  kind: "highlight";
  /** 多行选区 = 多个矩形 */
  rects: Rect[];
  /** 0~1，叠加在文字上时用 multiply 混合，过深会盖住文字 */
  opacity: number;
}

export interface UnderlineAnnotation extends AnnotationBase {
  kind: "underline";
  rects: Rect[];
  /** 线宽（pt） */
  thickness: number;
}

/**
 * 形状类：矩形 / 箭头共用起止点。
 * 不存 x/y/w/h 是因为箭头需要方向 —— 归一化成矩形就丢了“从哪到哪”。
 */
export interface ShapeAnnotation extends AnnotationBase {
  kind: "rect" | "arrow";
  from: Point;
  to: Point;
  /** 线宽（pt） */
  strokeWidth: number;
}

export interface InkAnnotation extends AnnotationBase {
  kind: "ink";
  mode: InkMode;
  points: InkPoint[];
  /** 基准笔宽（pt），逐点宽度已含速度调制 */
  width: number;
  opacity: number;
}

export interface NoteAnnotation extends AnnotationBase {
  kind: "note";
  /** 图钉锚点（NORM）。图钉本身有固定像素尺寸，不随缩放变形 */
  at: Point;
  /** Markdown 源文；阶段四接富文本时这里只换渲染器，不换存储 */
  body: string;
}

export type Annotation =
  | HighlightAnnotation
  | UnderlineAnnotation
  | ShapeAnnotation
  | InkAnnotation
  | NoteAnnotation;

/**
 * 回链高亮（backlink highlight）—— 与 Annotation **不是**一回事。
 *
 * Annotation 是「我在这个 PDF 上画的东西」，可编辑、可撤销；
 * BacklinkMark 是「别人的笔记里有一条链接指向这段文字」，是**只读的投影**：
 * 数据真身在某个 .md 文件里，这里只是把它画出来。
 *
 * 分开建模带来的好处：
 *  · 撤销栈不会被扫描结果污染（重扫一遍不该产生 undo）；
 *  · 两者可以同时存在而不打架（同一处既有草稿又有回链时，用几何去重）；
 *  · 回链的交互也不同：双击跳走，而不是选中/拖动。
 */
export interface BacklinkMark {
  /** 唯一键（来源路径 + 链接偏移） */
  key: string;
  page: number;
  /** NORM 矩形（一行一个） */
  rects: Rect[];
  color: string;
  opacity: number;
  /** 悬停提示文案 */
  title: string;
  sourcePath: string;
  /** 源笔记里的行号（0 基） */
  line: number;
}

/* ------------------------------------------------------------------ *
 * 判别辅助
 * ------------------------------------------------------------------ */

export function isTextMark(a: Annotation): a is HighlightAnnotation | UnderlineAnnotation {
  return a.kind === "highlight" || a.kind === "underline";
}

/* ------------------------------------------------------------------ *
 * 各类批注的默认外观参数
 * 集中放这里，方便阶段四做成设置项
 * ------------------------------------------------------------------ */

export const ANNOT_DEFAULTS = {
  highlightOpacity: 0.34,
  underlineThickness: 2,
  shapeStrokeWidth: 2,
  arrowStrokeWidth: 2,
  pencilWidth: 2.2,
  markerWidth: 11,
  markerOpacity: 0.36,
} as const;

/** 便签图钉的视觉半径（CSS px，不随缩放变化） */
export const NOTE_PIN_RADIUS = 10;

let idSeed = 0;

/**
 * 批注 id：时间戳 + 自增 + 随机后缀。
 * 不用 uuid 库：插件里没这个依赖，而碰撞概率在这里无关痛痒
 * （即使碰撞，也只是同一页两条批注互相覆盖，重启后重新生成）。
 */
export function createAnnotationId(): string {
  idSeed = (idSeed + 1) % 1_000_000;
  return `a${Date.now().toString(36)}${idSeed.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
