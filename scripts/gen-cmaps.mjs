/**
 * 生成 src/pdf/cmaps.ts —— 把 pdf.js 的 CMap 表内嵌进插件。
 *
 * ── 为什么必须内嵌，而不是给 cMapUrl ──────────────────────────────
 * pdf.js 的默认做法是给一个 cMapUrl，运行时按 `${name}.bcmap` 去 fetch。
 * 但 Obsidian 插件跑在 app:// 协议下，既不能读 file://，也没有稳定的
 * 静态资源域名；更关键的是社区插件的发行约定只有 main.js / manifest.json /
 * styles.css 三个文件，多带一个 cmaps/ 目录会让「手动安装」「BRAT」「社区市场」
 * 三条路径全部多一步，用户漏拷就退化成中文全丢。
 * 所以直接把表打成 base64 常量，随 main.js 一起走。
 *
 * ── 为什么是全部 ────────────────────────────────────────────────
 * 缺哪个 CMap 的症状都是「那种语言的文字整片消失」，而用户无从判断，
 * 只会认为插件坏了。全量约 1.4 MB（base64 后约 1.9 MB），一次付清，
 * 换掉一整类静默失败。
 *
 * 用法：node scripts/gen-cmaps.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "node_modules", "pdfjs-dist", "cmaps");
const outFile = path.join(root, "src", "pdf", "cmaps.ts");

if (!fs.existsSync(srcDir)) {
  console.error(`找不到 ${srcDir}，先执行 npm install。`);
  process.exit(1);
}

const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith(".bcmap"))
  .sort((a, b) => a.localeCompare(b, "en"));

if (files.length === 0) {
  console.error("cmaps 目录里没有 .bcmap 文件。");
  process.exit(1);
}

let rawBytes = 0;
const lines = files.map((file) => {
  const buf = fs.readFileSync(path.join(srcDir, file));
  rawBytes += buf.length;
  const name = file.slice(0, -".bcmap".length);
  return `  ${JSON.stringify(name)}: "${buf.toString("base64")}",`;
});

const content = `/**
 * 本文件由 scripts/gen-cmaps.mjs 自动生成，请勿手工编辑。
 *
 * pdf.js 的 CMap 表（${files.length} 个，原始 ${(rawBytes / 1024 / 1024).toFixed(2)} MB）。
 * 键是 CMap 名（与 PDF 里 \`/Encoding\` 的值一致，例如 "GBK-EUC-H"），
 * 值是 .bcmap 的 base64。运行期由 EmbeddedCMapReaderFactory 解码后喂给 pdf.js。
 *
 * 背景：中文期刊 PDF（知网、万方等）大量使用 GBK-EUC-H / UniGB-UCS2-H 这类
 * 双字节 CMap，且字体不嵌入。没有这张表，pdf.js 解不出字形，但也不会报错，
 * 结果是中文整片消失、只剩数字和标点——看起来像「乱码」，其实是「缺表」。
 */
export const CMAP_DATA: Record<string, string> = {
${lines.join("\n")}
};
`;

fs.writeFileSync(outFile, content, "utf8");
console.log(
  `已生成 ${path.relative(root, outFile)}：${files.length} 个 CMap，` +
    `${(rawBytes / 1024 / 1024).toFixed(2)} MB → ${(content.length / 1024 / 1024).toFixed(2)} MB 源码`
);
