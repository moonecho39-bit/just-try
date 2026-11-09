/**
 * format.ts —— PDF 链接的语法层（纯函数，零依赖，可单测）
 *
 * ── 这是整个插件的存储层 ────────────────────────────────────────────
 * 高亮不写 JSON、不写 PDF、不写侧挂文件，只写成 Markdown 里的一条**普通链接**：
 *
 *   [[论文.pdf#page=3&selection=8,0,10,45&color=yellow]]
 *   [[论文.pdf#page=3&rect=72,600,300,640&color=red]]
 *
 * 除了 `&color=` / `&rect=` 这两个可选参数，不引入任何私有语法 ——
 * 把插件卸掉，笔记依然能被 Obsidian 正常解析，链接依然能点开 PDF。
 * 坐标不落盘：highlight 的几何是**打开 PDF 时从文本重新算出来的**。
 *
 * ── 参数语义（严格对齐 PDF++）───────────────────────────────────────
 *   page=N                      页码，从 1 开始
 *   selection=l1,c1,l2,c2       文本选区 = （起始行, 起始字符, 结束行, 结束字符）
 *                               ★ 注意：不是 x1,y1,x2,y2 坐标！是「第 l1 行第 c1 个
 *                                 字符 → 第 l2 行第 c2 个字符」。行/字符是索引，
 *                                 不是位置，所以缩放、换设备、换渲染精度都不会漂。
 *                                 真实 PDF++ 链接 `selection=8,0,10,45` 就是这个含义：
 *                                 第 8 行第 0 字 → 第 10 行第 45 字。
 *   rect=l,b,r,t                矩形区域 = （左, 下, 右, 上），PDF 用户空间（y 向上），
 *                               单位 pt。用于图片、表格、空白处的框选。
 *   color=NAME                  可选，颜色名（yellow/red/…）或裸 hex（FFE066）
 *   offset=l,t,zoom             可选，Obsidian 原生参数，纯滚动位置，我们不生成但会保留
 *   annotation=ID               可选，PDF 原生批注 id（来自 PDF++ 的另一种模式），只读忽略
 *
 * 为什么 selection 必须是索引而不是坐标：
 *   坐标方案在下列任一情况下都会「高亮跑到别的地方去」，而索引方案不会：
 *     · 用户在另一台机器上用不同 DPI 打开；· PDF 被重新裁剪（CropBox 变了）；
 *     · 我们自己改了行合并的容差。索引只依赖「文本内容本身」，内容不变则位置不变。
 *   代价是：必须能拿到文本层（扫描版 PDF 没有文本层，只能退化用 rect=）。
 */

/** 四元组：selection 是 (l1,c1,l2,c2)，rect 是 (l,b,r,t) */
export type Quad = [number, number, number, number];

/** 链接在源文件中的位置（与 Obsidian metadataCache 的 Loc 结构一致） */
export interface LinkPosition {
  start: { line: number; col: number; offset: number };
  end: { line: number; col: number; offset: number };
}

/** 颜色：name 是链接里写的名字（可能为 null，说明写的是裸 hex） */
export interface LinkColor {
  /** 写进链接的参数值（已知色名就用名字，未知就用裸 hex） */
  param: string;
  /** 规范化后的 #rrggbb */
  hex: string;
  /** 已知色名时给出名字，否则 null */
  name: string | null;
}

/**
 * 回链高亮的命名色板。
 * 与「取色器色组」分开：这里是**协议层**，一旦改了名字，用户已有的笔记就变色，
 * 所以要当成公开 API 对待，只能加不能改。
 */
export const LINK_COLORS: ReadonlyArray<{ name: string; hex: string; label: string }> = [
  { name: "yellow", hex: "#FFE066", label: "黄" },
  { name: "orange", hex: "#FFB454", label: "橙" },
  { name: "red", hex: "#FF8C8C", label: "红" },
  { name: "pink", hex: "#FFA6D2", label: "粉" },
  { name: "purple", hex: "#C7A6FF", label: "紫" },
  { name: "blue", hex: "#8FC5F5", label: "蓝" },
  { name: "cyan", hex: "#8FE3E8", label: "青" },
  { name: "green", hex: "#A3E2A8", label: "绿" },
  { name: "gray", hex: "#C4C4C4", label: "灰" },
];

