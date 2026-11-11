/**
 * protocol.ts —— OpenAI 兼容协议的**纯函数**部分（零 Obsidian 依赖）
 *
 * 与 client.ts 的分界：
 *   protocol.ts  只做"字符串/JSON 进、字符串/JSON 出"：拼端点、拼请求体、
 *                切 SSE、抽字段、把状态码翻译成人话。**可以脱离 Obsidian 单测**。
 *   client.ts    只负责"把请求发出去"：requestUrl / fetch，以及流式的编排。
 *
 * 这么分的直接收益：CORS、超时、降级这些"环境相关"的坑都集中在 client.ts，
 * 而最容易写错的协议细节（SSE 半包、`[DONE]`、Ollama 与 OpenAI 的字段差异）
 * 有单测兜底 —— 这部分正是"看起来能跑、换个服务就崩"的高发区。
 */

import type { AiResult, AiSettings } from "./types";
import type { ChatMessage } from "./prompt";

export type AiErrorKind = "config" | "auth" | "notfound" | "network" | "ratelimit" | "server" | "aborted" | "unknown";

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
    /** 给用户的可执行建议（显示在弹窗的红色块里） */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

/**
 * baseUrl → 真正的 chat completions 端点。
 *
 * 容错四种常见写法，用户不必读懂"要不要带 /v1"：
 *   https://api.openai.com/v1                   → …/v1/chat/completions
 *   https://api.openai.com/v1/                  → …/v1/chat/completions
 *   https://api.openai.com/v1/chat/completions  → 原样（用户已经写全了）
 *   http://localhost:11434                      → …/11434/v1/chat/completions
 */
export function chatEndpoint(baseUrl: string): string {
  let base = (baseUrl || "").trim();
  if (!base) base = "https://api.openai.com/v1";
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  // 裸域名 / Ollama 原生端口：补 /v1
  if (/^https?:\/\/[^/]+$/.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

/** `/models` 端点，用于设置面板里的「拉取模型列表」 */
export function modelsEndpoint(baseUrl: string): string {
  return chatEndpoint(baseUrl).replace(/\/chat\/completions$/, "/models");
}

/** 请求头：只有非空 key 才带 Authorization（Ollama 不认空串 Bearer） */
export function chatHeaders(settings: AiSettings): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = settings.apiKey.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export function buildRequestBody(settings: AiSettings, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: settings.model.trim(),
    messages,
    stream,
  };
  // temperature 的默认值 0.3 就不发，交给服务端 ——
  // 某些推理模型只接受固定值，硬塞会 400。
  if (settings.temperature !== 0.3) body.temperature = settings.temperature;
  if (settings.maxTokens > 0) body.max_tokens = settings.maxTokens;
  return body;
}

export function assertConfigured(settings: AiSettings): void {
  if (!settings.model.trim()) {
    throw new AiError(
      "还没填模型名",
      "config",
      "打开「设置 → PDF View for Obsidian → AI 伴读」，填一个模型名（例如 gpt-4o-mini 或 qwen2.5:7b）。",
    );
  }
  if (settings.provider === "openai" && !settings.apiKey.trim()) {
    throw new AiError("缺少 API Key", "config", "当前 Provider 需要 API Key，请在设置里填写。");
  }
}

/* ------------------------------------------------------------------ *
 * 响应解析
 * ------------------------------------------------------------------ */

/**
 * 从一条响应/增量里取文本。兼容三家形状：
 *   OpenAI / Ollama(/v1)：choices[0].delta.content
 *   Ollama 原生：          message.content / response
 *   推理模型：             delta.reasoning_content（**不算正文**，丢弃）
 */
export function extractDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, any>;
  const choice = Array.isArray(p.choices) ? p.choices[0] : null;
  const delta = choice?.delta ?? choice?.message;
  if (delta && typeof delta.content === "string") return delta.content;
  if (typeof p.response === "string") return p.response;
  if (typeof p.message?.content === "string") return p.message.content;
  return "";
}

export function extractFullText(payload: unknown): string {
  return extractDelta(payload);
}

