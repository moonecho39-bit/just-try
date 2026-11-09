/**
 * attachments.ts —— 把剪贴板里的图片存成 vault 附件
 *
 * ── 为什么用 createBinary + getAvailablePathForAttachment ────────────
 * ① `getAvailablePathForAttachment()` 会按用户设置的「附件默认位置」
 *    （同目录 / 指定文件夹 / 与笔记同名的子文件夹）生成**不重名**的路径，
 *    并自动补 `1`、`2` 后缀。自己拼路径迟早会覆盖别人的图。
 * ② `createBinary` 是唯一能写二进制的公开 API（`create` 只接受字符串，
 *    走它会把 PNG 写坏）。
 *
 * ── 文件名为什么带时间戳 ────────────────────────────────────────────
 * 剪贴板图片没有原名（浏览器只给 "image.png"）。若直接用它，
 * 每次粘贴都是 image.png → Obsidian 会生成 image 1.png、image 2.png…
 * 一年后附件夹里全是 image 37.png，谁也认不出哪张是哪张。
 * 用 `pasted-20261109-0032-17.png` 至少能按时间找回来。
 */

import type { App } from "obsidian";
import { TFile, normalizePath } from "obsidian";

/** 支持的图片扩展名（剪贴板给的 MIME 未必可靠，按 MIME 再按文件名兜底） */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

/** 单个附件上限：超过就拒绝（避免把 50MB 的截图塞进同步库） */
const MAX_BYTES = 20 * 1024 * 1024;

/** 从 paste 事件的剪贴板数据里挑出图片文件 */
export function imagesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  // items 比 files 更可靠：某些平台 files 里没有图片，只有 items
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      if (!item.type.startsWith("image/")) continue;
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0 && data.files) {
    for (const f of Array.from(data.files)) {
      if (f.type.startsWith("image/")) out.push(f);
    }
  }
  return out;
}

/** 时间戳文件名：pasted-20261109-003217.png */
export function pastedFileName(mime: string, now = new Date()): string {
  const ext = MIME_EXT[mime] ?? mime.split("/")[1] ?? "png";
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `pasted-${stamp}.${ext}`;
}

export interface SavedAttachment {
  path: string;
  /** 直接可插入的 Markdown：`![[path]]` */
  markdown: string;
}

/**
 * 存一张图片，返回可插入的嵌入语法。
 * `sourcePath` 传当前笔记路径 —— 决定"附件默认位置 = 同目录/子文件夹"时的落点。
 */
export async function saveImageAttachment(app: App, file: File, sourcePath: string): Promise<SavedAttachment> {
  if (file.size > MAX_BYTES) {
    throw new Error(`图片太大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 ${MAX_BYTES / 1024 / 1024} MB`);
  }

  const name = pastedFileName(file.type || "image/png");
  // 这个方法在 1.4+ 才有；老版本回退到附件文件夹拼接
  const target = await resolveAttachmentPath(app, name, sourcePath);
  await ensureParent(app, target);

  const buffer = await file.arrayBuffer();
  await app.vault.createBinary(target, buffer);

  return { path: target, markdown: `![[${target}]]` };
}

async function resolveAttachmentPath(app: App, name: string, sourcePath: string): Promise<string> {
  const fm = app.fileManager as unknown as {
    getAvailablePathForAttachment?: (filename: string, sourcePath?: string) => Promise<string>;
  };
  if (typeof fm.getAvailablePathForAttachment === "function") {
    return normalizePath(await fm.getAvailablePathForAttachment(name, sourcePath));
  }
  // 回退：附件文件夹设置读不到时，放到 sourcePath 同目录
  const dir = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : "";
  return normalizePath(dir ? `${dir}/${name}` : name);
}

async function ensureParent(app: App, path: string): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!dir) return;
  if (app.vault.getAbstractFileByPath(dir)) return;
  let cur = "";
  for (const part of dir.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    if (app.vault.getAbstractFileByPath(cur)) continue;
    try {
      await app.vault.createFolder(cur);
    } catch {
      /* 已存在（并发） */
    }
  }
}

/** 反查：某个附件现在还存在吗（用于预览里显示"图没了"而不是一片空白） */
export function attachmentExists(app: App, path: string): boolean {
  return app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
}
