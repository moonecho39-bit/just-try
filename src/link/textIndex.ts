/**
 * textIndex.ts —— 页面文本索引：字符位置 ⇄ 屏幕矩形
 *
 * 这是链接格式能成立的前提。链接里存的是
 *   selection = (起始行, 起始字符, 结束行, 结束字符)
 * 一个「字符坐标」，而屏幕要的是像素矩形，两者之间必须有一个可复现的映射。
 * 这一层就是这个映射，而且**必须双向**：
 *
 *   读（渲染回链）：链接 → 索引 → 逐行矩形   selectionToRects()
 *   写（生成链接）：选区矩形 → 索引 → 链接   rectsToSelection()
 *
 * 双向都走同一个索引，才能保证「写出去的链接再读回来落回原处」。
 * 索引由 pdf.js 的 getTextContent() 构建，只依赖 PDF 文本内容，
 * 不依赖缩放、不依赖 DOM、不依赖我们自己的渲染顺序 —— 换设备也一致。
 *
 * ── 行是怎么切的 ────────────────────────────────────────────────────
 * pdf.js 给的 items 是「文本块」，同一行的文字可能被切成好几块。
 * 切行的判定（顺序很重要，先严后松）：
 *   ① 上一块带 hasEOL  → 一定换行（pdf.js 从内容流里读出来的硬换行）
 *   ② 基线差 > max(2pt, 0.45em) → 换行
 *   ③ x 明显回退（< 上一块末尾 - 0.5em）→ 换行（分栏、表格列）
 * ①②③ 都是纯几何/纯内容判断，对同一份 PDF 恒等，所以索引稳定。
 *
 * ── 不插入空格 ──────────────────────────────────────────────────────
 * 网上很多实现会在块之间按间距补空格，但中文排版里「［摘」和「要］」之间的
 * 空隙是标点字宽，不是空格。补了就变成「［摘 要］」，字符索引跟着错位。
 * 所以这里**原样拼接**：索引只服务于本插件自己的往返，宁可少插不要错插。
 */

import type { Rect } from "../coords";
import type { PdfLinkTarget, Quad } from "./format";

/* ------------------------------------------------------------------ *
 * pdf.js 的最小结构（不 import pdfjs 类型，保证这一层可单测）
 * ------------------------------------------------------------------ */

export interface PdfTextItemLike {
  str: string;
  dir?: string;
  /** 文本块宽度，单位与页面 pt 一致（scale=1） */
  width?: number;
  height?: number;
  /** [a, b, c, d, e, f]，PDF 用户空间 */
  transform?: number[];
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfTextStyleLike {
  ascent?: number;
  descent?: number;
  fontFamily?: string;
}

export interface PdfTextContentLike {
  items: Array<PdfTextItemLike | { type?: string }>;
  styles?: Record<string, PdfTextStyleLike>;
}

/** 一个文本块（同一行内的连续片段） */
export interface TextRun {
  text: string;
  /** 在本行 text 中的起始字符下标 */
  charStart: number;
  /** BASE 空间（pt，y 向下）的包围盒 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLine {
  /** 行号 = 在 lines 数组中的下标，就是链接里的 l */
  index: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  runs: TextRun[];
}

export interface TextPageIndex {
  page: number;
  /** 页面在 scale=1 下的尺寸（pt） */
  width: number;
  height: number;
  /** pdf.js viewport 的变换矩阵，用于把 PDF 用户空间坐标换过来 */
  transform: number[];
  lines: TextLine[];
}

/* ------------------------------------------------------------------ *
 * 构建
 * ------------------------------------------------------------------ */

/**
 * @param viewportTransform pdf.js `page.getViewport({scale:1}).transform`
 * @param width  viewport 宽（pt）
 * @param height viewport 高（pt）
 */
export function buildTextIndex(
  page: number,
  content: PdfTextContentLike | null | undefined,
  viewportTransform: number[],
  width: number,
  height: number,
): TextPageIndex {
  const index: TextPageIndex = { page, width, height, transform: viewportTransform.slice(0, 6), lines: [] };
  if (!content || !Array.isArray(content.items)) return index;

  // viewport 的横向缩放（scale=1 时是 1）。item.width 已经是「页面单位」，
  // 不能再乘文本块自己的字号缩放，否则 24pt 的标题会被放大 24 倍。
  const vpScale = Math.hypot(viewportTransform[0], viewportTransform[1]) || 1;
  const styles = content.styles ?? {};

  let runs: TextRun[] = [];
  let text = "";
  let baseline = Number.NaN;
  let endX = Number.NaN;
  let prevEOL = false;

  const flush = (): void => {
    if (runs.length === 0) return;
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const r of runs) {
      if (r.x < x1) x1 = r.x;
      if (r.y < y1) y1 = r.y;
      if (r.x + r.w > x2) x2 = r.x + r.w;
      if (r.y + r.h > y2) y2 = r.y + r.h;
    }
    index.lines.push({ index: index.lines.length, text, x: x1, y: y1, w: x2 - x1, h: y2 - y1, runs });
    runs = [];
    text = "";
    baseline = Number.NaN;
    endX = Number.NaN;
  };

