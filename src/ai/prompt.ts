/**
 * prompt.ts —— 三种伴读动作的提示词（纯函数，可单测）
 *
 * ── 三条写提示词的纪律 ───────────────────────────────────────────────
 * ① **只给模型它看不到的信息**。文件名和页码有用（帮助判断「这是法条还是摘要」），
 *    但不要把我们自己算出来的坐标、颜色、链接格式塞进去 —— 占 token 且误导。
 * ② **明确要求 Markdown**。结果要落进笔记，模型吐 ```` ```markdown ```` 围栏
 *    会变成笔记里的代码块，非常难看。所以每次都写死「直接输出 Markdown 正文」。
 * ③ **禁止复述原文**。模型很爱先抄一遍再翻译，用户读起来像加载了两遍。
 *    这一点在输出长度/延迟上都心疼，所以三个任务都显式禁止。
 */

import type { AiRequest, AiSettings } from "./types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 粗略判断是否含中日韩文字：只用来决定「auto」翻译方向，错了也无伤大雅 */
export function hasCjk(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

const LANG_NAME: Record<string, string> = {
  zh: "简体中文",
  en: "English",
  ja: "日本語",
};

/** 解析目标语言：auto 时「中文→英文、非中文→中文」 */
export function resolveTargetLang(setting: AiSettings["targetLang"], quote: string): string {
  if (setting !== "auto") return LANG_NAME[setting] ?? setting;
  return hasCjk(quote) ? "English" : "简体中文";
}

/** 系统提示：统一的"角色 + 输出格式"约束 */
function systemPrompt(task: AiRequest["task"], lang: string): string {
  const base =
    "你是一名严谨的学术助手，正在帮用户阅读一份 PDF 文献。回答要准确、克制，" +
    "不要编造原文没有的信息；不确定的地方直接说不确定。";

  const format =
    "输出要求：直接给出 Markdown 正文，不要用 ``` 代码块包裹，" +
    "不要重复原文，不要写「以下是翻译/解释」这类开场白。";

  switch (task) {
    case "translate":
      return `${base}\n任务：把用户给的选段翻译成${lang}。保留专业术语的原词（首次出现可用「译名（original）」格式），保留公式、编号、引用标记。\n${format}`;
    case "explain":
      return `${base}\n任务：解释用户给的选段。先用 1~2 句话说明这段在讲什么，再逐条解释其中的关键概念、术语、隐含前提与可能的歧义。若涉及法条/公式，指出它引用了什么、适用条件是什么。\n${format}`;
    case "summarize":
      return `${base}\n任务：总结用户给的选段。用 3~6 条要点（无序列表）概括核心论点与关键数据，最后用一句话给出「这段的结论是什么」。若选段本身是碎片（例如只有半句），就照实总结这半句能确定的信息，不要 extrapolate。\n${format}`;
  }
}

/**
 * 组织消息。
 * 用户内容里刻意把「上下文」放在**最前面**、原文用分隔线包住：
 * 模型对 `<<<` 这类无歧义分隔符的服从度，明显高于让它自己找边界。
 */
export function buildMessages(req: AiRequest): ChatMessage[] {
  const lang = resolveTargetLang(req.settings.targetLang, req.quote);
  const { documentTitle, page } = req.context;

  const parts: string[] = [];
  parts.push(`【来源】${documentTitle} · 第 ${page} 页`);
  if (req.quote.trim()) {
    parts.push(`【选段开始】\n${req.quote.trim()}\n【选段结束】`);
  } else {
    // 没有选区时（例如从工具栏直接点总结），退化成"总结这一页"，
    // 但我们拿不到整页文本，只能让模型基于文件名和标题作答 —— 提示它别硬编。
    parts.push("（用户没有选中具体文字，请基于来源信息说明你能确定什么，不要编造页面内容。）");
  }

  return [
    { role: "system", content: systemPrompt(req.task, lang) },
    { role: "user", content: parts.join("\n\n") },
  ];
}