export const DEFAULT_LINK_COLOR = LINK_COLORS[0];

/** 少数常见别名，避免用户从别处抄来的链接整条失效 */
const COLOR_ALIASES: Record<string, string> = {
  grey: "gray",
  amber: "orange",
  violet: "purple",
  magenta: "pink",
};

export function linkColorByName(name: string): { name: string; hex: string; label: string } | null {
  const key = name.trim().toLowerCase();
  const direct = LINK_COLORS.find((c) => c.name === key);
  if (direct) return direct;
  const alias = COLOR_ALIASES[key];
  if (alias) return LINK_COLORS.find((c) => c.name === alias) ?? null;
  return null;
}

/** 3 位 / 6 位 hex → #rrggbb；8 位丢弃 alpha（高亮透明度由渲染层统一控制） */
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toUpperCase();
  }
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-f]{8}$/i.test(s)) return `#${s.slice(0, 6).toUpperCase()}`;
  return null;
}

/**
 * 解析 color 参数：先按色名找，再按 hex 找。
 * 解析失败返回 null，由调用方回退到默认色（**不要**抛错 ——
 * 一条颜色写错的链接不该让整个 PDF 的回链高亮全部消失）。
 */
export function parseColorParam(raw: string | null | undefined): LinkColor | null {
  if (!raw) return null;
  const byName = linkColorByName(raw);
  if (byName) return { param: byName.name, hex: byName.hex, name: byName.name };
  const hex = normalizeHex(raw);
  if (!hex) return null;
  const known = LINK_COLORS.find((c) => c.hex.toUpperCase() === hex);
  return { param: known ? known.name : hex.replace("#", ""), hex, name: known?.name ?? null };
}

/**
 * 反查颜色参数：优先写色名（可读、可被 PDF++ 识别），
 * 色值是自定义色时才写裸 hex。裸 hex 不带 `#`，因为它出现在 `#` 之后的
 * fragment 里，再写一个 `#` 会把子路径截断。
 */
export function colorParam(hexOrName: string): string {
  const byName = linkColorByName(hexOrName);
  if (byName) return byName.name;
  const hex = normalizeHex(hexOrName);
  if (hex) {
    const known = LINK_COLORS.find((c) => c.hex.toUpperCase() === hex);
    return known ? known.name : hex.replace("#", "");
  }
  return DEFAULT_LINK_COLOR.name;
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

export interface PdfLinkTarget {
  /** 链接里写的路径（可能不含 .pdf 后缀、可能是相对路径） */
  linkpath: string;
  page: number;
  selection: Quad | null;
  rect: Quad | null;
  color: LinkColor | null;
  /** 原始颜色参数值，回写 / 展示用 */
  colorRaw: string | null;
  offset: [number, number, number] | null;
  annotationId: string | null;
  alias: string | null;
  /** `#` 之后的原始子路径，用于去重与状态回填 */
  subpath: string;
}

/** 只接受「指向 PDF 且带 page」的链接；其余一律返回 null，交回 Obsidian 原生处理 */
export function parsePdfLink(input: string): PdfLinkTarget | null {
  if (!input) return null;

  let s = input.trim();
  if (s.startsWith("![[")) s = s.slice(3);
  else if (s.startsWith("[[")) s = s.slice(2);
  if (s.endsWith("]]")) s = s.slice(0, -2);

  // 别名：文件名里不可能出现 `|`，所以在第一个 `|` 处截断是安全的
  let alias: string | null = null;
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    alias = s.slice(pipe + 1).trim() || null;
    s = s.slice(0, pipe);
  }

  const hash = s.indexOf("#");
  if (hash < 0) return null;
  // 路径可能是百分号编码的（Obsidian 渲染 href 时会转义空格等字符）
  const linkpath = safeDecode(s.slice(0, hash).trim());
  const subpath = s.slice(hash + 1).trim();
  if (!linkpath || !/\.pdf$/i.test(linkpath)) return null;

  const params = new URLSearchParams(subpath.replace(/&amp;/g, "&"));
  const page = parsePage(params.get("page"));
  if (page === null) return null;

  const colorRaw = params.get("color");
  return {
    linkpath,
    page,
    selection: parseNumbers(params.get("selection"), 4) as Quad | null,
    rect: parseNumbers(params.get("rect"), 4) as Quad | null,
    color: parseColorParam(colorRaw),
    colorRaw,
    offset: parseNumbers(params.get("offset"), 3) as [number, number, number] | null,
    annotationId: params.get("annotation") || null,
    alias,
    subpath,
  };
}

