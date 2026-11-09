/**
 * main.ts —— 插件入口
 *
 * 阶段一：注册一个**补充式**视图（不接管 .pdf 打开行为）+ 坐标自检。
 * 阶段二：工具栏、绘制层、批注 Store。
 * 阶段三：Markdown 链接即存储 —— 解析、扫描、双向跳转、拖拽/复制。
 *
 * ── 一条设计红线（阶段三仍然守着）──────────────────────────────────
 * 不调用 registerExtensions(["pdf"], ...)：那会把系统级的 .pdf 打开方式抢过来。
 * 本插件是「按需打开的批注视图」，默认打开行为完全交给 Obsidian 原生查看器。
 * 但为了让 `[[x.pdf#page=3&selection=…]]` 能跳进本视图，我们需要在
 * **捕获阶段**拦下点击 —— 见 onInternalLinkClick。这是唯一"侵入"原生行为的地方，
 * 而且只对带 `page=` 的 PDF 链接生效，其余一律放行。
 */

import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { PDF_VIEW_TYPE, PDFFileView } from "./view";
import { parsePdfLink } from "./link/format";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type PluginSettings } from "./ai/settings";
import { PdfAnnotatorSettingTab } from "./ai/settingsTab";
import { AI_TASKS } from "./ai/types";

export default class PdfAnnotatorPlugin extends Plugin {
  /** 全部设置（AI + 便签）；UI 层直接读，改完调 saveSettings() */
  settings: PluginSettings = DEFAULT_SETTINGS;

  /**
   * 最近编辑过的 Markdown 笔记路径。
   *
   * 为什么需要它：AI 弹窗是 Modal，打开后 activeLeaf 仍是 PDF 视图，
   * `getActiveViewOfType(MarkdownView)` 会返回 null —— 那样"插入到当前笔记"
   * 就永远插不进用户刚才在写的那篇。所以在这里记一手。
   */
  lastMarkdownPath: string | null = null;

