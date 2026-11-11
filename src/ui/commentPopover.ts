/**
 * commentPopover.ts —— 点一下高亮，就地写评论（WPS / Zotero 的那种气泡）
 *
 * 交互只有两态，不做状态机：
 *   ① 看：色点 + 「高亮 · 页 111」+ 已有评论；没有评论时只有一枚「添加评论」按钮
 *   ② 写：同一个气泡里长出一块 textarea，Ctrl/⌘+Enter 或「保存」落盘，Esc 放弃
 *
 * ── 为什么不复用 noteEditor（富文本便签）────────────────────────────
 * 便签是"我要写一段东西"，需要 Markdown 预览、图片、格式按钮，面板也大；
 * 加评论是"我就补一句"，多一个面板、多一次"完成"点击都是摩擦。
 * 两者共用同一份存储（伴生笔记里的 Callout），只是入口与体量不同。
 *
 * ── 位置 ─────────────────────────────────────────────────────────
 * 用 position: fixed + placeFloating，锚点是被点中的**那一行文字的屏幕矩形**。
 * 这样气泡永远贴着内容，且会自己在上下翻转、贴边夹紧，不会飞出窗口。
 */

import { setIcon } from "obsidian";
import { h, onOutsidePointerDown, placeFloating, type RectLike } from "../dom";

export interface CommentVM {
  id: string;
  /** 色点：跟批注同色，让人一眼确认"是这个标记" */
  color: string;
  page: number;
  /** 高亮 / 下划线 / 框选 / 批注 */
  kindLabel: string;
  /** 已有评论（Markdown）；null = 还没写 */
  comment: string | null;
  /** 箭头 / 手绘不可评论，给一句解释而不是给一个点了没用的按钮 */
  canComment: boolean;
}

export interface CommentHooks {
  /** 保存（可能是空串 = 清空评论） */
  onSave(text: string): void;
  onDelete(): void;
  /** 「在笔记中打开这一条」；没有落盘的批注不传 */
  onOpenInNote?(): void;
  /** 评论正文按 Markdown 渲染 */
  renderBody(el: HTMLElement, md: string): Promise<void> | void;
}

const ROOT_CLS = "pdfa-pop pdfa-comment-pop";

export class CommentPopover {
  private el: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private detach: (() => void) | null = null;
  private vm: CommentVM | null = null;
  private hooks: CommentHooks | null = null;
  private anchor: RectLike | null = null;
  private editing = false;

  get isOpen(): boolean {
    return this.el !== null;
  }

  /**
   * 打开 / 刷新气泡。
   * 已经开着时只换内容、不重新定位 —— 否则点「保存」后气泡会跳一下。
   */
  show(vm: CommentVM, anchor: RectLike, hooks: CommentHooks, options: { edit?: boolean } = {}): void {
    const sameTarget = this.vm?.id === vm.id;
    const move = !this.el || !sameTarget;

    this.vm = vm;
    this.hooks = hooks;
    this.anchor = anchor;
    if (options.edit) this.editing = true;
    else if (!sameTarget) this.editing = false;

    if (!this.el) {
      const el = h("div", { cls: ROOT_CLS, parent: document.body });
      // 气泡是控件：别把按下事件透给下面的绘制层 / 文本层
      el.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      this.el = el;
      this.detach = onOutsidePointerDown(el, () => this.close(true));
      document.addEventListener("keydown", this.onKeyDown, true);
    }

    this.render();

    if (move) placeFloating(this.el, anchor, { placement: "auto", gap: 10 });
  }

  /** 关掉；编辑中且 save=true 时先把草稿交出去 */
  close(save = true): void {
    const text = this.textarea?.value;
    const dirty = this.editing && text !== undefined && text !== (this.vm?.comment ?? "");
    const hooks = this.hooks;
    const target = dirty && save ? text : null;

    this.detach?.();
    this.detach = null;
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.el?.remove();

    this.el = null;
    this.card = null;
    this.textarea = null;
    this.vm = null;
    this.hooks = null;
    this.anchor = null;
    this.editing = false;

    if (target !== null && hooks) hooks.onSave(target);
  }

