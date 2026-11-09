/**
 * ink.ts —— 手绘笔迹：采样、平滑、路径生成
 *
 * 三个必须分开的职责，否则很容易写出“越画越糊”的实现：
 *
 *  ① 采样（StrokeBuilder）
 *     原始 pointermove 事件的密度跟设备刷新率、CPU 负载都有关：
 *     慢速拖动可能每像素 3 个点，快速甩笔可能一段直线只有 2 个点。
 *     所以第一关是 **距离抽稀**：两点间距小于阈值就丢弃，保证点序列疏密均匀。
 *
 *  ② 平滑（chaikin）
 *     ptr 事件是折线，直接连起来会有明显棱角。Chaikin 切角算法做一次迭代，
 *     折线就变成近似二次 B 样条，且**首尾点不动**（这点很关键：
 *     否则笔画会肉眼可见地缩进一截，跟指针轨迹对不上）。
 *
 *  ③ 成径（ribbon / centerline）
 *     · 马克笔 = 等宽，用「描边路径」最省：一个 <path> + stroke-width。
 *     · 铅笔   = 变速变宽，必须用「轮廓带」：把中心线按法向偏移出左右两条边，
 *                再首尾用二次曲线收成圆头，得到一个填充多边形。
 *                为什么不用「一段一段的 stroke-width」：接缝处宽度跳变，
 *                高速手写时会出现一串明显的台阶。
 *
 * 笔宽来自速度调制：写快 → 细，落笔停顿时 → 粗。这是手写笔迹“像手写”
 * 的主要来源，比任何平滑算法都重要。
 */

import type { InkMode, InkPoint } from "./types";
import { fmt } from "./geometry";

export interface Sample {
  /** BASE 空间 x（pt） */
  x: number;
  /** BASE 空间 y（pt） */
  y: number;
  /** 该点笔宽（pt） */
  w: number;
}

/** 抽稀阈值（pt）：太小 = 点太多，太大 = 曲线变棱角 */
const MIN_POINT_DISTANCE = 0.9;
/** 速度归一化上限（pt/s）：超过这个速度就是最细笔画 */
const SPEED_NORM = 900;

export interface StrokeOptions {
  /** 基准笔宽（pt） */
  width: number;
  mode: InkMode;
  /** 页面宽高（pt），用于把 BASE 坐标压成 NORM 存盘 */
  baseWidth: number;
  baseHeight: number;
}

export class StrokeBuilder {
  private samples: Sample[] = [];
  private lastTime = 0;
  private lastBaseX = 0;
  private lastBaseY = 0;
  private speed = 0;
  private started = false;

  constructor(private readonly opts: StrokeOptions) {}

  get count(): number {
    return this.samples.length;
  }

  get isEmpty(): boolean {
    return this.samples.length === 0;
  }

  /**
   * 追加一个采样点。
   * @param x,y BASE 空间坐标（pt）
   * @param time performance.now()
   * @returns 是否真的入列（被抽稀时返回 false，调用方据此跳过重绘）
   */
  add(x: number, y: number, time: number): boolean {
    if (!this.started) {
      this.started = true;
      this.lastBaseX = x;
      this.lastBaseY = y;
      this.lastTime = time;
      this.speed = 0;
      this.samples.push({ x, y, w: this.opts.width * 1.1 });
      return true;
    }

    const dist = Math.hypot(x - this.lastBaseX, y - this.lastBaseY);
    if (dist < MIN_POINT_DISTANCE) return false;

    const dt = Math.max(1, time - this.lastTime);
    // 瞬时速度抖动很大（事件时间戳精度、掉帧），用 EMA 压一下再调制笔宽
    const instant = (dist / dt) * 1000;
    this.speed = this.speed === 0 ? instant : this.speed * 0.62 + instant * 0.38;

    this.samples.push({ x, y, w: this.widthForSpeed(this.speed) });
    this.lastBaseX = x;
    this.lastBaseY = y;
    this.lastTime = time;
    return true;
  }

  private widthForSpeed(speed: number): number {
    const base = this.opts.width;
    if (this.opts.mode === "marker") return base;

    const k = Math.min(1, speed / SPEED_NORM);
    // 停顿 1.28 倍粗，疾写 0.72 倍细：差距再大就会显得笔画时粗时细很脏
    const w = base * (1.28 - 0.56 * k);
    return Math.max(base * 0.55, Math.min(base * 1.4, w));
  }

  /** 导出为存盘格式（NORM + pt），并在末尾补一个尺寸饱和点 */
  toInkPoints(): InkPoint[] {
    const { baseWidth, baseHeight } = this.opts;
    return this.samples.map((s) => [
      round(s.x / baseWidth, 5),
      round(s.y / baseHeight, 5),
      round(s.w, 2),
    ]);
  }

  /** 实时预览：直接吐 BASE 坐标的样例，避免每帧来回换算 */
  baseSamples(): ReadonlyArray<Sample> {
    return this.samples;
  }
}

