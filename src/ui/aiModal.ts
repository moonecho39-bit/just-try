/**
 * aiModal.ts —— AI 结果弹窗（流式打字机 + 插入笔记）
 *
 * ── 为什么是 Modal 而不是侧栏面板 ────────────────────────────────────
 * AI 的结果是「一次性的、要落进笔记的中间产物」，不是需要常驻的工作区。
 * 用 Modal 有三个顺带的好处：
 *   · 自带 Esc / 点击遮罩关闭，不必自己管浮层栈；
 *   · 挡住 PDF 视图，用户读结果时不会被排版干扰；
 *   · 关闭即销毁，不用维护"上次的答案还挂在侧栏"这种状态。
 *
 * ── 流式渲染策略：先纯文本，结束后再渲染 Markdown ───────────────────
 * 每 30ms 就重跑一次 MarkdownRenderer 会把主线程压满（尤其是表格/公式），
 * 而且半截的 `**` 会让渲染结果反复跳变，读起来更糟。
 * 所以：流式期间用 `white-space: pre-wrap` 的纯文本（打字机效果本身就很爽），
 * 结束后一次性渲染成 Markdown。这是"看起来快"和"真的不卡"之间的平衡点。
 */

import { Modal, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import { complete, AiError } from "../ai/client";
import { taskMeta, type AiRequest, type AiResult } from "../ai/types";
import { h } from "../dom";
import { MarkdownPreview } from "./mdRender";

export interface AiModalOptions {
  request: AiRequest;
  /** MarkdownRenderer 的 sourcePath（决定相对图片链接怎么解析） */
  sourcePath: string;
  /** 插入到笔记；由 view 负责带上 PDF 链接与引用 */
  onInsert(result: AiResult): Promise<void> | void;
  /** 弹窗关闭后回调（用于释放 controller） */
  onClose?(): void;
}

type Phase = "idle" | "pending" | "streaming" | "done" | "error" | "aborted";

export class AiModal extends Modal {
  private readonly preview: MarkdownPreview;
  private readonly controller = new AbortController();

  private bodyEl!: HTMLElement;
  private streamEl!: HTMLElement;
  private metaEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private spinnerEl!: HTMLElement;

  private stopBtn!: HTMLButtonElement;
  private retryBtn!: HTMLButtonElement;
  private copyBtn!: HTMLButtonElement;
  private insertBtn!: HTMLButtonElement;

  private phase: Phase = "idle";
  /** 是否有请求在飞（不能用 phase 判断：第一次 run() 之前 phase 是 idle） */
  private inFlight = false;
  private result: AiResult | null = null;
  private rafId = 0;
  private pendingText = "";

  constructor(
    app: App,
    private readonly opts: AiModalOptions,
  ) {
    super(app);
    this.preview = new MarkdownPreview(app);
  }

  onOpen(): void {
    const meta = taskMeta(this.opts.request.task);
    this.modalEl.addClass("pdfa-ai-modal");
    this.titleEl.empty();
    this.titleEl.addClass("pdfa-ai-title");

    const icon = h("span", { cls: "pdfa-ai-title-icon", parent: this.titleEl });
    setIcon(icon, meta.icon);
    h("span", { text: meta.label, parent: this.titleEl });
    h("span", {
      cls: "pdfa-ai-title-src",
      text: `第 ${this.opts.request.context.page} 页 · ${this.opts.request.context.documentTitle}`,
      parent: this.titleEl,
    });

    /* ---------------- 正文 ---------------- */
    this.bodyEl = h("div", { cls: "pdfa-ai-body", parent: this.contentEl });

    this.spinnerEl = h("div", { cls: "pdfa-ai-pending", parent: this.bodyEl });
    this.spinnerEl.createDiv({ cls: "pdfa-spinner" });
    h("span", { text: "正在请求模型…", parent: this.spinnerEl });

    this.streamEl = h("div", { cls: "pdfa-ai-stream", parent: this.bodyEl });
    this.errorEl = h("div", { cls: "pdfa-ai-error", parent: this.bodyEl });
    this.errorEl.hide();

    /* ---------------- 元信息（模型 / 耗时 / tokens）---------------- */
    this.metaEl = h("div", { cls: "pdfa-ai-meta", parent: this.contentEl });

    /* ---------------- 底栏 ---------------- */
    const foot = h("div", { cls: "pdfa-ai-foot", parent: this.contentEl });

    this.copyBtn = this.iconButton(foot, "copy", "复制结果", () => {
      if (!this.result) return;
      void navigator.clipboard.writeText(this.result.text).then(
        () => new Notice("已复制"),
        () => new Notice("复制失败"),
      );
    });

    this.retryBtn = this.iconButton(foot, "rotate-cw", "重新生成", () => void this.run());

    this.stopBtn = h("button", {
      cls: "pdfa-btn",
      text: "停止",
      attr: { type: "button" },
      parent: foot,
    });
    this.stopBtn.onclick = () => {
      this.controller.abort();
      this.setPhase(this.phase === "done" ? "done" : "aborted");
    };

    h("span", { cls: "pdfa-ai-foot-spacer", parent: foot });

    this.insertBtn = h("button", {
      cls: "pdfa-btn pdfa-btn-primary",
      text: "插入到当前笔记",
      attr: { type: "button" },
      parent: foot,
    });
    this.insertBtn.onclick = () => void this.doInsert();

    this.setPhase("pending");
    void this.run();
  }

  onClose(): void {
    if (this.phase === "pending" || this.phase === "streaming") this.controller.abort();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.preview.destroy();
    this.opts.onClose?.();
    this.contentEl.empty();
  }

  /* ---------------------------------------------------------------- */

  private async run(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    this.result = null;
    this.pendingText = "";
    this.streamEl.empty();
    this.streamEl.removeClass("is-markdown");
    this.errorEl.hide();
    this.metaEl.empty();
    this.setPhase("pending");

    try {
      const result = await complete(this.opts.request, {
        signal: this.controller.signal,
        onDelta: (delta) => this.onDelta(delta),
      });

      if (this.controller.signal.aborted) {
        // 用户点了停止：已经收到的字保留下来，允许插入半成品（用户自己要的）
        this.result = result;
        this.finishRendering();
        this.setPhase("aborted");
        this.inFlight = false;
        return;
      }

      this.result = result;
      this.finishRendering();
      this.setPhase("done");
      this.inFlight = false;
    } catch (err) {
      this.inFlight = false;
      if (this.controller.signal.aborted) {
        this.setPhase("aborted");
        return;
      }
      const e = err instanceof AiError ? err : new AiError(err instanceof Error ? err.message : String(err), "unknown");
      this.showError(e);
      this.setPhase("error");
    }
  }

  /** 增量：用 rAF 合并写入，避免每个 token 都触发一次布局 */
  private onDelta(delta: string): void {
    if (delta === "") {
      // 流式失败要降级：把已经打出去的字擦掉，等普通请求的完整结果
      this.pendingText = "";
      this.streamEl.textContent = "";
      this.setPhase("pending");
      return;
    }
    if (this.phase === "pending") this.setPhase("streaming");
    this.pendingText += delta;
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.streamEl.textContent = this.pendingText;
      this.streamEl.scrollTop = this.streamEl.scrollHeight;
    });
  }

  /** 已经全部到齐（或用户停止）：把纯文本换成 Markdown */
  private finishRendering(): void {
    const text = this.result?.text?.trim() ?? this.pendingText.trim();
    if (!text) return;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.streamEl.addClass("is-markdown");
    void this.preview.render(this.streamEl, text, this.opts.sourcePath);
    this.renderMeta();
  }

  private renderMeta(): void {
    const r = this.result;
    if (!r) return;
    this.metaEl.empty();
    const bits: string[] = [r.model];
    if (r.firstTokenMs !== null) bits.push(`首字 ${formatMs(r.firstTokenMs)}`);
    bits.push(`共 ${formatMs(r.totalMs)}`);
    if (r.usage) bits.push(`${r.usage.prompt}→${r.usage.completion} tokens`);
    h("span", { text: bits.join(" · "), parent: this.metaEl });
    if (r.aborted || this.phase === "aborted") {
      h("span", { cls: "pdfa-ai-meta-warn", text: "已中断，内容可能不完整", parent: this.metaEl });
    }
  }

  private showError(err: AiError): void {
    this.errorEl.empty();
    this.errorEl.show();
    const head = h("div", { cls: "pdfa-ai-error-head", parent: this.errorEl });
    setIcon(h("span", { cls: "pdfa-ai-error-icon", parent: head }), "alert-triangle");
    h("span", { text: err.message, parent: head });
    if (err.hint) h("div", { cls: "pdfa-ai-error-hint", text: err.hint, parent: this.errorEl });
    if (err.kind === "config") {
      const link = h("button", {
        cls: "pdfa-btn pdfa-btn-ghost",
        text: "打开设置",
        attr: { type: "button" },
        parent: this.errorEl,
      });
      link.onclick = () => {
        this.close();
        // 打开设置页并定位到本插件：Obsidian 没有"定位到某个 setting tab"的公开 API，
        // 但 setting.open() 之后插件会自己高亮到上次的 tab，足够用。
        (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting?.open();
        (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting?.openTabById(
          "pdf-annotator",
        );
      };
    }
  }

  private async doInsert(): Promise<void> {
    if (!this.result || !this.result.text.trim()) {
      new Notice("还没有可插入的内容");
      return;
    }
    this.insertBtn.disabled = true;
    try {
      await this.opts.onInsert(this.result);
      this.close();
    } catch (err) {
      console.error("[pdf-annotator] 插入失败", err);
      new Notice("插入失败，已复制到剪贴板作为兜底");
      await navigator.clipboard.writeText(this.result.text).catch(() => undefined);
      this.insertBtn.disabled = false;
    }
  }

  private setPhase(next: Phase): void {
    this.phase = next;
    const running = next === "pending" || next === "streaming";

    this.spinnerEl.toggle(next === "pending");
    this.stopBtn.toggle(running);
    this.retryBtn.toggle(!running);
    this.copyBtn.disabled = !this.result?.text;
    this.insertBtn.disabled = !this.result?.text;
    this.modalEl.toggleClass("is-streaming", next === "streaming");
    this.modalEl.toggleClass("is-error", next === "error");
    if (next === "aborted") this.renderMeta();
  }

  private iconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = h("button", {
      cls: "pdfa-icon-btn",
      attr: { type: "button", title, "aria-label": title },
      parent,
    });
    setIcon(btn, icon);
    btn.onclick = onClick;
    return btn;
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