export function extractModel(payload: unknown, fallback: string): string {
  const p = payload as Record<string, any> | null;
  return typeof p?.model === "string" && p.model ? p.model : fallback;
}

export function extractUsage(payload: unknown): AiResult["usage"] {
  const p = payload as Record<string, any> | null;
  const u = p?.usage;
  if (!u) return null;
  // OpenAI 用 *_tokens，Ollama 用 *_count
  const prompt = typeof u.prompt_tokens === "number" ? u.prompt_tokens : u.prompt_eval_count;
  const completion = typeof u.completion_tokens === "number" ? u.completion_tokens : u.eval_count;
  if (typeof prompt !== "number" && typeof completion !== "number") return null;
  return { prompt: prompt ?? 0, completion: completion ?? 0 };
}

/**
 * 切 SSE 事件。
 *
 * ★ 两个真实会踩的点：
 *  ① **半包**：一个 TCP chunk 可能把一条事件劈成两半（`data: {"cho` + `ices":…}`），
 *     所以必须返回 `rest` 让下次接着拼，不能逐块 JSON.parse。
 *  ② **CRLF**：有些代理把行尾改写成 `\r\n`，只按 `\n\n` 切会一条事件都切不出来，
 *     表现是"流式没有输出、最后一次性蹦出全文"。
 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const data: string[] = [];
    for (const line of part.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) continue; // `: keep-alive` 注释行直接跳过
      data.push(trimmed.slice(5).trimStart());
    }
    if (data.length > 0) events.push(data.join("\n"));
  }
  return { events, rest };
}

/** 一条 SSE event 的 data → 增量文本；`[DONE]` 返回 null 表示结束 */
export function applySseEvent(data: string): string | null {
  if (data === "[DONE]" || data === "[done]") return null;
  try {
    return extractDelta(JSON.parse(data));
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ *
 * 失败信息人类化
 * ------------------------------------------------------------------ */

export function describeFailure(status: number, body: string, settings: AiSettings): AiError {
  const snippet = body.trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return new AiError(
      `认证失败（${status}）`,
      "auth",
      settings.provider === "ollama"
        ? "Ollama 一般不需要 API Key，请把 API Key 清空试试。"
        : "API Key 不正确或已失效，检查是否有多余空格、是否选对了项目。",
    );
  }
  if (status === 404) {
    return new AiError(
      `接口或模型不存在（404）${snippet ? `：${snippet}` : ""}`,
      "notfound",
      /model/i.test(snippet)
        ? "模型名写错了。Ollama 用 `ollama list` 看真实名字（要带 :tag）；OpenAI 兼容服务按对方文档填。"
        : "Base URL 写错了：要以 /v1 结尾（Ollama 是 http://localhost:11434/v1），但不要带 /chat/completions。",
    );
  }
  if (status === 429) {
    return new AiError("触发限流（429）", "ratelimit", "稍等再试，或在服务商后台提高额度 / 换一个小模型。");
  }
  if (status >= 500) {
    return new AiError(
      `服务端错误（${status}）${snippet ? `：${snippet}` : ""}`,
      "server",
      "多半是服务端临时故障或代理超时，稍后重试。",
    );
  }
  return new AiError(`请求失败（${status}）${snippet ? `：${snippet}` : ""}`, "unknown");
}

/** 网络层异常（fetch 抛错 / requestUrl 抛错）的统一包装 */
export function describeNetworkError(err: unknown, settings: AiSettings): AiError {
  const msg = err instanceof Error ? err.message : String(err);
  const isLocal = settings.provider === "ollama" || /localhost|127\.0\.0\.1/.test(settings.baseUrl);
  return new AiError(
    `连不上服务：${msg}`,
    "network",
    isLocal
      ? "① 确认已经 `ollama serve` 且 `ollama run <模型>` 能跑；② 流式模式需要给 Ollama 放行来源：" +
        "设置环境变量 OLLAMA_ORIGINS=app://obsidian.md 后重启 ollama；③ 手机上的 localhost 是你手机自己，连不到电脑。"
      : "检查网络 / 代理 / Base URL；如果开了流式，试试关掉（流式走 fetch，会被 CORS 拦）。",
  );
}
