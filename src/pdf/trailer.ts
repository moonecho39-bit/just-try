/**
 * trailer.ts —— PDF 尾部垃圾的识别与裁剪（纯字节运算，零 Obsidian 依赖）
 *
 * ── 为什么会有这个文件 ──────────────────────────────────────────────
 * 知网 / 万方的下载器会在 `%%EOF` **之后**再追加一段 `WebFastLoad` 的 XML 元数据
 * （DOI、文件名、表名之类）。多数解析器会从文件末尾往回找 `startxref`，
 * 尾部多出非空白字节时找不到，于是判定"无法解析"。
 *
 * 表现就是：**同一个文件**在 Edge / 新版 pdf.js 里正常 15 页，
 * 在 Obsidian 内置查看器里是空白页 + `0 / 0`。
 *
 * 修法本身很简单（截断到最后一个 `%%EOF`），但必须做得可验证：
 * 所以这里全是纯函数，能单测，也方便将来扩展到"批量体检整个库"。
 */

const EOF_PATTERN = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%EOF" 去掉一个 %，实际匹配 "%%EOF"

/** 允许出现在 `%%EOF` 之后、仍算"干净"的字节：各类空白 + NUL 填充 */
function isBlank(b: number): boolean {
  return b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09 || b === 0x00 || b === 0x0c;
}

/**
 * 最后一个 `%%EOF` 的**结束位置**（指向 F 之后那个字节）；找不到返回 -1。
 *
 * 从后往前找而不是从前：增量更新过的 PDF 会有多个 `%%EOF`，
 * 只有最后一个才是当前版本的结束标记；前面的都在有效数据中间。
 */
export function lastEofEnd(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n < EOF_PATTERN.length) return -1;
  for (let i = n - EOF_PATTERN.length; i >= 0; i--) {
    let hit = true;
    for (let k = 0; k < EOF_PATTERN.length; k++) {
      if (bytes[i + k] !== EOF_PATTERN[k]) {
        hit = false;
        break;
      }
    }
    if (hit) return i + EOF_PATTERN.length;
  }
  return -1;
}

/** `%%EOF` 之后追加的**非空白**字节数；干净文件返回 0，找不到 EOF 返回 -1 */
export function trailingJunkLength(bytes: Uint8Array): number {
  const end = lastEofEnd(bytes);
  if (end < 0) return -1;
  let junk = 0;
  for (let i = end; i < bytes.length; i++) {
    if (!isBlank(bytes[i])) junk++;
  }
  return junk;
}

/**
 * 裁掉尾部垃圾，返回一个新的字节数组；无需裁剪时返回 null。
 *
 * 返回新数组而不是原地截断：调用方要拿它去写副本，
 * 原文件的字节必须原样不动（用户的文件不该被我们改写）。
 */
export function trimTrailingJunk(bytes: Uint8Array): Uint8Array | null {
  const end = lastEofEnd(bytes);
  if (end < 0) return null;
  if (trailingJunkLength(bytes) <= 0) return null;
  const out = new Uint8Array(end + 1);
  out.set(bytes.subarray(0, end));
  out[end] = 0x0a; // 补一个换行，符合 PDF 规范的习惯写法
  return out;
}

/**
 * 修复版副本的路径：`论文.pdf` → `论文（修复版）.pdf`，重名则追加序号。
 * `taken` 由调用方注入（vault 是否已存在该文件），保持本模块无依赖。
 */
export function repairedCopyPath(path: string, taken: (p: string) => boolean = () => false): string {
  const cut = path.lastIndexOf(".");
  const base = cut > 0 ? path.slice(0, cut) : path;
  const ext = cut > 0 ? path.slice(cut) : ".pdf";
  const first = `${base}（修复版）${ext}`;
  if (!taken(first)) return first;
  for (let i = 2; i < 100; i++) {
    const next = `${base}（修复版 ${i}）${ext}`;
    if (!taken(next)) return next;
  }
  return `${base}（修复版 ${Date.now()}）${ext}`;
}