  for (const raw of content.items) {
    const item = raw as PdfTextItemLike;
    if (typeof item.str !== "string") continue; // marked-content 标记，跳过
    if (item.str.length === 0) {
      if (item.hasEOL) flush();
      continue;
    }
    const t = item.transform;
    if (!t || t.length < 6) continue;

    const tx = mulTransform(viewportTransform, t);
    // 字号：transform 的纵向缩放；退化时退回 item.height / 横向缩放
    const fontSize = Math.hypot(tx[2], tx[3]) || item.height || Math.abs(t[0]) || 10;
    const style = item.fontName ? styles[item.fontName] : undefined;
    const ascent = typeof style?.ascent === "number" && style.ascent > 0 ? style.ascent : 0.86;
    const descent = typeof style?.descent === "number" && style.descent < 0 ? style.descent : -0.24;

    const baseY = tx[5];
    const x = tx[4];
    const w = Math.max(0, (item.width ?? 0) * vpScale);
    const h = (ascent - descent) * fontSize;
    const y = baseY - ascent * fontSize;

    const newLine =
      runs.length > 0 &&
      (prevEOL ||
        !Number.isFinite(baseline) ||
        Math.abs(baseY - baseline) > Math.max(2, fontSize * 0.45) ||
        (Number.isFinite(endX) && x < endX - fontSize * 0.5));
    if (newLine) flush();

    runs.push({ text: item.str, charStart: text.length, x, y, w, h });
    text += item.str;
    baseline = baseY;
    endX = x + w;
    prevEOL = item.hasEOL === true;
  }
  flush();

  return index;
}

/** 2×3 仿射矩阵相乘（pdf.js 的 [a,b,c,d,e,f] 约定） */
export function mulTransform(m: number[], t: number[]): number[] {
  return [
    m[0] * t[0] + m[2] * t[1],
    m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3],
    m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4],
    m[1] * t[4] + m[3] * t[5] + m[5],
  ];
}

