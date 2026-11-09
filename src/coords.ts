/**
 * coords.ts —— 坐标系统（整个插件的“度量衡”）
 *
 * 为什么要有这一层：批注在 PDF 上的位置必须能被精确复现，
 * 但屏幕坐标受 zoom、devicePixelRatio、窗口大小影响，随时会变。
 * 所以这里定义四个坐标系，并只允许在它们之间做显式换算：
 *
 *  ① CSS 空间     —— 相对页面容器左上角，单位 CSS px，y 向下。
 *                    一切鼠标事件、getBoundingClientRect 都落在这里。
 *  ② BASE 空间    —— viewport(scale = 1) 下的坐标，单位 = PDF pt，y 向下。
 *                    ★ 这是“真值空间”：所有批注几何在内存里只以它为准。
 *  ③ NORM 空间    —— BASE 除以页面宽高，0 ~ 1 的浮点，y 向下。
 *                    ★ 落到 Markdown 里只存这个，跨设备/跨版本最稳。
 *  ④ PDF 用户空间 —— 原点在左下角，y 向上，单位 pt。
 *                    只有导出、外部工具互操作、redo/undo 时才用。
 *
 * 换算链恒定：CSS ⇄ BASE ⇄ NORM，BASE ⇄ PDF。
 * 任何代码都不许拿 CSS 坐标直接存盘。
 */

export interface PageGeometry {
  pageNumber: number;
  /** scale = 1 时的页面宽度（= PDF pt） */
  baseWidth: number;
  /** scale = 1 时的页面高度（= PDF pt） */
  baseHeight: number;
  /** 当前渲染缩放倍率 */
  scale: number;
  /** 页面旋转角度 0 | 90 | 180 | 270 */
  rotation: number;
}

/** 矩形：统一用「左上角 + 宽高」，避免各 API 的 x1/y1/x2/y2 混用 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** PDF 用户空间矩形（y 向上，需显式区分上下边） */
export interface PdfRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/* ------------------------------------------------------------------ *
 * 几何派生量
 * ------------------------------------------------------------------ */

export function cssWidth(geo: PageGeometry): number {
  return geo.baseWidth * geo.scale;
}

export function cssHeight(geo: PageGeometry): number {
  return geo.baseHeight * geo.scale;
}

/* ------------------------------------------------------------------ *
 * ① CSS ⇄ ② BASE  —— 只跟 scale 有关
 * ------------------------------------------------------------------ */

export function cssRectToBase(rect: Rect, geo: PageGeometry): Rect {
  const s = geo.scale;
  return { x: rect.x / s, y: rect.y / s, w: rect.w / s, h: rect.h / s };
}

export function baseRectToCss(rect: Rect, geo: PageGeometry): Rect {
  const s = geo.scale;
  return { x: rect.x * s, y: rect.y * s, w: rect.w * s, h: rect.h * s };
}

/* ------------------------------------------------------------------ *
 * ② BASE ⇄ ③ NORM  —— 只跟页面固有尺寸有关，与 zoom 无关
 * ------------------------------------------------------------------ */

export function baseRectToNorm(rect: Rect, geo: PageGeometry): Rect {
  return {
    x: rect.x / geo.baseWidth,
    y: rect.y / geo.baseHeight,
    w: rect.w / geo.baseWidth,
    h: rect.h / geo.baseHeight,
  };
}

export function normRectToBase(rect: Rect, geo: PageGeometry): Rect {
  return {
    x: rect.x * geo.baseWidth,
    y: rect.y * geo.baseHeight,
    w: rect.w * geo.baseWidth,
    h: rect.h * geo.baseHeight,
  };
}

/* ------------------------------------------------------------------ *
 * 便捷组合
 * ------------------------------------------------------------------ */

export function cssRectToNorm(rect: Rect, geo: PageGeometry): Rect {
  return baseRectToNorm(cssRectToBase(rect, geo), geo);
}

export function normRectToCss(rect: Rect, geo: PageGeometry): Rect {
  return baseRectToCss(normRectToBase(rect, geo), geo);
}

/* ------------------------------------------------------------------ *
 * ② BASE ⇄ ④ PDF 用户空间 —— 唯一的 y 轴翻转点
 * ------------------------------------------------------------------ */

export function baseRectToPdf(rect: Rect, geo: PageGeometry): PdfRect {
  return {
    x1: rect.x,
    y1: geo.baseHeight - (rect.y + rect.h),
    x2: rect.x + rect.w,
    y2: geo.baseHeight - rect.y,
  };
}

export function pdfRectToBase(rect: PdfRect, geo: PageGeometry): Rect {
  return {
    x: Math.min(rect.x1, rect.x2),
    y: geo.baseHeight - Math.max(rect.y1, rect.y2),
    w: Math.abs(rect.x2 - rect.x1),
    h: Math.abs(rect.y2 - rect.y1),
  };
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把选区矩形收紧到页面范围内，并抹掉浮点噪声 */
export function clampNormRect(rect: Rect): Rect {
  const x1 = clamp(rect.x, 0, 1);
  const y1 = clamp(rect.y, 0, 1);
  const x2 = clamp(rect.x + rect.w, 0, 1);
  const y2 = clamp(rect.y + rect.h, 0, 1);
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
}

/** 存盘精度：5 位小数 ≈ A4 页面上 0.02pt，远高于人眼分辨力 */
export function roundRect(rect: Rect, digits = 5): Rect {
  const p = 10 ** digits;
  return {
    x: Math.round(rect.x * p) / p,
    y: Math.round(rect.y * p) / p,
    w: Math.round(rect.w * p) / p,
    h: Math.round(rect.h * p) / p,
  };
}

/**
 * 多行选区 → 合并成少量矩形带。
 * 浏览器 Range.getClientRects() 会给每个 span 一个碎矩形，
 * 直接逐个存盘会让 Markdown 元数据膨胀十倍。
 * 这里按「y 中心线接近 + 水平可衔接」合并成行级矩形。
 */
export function mergeLineRects(rects: Rect[], toleranceRatio = 0.6): Rect[] {
  if (rects.length === 0) return [];
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Rect[] = [];

  for (const r of sorted) {
    const center = r.y + r.h / 2;
    const last = lines[lines.length - 1];
    if (last) {
      const lastCenter = last.y + last.h / 2;
      // 同一行：中心线偏移小于行高的一定比例
      if (Math.abs(center - lastCenter) < Math.max(last.h, r.h) * toleranceRatio) {
        const x1 = Math.min(last.x, r.x);
        const x2 = Math.max(last.x + last.w, r.x + r.w);
        const y1 = Math.min(last.y, r.y);
        const y2 = Math.max(last.y + last.h, r.y + r.h);
        lines[lines.length - 1] = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
        continue;
      }
    }
    lines.push({ ...r });
  }
  return lines;
}