  destroy(): void {
    this.close(false);
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  private render(): void {
    const el = this.el;
    const vm = this.vm;
    const hooks = this.hooks;
    if (!el || !vm || !hooks) return;

    // 不用 Obsidian 的 el.empty()：这里也跑在浏览器校验页里，标准 DOM 才通用
    el.textContent = "";
    const card = h("div", { cls: "pdfa-comment-card", parent: el });
    this.card = card;
    this.textarea = null;

    /* ---------------- 头部 ---------------- */
    const head = h("div", { cls: "pdfa-comment-head", parent: card });
    const dot = h("span", { cls: "pdfa-comment-dot", parent: head });
    dot.style.background = vm.color;
    h("span", { cls: "pdfa-comment-title", text: vm.kindLabel, parent: head });
    h("span", { cls: "pdfa-comment-page", text: `页 ${vm.page}`, parent: head });

    const spacer = h("span", { cls: "pdfa-comment-spacer", parent: head });
    spacer.style.flex = "1";

    if (vm.comment && hooks.onOpenInNote) {
      const openBtn = h("button", {
        cls: "pdfa-icon-btn",
        attr: { type: "button", title: "在笔记中打开这一条", "aria-label": "在笔记中打开" },
        parent: head,
      });
      setIcon(openBtn, "external-link");
      openBtn.onclick = (ev) => {
        ev.preventDefault();
        this.close(true);
        hooks.onOpenInNote?.();
      };
    }

    const closeBtn = h("button", {
      cls: "pdfa-icon-btn",
      attr: { type: "button", title: "关闭（Esc）", "aria-label": "关闭" },
      parent: head,
    });
    setIcon(closeBtn, "x");
    closeBtn.onclick = (ev) => {
      ev.preventDefault();
      this.close(true);
    };

    /* ---------------- 「添加评论」按钮 ---------------- */
    if (this.editing) {
      this.renderEditor(card, vm);
    } else if (vm.comment) {
      const body = h("div", { cls: "pdfa-comment-body", parent: card });
      const out = hooks.renderBody(body, vm.comment);
      if (out && typeof out.then === "function") {
        void out.then(() => {
          if (this.anchor && this.el) placeFloating(this.el, this.anchor, { placement: "auto", gap: 10 });
        });
      }

      const foot = h("div", { cls: "pdfa-comment-foot", parent: card });
      const edit = h("button", {
        cls: "pdfa-comment-action",
        attr: { type: "button" },
        parent: foot,
      });
      const editIcon = h("span", { cls: "pdfa-comment-action-icon", parent: edit });
      setIcon(editIcon, "pencil");
      h("span", { text: "编辑", parent: edit });
      edit.onclick = (ev) => {
        ev.preventDefault();
        this.editing = true;
        this.render();
      };

      const del = h("button", {
        cls: "pdfa-comment-action is-danger",
        attr: { type: "button" },
        parent: foot,
      });
      const delIcon = h("span", { cls: "pdfa-comment-action-icon", parent: del });
      setIcon(delIcon, "trash-2");
      h("span", { text: "删除", parent: del });
      del.onclick = (ev) => {
        ev.preventDefault();
        this.close(false);
        hooks.onDelete();
      };
    } else if (vm.canComment) {
      const add = h("button", {
        cls: "pdfa-comment-add",
        attr: { type: "button", title: "在这条标记上写评论" },
        parent: card,
      });
      const icon = h("span", { cls: "pdfa-comment-add-icon", parent: add });
      setIcon(icon, "message-square-plus");
      h("span", { text: "添加评论", parent: add });
      add.onclick = (ev) => {
        ev.preventDefault();
        this.editing = true;
        this.render();
        this.textarea?.focus();
      };
    } else {
      h("div", {
        cls: "pdfa-comment-hint",
        text: "箭头 / 手绘没有可圈住的文字。改用「矩形框」圈出那一段，就能写评论。",
        parent: card,
      });
    }
  }

  private renderEditor(card: HTMLElement, vm: CommentVM): void {
    const ta = h("textarea", {
      cls: "pdfa-comment-input",
      attr: {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- 这是正文占位，不是 UI 文案标题
        placeholder: "写评论…支持 Markdown（**加粗**、- 列表）",
        spellcheck: "false",
        rows: "3",
      },
      parent: card,
    });
    ta.value = vm.comment ?? "";
    this.textarea = ta;

    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(220, Math.max(56, ta.scrollHeight + 2))}px`;
    });

    ta.addEventListener("keydown", (ev) => {
      // 输入框里的 Esc / Ctrl+Enter 归气泡自己处理：别让视图层顺手切工具
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        this.close(false);
        return;
      }
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        this.commit();
      }
    });

    const foot = h("div", { cls: "pdfa-comment-foot", parent: card });
    h("span", { cls: "pdfa-comment-kbd", text: "Ctrl/⌘ + Enter 保存", parent: foot });

    const cancel = h("button", {
      cls: "pdfa-btn",
      text: "取消",
      attr: { type: "button" },
      parent: foot,
    });
    cancel.onclick = (ev) => {
      ev.preventDefault();
      this.close(false);
    };

    const save = h("button", {
      cls: "pdfa-btn pdfa-btn-primary",
      text: "保存",
      attr: { type: "button" },
      parent: foot,
    });
    save.onclick = (ev) => {
      ev.preventDefault();
      this.commit();
    };

    window.requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(220, Math.max(56, ta.scrollHeight + 2))}px`;
    });
  }

  /** 把 textarea 里的内容交出去，并立刻切回"看"的形态（不等落盘） */
  private commit(): void {
    const ta = this.textarea;
    const vm = this.vm;
    const hooks = this.hooks;
    if (!ta || !vm || !hooks) return;

    const text = ta.value.trim() === "" ? "" : ta.value;
    this.editing = false;
    this.vm = { ...vm, comment: text ? text : null };
    hooks.onSave(text);
    this.render();
  }

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    this.close(false);
  };
}
