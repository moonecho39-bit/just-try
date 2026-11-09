/**
 * noteEditor.ts —— 富文本便签浮层（编辑 + 实时预览 + 粘贴图片）
 *
 * ── 为什么仍然是 <textarea>，而不是 contenteditable ────────────────
 * contenteditable 会往内容里掺 `<div>`、`&nbsp;`、零宽字符、浏览器的
 * `style="..."` 残留；一旦落进 Markdown 文件就是永久的毒。而"富文本"在这里的
 * 真实含义是 **Markdown 的所见即所得预览**，不是 HTML 编辑 —— 所以正确做法是
 * 「textarea 编辑源码 + 旁边一块 MarkdownRenderer 渲染的预览」，
 * 既保住了纯 Markdown 的存储，又拿到了富文本的观感。
 *
 * ── 300ms 防抖的理由 ──────────────────────────────────────────────
 * `MarkdownRenderer.render` 是异步的，内部要解析表格、图片尺寸、公式。
 * 每敲一个字都跑一遍会让输入明显发涩（尤其带公式的笔记）。
 * 300ms 是"手停即所见"与"不卡"的平衡：低于 200ms 抖动明显，高于 500ms 会觉得预览在偷懒。
 *
 * ── 粘贴图片 ──────────────────────────────────────────────────────
 * 剪贴板图片没有文件名，只能自己造（见 attachments.ts）。存完后把
 * `![[path]]` 插到光标处 —— 用的是 setRangeText，而不是 value += ，
 * 否则光标会跳到末尾、撤销栈也会断。
 */

import { setIcon } from "obsidian";
import type { App } from "obsidian";
import type { NoteAnnotation } from "../annot/types";
import { h, onOutsidePointerDown, placeFloating, type RectLike } from "../dom";
import { imagesFromClipboard, saveImageAttachment } from "../note/attachments";
import { MarkdownPreview } from "./mdRender";

export interface NoteEditorOptions {
  app: App;
  onCommit(anno: NoteAnnotation, body: string): void;
  onDelete(anno: NoteAnnotation): void;
  /** 「在笔记中打开」：跳到伴生笔记里那块 Callout */
  onOpenInNote?(anno: NoteAnnotation): void;
  /** 图片来源路径（相对链接按它解析）；一般传伴生笔记路径 */
  sourcePath(): string;
}

const PREVIEW_DEBOUNCE = 300;

export class NoteEditor {
  private el: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private previewEl: HTMLElement | null = null;
  private preview: MarkdownPreview;
  private detach: (() => void) | null = null;
  private current: NoteAnnotation | null = null;
  private timer = 0;
  private token = 0;

  constructor(private readonly opts: NoteEditorOptions) {
    this.preview = new MarkdownPreview(opts.app);
  }

  get isEditing(): boolean {
    return this.el !== null;
  }

