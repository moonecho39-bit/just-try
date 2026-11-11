/**
 * cmapFactory.ts —— 把内嵌的 CMap 表喂给 pdf.js
 *
 * pdf.js 默认走 DOMCMapReaderFactory：给一个 cMapUrl，运行时去 fetch
 * `${cMapUrl}${name}.bcmap`。这条路在 Obsidian 里走不通，原因见
 * scripts/gen-cmaps.mjs 的注释（app:// 协议 + 单文件分发）。
 *
 * 所以这里实现一个同形状的工厂：pdf.js 支持的 `CMapReaderFactory` 参数
 * 只要求对象有 `fetch({ name })` 方法，返回 `{ cMapData, compressionType }`。
 * 两者对上即可，不需要继承 pdf.js 的基类。
 *
 * compressionType 取 1（CMapCompressionType.BINARY），因为 .bcmap 是打包
 * 过的二进制格式，不是明文 CMap 文本。
 */

import { CMAP_DATA } from "./cmaps";

/** pdf.js 的 CMapCompressionType.BINARY；取字面量以免依赖内部枚举导出 */
const CMapCompressionTypeBINARY = 1;

/**
 * base64 → 字节数组。
 *
 * 优先用 atob（Chromium 与 Node ≥16 都有），失败时退回手写解码，
 * 避免某些受限环境里 atob 被替换成非标准实现。
 */
export function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const table =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = table.indexOf(clean[i]);
    const c2 = table.indexOf(clean[i + 1]);
    const c3 = clean[i + 2] ? table.indexOf(clean[i + 2]) : -1;
    const c4 = clean[i + 3] ? table.indexOf(clean[i + 3]) : -1;
    if (o < out.length) out[o++] = (c1 << 2) | (c2 >> 4);
    if (c3 >= 0 && o < out.length) out[o++] = ((c2 & 15) << 4) | (c3 >> 2);
    if (c4 >= 0 && o < out.length) out[o++] = ((c3 & 3) << 6) | c4;
  }
  return out;
}

/** 同一个 CMap 会被多个字体请求，解一次留着 */
const cache = new Map<string, Uint8Array>();

/**
 * 取一个 CMap 的二进制内容。
 * 抽成独立函数是为了能被单测直接调用（不必构造工厂、也不必起 pdf.js）。
 */
export function getCMapBytes(name: string): Uint8Array | null {
  const hit = cache.get(name);
  if (hit) return hit;

  const b64 = CMAP_DATA[name];
  if (!b64) return null;

  const bytes = decodeBase64(b64);
  cache.set(name, bytes);
  return bytes;
}

/** 供测试与诊断：已内嵌的 CMap 名 */
export function listCMapNames(): string[] {
  return Object.keys(CMAP_DATA);
}

/**
 * pdf.js 的 `CMapReaderFactory` 参数接受一个**类**（内部会 new 一次，
 * 传入 { baseUrl, isCompressed }）。构造参数我们不使用——数据是内嵌的。
 */
export class EmbeddedCMapReaderFactory {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_options?: { baseUrl?: string | null; isCompressed?: boolean }) {
    /* 无外部资源可配 */
  }

  async fetch({ name }: { name: string }): Promise<{
    cMapData: Uint8Array;
    compressionType: number;
  }> {
    const bytes = getCMapBytes(name);
    if (!bytes) {
      /*
       * 这里抛出而不是静默降级：缺表的表现是「那种语言的文字整片消失」，
       * 用户会以为是文件坏了。把缺失的 CMap 名带上，至少日志里能自证。
       */
      throw new Error(
        `未内置 CMap「${name}」。pdfjs-dist 里没有这个名字，或 gen-cmaps 生成时被过滤掉了。`
      );
    }
    return { cMapData: bytes, compressionType: CMapCompressionTypeBINARY };
  }
}
