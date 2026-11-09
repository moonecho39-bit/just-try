/**
 * noteFormat.ts —— 便签与 AI 结果块的**纯字符串格式**（零 Obsidian 依赖，可单测）
 *
 * ── 为什么不把正文塞进 PDF 链接参数 ────────────────────────────────
 * 链接是**定位信息**，不是**内容**。把正文塞进 `&note=` 会有四个立刻可见的后果：
 *   ① 链接会变成几 KB 长，Markdown 源码里一行横着拉出屏幕，没法读、没法 diff；
 *   ② URL 参数里不能有换行，多段 Markdown / 列表 / 图片全部退化成 `%0A`；
 *   ③ 笔记的「反向链接」面板会显示成一坨乱码（它就是拿链接文本渲染的）；
 *   ④ 违反插件第一原则：把插件卸了，笔记要**依然好看、依然能读**。
 * PDF++ 的做法正是把正文留在 Markdown 里、只让链接负责"指哪打哪"，这里沿用。
 *
 * ── 存储形态（一个便签 = 一个 Callout + 一个块引用锚点）──────────────
 *
 *   > [!PDF-note|yellow] [[论文.pdf#page=3&rect=72,600,90,620|论文, p.3]]
 *   > 这里是 **Markdown** 正文
 *   >
 *   > ![[附件/pasted-2026.png]]
 *
 *   ^pdfa-note-a1b2c3
 *
 * 三个角色各司其职：
 *   · Callout 第一行 = **回链**（PDF 哪一页、哪一块），点它跳回 PDF；
 *   · Callout 正文 = 内容，纯 Markdown，Obsidian 原生渲染；
 *   · `^pdfa-note-<id>` = **块引用锚点**，PDF 上的图钉指向它。
 * 于是 PDF 与笔记之间是两条**对称的普通链接**，没有任何私有容器格式。
 *
 * ── 为什么块引用锚点必须写在 Callout 外面 ──────────────────────────
 * Obsidian 只把「空行之后、独占一行」的 `^id` 认作块引用；
 * 写在 `>` 引用块内部时它只是普通文本，跳转会失效。
 * 代价是源码里多一行，收益是点图钉真能跳到。
 */

import { buildPdfLink, defaultAlias, parsePdfLink } from "../link/format";
import type { Quad } from "../link/format";

/** 块引用锚点的前缀。改它等于让所有旧笔记的图钉失效，所以当常量锁死 */
export const NOTE_ANCHOR_PREFIX = "pdfa-note-";

/** Callout 的类型名（`[!PDF-note]`），用于解析时认领自己写下的块 */
export const NOTE_CALLOUT = "PDF-note";

export interface NoteLocationSettings {
  noteLocation: "source" | "folder";
  noteFolder: string;
  noteSuffix: string;
}

/** 一条已落盘的便签 */
export interface StoredNote {
  /** 稳定 id（= 批注 id），不进标题，只进锚点 */
  id: string;
  page: number;
  color: string;
  /** `[[论文.pdf#page=3&rect=…]]` 原文（不含别名） */
  link: string;
  /** Markdown 正文 */
  body: string;
  /** 在文件里的行号（0 基），用于"跳回这条便签" */
  startLine: number;
}

/* ------------------------------------------------------------------ *
 * 路径与链接
 * ------------------------------------------------------------------ */

/** 与 Obsidian 的 normalizePath 等价的最小实现（避免这里依赖 obsidian） */
function tidyPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\s+$/g, "");
}

/**
 * 伴生笔记路径。
 *   source: 论文/社会保险法.pdf → 论文/社会保险法 (pdf-notes).md
 *   folder: 论文/社会保险法.pdf → PDF 批注/社会保险法 (pdf-notes).md
 */
export function companionPath(pdfPath: string, s: NoteLocationSettings): string {
  const base = (pdfPath.split("/").pop() ?? "untitled.pdf").replace(/\.pdf$/i, "");
  const name = `${base} (${s.noteSuffix || "pdf-notes"}).md`;
  if (s.noteLocation === "folder") {
    const folder = (s.noteFolder || "PDF 批注").replace(/^\/+|\/+$/g, "");
    return tidyPath(`${folder}/${name}`);
  }
  const dir = pdfPath.includes("/") ? pdfPath.slice(0, pdfPath.lastIndexOf("/")) : "";
  return tidyPath(dir ? `${dir}/${name}` : name);
}

/** 图钉要跳的链接：`[[论文 (pdf-notes).md#^pdfa-note-abc]]` */
export function anchorLink(companionFile: string, id: string): string {
  return `[[${companionFile}#^${NOTE_ANCHOR_PREFIX}${id}]]`;
}

