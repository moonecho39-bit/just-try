/**
 * scan.ts —— 反向链接扫描：从整个库里找出「指向这篇 PDF 的链接」
 *
 * 这是 PDF++ 最关键的一步：**PDF 没有自己的批注存储，它的批注散落在整个库的
 * 笔记里**。所以每次打开 PDF，都要反查一遍「谁引用了我」。
 *
 * ── 为什么不遍历所有 md 文件读全文 ──────────────────────────────────
 * 5000 篇笔记全读一遍是几十 MB IO。Obsidian 的 metadataCache 已经把
 * 每个文件的链接解析好放在内存里了，直接用它：
 *
 *   app.metadataCache.resolvedLinks  → { 来源路径: { 目标路径: 次数 } }
 *   app.metadataCache.getFileCache(f) → f.links[]（带行/列位置）
 *
 * 先用 resolvedLinks 做 O(1) 命中（一次哈希查找就能判断某笔记是否链接到本 PDF），
 * 只对命中的笔记再取 link 数组解析参数。全程同步、无 IO，几千篇也是毫秒级。
 *
 * ── 为什么要把 ScanHost 抽象出来 ────────────────────────────────────
 * 这样扫描逻辑可以脱离 Obsidian 单测（见 test/entry.ts 的 [I] 组）。
 * 真实实现只有 createAppScanHost 这十几行适配代码。
 */

import type { LinkPosition, PdfLinkTarget } from "./format";
import { parsePdfLink } from "./format";

export type { LinkPosition };

/** metadataCache 里的一条链接（与 obsidian 的 LinkCache 结构兼容） */
export interface CachedLinkLike {
  /** 去掉别名的原始链接，如 "论文.pdf#page=3&selection=8,0,10,45" */
  link: string;
  position: LinkPosition;
}

/** 扫描所需的最小宿主接口（真实实现用 App，测试用假对象） */
export interface ScanHost {
  /** 来源文件路径 → 目标文件路径 → 引用次数 */
  resolvedLinks: Record<string, Record<string, number>>;
  /** 该文件的链接缓存；没有缓存返回 null */
  getLinks(sourcePath: string): CachedLinkLike[] | null;
  /** 把链接里的路径解析成库内真实路径（解析不到返回 null） */
  resolveLinkpath(linkpath: string, sourcePath: string): string | null;
  /** 读文件正文（只用于抽取 Callout 引用行，按需调用） */
  readText(path: string): Promise<string>;
}

export interface BacklinkEntry {
  /** 稳定唯一键：来源 + 链接在源文件中的字节偏移。同一文件里重复贴同一条链接 = 两条 */
  key: string;
  sourcePath: string;
  /** 文件名（含后缀），面板里显示用 */
  sourceName: string;
  position: LinkPosition;
  page: number;
  target: PdfLinkTarget;
  /** Callout 下面 `> >` 引用的原文（没有则为 null） */
  quote: string | null;
}

export interface ScanResult {
  pdfPath: string;
  entries: BacklinkEntry[];
  /** 有多少条链接指向本 PDF 但解析失败（参数坏了 / 只有 #page 之外的子路径） */
  skipped: number;
  /** 扫描时读了多少个来源文件的正文（诊断用） */
  sources: number;
}

/**
 * 扫描整个库，收集指向 pdfPath 的所有可解析链接。
 *
 * 注意「可解析」的边界：只有 `#page=` 存在的链接才算。
 * 例如 `[[论文.pdf]]`（只是打开文件）或 `[[论文.pdf#page=3]]`（只跳页、没有高亮）
 * 里的后者**会**被算进来（page 有、selection 没有），因为它是合法的定位链接。
 */
