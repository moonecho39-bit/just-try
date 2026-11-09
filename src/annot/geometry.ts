/**
 * geometry.ts —— 纯几何计算（无 DOM、无状态，全部可单测）
 *
 * 这里的函数都工作在 **BASE 空间（pt）** 或 **NORM 空间**，
 * 绝不接触 CSS px —— 一旦混进屏幕坐标，缩放后必然错位。
 */

import type { Point } from "./types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 两个对角点 → 左上角 + 宽高（支持任意拖拽方向） */
export function boxFromPoints(a: Point, b: Point): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** 太小的框视为误触（单击而不拖动），不该留下一条看不见的批注 */
export function isBoxDegenerate(box: Box, minW: number, minH: number): boolean {
  return box.w < minW || box.h < minH;
}

export function clampPoint(p: Point, w: number, h: number): Point {
  return {
    x: p.x < 0 ? 0 : p.x > w ? w : p.x,
    y: p.y < 0 ? 0 : p.y > h ? h : p.y,
  };
}

export function pointInBox(px: number, py: number, box: Box): boolean {
  return px >= box.x && px <= box.x + box.w && py >= box.y && py <= box.y + box.h;
}

/** 点到线段的最短距离 —— 箭头/手绘命中检测的核心 */
export function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);

  // 投影参数 t 夹在 [0,1]，保证落在“线段”而不是“无限延长线”上
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 到矩形边框的距离（在矩形内部时返回 0） */
export function distanceToBoxFrame(px: number, py: number, box: Box): number {
  if (!pointInBox(px, py, box)) {
    const cx = Math.max(box.x, Math.min(px, box.x + box.w));
    const cy = Math.max(box.y, Math.min(py, box.y + box.h));
    return Math.hypot(px - cx, py - cy);
  }
  return Math.min(px - box.x, box.x + box.w - px, py - box.y, box.y + box.h - py);
}

/* ------------------------------------------------------------------ *
 * 箭头
 * ------------------------------------------------------------------ */

export interface ArrowGeometry {
  /** 主干线段 */
  line: string;
  /** 箭头三角形（填充） */
  head: string;
  /** 主干应停在哪（避免线头从三角尖里戳出来） */
  lineEnd: Point;
}

const HEAD_HALF_ANGLE = (26 * Math.PI) / 180;

/**
 * 箭头几何。
 * @param headLen 箭头长度（BASE pt）。按长度自适应：
 *                短线用小箭头，长线用大箭头，避免“一根长线上顶个米粒”。
 */
export function arrowGeometry(from: Point, to: Point, headLen: number): ArrowGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);

  if (len < 0.5) {
    return { line: `M ${from.x} ${from.y} L ${to.x} ${to.y}`, head: "", lineEnd: to };
  }

  const ux = dx / len;
  const uy = dy / len;
  // 箭头长度不超过线长的 60%，否则短箭头会占满整条线
  const h = Math.min(headLen, len * 0.6);

  // 主干提前 h*0.85 收笔，让三角形盖住线头
  const lineEnd: Point = { x: to.x - ux * h * 0.85, y: to.y - uy * h * 0.85 };

  const bx = to.x - ux * h;
  const by = to.y - uy * h;
  const nx = -uy;
  const ny = ux;
  const halfW = h * Math.tan(HEAD_HALF_ANGLE);

  const p1 = { x: bx + nx * halfW, y: by + ny * halfW };
  const p2 = { x: bx - nx * halfW, y: by - ny * halfW };

  return {
    line: `M ${from.x} ${from.y} L ${lineEnd.x} ${lineEnd.y}`,
    head: `M ${to.x} ${to.y} L ${p1.x} ${p1.y} L ${p2.x} ${p2.y} Z`,
    lineEnd,
  };
}

/** 数字进 SVG path 时统一保留 2 位小数：体积小一半，人眼无差 */
export function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