/** 锚点行（独占一行，前面必须有空行） */
export function anchorLine(id: string): string {
  return `^${NOTE_ANCHOR_PREFIX}${id}`;
}

/** 从锚点文本里取 id；不是我们的锚点返回 null */
export function parseAnchor(line: string): string | null {
  const m = /^\^pdfa-note-([A-Za-z0-9_-]+)\s*$/.exec(line.trim());
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ *
 * 序列化
 * ------------------------------------------------------------------ */

export interface NoteBlockInput {
  id: string;
  page: number;
  color: string;
  /** 完整链接（可带别名） */
  link: string;
  body: string;
}

/** 生成一条便签的完整 Markdown */
export function renderNoteBlock(note: NoteBlockInput): string {
  const header = `> [!${NOTE_CALLOUT}|${colorToken(note.color)}] ${note.link}`;
  const body = note.body.replace(/\s+$/, "");
  const lines = [header];
  if (body) {
    for (const line of body.split(/\r?\n/)) lines.push(line ? `> ${line}` : ">");
  }
  return `${lines.join("\n")}\n\n${anchorLine(note.id)}`;
}

/**
 * 颜色 token：Callout 的类型后缀只接受简单标识符。
 * 自定义色 `#FFE066` 会把 `|` 之后的解析搞乱，所以转成 `hex-FFE066`。
 */
export function colorToken(color: string): string {
  const c = (color || "").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return `hex-${c.slice(1)}`;
  if (/^[a-z-]+$/.test(c)) return c;
  return "yellow";
}

/** 反向：`hex-FFE066` → `#FFE066`；命名色原样 */
export function colorFromToken(token: string): string {
  const m = /^hex-([0-9a-f]{6})$/i.exec(token);
  return m ? `#${m[1].toUpperCase()}` : token || "yellow";
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/**
 * 从文件全文里捞出所有便签块。
 *
 * 扫描规则（只认我们自己写出来的形状，不做通用 Markdown 解析）：
 *   遇到 `> [!PDF-note…` 记为块头；
 *   遇到顶格的 `^pdfa-note-<id>` 记为块尾；
 *   中间的 `> ` 行去掉一层前缀就是正文。
 * 好处：块与块之间夹着用户手写的其它内容也不会被吞掉。
 */
export function parseNoteBlocks(text: string): StoredNote[] {
  const lines = text.split(/\r?\n/);
  const out: StoredNote[] = [];

  let head = -1;
  let headLine = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (/^>\s*\[!PDF-note/i.test(trimmed)) {
      head = i;
      headLine = trimmed;
      continue;
    }

    const id = parseAnchor(line);
    if (!id || head < 0) continue;

    const body: string[] = [];
    for (let k = head + 1; k < i; k++) {
      const raw = lines[k];
      if (!raw.startsWith(">")) {
        if (raw.trim() === "") body.push("");
        continue;
      }
      body.push(raw.replace(/^>\s?/, ""));
    }

    const meta = parseHeader(headLine);
    out.push({
      id,
      page: meta.page,
      color: meta.color,
      link: meta.link,
      body: body.join("\n").replace(/\s+$/, ""),
      startLine: head,
    });
    head = -1;
    headLine = "";
  }
  return out;
}

function parseHeader(line: string): { page: number; color: string; link: string } {
  const colorMatch = /\[!PDF-note\|([^\]]+)\]/i.exec(line);
  const color = colorMatch ? colorFromToken(colorMatch[1].trim()) : "yellow";
  const linkMatch = /\[\[[^\]]+\]\]/.exec(line);
  const link = linkMatch ? linkMatch[0] : "";
  const target = link ? parsePdfLink(link) : null;
  return { page: target?.page ?? 1, color, link };
}

/* ------------------------------------------------------------------ *
 * 增删改（纯字符串，行级替换 —— 不重排整份文件）
 * ------------------------------------------------------------------ */

/**
 * 插入或更新一条便签。
 *
 * 为什么用"行级替换"而不是"解析成对象再整份重写"：
 * 伴生笔记是用户也能编辑的普通文件，整份重写会把用户手加的标题、
 * 空行风格、甚至别人的备注全部抹平。只动自己那一块最安全。
 */
