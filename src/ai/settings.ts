/**
 * settings.ts —— 设置的读写与清洗
 *
 * 一律走 `plugin.loadData()/saveData()`（即 `.obsidian/plugins/<id>/data.json`），
 * 不自己写文件：这样 Obsidian 的同步、备份、迁移都不用我们操心。
 *
 * 读的时候必须**逐字段兜底** —— data.json 是用户能手改的，
 * 也是升级后旧版本留下的，任何一个字段缺失或类型不对都不该让插件起不来。
 */

import type { Plugin } from "obsidian";
import { DEFAULT_AI_SETTINGS, presetOf, type AiProvider, type AiSettings } from "./types";

export type PluginSettings = {
  ai: AiSettings;
  /** 便签伴生笔记放在哪：source = 与 PDF 同目录，folder = 统一放一个文件夹 */
  noteLocation: "source" | "folder";
  /** noteLocation = folder 时用的文件夹 */
  noteFolder: string;
  /** 便签备注文件命名后缀，默认 "pdf-notes" → `论文 (pdf-notes).md` */
  noteSuffix: string;
  /**
   * 是否让本插件接管 .pdf 的打开方式（双击 / 点链接直接进批注视图）。
   *
   * 默认 false —— 本项目的原则是不抢 Obsidian 原生查看器。但在原生查看器
   * 打不开某些文件（只有空白页、页码 0/0）时，这是唯一能让用户继续读下去
   * 的开关，所以留一个显式的、可随时关掉的入口。
   * 注意：改变这个值需要重启 Obsidian 才生效（扩展名注册在启动时做）。
   */
  openPdfInPlugin: boolean;
  /**
   * 打开 PDF 时自动进「全屏阅读」（收起两侧边栏）。
   *
   * 默认 false：改布局是件有副作用的事，得用户自己点头。
   * 但侧栏关不掉、PDF 只能占半屏时，这是最省事的一次性开关。
   */
  focusOnOpen: boolean;
};

export const DEFAULT_SETTINGS: PluginSettings = {
  ai: { ...DEFAULT_AI_SETTINGS },
  noteLocation: "source",
  noteFolder: "PDF 批注",
  noteSuffix: "pdf-notes",
  openPdfInPlugin: false,
  focusOnOpen: false,
};

export async function loadSettings(plugin: Plugin): Promise<PluginSettings> {
  let raw: unknown = null;
  try {
    raw = await plugin.loadData();
  } catch (err) {
    console.warn("[pdf-annotator] 读取设置失败，使用默认值", err);
  }
  return sanitizeSettings(raw);
}

export async function saveSettings(plugin: Plugin, settings: PluginSettings): Promise<void> {
  await plugin.saveData(settings);
}

/** 把任意输入洗成合法设置（导出以便单测） */
export function sanitizeSettings(raw: unknown): PluginSettings {
  const root = (raw ?? {}) as Record<string, unknown>;
  const aiRaw = (root.ai ?? {}) as Record<string, unknown>;

  const provider = pickProvider(aiRaw.provider);
  const preset = presetOf(provider);

  const ai: AiSettings = {
    provider,
    baseUrl: str(aiRaw.baseUrl, preset.baseUrl).trim() || preset.baseUrl,
    apiKey: str(aiRaw.apiKey, DEFAULT_AI_SETTINGS.apiKey),
    model: str(aiRaw.model, preset.model),
    temperature: clamp(num(aiRaw.temperature, DEFAULT_AI_SETTINGS.temperature), 0, 2),
    maxTokens: Math.max(0, Math.round(num(aiRaw.maxTokens, 0))),
    targetLang: pickLang(aiRaw.targetLang),
    stream: bool(aiRaw.stream, DEFAULT_AI_SETTINGS.stream),
    includeQuote: bool(aiRaw.includeQuote, DEFAULT_AI_SETTINGS.includeQuote),
  };

  return {
    ai,
    noteLocation: root.noteLocation === "folder" ? "folder" : "source",
    noteFolder: str(root.noteFolder, DEFAULT_SETTINGS.noteFolder).replace(/^\/+|\/+$/g, "") || DEFAULT_SETTINGS.noteFolder,
    noteSuffix: str(root.noteSuffix, DEFAULT_SETTINGS.noteSuffix).trim() || DEFAULT_SETTINGS.noteSuffix,
    openPdfInPlugin: bool(root.openPdfInPlugin, DEFAULT_SETTINGS.openPdfInPlugin),
    focusOnOpen: bool(root.focusOnOpen, DEFAULT_SETTINGS.focusOnOpen),
  };
}

function pickProvider(v: unknown): AiProvider {
  return v === "ollama" || v === "custom" || v === "openai" ? v : "openai";
}

function pickLang(v: unknown): AiSettings["targetLang"] {
  return v === "zh" || v === "en" || v === "ja" || v === "auto" ? v : "auto";
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
