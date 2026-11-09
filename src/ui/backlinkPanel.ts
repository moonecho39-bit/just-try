/**
 * backlinkPanel.ts —— 「反向链接」侧栏
 *
 * 它存在的理由是：PDF 里的高亮可能来自十几篇笔记，光靠画面上的色块
 * 你没法知道"这条是谁写的、在哪个文件的第几行"。这个面板把
 * 「颜色 → 出处」这一层显式列出来，并且与页面上的高亮双向联动：
 *
 *   悬停面板条目 → 页面上对应的那块高亮描边亮起
 *   点击面板条目 → 跳到源笔记的那一行
 *
 * 不用 Obsidian 的 ItemView（独立侧栏）而是内嵌在 PDF 视图右侧：
 *  · 反向链接是"这一篇 PDF 的"属性，脱离 PDF 没有意义；
 *  · 内嵌可以做 hover 联动（跨视图拿 DOM 要绕一大圈）；
 *  · 少一个视图类型 = 少一堆状态同步。
 */

import { setIcon } from "obsidian";
import { h } from "../dom";
import type { BacklinkEntry } from "../link/scan";

export interface BacklinkPanelOptions {
  onActivate(entry: BacklinkEntry): void;
  onHover(entry: BacklinkEntry | null): void;
  /** 「仅本页」开关变化 */
  onFilterChange(onlyCurrentPage: boolean): void;
  onClose(): void;
}

export class BacklinkPanel {
  readonly el: HTMLElement;

  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly filterBtn: HTMLElement;
  private readonly hintEl: HTMLElement;

  private entries: BacklinkEntry[] = [];
  private currentPage: number | null = null;
  private onlyCurrentPage = false;
  private activeKey: string | null = null;

  constructor(private readonly opts: BacklinkPanelOptions) {
    this.el = h("div", { cls: "pdfa-side" });

    const head = h("div", { cls: "pdfa-side-head", parent: this.el });
    const title = h("div", { cls: "pdfa-side-title", parent: head });
    title.textContent = "反向链接";
    this.countEl = h("span", { cls: "pdfa-side-count", parent: title });

    this.filterBtn = h("button", {
      cls: "pdfa-side-filter",
      attr: { type: "button", title: "只显示指向当前页的链接" },
      parent: head,
    });
    this.filterBtn.textContent = "仅本页";
    this.filterBtn.onclick = () => {
      this.onlyCurrentPage = !this.onlyCurrentPage;
      this.filterBtn.classList.toggle("is-on", this.onlyCurrentPage);
      this.opts.onFilterChange(this.onlyCurrentPage);
      this.render();
    };

    const close = h("button", {
      cls: "pdfa-icon-btn",
      attr: { type: "button", title: "关闭面板" },
      parent: head,
    });
    setIcon(close, "x");
    close.onclick = () => this.opts.onClose();

    this.listEl = h("div", { cls: "pdfa-side-list", parent: this.el });
    this.hintEl = h("div", { cls: "pdfa-side-foot", parent: this.el });
    this.render();
  }

  get filterOnlyCurrentPage(): boolean {
    return this.onlyCurrentPage;
  }

  setEntries(entries: BacklinkEntry[], currentPage: number | null): void {
    this.entries = entries;
    this.currentPage = currentPage;
    this.render();
  }

  /** 页面滚动时更新"当前页"，只影响「仅本页」过滤，不重建 DOM */
  setCurrentPage(page: number | null): void {
    if (this.currentPage === page) return;
    this.currentPage = page;
    if (this.onlyCurrentPage) this.render();
  }

  setActiveKey(key: string | null): void {
    if (this.activeKey === key) return;
    this.activeKey = key;
    for (const row of Array.from(this.listEl.querySelectorAll<HTMLElement>(".pdfa-bl-item"))) {
      row.classList.toggle("is-active", row.dataset.key === key);
    }
  }

  destroy(): void {
    this.el.remove();
  }

  /* ---------------------------------------------------------------- */

  private visibleEntries(): BacklinkEntry[] {
    if (!this.onlyCurrentPage || this.currentPage === null) return this.entries;
    return this.entries.filter((e) => e.page === this.currentPage);
  }

  private render(): void {
    const list = this.visibleEntries();
    this.countEl.textContent = String(list.length);
    this.countEl.classList.toggle("is-zero", list.length === 0);

    this.listEl.textContent = "";
    this.listEl.scrollTop = 0;

    if (list.length === 0) {
      h("div", {
        cls: "pdfa-side-empty",
        parent: this.listEl,
        text:
          this.onlyCurrentPage && this.entries.length > 0
            ? "本页没有回链（关掉「仅本页」看全部）"
            : "还没有笔记链接到这篇 PDF。\n选中文字后用工具栏的「复制链接」，把链接粘进笔记即可。",
      });
      this.hintEl.textContent = "";
      return;
    }

    // 按来源文件分组：同一篇笔记里的多条高亮聚在一起才可读
    const groups = new Map<string, BacklinkEntry[]>();
    for (const entry of list) {
      const arr = groups.get(entry.sourcePath);
      if (arr) arr.push(entry);
      else groups.set(entry.sourcePath, [entry]);
    }

    for (const [path, items] of groups) {
      const group = h("div", { cls: "pdfa-bl-group", parent: this.listEl });
      const fileRow = h("div", { cls: "pdfa-bl-file", parent: group, attr: { title: path } });
      const icon = h("span", { cls: "pdfa-bl-file-icon", parent: fileRow });
      setIcon(icon, "file-text");
      h("span", { cls: "pdfa-bl-file-name", parent: fileRow, text: path.replace(/\.md$/i, "") });
      h("span", { cls: "pdfa-bl-file-count", parent: fileRow, text: String(items.length) });

      for (const entry of items) {
        const row = h("div", {
          cls: "pdfa-bl-item",
          parent: group,
          attr: {
            "data-key": entry.key,
            title: `${path}:${entry.position.start.line + 1}\n点击跳到该行`,
          },
        });
        if (entry.key === this.activeKey) row.classList.add("is-active");

        h("span", { cls: "pdfa-bl-page", parent: row, text: `P.${entry.page}` });
        const dot = h("span", { cls: "pdfa-bl-dot", parent: row });
        dot.style.background = entry.target.color?.hex ?? "";

        const label =
          entry.quote?.replace(/\s+/g, " ").trim() ||
          entry.target.alias ||
          (entry.target.rect ? "矩形区域" : "（无引用文本）");
        h("span", { cls: "pdfa-bl-text", parent: row, text: label });

        row.addEventListener("pointerenter", () => {
          this.opts.onHover(entry);
          this.setActiveKey(entry.key);
        });
        row.addEventListener("pointerleave", () => {
          this.opts.onHover(null);
          this.setActiveKey(null);
        });
        row.addEventListener("click", (ev) => {
          ev.preventDefault();
          this.opts.onActivate(entry);
        });
      }
    }

    this.hintEl.textContent = `${list.length} 条 · 悬停联动 · 点击跳转`;
  }
}