  async onload(): Promise<void> {
    this.settings = await loadSettings(this);
    this.addSettingTab(new PdfAnnotatorSettingTab(this.app, this));

    /*
     * 记录最近活跃的 Markdown 笔记。
     * 只认 file 视图（MarkdownView），不看 leaf 类型 —— 同一种视图可以被
     * 用户在设置里换成别的编辑模式，但 file 一定在。
     */
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.file) this.lastMarkdownPath = view.file.path;
      }),
    );
    // 启动时补一次：否则"刚打开 Obsidian 就点 AI"时还不知道当前笔记
    const initial = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (initial?.file) this.lastMarkdownPath = initial.file.path;

    /*
     * ★ registerView
     * 回调必须每次返回一个**新的**视图实例 —— Obsidian 会在分屏、
     * 拖拽到新窗口时对同一个 viewType 多次调用它。
     * 绝不能复用一个单例，否则两个 pane 会互相抢 DOM。
     */
    this.registerView(PDF_VIEW_TYPE, (leaf: WorkspaceLeaf) => new PDFFileView(leaf, this));

    /* 功能区图标：把当前选中的 PDF 用批注视图打开 */
    this.addRibbonIcon("file-text", "在批注视图中打开 PDF", () => {
      void this.openActivePdf();
    });

    /* 命令 1：打开当前 PDF */
    this.addCommand({
      id: "open-in-annotator-view",
      name: "用批注视图打开当前 PDF",
      checkCallback: (checking: boolean) => {
        const file = this.getActivePdfFile();
        if (!file) return false;
        if (!checking) void this.openPdf(file);
        return true;
      },
    });

    /* 命令 2：复制链接（阶段三的主命令，对应 PDF++ 的 Copy link to selection） */
    this.addCommand({
      id: "copy-selection-link",
      name: "复制选中文字的 PDF 链接",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "C" }],
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) void view.copySelectionLink(false);
        return true;
      },
    });

    /* 命令 3：复制成 Callout（带引用原文，适合做阅读笔记） */
    this.addCommand({
      id: "copy-selection-callout",
      name: "复制选中文字为 PDF Callout",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) void view.copySelectionLink(true);
        return true;
      },
    });

    /* 命令 4：反向链接面板 */
    this.addCommand({
      id: "toggle-backlinks-panel",
      name: "显示 / 隐藏反向链接面板",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) view.toggleBacklinkPanel();
        return true;
      },
    });

    /* 命令 5：坐标自检（阶段一验收用，之后只是调试工具） */
    this.addCommand({
      id: "debug-selection-coords",
      name: "调试：打印当前选区的归一化坐标",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) this.dumpSelection(view);
        return true;
      },
    });

    /* 命令 6 / 7：清空内存里的草稿批注（真正的高亮在笔记里，删链接即可） */
    this.addCommand({
      id: "clear-page-annotations",
      name: "清除当前页的草稿批注",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) view.clearCurrentPage();
        return true;
      },
    });

    this.addCommand({
      id: "clear-all-annotations",
      name: "清除本文档的全部草稿批注",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(PDFFileView);
        if (!view) return false;
        if (!checking) view.clearAllAnnotations();
        return true;
      },
    });

    /*
     * ★ 拦截 Markdown 里的 PDF 链接点击
     *
     * 必须在**捕获阶段**：Obsidian 自己的 click 处理挂在编辑器/预览的冒泡链上，
     * 等冒泡到 document 时它已经把 PDF 用原生查看器打开了。
     * 捕获阶段先拿到事件，preventDefault + stopPropagation 才拦得住。
     */
    this.registerDomEvent(document, "click", this.onInternalLinkClick, true);

    /*
     * ── AI 伴读（阶段四）──
     * 三条独立命令而不是一条带参数的：Obsidian 命令没有参数，
     * 拆成三条才能各自绑快捷键（翻译设 Ctrl+Alt+T 这类肌肉记忆很自然）。
     */
    for (const task of AI_TASKS) {
      this.addCommand({
        id: `ai-${task.id}`,
        name: `AI ${task.label}选中文字`,
        checkCallback: (checking: boolean) => {
          const view = this.app.workspace.getActiveViewOfType(PDFFileView);
          if (!view) return false;
          if (!checking) void view.runAiTask(task.id);
          return true;
        },
      });
    }

    /*
     * 刻意**不**调用 registerExtensions(["pdf"], PDF_VIEW_TYPE)
     * 见文件头注释：那等于替换原生查看器，违背本项目第一原则。
     */
  }

  /** 统一的保存入口：所有 UI 改完设置都调它 */
  async saveSettings(): Promise<void> {
    await saveSettings(this, this.settings);
  }

  onunload(): void {
    // 卸载插件时清掉残留视图，避免留下无法交互的空壳 pane
    this.app.workspace.detachLeavesOfType(PDF_VIEW_TYPE);
  }

  /* ------------------------------------------------------------------ */

  private getActivePdfFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension.toLowerCase() === "pdf" ? file : null;
  }

  private async openActivePdf(): Promise<void> {
    const file = this.getActivePdfFile();
    if (!file) {
      new Notice("请先在文件列表中选中一个 PDF 文件");
      return;
    }
    await this.openPdf(file);
  }

  /**
   * 在标签页中打开批注视图。
   *
   * @param link 可选的子路径链接（`x.pdf#page=3&selection=…`）。
   *   注意：已经打开同一个 PDF 时**不重建视图**（那会重新解析整个 PDF），
   *   而是让现有视图滚动过去。
   */
  async openPdf(file: TFile, leaf?: WorkspaceLeaf, link?: string): Promise<void> {
    if (link && !leaf) {
      const existing = this.findOpenPdfView(file.path);
      if (existing) {
        this.app.workspace.setActiveLeaf(existing.leaf, { focus: true });
        await existing.view.navigateToLink(link);
        return;
      }
    }

    const target = leaf ?? this.app.workspace.getLeaf("tab");
    await target.setViewState({
      type: PDF_VIEW_TYPE,
      state: link ? { file: file.path, link } : { file: file.path },
      active: true,
    });
  }

  private findOpenPdfView(path: string): { leaf: WorkspaceLeaf; view: PDFFileView } | null {
    for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE)) {
      const view = leaf.view;
      if (!(view instanceof PDFFileView)) continue;
      const state = leaf.getViewState().state as { file?: unknown } | null;
      if (state?.file === path) return { leaf, view };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 链接点击拦截
   * ------------------------------------------------------------------ */

  private readonly onInternalLinkClick = (ev: MouseEvent): void => {
    if (ev.defaultPrevented || ev.button !== 0) return;

    const anchor = (ev.target as HTMLElement | null)?.closest?.("a.internal-link") as HTMLAnchorElement | null;
    if (!anchor) return;

    const href = anchor.getAttribute("data-href") ?? anchor.getAttribute("href");
    if (!href || !/\.pdf(#|$)/i.test(href)) return;

    const target = parsePdfLink(href);
    // 没有 page= 的链接（只是"打开这个 PDF"）交回 Obsidian：
    // 用户装这个插件不是为了让所有 PDF 都从批注视图打开
    if (!target) return;

    const sourcePath =
      (anchor.closest("[data-path]") as HTMLElement | null)?.getAttribute("data-path") ??
      this.app.workspace.getActiveFile()?.path ??
      "";
    const file = this.app.metadataCache.getFirstLinkpathDest(target.linkpath, sourcePath);
    if (!(file instanceof TFile)) return;

    ev.preventDefault();
    ev.stopPropagation();
    // Ctrl/Cmd 点 = 新标签页打开；普通点击 = 复用已经打开的那个
    void this.openPdf(file, ev.ctrlKey || ev.metaKey ? this.app.workspace.getLeaf("tab") : undefined, href);
  };

  private dumpSelection(view: PDFFileView): void {
    const items = view.getSelectionAsNormRects();
    if (items.length === 0) {
      new Notice("没有选中任何文本（或该页尚未完成渲染）");
      return;
    }
    view.flashNormRects(items);
    console.log("[pdf-annotator] 选区归一化坐标", items);
    const count = items.reduce((acc, it) => acc + it.rects.length, 0);
    new Notice(`已捕获 ${items.length} 页 / ${count} 个矩形，详见控制台`);
  }
}