  open(anno: NoteAnnotation, anchor: HTMLElement | RectLike): void {
    this.close(false);
    this.current = anno;
    const my = ++this.token;

    const el = h("div", { cls: "pdfa-pop pdfa-note-editor", parent: document.body });
    el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.el = el;

    /* ---------------- 标题栏 ---------------- */
    const head = h("div", { cls: "pdfa-note-head", parent: el });
    const dot = h("span", { cls: "pdfa-note-dot", parent: head });
    dot.style.background = anno.color;
    h("span", { cls: "pdfa-note-title", text: "便签", parent: head });

    const spacer = h("span", { cls: "pdfa-note-spacer", parent: head });
    spacer.style.flex = "1";

    if (this.opts.onOpenInNote) {
      const openBtn = h("button", {
        cls: "pdfa-icon-btn",
        attr: { type: "button", title: "在笔记中打开这一条", "aria-label": "在笔记中打开" },
        parent: head,
      });
      setIcon(openBtn, "external-link");
      openBtn.onclick = () => {
        const target = this.current;
        this.close(true);
        if (target) this.opts.onOpenInNote?.(target);
      };
    }

    const closeBtn = h("button", {
      cls: "pdfa-icon-btn",
      attr: { type: "button", "aria-label": "关闭", title: "关闭（自动保存）" },
      parent: head,
    });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.close(true);

    /* ---------------- 工具条 ---------------- */
    const tools = h("div", { cls: "pdfa-note-tools", parent: el });
    const wrap = (before: string, after = before, placeholder = "文本"): void => {
      const ta = this.textarea;
      if (!ta) return;
      const { selectionStart: s, selectionEnd: e, value } = ta;
      const sel = value.slice(s, e) || placeholder;
      const next = `${value.slice(0, s)}${before}${sel}${after}${value.slice(e)}`;
      ta.value = next;
      ta.focus();
      ta.setSelectionRange(s + before.length, s + before.length + sel.length);
      this.schedulePreview(true);
    };
    this.toolButton(tools, "bold", "加粗 Ctrl/⌘+B", () => wrap("**"));
    this.toolButton(tools, "italic", "斜体 Ctrl/⌘+I", () => wrap("*"));
    this.toolButton(tools, "code", "行内代码", () => wrap("`"));
    this.toolButton(tools, "list", "无序列表", () => {
      const ta = this.textarea;
      if (!ta) return;
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf("\n", s - 1) + 1;
      ta.value = `${ta.value.slice(0, lineStart)}- ${ta.value.slice(lineStart)}`;
      ta.focus();
      ta.setSelectionRange(s + 2, s + 2);
      this.schedulePreview(true);
    });
    const pasteHint = h("span", { cls: "pdfa-note-tools-hint", text: "可直接粘贴截图 / Ctrl+V", parent: tools });
    pasteHint.title = "粘贴图片会自动存进附件文件夹，并插入 ![[…]]";

    /* ---------------- 编辑 + 预览 ---------------- */
    const body = h("div", { cls: "pdfa-note-body", parent: el });
    const editPane = h("div", { cls: "pdfa-note-pane is-edit", parent: body });
    const previewPane = h("div", { cls: "pdfa-note-pane is-preview", parent: body });
    h("div", { cls: "pdfa-note-pane-label", text: "预览", parent: previewPane });

    const ta = h("textarea", {
      cls: "pdfa-note-input",
      attr: {
        placeholder: "写点什么…支持完整 Markdown（**加粗**、- 列表、`代码`、![[图片]]）",
        spellcheck: "false",
      },
      parent: editPane,
    });
    ta.value = anno.body;
    this.textarea = ta;
    this.previewEl = h("div", { cls: "pdfa-note-preview", parent: previewPane });

    const autosize = (): void => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(280, Math.max(96, ta.scrollHeight + 2))}px`;
    };
    ta.addEventListener("input", () => {
      autosize();
      this.schedulePreview();
    });

    ta.addEventListener("keydown", (ev) => {
      if ((ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) || ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.close(true);
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "b") {
        ev.preventDefault();
        wrap("**");
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "i") {
        ev.preventDefault();
        wrap("*");
      }
    });

    ta.addEventListener("paste", (ev) => void this.onPaste(ev, ta));

    /* ---------------- 底栏 ---------------- */
    const foot = h("div", { cls: "pdfa-note-foot", parent: el });
    h("span", { cls: "pdfa-note-hint", text: "Ctrl/⌘ + Enter 保存 · Esc 保存", parent: foot });

    const del = h("button", { cls: "pdfa-btn pdfa-btn-danger", text: "删除", attr: { type: "button" }, parent: foot });
    del.onclick = () => {
      const target = this.current;
      this.close(false);
      if (target) this.opts.onDelete(target);
    };

    const done = h("button", { cls: "pdfa-btn pdfa-btn-primary", text: "完成", attr: { type: "button" }, parent: foot });
    done.onclick = () => this.close(true);

    placeFloating(el, anchor, { placement: "below", gap: 8 });
    autosize();
    void this.renderPreview(my, ta.value);

    this.detach = onOutsidePointerDown(el, () => this.close(true));

    window.requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  close(commit: boolean): void {
    const el = this.el;
    const anno = this.current;
    const body = this.textarea?.value ?? "";

    window.clearTimeout(this.timer);
    this.detach?.();
    this.detach = null;
    el?.remove();
    this.el = null;
    this.textarea = null;
    this.previewEl = null;
    this.current = null;
    this.preview.destroy();
    this.preview = new MarkdownPreview(this.opts.app);

    if (commit && anno && body !== anno.body) this.opts.onCommit(anno, body);
  }

  destroy(): void {
    this.close(false);
  }

  /* ---------------------------------------------------------------- */

  /** 300ms 后刷新预览；immediate = 用户点了工具按钮，先刷新再说 */
  private schedulePreview(immediate = false): void {
    window.clearTimeout(this.timer);
    const my = this.token;
    const run = (): void => {
      const ta = this.textarea;
      if (!ta) return;
      void this.renderPreview(my, ta.value);
    };
    if (immediate) run();
    else this.timer = window.setTimeout(run, PREVIEW_DEBOUNCE);
  }

  private async renderPreview(my: number, text: string): Promise<void> {
    const el = this.previewEl;
    if (!el || my !== this.token) return;
    await this.preview.render(el, text, this.opts.sourcePath());
  }

  /** 粘贴：有图片就存附件并插入；没有就交给浏览器正常粘贴文本 */
  private async onPaste(ev: ClipboardEvent, ta: HTMLTextAreaElement): Promise<void> {
    const files = imagesFromClipboard(ev.clipboardData);
    if (files.length === 0) return;

    ev.preventDefault();
    const el = this.el;
    if (!el) return;
    el.classList.add("is-uploading");

    for (const file of files) {
      try {
        const saved = await saveImageAttachment(this.opts.app, file, this.opts.sourcePath());
        insertAtCursor(ta, `${saved.markdown}\n`);
      } catch (err) {
        console.error("[pdf-annotator] 粘贴图片失败", err);
        insertAtCursor(ta, `> ⚠️ 图片保存失败：${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    el.classList.remove("is-uploading");
    this.schedulePreview(true);
  }

  private toolButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): void {
    const btn = h("button", {
      cls: "pdfa-icon-btn pdfa-note-tool",
      attr: { type: "button", title, "aria-label": title },
      parent,
    });
    setIcon(btn, icon);
    // mousedown 必须拦住：否则点按钮的瞬间 textarea 失焦，selectionStart 归零
    btn.addEventListener("mousedown", (ev) => ev.preventDefault());
    btn.onclick = (ev) => {
      ev.preventDefault();
      onClick();
    };
  }
}

/**
 * 在光标处插入文本，并保住撤销栈。
 * `document.execCommand("insertText")` 虽然被标了 deprecated，但它是唯一能让
 * textarea 的原生撤销（Ctrl+Z）仍然有效的办法；`setRangeText` 不行。
 */
function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  ta.focus();
  const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  if (ok) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.setSelectionRange(s + text.length, s + text.length);
}