function round(v: number, digits: number): number {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/* ------------------------------------------------------------------ *
 * 平滑
 * ------------------------------------------------------------------ */

/**
 * Chaikin 切角：每条线段取 1/4、3/4 两点，替换原顶点。
 * 一次迭代就把尖角磨圆；两次以上会明显“缩水”（曲率大的地方向内塌），所以只做一次。
 * 首尾点原样保留，保证笔迹起止位置与指针完全一致。
 */
export function chaikin(samples: ReadonlyArray<Sample>, iterations = 1): Sample[] {
  let cur: Sample[] = samples.map((s) => ({ ...s }));
  if (cur.length < 3) return cur;

  for (let it = 0; it < iterations; it++) {
    const next: Sample[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, w: a.w * 0.75 + b.w * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, w: a.w * 0.25 + b.w * 0.75 });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

/** 等宽描边路径（马克笔 / 宽度差异可忽略的铅笔） */
export function centerlinePathD(samples: ReadonlyArray<Sample>): string {
  const n = samples.length;
  if (n === 0) return "";
  if (n === 1) {
    const p = samples[0];
    // 单点：一条极短线段 + round linecap，浏览器会渲染成一个圆点
    return `M ${fmt(p.x)} ${fmt(p.y)} L ${fmt(p.x + 0.01)} ${fmt(p.y)}`;
  }
  if (n === 2) {
    return `M ${fmt(samples[0].x)} ${fmt(samples[0].y)} L ${fmt(samples[1].x)} ${fmt(samples[1].y)}`;
  }

  // 中点二次曲线：控制点取原始顶点，端点取相邻两点的中点 —— 一阶连续，视觉上就是顺滑的
  let d = `M ${fmt(samples[0].x)} ${fmt(samples[0].y)}`;
  for (let i = 1; i < n - 1; i++) {
    const c = samples[i];
    const nx = (c.x + samples[i + 1].x) / 2;
    const ny = (c.y + samples[i + 1].y) / 2;
    d += ` Q ${fmt(c.x)} ${fmt(c.y)} ${fmt(nx)} ${fmt(ny)}`;
  }
  const last = samples[n - 1];
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

/**
 * 变宽轮廓带：沿法向偏移出左右两侧，首尾用二次曲线收圆头。
 *
 * 法向用「前后各跨一个点」的切线算（中心差分），比逐段法向更稳：
 * 逐段法向在相邻两段夹角大时会突变，轮廓会出锯齿。
 */
export function ribbonPathD(samples: ReadonlyArray<Sample>): string {
  const n = samples.length;
  if (n === 0) return "";
  if (n === 1) {
    const p = samples[0];
    return `M ${fmt(p.x)} ${fmt(p.y)} L ${fmt(p.x + 0.01)} ${fmt(p.y)}`;
  }

  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < n; i++) {
    const p0 = samples[Math.max(0, i - 1)];
    const p1 = samples[Math.min(n - 1, i + 1)];
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      // 退化：与上一点重合，法向沿用 → 直接用上一对左右点，避免 NaN
      if (left.length > 0) {
        left.push(left[left.length - 1]);
        right.push(right[right.length - 1]);
        continue;
      }
      dx = 1;
      dy = 0;
    } else {
      dx /= len;
      dy /= len;
    }

    const nx = -dy;
    const ny = dx;
    const half = samples[i].w / 2;
    left.push({ x: samples[i].x + nx * half, y: samples[i].y + ny * half });
    right.push({ x: samples[i].x - nx * half, y: samples[i].y - ny * half });
  }

  let d = `M ${fmt(left[0].x)} ${fmt(left[0].y)}`;
  for (let i = 1; i < n; i++) d += ` L ${fmt(left[i].x)} ${fmt(left[i].y)}`;

  // 末端圆头：控制点 = 中心线端点
  const end = samples[n - 1];
  d += ` Q ${fmt(end.x)} ${fmt(end.y)} ${fmt(right[n - 1].x)} ${fmt(right[n - 1].y)}`;

  for (let i = n - 2; i >= 0; i--) d += ` L ${fmt(right[i].x)} ${fmt(right[i].y)}`;

  const start = samples[0];
  d += ` Q ${fmt(start.x)} ${fmt(start.y)} ${fmt(left[0].x)} ${fmt(left[0].y)} Z`;
  return d;
}

/* ------------------------------------------------------------------ *
 * 由存盘数据重建路径
 * ------------------------------------------------------------------ */

export interface InkRender {
  /** 主路径 */
  d: string;
  /** 是否填充（轮廓带）还是描边（中心线） */
  filled: boolean;
  /** 描边宽度（filled=false 时有效，pt） */
  strokeWidth: number;
}

export function buildInkRender(points: readonly InkPoint[], baseWidth: number, baseHeight: number, mode: InkMode): InkRender {
  const samples: Sample[] = points.map(([x, y, w]) => ({ x: x * baseWidth, y: y * baseHeight, w }));
  return renderSamples(samples, mode);
}

/**
 * 实时预览与最终重建共用同一条出口。
 * ★ 必须共用：如果预览用一套算法、落盘后重建用另一套，用户会看到
 *   “松手的瞬间笔迹变了一下”—— 这种细节最伤手写手感。
 */
export function renderSamples(samples: ReadonlyArray<Sample>, mode: InkMode): InkRender {
  if (samples.length === 0) return { d: "", filled: false, strokeWidth: 1 };
  if (samples.length === 1) {
    return { d: centerlinePathD(samples), filled: false, strokeWidth: samples[0].w };
  }

  const smoothed = chaikin(samples, 1);

  let minW = Infinity;
  let maxW = -Infinity;
  let sum = 0;
  for (const s of smoothed) {
    if (s.w < minW) minW = s.w;
    if (s.w > maxW) maxW = s.w;
    sum += s.w;
  }
  const avg = sum / smoothed.length;

  // 宽度差异不足 8% 就没必要走轮廓带，描边更省也更锐
  const variable = mode === "pencil" && maxW - minW > Math.max(0.12, avg * 0.08);
  if (!variable) {
    return { d: centerlinePathD(smoothed), filled: false, strokeWidth: avg };
  }
  return { d: ribbonPathD(smoothed), filled: true, strokeWidth: avg };
}
