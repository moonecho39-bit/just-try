/**
 * noteStore.ts —— 伴生笔记的 vault 读写（唯一碰 app.vault 的一层）
 *
 * 所有格式逻辑都在 noteFormat.ts（纯函数、有单测）；这里只负责
 * "读文件 / 建目录 / 写回"，把 IO 与格式分开，改格式不必碰 IO。
 *
 * 一条原则：**不在打开 PDF 时创建文件**。
 * 只在用户真的写了第一条便签（或插入第一条 AI 结果）时才落盘，
 * 否则逛一遍文献库会在每个目录里撒下一堆空笔记。
 */

import type { App } from "obsidian";
import { TFile } from "obsidian";
import {
  companionPath,
  anchorLink,
  findBlockRange,
  parseNoteBlocks,
  removeNoteBlock,
  upsertNoteBlock,
  type NoteBlockInput,
  type NoteLocationSettings,
  type StoredNote,
} from "./noteFormat";

export interface NoteFileStoreOptions extends NoteLocationSettings {
  app: App;
}

export class NoteFileStore {
  constructor(private readonly opts: NoteFileStoreOptions) {}

  pathFor(pdfPath: string): string {
    return companionPath(pdfPath, this.opts);
  }

  /** 读全文；文件不存在返回空串（**不**创建） */
  async read(pdfPath: string): Promise<string> {
    const file = this.fileFor(pdfPath);
    if (!file) return "";
    return this.opts.app.vault.read(file);
  }

  async list(pdfPath: string): Promise<StoredNote[]> {
    return parseNoteBlocks(await this.read(pdfPath));
  }

  /** 插入/更新一条便签，返回它在文件里的位置（供"跳过去"用） */
  async upsert(pdfPath: string, note: NoteBlockInput): Promise<{ path: string; line: number }> {
    const path = this.pathFor(pdfPath);
    const text = await this.readOrCreate(path, pdfPath);
    const next = upsertNoteBlock(text, note);
    await this.write(path, next);
    const range = findBlockRange(next, note.id);
    return { path, line: range?.start ?? 0 };
  }

  async remove(pdfPath: string, id: string): Promise<void> {
    const file = this.fileFor(pdfPath);
    if (!file) return;
    const text = await this.opts.app.vault.read(file);
    const next = removeNoteBlock(text, id);
    if (next === text) return;
    await this.write(file.path, next);
  }

  /** 生成一条引用链接（图钉 / 面板用） */
  linkFor(pdfPath: string, id: string): string {
    return anchorLink(this.pathFor(pdfPath), id);
  }

  /**
   * 往伴生笔记末尾追加一段原文（AI 结果用）。
   * 不走 upsert：AI 结果是一次性块，没有 id，也不需要后续更新。
   */
  async append(pdfPath: string, text: string): Promise<string> {
    const path = this.pathFor(pdfPath);
    await this.readOrCreate(path, pdfPath);
    const file = this.opts.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.opts.app.vault.append(file, `\n\n${text}\n`);
    else await this.write(path, text);
    return path;
  }

  /* ---------------- 内部 ---------------- */

  private fileFor(pdfPath: string): TFile | null {
    const f = this.opts.app.vault.getAbstractFileByPath(this.pathFor(pdfPath));
    return f instanceof TFile ? f : null;
  }

  /** 读，不存在就创建（含逐级建目录 —— vault.create 不会帮你建父目录） */
  private async readOrCreate(path: string, pdfPath: string): Promise<string> {
    const existing = this.opts.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return this.opts.app.vault.read(existing);

    await this.ensureFolder(path);
    const title = (pdfPath.split("/").pop() ?? "PDF").replace(/\.pdf$/i, "");
    const header =
      `# ${title} · 便签\n\n` +
      "> 本文件由 PDF View 自动维护：每条便签是一个 Callout，\n" +
      "> 末尾的 `^pdfa-note-…` 是 PDF 上那枚图钉要跳的锚点。删掉 Callout 就等于删掉便签。\n";
    await this.opts.app.vault.create(path, header);
    return header;
  }

  private async write(path: string, text: string): Promise<void> {
    const file = this.opts.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.opts.app.vault.modify(file, text);
      return;
    }
    await this.ensureFolder(path);
    await this.opts.app.vault.create(path, text);
  }

  private async ensureFolder(path: string): Promise<void> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!dir) return;
    let cur = "";
    for (const part of dir.split("/")) {
      cur = cur ? `${cur}/${part}` : part;
      if (this.opts.app.vault.getAbstractFileByPath(cur)) continue;
      try {
        await this.opts.app.vault.createFolder(cur);
      } catch {
        /* 并发创建时已存在，忽略 */
      }
    }
  }
}