function parsePage(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // 容错：PDF++ 允许小数页码（enhanced float parsing），这里取整
  const page = Math.round(n);
  return page >= 1 ? page : null;
}

/** 严格按个数校验：多一个少一个都算坏链接，而不是尽力猜测 */
function parseNumbers(raw: string | null, count: number): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== count) return null;
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/** 解码失败就原样返回：一条路径里出现孤立的 `%` 不该让整条链接失效 */
function safeDecode(text: string): string {
  if (!text.includes("%")) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ *
 * 构造
 * ------------------------------------------------------------------ */

export interface BuildLinkOptions {
  /** 库内相对路径，例如 "论文/社会保险法.pdf" */
  path: string;
  page: number;
  selection?: Quad | null;
  rect?: Quad | null;
  color?: string | null;
  /** 显示别名，不给就不写 `|…` */
  alias?: string | null;
}

export function buildPdfLink(opts: BuildLinkOptions): string {
  const params: string[] = [`page=${Math.max(1, Math.round(opts.page))}`];
  if (opts.selection) params.push(`selection=${opts.selection.map((n) => String(Math.round(n))).join(",")}`);
  if (opts.rect) params.push(`rect=${opts.rect.map(fmtCoord).join(",")}`);
  if (opts.color) params.push(`color=${colorParam(opts.color)}`);
  const alias = opts.alias ? `|${opts.alias}` : "";
  return `[[${opts.path}#${params.join("&")}${alias}]]`;
}

/**
 * Callout 形式（PDF++ 的默认观感）：
 *
 *   > [!PDF|yellow] [[论文.pdf#page=3&selection=8,0,10,45|论文, p.3]]
 *   > > 被高亮的那段原文
 *
 * 第二层 `> >` 是 PDF++ 的既定写法（引用行），这样渲染出来是
 * 「标题 + 引用块」，且原样仍然是合法的 Markdown。
 */
export function buildPdfCallout(opts: {
  link: string;
  color: string;
  quote?: string | null;
  note?: string | null;
}): string {
  const lines = [`> [!PDF|${colorParam(opts.color)}] ${opts.link}`];
  if (opts.quote) {
    const quoted = opts.quote.replace(/\s+$/, "");
    if (quoted) for (const line of quoted.split(/\r?\n/)) lines.push(line ? `> > ${line}` : "> >");
  }
  if (opts.note) {
    for (const line of opts.note.replace(/\s+$/, "").split(/\r?\n/)) lines.push(line ? `> ${line}` : ">");
  }
  return lines.join("\n");
}

/** 显示别名：`论文, p.3` —— 与 PDF++ 一致，让笔记里一眼能看出页码 */
export function defaultAlias(path: string, page: number): string {
  const base = path.split("/").pop() ?? path;
  return `${base.replace(/\.pdf$/i, "")}, p.${page}`;
}

/** 坐标保留 2 位小数：A4 上 0.01pt 远超人眼分辨力，也让链接短一点 */
function fmtCoord(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

/** `#` 之后的子路径单独取出来（不看文件是否存在，纯字符串） */
export function subpathOf(raw: string): string {
  const hash = raw.indexOf("#");
  return hash < 0 ? "" : raw.slice(hash + 1);
}

/** 是否是一条「我们已经能处理」的 PDF 链接（用于链接点击拦截的白名单） */
export function isPdfSubpathLink(raw: string): boolean {
  return parsePdfLink(raw) !== null;
}
