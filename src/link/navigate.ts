/**
 * navigate.ts —— 跨视图跳转（PDF ⇄ 笔记）
 *
 * 双向跳转是这个插件的"闭环"所在，两个方向各有一个坑：
 *
 *  笔记 → PDF：不能只 openLinkText。Obsidian 对 `#page=…` 这种子路径
 *            无能为力（未知参数它直接忽略），所以必须自己解析参数、
 *            自己把 PDF 视图打开、自己滚到位置。
 *  PDF → 笔记：必须落到**行**，而不是只打开文件。Obsidian 支持
 *            `leaf.openFile(file, { eState: { line, ch } })`，
 *            但如果你只传 state 不传 eState，它会把视图恢复成上次的滚动位置，
 *            看起来就像"跳到了另一处"。
 */

import { type App, MarkdownView, TFile, type WorkspaceLeaf } from "obsidian";

/** 找到已经在显示该笔记的叶子；没有就返回 null（避免开出重复标签页） */
export function findMarkdownLeaf(app: App, path: string): WorkspaceLeaf | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === path) return leaf;
  }
  return null;
}

/**
 * 打开笔记并落到指定行。
 *
 * @returns 是否成功（文件不存在时返回 false，由调用方决定要不要提示）
 */
export async function openNoteAt(app: App, path: string, line = 0, ch = 0): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;

  const leaf = findMarkdownLeaf(app, path) ?? app.workspace.getLeaf("tab");
  const pos = { line: Math.max(0, line), ch: Math.max(0, ch) };

  await leaf.openFile(file, {
    eState: { line: pos.line, ch: pos.ch },
    active: true,
    // 新标签页里如果复用旧 state，会先闪一下旧位置；显式给 state 更稳
    state: { mode: "source" },
  });
  app.workspace.setActiveLeaf(leaf, { focus: true });

  const view = leaf.view;
  if (view instanceof MarkdownView) {
    // eState 只在 openFile 那一刻生效；视图已存在时它可能被忽略，
    // 所以这里再显式定位一次（幂等，代价可忽略）
    try {
      view.editor.setCursor(pos);
      view.editor.scrollIntoView({ from: pos, to: pos }, true);
    } catch {
      /* 视图尚未完成布局时可能抛错，位置已经由 eState 设好，忽略即可 */
    }
  }
  return true;
}

/** 该 PDF 是否已经在某个批注视图里打开（用于「就地滚动」而不是新开标签页） */
export function findPdfLeaf(app: App, viewType: string, path: string): WorkspaceLeaf | null {
  for (const leaf of app.workspace.getLeavesOfType(viewType)) {
    const state = leaf.getViewState();
    const current = (state.state as { file?: unknown } | null)?.file;
    if (current === path) return leaf;
  }
  return null;
}
