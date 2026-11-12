/**
 * 批注卡片验证页的入口（仅本地排查用，不进 main.js）
 *
 * 把真实的 CardOverlay 挂到假页面上，用 Edge 无头模式截图，
 * 验证三件事：右侧有地方时卡片在页面外、没地方时压回内侧、两张卡不会叠在一起。
 */

import { CardOverlay, type CardVM } from "../src/ui/noteCards";

const BODY_A = "这块现在可以用在叙述部分。";
const BODY_B = "这块不高的部分，需要看原文。";
const BODY_C = "**Interaction** —— 这一条对应摘要里的调节效应，需要和第三章的模型对上。";

function main(): void {
  const scroller = document.getElementById("scroller") as HTMLElement | null;
  if (!scroller) return;

  const overlay = new CardOverlay(scroller, {
    pageEl: (page) => document.querySelector(`.pdfa-page[data-page="${page}"]`) as HTMLElement | null,
    onEdit: () => undefined,
    onDelete: () => undefined,
    onSelect: () => undefined,
    // 验证页不引入 MarkdownRenderer，用最朴素的段落渲染代替
    renderBody: (el, body) => {
      el.textContent = body.replace(/\*\*/g, "");
    },
  });

  // 标题按「形态 · 页码」写：和参考图里「高亮 · p.2」「矩形 · p.2」一致
  // anchorLeft / anchorRight 是大致的手工值：对应 html 里那条 fake-hl 的左右端（/798）
  const vms: CardVM[] = [
    { id: "a", page: 1, color: "#f5c542", title: "高亮 · p.1", body: BODY_A, anchorTop: 127, anchorLeft: 0.075, anchorRight: 0.476 },
    { id: "b", page: 1, color: "#f6a6a6", title: "下划线 · p.1", body: BODY_B, anchorTop: 157, anchorLeft: 0.075, anchorRight: 0.426 },
    { id: "c", page: 1, color: "#b48ef0", title: "框选 · p.1", body: BODY_C, anchorTop: 707, anchorLeft: 0.075, anchorRight: 0.501 },
    // 空卡片：确认"点这里写批注…"的占位样式不会撑坏排版
    { id: "d", page: 2, color: "#8fd0c0", title: "高亮 · p.2", body: "", anchorTop: 307, anchorLeft: 0.075, anchorRight: 0.451 },
  ];
  overlay.setCards(vms);

  // 让截图前一定完成一次布局
  window.requestAnimationFrame(() => overlay.setCards(vms));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