export function upsertNoteBlock(text: string, note: NoteBlockInput): string {
  const block = renderNoteBlock(note);
  const range = findBlockRange(text, note.id);
  if (!range) return appendBlock(text, block);

  const lines = text.split(/\r?\n/);
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end + 1);
  while (after.length > 0 && after[0].trim() === "") after.shift();

  const merged = [...before, ...block.split("\n")];
  if (after.length > 0) merged.push("", ...after);
  return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "")}\n`;
}

export function removeNoteBlock(text: string, id: string): string {
  const range = findBlockRange(text, id);
  if (!range) return text;
  const lines = text.split(/\r?\n/);
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end + 1);
  while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
  while (after.length > 0 && after[0].trim() === "") after.shift();
  const merged = before.length > 0 && after.length > 0 ? [...before, "", ...after] : [...before, ...after];
  return merged.join("\n").replace(/\s+$/, "") + (merged.length ? "\n" : "");
}

/** 找到某条便签占用的行区间 [start, end]（含块头与锚点行） */
export function findBlockRange(text: string, id: string): { start: number; end: number } | null {
  const lines = text.split(/\r?\n/);
  const anchorIdx = lines.findIndex((l) => parseAnchor(l) === id);
  if (anchorIdx < 0) return null;
  let start = -1;
  for (let i = anchorIdx - 1; i >= 0; i--) {
    if (/^>\s*\[!PDF-note/i.test(lines[i].trimStart())) {
      start = i;
      break;
    }
    // 撞到上一个锚点说明数据坏了（有锚点没块头），保守放弃
    if (parseAnchor(lines[i])) break;
  }
  if (start < 0) return null;
  return { start, end: anchorIdx };
}

function appendBlock(text: string, block: string): string {
  const cur = text.replace(/\s+$/, "");
  if (!cur) return `${block}\n`;
  return `${cur}\n\n${block}\n`;
}

/* ------------------------------------------------------------------ *
 * 图钉位置：从 rect= 反算 NORM
 * ------------------------------------------------------------------ */

/**
 * rect（PDF 用户空间，y 向上）→ 页面 NORM 中心点。
 *
 * 用 viewport 变换的**正变换**：`apply(transform, x, y)` 正是 pdf.js 把
 * 用户空间转到视口空间用的那条。四角都转一遍再取包围盒，
 * 这样页面带旋转（viewport.rotation = 90/180）也算得对。
 */
export function quadCenterToNorm(
  quad: Quad,
  transform: number[],
  width: number,
  height: number,
  apply: (m: number[], x: number, y: number) => { x: number; y: number },
): { x: number; y: number } {
  const [l, b, r, t] = quad;
  const pts = [apply(transform, l, b), apply(transform, r, b), apply(transform, l, t), apply(transform, r, t)];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  return {
    x: clamp01((Math.min(...xs) + Math.max(...xs)) / 2 / width),
    y: clamp01((Math.min(...ys) + Math.max(...ys)) / 2 / height),
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(0.999, Math.max(0.001, n));
}

/* ------------------------------------------------------------------ *
 * AI 结果块
 * ------------------------------------------------------------------ */

/**
 * 「引用 + AI 解读」的落盘形态：
 *
 *   > [!PDF|yellow] [[论文.pdf#page=3&selection=8,0,10,45|论文, p.3]]
 *   > > 被解读的原文
 *   >
 *   > **AI 翻译**
 *   > 结果……
 *
 * `> >` 只给**原文**用（PDF++ 的引用约定），AI 结果用单层 `>`，
 * 渲染出来是「Callout 里嵌一个引用块 + 正文」，层次一眼能分。
 */
export function renderAiBlock(opts: {
  link: string;
  color: string;
  quote?: string | null;
  heading: string;
  text: string;
}): string {
  const lines = [`> [!PDF|${colorToken(opts.color)}] ${opts.link}`];
  if (opts.quote && opts.quote.trim()) {
    for (const line of opts.quote.trim().split(/\r?\n/)) lines.push(line ? `> > ${line}` : "> >");
    lines.push(">");
  }
  lines.push(`> **${opts.heading}**`);
  for (const line of opts.text.trim().split(/\r?\n/)) lines.push(line ? `> ${line}` : ">");
  return lines.join("\n");
}

/** 给链接补别名（`|论文, p.3`），已有别名则原样返回 */
export function withAlias(link: string, pdfPath: string, page: number): string {
  if (!link.endsWith("]]") || link.slice(0, -2).includes("|")) return link;
  return `${link.slice(0, -2)}|${defaultAlias(pdfPath, page)}]]`;
}

/** 便捷：按参数直接造一条带别名的 PDF 链接 */
export function pdfLink(pdfPath: string, page: number, rect: Quad | null, color: string): string {
  return withAlias(buildPdfLink({ path: pdfPath, page, rect, color }), pdfPath, page);
}