export function applyTransform(m: number[], x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/* ------------------------------------------------------------------ *
 * 读：selection → 逐行矩形（BASE，pt）
 * ------------------------------------------------------------------ */

/**
 * 把 (l1,c1,l2,c2) 还原成一组**行级**矩形。
 * 一行一个矩形，而不是整块选区一个外接框 —— 后者跨段落时会把整片空白也涂上，
 * 而且多行文字的行距空隙会被填成实心块，非常难看。
 */
export function selectionToRects(index: TextPageIndex, selection: Quad): Rect[] {
  const { lines } = index;
  if (lines.length === 0) return [];

  const [rawL1, rawC1, rawL2, rawC2] = selection;
  const l1 = clampInt(Math.min(rawL1, rawL2), 0, lines.length - 1);
  const l2 = clampInt(Math.max(rawL1, rawL2), 0, lines.length - 1);
  // 仅当两端顺序正常时才交换字符偏移，避免把「反向选区」当成整行
  const forward = rawL1 <= rawL2;
  const c1 = forward ? rawC1 : rawC2;
  const c2 = forward ? rawC2 : rawC1;

  const out: Rect[] = [];
  for (let i = l1; i <= l2; i++) {
    const line = lines[i];
    const from = i === l1 ? c1 : 0;
    const to = i === l2 ? c2 : line.text.length;
    const rect = sliceLine(line, from, to);
    if (rect) out.push(rect);
  }

  // 兜底：索引与链接不同步（例如来自 PDF++ 的链接，行/字符算法略有差异）时，
  // 至少把起始行整行标出来，而不是让用户以为链接坏了。
  if (out.length === 0) {
    const line = lines[l1];
    out.push({ x: line.x, y: line.y, w: Math.max(1, line.w), h: Math.max(1, line.h) });
  }
  return out;
}

/** 一行内 [from, to) 字符覆盖的矩形；越界返回 null */
export function sliceLine(line: TextLine, from: number, to: number): Rect | null {
  const len = line.text.length;
  const a = clampInt(from, 0, len);
  const b = clampInt(to, 0, len);
  if (b <= a) return null;

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let found = false;

  for (const run of line.runs) {
    const rs = run.charStart;
    const re = rs + run.text.length;
    const s = Math.max(a, rs);
    const e = Math.min(b, re);
    if (e <= s) continue;
    found = true;
    const n = re - rs || 1;
    const f1 = (s - rs) / n;
    const f2 = (e - rs) / n;
    const rx1 = run.x + f1 * run.w;
    const rx2 = run.x + f2 * run.w;
    if (rx1 < x1) x1 = rx1;
    if (rx2 > x2) x2 = rx2;
    if (run.y < y1) y1 = run.y;
    if (run.y + run.h > y2) y2 = run.y + run.h;
  }

  if (!found) return null;
  return { x: x1, y: y1, w: Math.max(0.6, x2 - x1), h: Math.max(1, y2 - y1) };
}

/** 选区的纯文本（用于 Callout 里的引用行、面板里的摘要） */
export function selectionText(index: TextPageIndex, selection: Quad): string {
  const { lines } = index;
  if (lines.length === 0) return "";
  const l1 = clampInt(Math.min(selection[0], selection[2]), 0, lines.length - 1);
  const l2 = clampInt(Math.max(selection[0], selection[2]), 0, lines.length - 1);
  const out: string[] = [];
  for (let i = l1; i <= l2; i++) {
    const line = lines[i];
    const from = i === l1 ? selection[1] : 0;
    const to = i === l2 ? selection[3] : line.text.length;
    out.push(line.text.slice(clampInt(from, 0, line.text.length), clampInt(to, 0, line.text.length)));
  }
  return out.join("\n").trim();
}

/* ------------------------------------------------------------------ *
 * 写：选区矩形 → selection
 * ------------------------------------------------------------------ */

/** 一行被选中的判定阈值：垂直重叠 / 较小行高 */
const LINE_COVER_RATIO = 0.3;
/** 水平方向至少要覆盖这么宽（pt），否则视为误触 */
const MIN_COVER_WIDTH = 0.8;

/**
 * 把从 DOM 选区拿到的矩形（BASE/pt）翻译成链接里的字符索引。
 *
 * 思路：不做 OCR、不读 DOM 文本，只做几何对齐 ——
 *   ① 行与矩形垂直重叠够多 → 该行被选中；
 *   ② 该行被矩形覆盖的 x 区间 → 用 run 的宽度线性插值出字符下标。
 * ② 对等宽字体（中文、代码）几乎精确；对西文比例字体误差在 ±1 字符内，
 * 只影响高亮边界的「半个字母」，不影响整段定位。
 */
export function rectsToSelection(index: TextPageIndex, rects: Rect[]): Quad | null {
  if (index.lines.length === 0 || rects.length === 0) return null;

  const covered: Array<{ line: TextLine; x1: number; x2: number }> = [];

  for (const line of index.lines) {
    let best: { x1: number; x2: number; ratio: number } | null = null;
    for (const r of rects) {
      const overlapY = Math.min(line.y + line.h, r.y + r.h) - Math.max(line.y, r.y);
      if (overlapY <= 0) continue;
      const ratio = overlapY / Math.max(1, Math.min(line.h, r.h));
      if (ratio < LINE_COVER_RATIO) continue;
      const x1 = Math.max(line.x, r.x);
      const x2 = Math.min(line.x + line.w, r.x + r.w);
      if (x2 - x1 < MIN_COVER_WIDTH) continue;
      if (!best || ratio > best.ratio) best = { x1, x2, ratio };
    }
    if (best) covered.push({ line, x1: best.x1, x2: best.x2 });
  }

  if (covered.length === 0) return null;

  const first = covered[0];
  const last = covered[covered.length - 1];
  return [first.line.index, charAtX(first.line, first.x1), last.line.index, charAtX(last.line, last.x2)];
}

/** x 坐标 → 行内字符下标（线性插值；落在块间空隙时归到下一块开头） */
export function charAtX(line: TextLine, x: number): number {
  for (const run of line.runs) {
    if (x <= run.x) return run.charStart;
    if (x < run.x + run.w) {
      const n = run.text.length;
      if (n === 0) return run.charStart;
      const f = (x - run.x) / (run.w || 1);
      return run.charStart + clampInt(Math.round(f * n), 0, n);
    }
  }
  return line.text.length;
}

/* ------------------------------------------------------------------ *
 * 链接 → NORM 矩形（渲染回链高亮的唯一入口）
 * ------------------------------------------------------------------ */

/**
 * 一条链接在某页上覆盖的矩形，单位是 NORM（0~1，相对页面左上角）。
 * 两种来源：
 *   · selection → 文本索引 → 行级矩形
 *   · rect      → PDF 用户空间 → viewport 变换 → 归一化
 */
export function linkRectsOnPage(target: PdfLinkTarget, index: TextPageIndex): Rect[] {
  const norm = (r: Rect): Rect => ({
    x: r.x / index.width,
    y: r.y / index.height,
    w: r.w / index.width,
    h: r.h / index.height,
  });

  if (target.selection) return selectionToRects(index, target.selection).map(norm);

  if (target.rect) {
    const [left, bottom, right, top] = target.rect;
    // PDF 用户空间（y 向上）→ viewport 空间（y 向下）。
    // 必须走 transform 而不是 width-bottom：CropBox 偏移的 PDF（很常见）
    // 直接用「页高减 y」会整体偏移几十 pt。
    const p1 = applyTransform(index.transform, left, top);
    const p2 = applyTransform(index.transform, right, bottom);
    const x1 = Math.min(p1.x, p2.x);
    const y1 = Math.min(p1.y, p2.y);
    const x2 = Math.max(p1.x, p2.x);
    const y2 = Math.max(p1.y, p2.y);
    return [norm({ x: x1, y: y1, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) })];
  }

  return [];
}

