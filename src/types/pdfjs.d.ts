/**
 * pdfjs-dist 类型补丁
 *
 * ① `pdfjs-dist/legacy/build/pdf` 自带 pdf.d.ts（内容是 `export * from "pdfjs-dist"`），
 *    无需重复声明，此处不要覆盖，否则会与官方声明冲突。
 *
 * ② `pdf.worker.entry` 是一个纯副作用脚本（把 WorkerMessageHandler 挂到
 *    window.pdfjsWorker），包里没有 .d.ts，需要补一个空声明。
 */

declare module "pdfjs-dist/legacy/build/pdf.worker.entry" {
  const _default: unknown;
  export default _default;
}
