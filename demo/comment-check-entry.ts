/**
 * 评论气泡验证页的入口（仅本地排查用，不进 main.js）
 *
 * 一次摆出四种状态，用 Edge 无头模式截图核对：
 *   A 已有评论（含编辑 / 删除 / 在笔记中打开）
 *   B 没有评论（只有「添加评论」）
 *   C 正在写（textarea + 保存 / 取消）
 *   D 箭头 / 手绘（不可评论，给一句解释）
 */

import { CommentPopover, type CommentHooks } from "../src/ui/commentPopover";

function markBox(name: string, grow = 0) {
  const el = document.querySelector(`[data-mark="${name}"]`) as HTMLElement | null;
  if (!el) throw new Error(`缺少标记 ${name}`);
  const r = el.getBoundingClientRect();
  return {
    left: r.left,
    top: r.top - grow,
    right: r.right,
    bottom: r.bottom + grow,
    width: r.width,
    height: r.height + grow * 2,
  };
}

function makeHooks(): CommentHooks {
  return {
    onSave: (text) => console.log("[save]", text),
    onDelete: () => console.log("[delete]"),
    onOpenInNote: () => console.log("[open-in-note]"),
    // 验证页不引入 MarkdownRenderer：粗体标记去掉、段落用白底文字顶替
    renderBody: (el, md) => {
      for (const para of md.split(/\n{2,}/)) {
        const p = document.createElement("p");
        p.textContent = para.replace(/\*\*(.+?)\*\*/g, "$1");
        p.style.margin = "0 0 6px";
        el.appendChild(p);
      }
    },
  };
}

function main(): void {
  const hooks = makeHooks();

  // A：已有评论
  new CommentPopover().show(
    {
      id: "a",
      color: "#f5c542",
      page: 111,
      kindLabel: "高亮",
      comment: "这段样本量只有 63，**结论要打折**看；对照组也不是随机分配的。",
      canComment: true,
    },
    markBox("a"),
    hooks,
  );

  // B：还没写
  new CommentPopover().show(
    { id: "b", color: "#f6a6a6", page: 112, kindLabel: "框选", comment: null, canComment: true },
    markBox("b"),
    hooks,
  );

  // C：正在写
  new CommentPopover().show(
    { id: "c", color: "#8fd0c0", page: 113, kindLabel: "高亮", comment: null, canComment: true },
    markBox("c"),
    hooks,
    { edit: true },
  );

  // D：下划线（不可评论）
  new CommentPopover().show(
    { id: "d", color: "#f06292", page: 114, kindLabel: "下划线", comment: null, canComment: false },
    markBox("d"),
    hooks,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}