/** 链接指向的那段文字（面板摘要、Callout 引用） */
export function linkText(target: PdfLinkTarget, index: TextPageIndex): string | null {
  if (!target.selection) return null;
  const text = selectionText(index, target.selection);
  return text || null;
}

/**
 * BASE 矩形 → `rect=` 参数（PDF 用户空间，左/下/右/上）。
 *
 * ★ 必须用 viewport 变换的**逆矩阵**，不能用「页高 − y」。
 *   CropBox 带偏移的 PDF（学术论文里非常普遍）页高 ≠ f，
 *   直接减会整体偏移几到几十 pt，写出去的链接再读回来就错位了。
 */
export function rectToPdfQuad(rect: Rect, transform: number[]): Quad {
  const inv = invertTransform(transform);
  const p1 = applyTransform(inv, rect.x, rect.y);
  const p2 = applyTransform(inv, rect.x + rect.w, rect.y + rect.h);
  const left = Math.min(p1.x, p2.x);
  const right = Math.max(p1.x, p2.x);
  const bottom = Math.min(p1.y, p2.y);
  const top = Math.max(p1.y, p2.y);
  return [round2(left), round2(bottom), round2(right), round2(top)];
}

/** 2×3 仿射矩阵求逆；退化时返回单位阵（宁可位置不准，也不要 NaN 链接） */
export function invertTransform(m: number[]): number[] {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  return [
    d / det,
    -b / det,
    -c / det,
    a / det,
    (c * f - d * e) / det,
    (b * e - a * f) / det,
  ];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.round(v);
  return n < lo ? lo : n > hi ? hi : n;
}
