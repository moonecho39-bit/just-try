/**
 * linkDrag.ts —— 把 PDF 里的高亮「拖」进笔记
 *
 * ── 为什么不用原生 HTML5 拖放 ──────────────────────────────────────
 * 原生拖放要求被拖元素在 **mousedown 之前**就是 `draggable="true"`。
 * 而我们的绘制层整层 `pointer-events: none`（否则文字选不中），
 * 命中靠几何计算 —— 没有任何 DOM 元素可以当拖拽源。
 * 把整层改成可拖拽的代价是：文字再也选不中，本末倒置。
 *
 * 所以这里自己实现一遍拖放：
 *   pointerdown(Alt) → 造一个幽灵块跟着指针 → pointerup 时用
 *   elementFromPoint 找到落点所在的编辑器 → 用 CodeMirror 的
 *   posAtCoords 换算成文档位置 → replaceRange 插入。
 *
 * 代价：跨窗口（popout）拖不了、没有系统的半透明缩略图。
 * 收益：不牺牲文本选择，落点精确到字符，且不依赖任何私有 API。
 */

import { type App, MarkdownView } from "obsidian";
import { h } from "../dom";

export interface DragPayload {
  /** 落进笔记的 Markdown 文本（链接或 Callout 全文） */
  text: string;
  /** 幽灵块上显示的短标签 */
  label: string;
}

export class LinkDrag {
  private ghost: HTMLElement | null = null;
  private detach: (() => void) | null = null;

  constructor(
    private readonly app: App,
    /** 落点处理结果回调：true = 成功插入 */
    private readonly onResult?: (inserted: boolean) => void,
  ) {}

  get active(): boolean {
    return this.ghost !== null;
  }

  /**
   * 由 pointerdown 触发；后续 move/up 全部走 window 级监听。
   * 只收坐标而不是整个事件：链接是异步算出来的（要等文本索引），
   * 开始拖拽时原本的 PointerEvent 早已结束，只有坐标还有意义。
   */
  begin(pos: { clientX: number; clientY: number }, payload: DragPayload): void {
    this.cancel();

    const ghost = h("div", { cls: "pdfa-drag-chip", parent: document.body });
    ghost.textContent = payload.label;
    this.ghost = ghost;
    this.moveTo(pos.clientX, pos.clientY);
    document.body.classList.add("pdfa-linking-drag");

    const onMove = (e: PointerEvent): void => {
      e.preventDefault();
      this.moveTo(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent): void => {
      const inserted = this.insertAt(e.clientX, e.clientY, payload.text);
      this.cancel();
      this.onResult?.(inserted);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      this.onResult?.(false);
    };

    // capture 阶段：编辑器自己的 pointerup 抢先处理会把光标挪走
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    this.detach = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }

  cancel(): void {
    this.detach?.();
    this.detach = null;
    this.ghost?.remove();
    this.ghost = null;
    document.body.classList.remove("pdfa-linking-drag");
  }

  destroy(): void {
    this.cancel();
  }

  /* ---------------------------------------------------------------- */

  private moveTo(x: number, y: number): void {
    const ghost = this.ghost;
    if (!ghost) return;
    ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
    // 拖到编辑器上时给个"能放"的视觉反馈
    ghost.classList.toggle("is-over-target", this.editorAt(x, y) !== null);
  }

  private insertAt(x: number, y: number, text: string): boolean {
    const hit = this.editorAt(x, y);
    if (!hit) return false;

    const { view, editor } = hit;
    let pos = editor.getCursor();

    // CodeMirror 6 的视图挂在 editor.cm 上（Obsidian 内部字段）。
    // 拿不到就退化成"插入到光标处" —— 位置差一点，但不会失败。
    const cm = (editor as unknown as {
      cm?: { posAtCoords?(coords: { x: number; y: number }): number | null };
    }).cm;
    try {
      const offset = cm?.posAtCoords?.({ x, y });
      if (typeof offset === "number" && offset >= 0) pos = editor.offsetToPos(offset);
    } catch {
      /* 布局中途可能抛错，用光标位置兜底 */
    }

    editor.replaceRange(text, pos);

    // 光标落到插入内容之后（多行时算最后一行的列）
    const lines = text.split("\n");
    const end = lines.length === 1
      ? { line: pos.line, ch: pos.ch + text.length }
      : { line: pos.line + lines.length - 1, ch: lines[lines.length - 1].length };
    editor.setCursor(end);
    view.editor.focus();
    return true;
  }

  private editorAt(x: number, y: number): { view: MarkdownView; editor: MarkdownView["editor"] } | null {
    const target = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!target) return null;
    const editorEl = target.closest(".cm-editor");
    if (!editorEl) return null;

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.containerEl.contains(editorEl)) return { view, editor: view.editor };
    }
    return null;
  }
}
