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

  const vms: CardVM[] = [
    { id: "a", page: 1, color: "#f5c542", title: "批注 · p.1", body: BODY_A, anchorTop: 120 },
    { id: "b", page: 1, color: "#f6a6a6", title: "批注 · p.1", body: BODY_B, anchorTop: 150 },
    { id: "c", page: 1, color: "#b48ef0", title: "批注 · p.1", body: BODY_C, anchorTop: 700 },
    { id: "d", page: 2, color: "#8fd0c0", title: "批注 · p.2", body: "第二页的批注，用来确认卡片会跟着各自的页面走。", anchorTop: 300 },
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
