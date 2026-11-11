/**
 * cmaps-smoke.cjs —— 内嵌 CMap 表的完整性检查
 *
 * 为什么单独一个脚本：src/pdf/cmaps.ts 有 1.5 MB 的 base64，
 * 塞进主测试包会让每次跑测试都多打包一兆多。这里直接读源码文本校验，
 * 既不依赖打包，也能在 CI 上跑。
 *
 * 检查四件事：
 * ① 生成的文件在，且条目数合理（不是被截断的半截文件）；
 * ② 中文必需的几个 CMap 都在（缺一个 = 某类中文 PDF 全变空白）；
 * ③ 每条 base64 长度是 4 的倍数、只含合法字符（能解码）；
 * ④ 抽样解码后的字节数与 node_modules 里的原文件一致（转发过程没损坏）。
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const srcFile = path.join(root, "src", "pdf", "cmaps.ts");
const pdfjsDir = path.join(root, "node_modules", "pdfjs-dist", "cmaps");

const fails = [];
const ok = (msg) => console.log("  ✓ " + msg);
const bad = (msg) => {
  fails.push(msg);
  console.log("  ✗ " + msg);
};

console.log("\n[CMap] 内嵌表完整性");

if (!fs.existsSync(srcFile)) {
  bad("src/pdf/cmaps.ts 不存在，先跑 node scripts/gen-cmaps.mjs");
  process.exit(1);
}

const text = fs.readFileSync(srcFile, "utf8");
const entries = new Map();
for (const m of text.matchAll(/^ {2}"([^"]+)": "([A-Za-z0-9+/=]+)",$/gm)) {
  entries.set(m[1], m[2]);
}

entries.size >= 100 ? ok(`条目 ${entries.size} 个`) : bad(`条目只有 ${entries.size} 个，疑似生成不完整`);

/* 中文场景的必需项：简体的 GB / GBK / UniGB，繁体的 B5 / ETen / UniCNS */
const required = [
  "GBK-EUC-H",
  "GBK-EUC-V",
  "GB-EUC-H",
  "UniGB-UCS2-H",
  "UniGB-UTF16-H",
  "Adobe-GB1-UCS2",
  "B5pc-H",
  "ETen-B5-H",
  "HKscs-B5-H",
  "UniCNS-UCS2-H",
  "Adobe-CNS1-UCS2",
];
const missing = required.filter((n) => !entries.has(n));
missing.length === 0
  ? ok(`中文必需 CMap 齐备（${required.length} 项）`)
  : bad(`缺少 ${missing.join(", ")}`);

let malformed = 0;
for (const [, b64] of entries) {
  if (b64.length % 4 !== 0) malformed++;
}
malformed === 0 ? ok("base64 长度均为 4 的倍数") : bad(`${malformed} 条 base64 长度非法`);

/* 抽样比对：解码长度必须与 pdfjs-dist 里的 .bcmap 原文件一致 */
let compared = 0;
for (const name of ["GBK-EUC-H", "Adobe-GB1-UCS2", "UniGB-UCS2-H"]) {
  const b64 = entries.get(name);
  const original = path.join(pdfjsDir, name + ".bcmap");
  if (!b64 || !fs.existsSync(original)) continue;
  const decoded = Buffer.from(b64, "base64");
  const raw = fs.readFileSync(original);
  if (decoded.length !== raw.length) {
    bad(`${name} 解码后 ${decoded.length} 字节，原文件 ${raw.length} 字节`);
  } else if (!decoded.equals(raw)) {
    bad(`${name} 内容与原文件不一致`);
  } else {
    compared++;
  }
}
compared === 3
  ? ok("抽样 3 个解码后与原文件逐字节一致")
  : bad(`只有 ${compared}/3 个抽样通过`);

if (fails.length) {
  console.error(`\nCMap 检查失败 ${fails.length} 项。`);
  process.exit(1);
}
console.log("CMap 检查通过。");