export async function scanBacklinks(host: ScanHost, pdfPath: string): Promise<ScanResult> {
  const entries: BacklinkEntry[] = [];
  let skipped = 0;
  let sources = 0;

  const candidates: string[] = [];
  const resolved = host.resolvedLinks ?? {};
  for (const source of Object.keys(resolved)) {
    const targets = resolved[source];
    if (!targets) continue;
    // hasOwnProperty 而不是 `in`：目标路径可能叫 "constructor"，虽然荒谬但不能踩
    if (!Object.prototype.hasOwnProperty.call(targets, pdfPath)) continue;
    candidates.push(source);
  }

  for (const source of candidates) {
    const links = host.getLinks(source);
    if (!links) continue;
    sources++;

    for (const link of links) {
      // 便宜的前置过滤：没有 page 参数的链接根本不用解析
      if (!/[#&]page=/.test(link.link)) continue;

      const target = parsePdfLink(link.link);
      if (!target) {
        skipped++;
        continue;
      }
      // resolvedLinks 只说明「这个文件里至少有一条链到 PDF」，
      // 具体到这一条可能是链到别的 PDF —— 必须逐条确认
      if (host.resolveLinkpath(target.linkpath, source) !== pdfPath) continue;

      entries.push({
        key: `${source}#${link.position?.start?.offset ?? `${link.position?.start?.line}:${link.position?.start?.col}`}`,
        sourcePath: source,
        sourceName: source.split("/").pop() ?? source,
        position: link.position,
        page: target.page,
        target,
        quote: null,
      });
    }
  }

  await attachQuotes(host, entries);

  entries.sort((a, b) => a.page - b.page || a.sourcePath.localeCompare(b.sourcePath) || a.position.start.line - b.position.start.line);

  return { pdfPath, entries, skipped, sources };
}

/**
 * 给带 Callout 的条目补上引用原文。
 *
 * 一个来源文件只读一次（缓存），因为一篇笔记里常常有十几条高亮。
 * 读正文是这里唯一的 IO，而且只发生在**已确认链接到本 PDF** 的文件上。
 */
async function attachQuotes(host: ScanHost, entries: BacklinkEntry[]): Promise<void> {
  const byFile = new Map<string, BacklinkEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.sourcePath);
    if (list) list.push(e);
    else byFile.set(e.sourcePath, [e]);
  }

  for (const [path, list] of byFile) {
    // 只有"链接所在行以 > 开头"才可能是 Callout，否则不必读正文
    let text: string | null = null;
    try {
      text = await host.readText(path);
    } catch {
      continue;
    }
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    for (const entry of list) {
      entry.quote = extractQuote(lines, entry.position.start.line);
    }
  }
}

/** 从链接所在行之后连续读取 `> >` 引用行 */
export function extractQuote(lines: string[], linkLine: number): string | null {
  if (linkLine < 0 || linkLine >= lines.length) return null;
  const self = lines[linkLine] ?? "";
  // 链接行本身必须是引用块（Callout 或被引用的内容），否则没有"正文"可取
  if (!/^\s*>/.test(self)) return null;

  const out: string[] = [];
  for (let i = linkLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*>/.test(line)) break;
    const stripped = line
      .replace(/^\s*>\s?/, "")
      .replace(/^>\s?/, "")
      .trimEnd();
    // 遇到下一个 Callout 标题就停（`> [!...]`）
    if (/^\[!/.test(stripped)) break;
    out.push(stripped);
  }

  const text = out.join("\n").trim();
  return text.length > 0 ? text : null;
}

/* ------------------------------------------------------------------ *
 * Obsidian 适配层（唯一与 App 耦合的地方）
 * ------------------------------------------------------------------ */

interface AppLike {
  metadataCache: {
    resolvedLinks: Record<string, Record<string, number>>;
    getFileCache(file: unknown): { links?: CachedLinkLike[] } | null;
    getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null;
  };
  vault: {
    getAbstractFileByPath(path: string): unknown;
    cachedRead(file: unknown): Promise<string>;
  };
}

export function createAppScanHost(app: AppLike): ScanHost {
  return {
    get resolvedLinks() {
      return app.metadataCache.resolvedLinks;
    },
    getLinks(sourcePath: string): CachedLinkLike[] | null {
      const file = app.vault.getAbstractFileByPath(sourcePath);
      if (!file) return null;
      const cache = app.metadataCache.getFileCache(file);
      return cache?.links ?? null;
    },
    resolveLinkpath(linkpath: string, sourcePath: string): string | null {
      return app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path ?? null;
    },
    async readText(path: string): Promise<string> {
      const file = app.vault.getAbstractFileByPath(path);
      if (!file) return "";
      return app.vault.cachedRead(file);
    },
  };
}
