/**
 * client.ts —— 传输层：把请求真正发出去（requestUrl / fetch）
 *
 * ── 为什么默认走 requestUrl，而不是 fetch ────────────────────────────
 * Obsidian 渲染进程的 `app://obsidian.md` 源对第三方域名发 fetch 会被 CORS 拦。
 * `requestUrl` 是 Obsidian 提供的**主进程转发**通道：不受 CORS 约束、
 * 移动端也能用、还能绕过部分混合内容限制。
 * 所以「非流式」这条主路径**必须**用 requestUrl —— 这是本文件的硬约束。
 *
 * ── 但 requestUrl 拿不到流 ──────────────────────────────────────────
 * 它把整个响应体缓冲完才返回，没有 ReadableStream。想要打字机效果，
 * 只能改用 `fetch` + `response.body.getReader()`。于是有了第二条路径：
 *
 *   设置里 stream = false（默认）→ requestUrl，稳、无 CORS、不可中途取消
 *   设置里 stream = true        → fetch，有打字机、可 AbortController 取消
 *
 * fetch 路径的真实代价（设置面板里逐条写给用户看）：
 *   1. **CORS**：Ollama 默认只放行 localhost/127.0.0.1，Obsidian 的源是
 *      `app://obsidian.md`，必须让用户设置 `OLLAMA_ORIGINS=app://obsidian.md`
 *      （或 `*`）后重启 ollama serve，否则浏览器层直接 "Failed to fetch"。
 *   2. **移动端**：`http://localhost` 在手机上指的是手机自己，连不到桌面端的
 *      Ollama；Android WebView 还可能拦截明文 http（cleartext）。
 *   3. **不能中断 requestUrl**：非流式只能用 Promise.race 超时"不再等"，
 *      底层请求仍在跑。所以 UI 上也让用户能取消（关掉弹窗即可）。
 *   4. **自动降级**：流式失败（多半是 CORS）时静默改用 requestUrl 重试一次，
 *      否则用户会以为插件坏了。弹窗里会保留"流式不可用"的日志。
 */

import { requestUrl } from "obsidian";
import type { AiRequest, AiResult, AiSettings } from "./types";
import { buildMessages, type ChatMessage } from "./prompt";
import {
  AiError,
  applySseEvent,
  assertConfigured,
  buildRequestBody,
  chatEndpoint,
  chatHeaders,
  describeFailure,
  describeNetworkError,
  extractFullText,
  extractModel,
  extractUsage,
  modelsEndpoint,
  splitSse,
} from "./protocol";

/* 纯函数从这里再导出一次，调用方只 import client 就够了 */
export {
  AiError,
  applySseEvent,
  assertConfigured,
  buildRequestBody,
  chatEndpoint,
  chatHeaders,
  describeFailure,
  describeNetworkError,
  extractDelta,
  extractFullText,
  extractModel,
  extractUsage,
  modelsEndpoint,
  splitSse,
} from "./protocol";

/** 非流式请求的兜底超时：requestUrl 本身不可取消，只能"不再等" */
const REQUEST_TIMEOUT_MS = 180_000;
/** 流式的空闲超时：两个 chunk 之间超过这么久就认为挂了 */
const IDLE_TIMEOUT_MS = 60_000;

export interface CompleteOptions {
  /** 有它 + 设置里开了 stream，就走流式 */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  /** 内部降级用：true 表示"不要再试 fetch 了" */
  forceBuffered?: boolean;
}

/**
 * 发一次对话请求。
 *
 * 路由：
 *   stream && onDelta && !forceBuffered → fetch 流式；**失败自动降级**
 *   否则                                → requestUrl 一次性返回
 */
export async function complete(req: AiRequest, opts: CompleteOptions = {}): Promise<AiResult> {
  const settings = req.settings;
  assertConfigured(settings);

  const messages = buildMessages(req);
  const wantStream = settings.stream && !!opts.onDelta && !opts.forceBuffered;
  const startedAt = Date.now();

  if (wantStream) {
    try {
      return await completeStreaming(settings, messages, startedAt, opts);
    } catch (err) {
      if (err instanceof AiError && err.kind === "aborted") throw err;
      // 降级：让 UI 把已经打出去的字擦掉（传空串表示"重置"）
      opts.onDelta?.("");
      return completeBuffered(settings, messages, startedAt, opts, err);
    }
  }
  return completeBuffered(settings, messages, startedAt, opts, null);
}

async function completeBuffered(
  settings: AiSettings,
  messages: ChatMessage[],
  startedAt: number,
  _opts: CompleteOptions,
  cause: unknown,
): Promise<AiResult> {
  let res;
  try {
    res = await withTimeout(
      requestUrl({
        url: chatEndpoint(settings.baseUrl),
        method: "POST",
        headers: chatHeaders(settings),
        contentType: "application/json",
        body: JSON.stringify(buildRequestBody(settings, messages, false)),
        throw: false,
      }),
      REQUEST_TIMEOUT_MS,
    );
  } catch (err) {
    throw describeNetworkError(err, settings);
  }

  if (res.status < 200 || res.status >= 300) {
    throw describeFailure(res.status, res.text ?? "", settings);
  }

  let payload: unknown;
  try {
    payload = res.json;
  } catch {
    throw new AiError("响应不是合法 JSON", "server", res.text?.slice(0, 200));
  }

  const text = extractFullText(payload).trim();
  if (!text) {
    throw new AiError("模型返回了空内容", "server", "换个模型试试；有些推理模型会把内容放进 reasoning_content。");
  }

  if (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    console.warn("[pdf-annotator] 流式失败，已降级为普通请求：", why);
  }

  return {
    text,
    model: extractModel(payload, settings.model),
    firstTokenMs: null,
    totalMs: Date.now() - startedAt,
    usage: extractUsage(payload),
    aborted: false,
  };
}

/**
 * 流式请求。这里**只能**用 fetch —— 见文件头。
 * 用 reader.read() 逐块解码，SSE 半包在 splitSse 里做。
 */
async function completeStreaming(
  settings: AiSettings,
  messages: ChatMessage[],
  startedAt: number,
  opts: CompleteOptions,
): Promise<AiResult> {
  const controller = new AbortController();
  const abortByUser = (): void => controller.abort();
  opts.signal?.addEventListener("abort", abortByUser, { once: true });

  let idleTimer = 0;
  const armIdle = (): void => {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  let res: Response;
  try {
    armIdle();
    res = await fetch(chatEndpoint(settings.baseUrl), {
      method: "POST",
      headers: chatHeaders(settings),
      body: JSON.stringify(buildRequestBody(settings, messages, true)),
      signal: controller.signal,
    });
  } catch (err) {
    window.clearTimeout(idleTimer);
    throw describeNetworkError(err, settings);
  }

  if (!res.ok) {
    window.clearTimeout(idleTimer);
    const body = await res.text().catch(() => "");
    throw describeFailure(res.status, body, settings);
  }
  if (!res.body) {
    window.clearTimeout(idleTimer);
    throw new AiError("该环境不支持流式响应", "network", "请在设置里关闭「流式输出」。");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const model = settings.model;
  let firstTokenMs: number | null = null;
  let aborted = false;

  try {
    for (;;) {
      armIdle();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSse(buffer);
      buffer = rest;

      for (const data of events) {
        const delta = applySseEvent(data);
        if (delta === null || !delta) continue;
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        text += delta;
        opts.onDelta?.(delta);
      }
    }
    // 收尾：有些服务最后一条事件没有空行结尾
    if (buffer.trim()) {
      for (const data of splitSse(`${buffer}\n\n`).events) {
        const delta = applySseEvent(data);
        if (delta) {
          text += delta;
          opts.onDelta?.(delta);
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      if (!opts.signal?.aborted) {
        throw new AiError(
          "流式响应超时",
          "network",
          `超过 ${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒没收到新内容。关掉流式再试，或换个小模型。`,
        );
      }
      aborted = true;
    } else {
      throw describeNetworkError(err, settings);
    }
  } finally {
    window.clearTimeout(idleTimer);
    opts.signal?.removeEventListener("abort", abortByUser);
    void reader.cancel().catch(() => undefined);
  }

  if (!text.trim() && !aborted) throw new AiError("模型返回了空内容", "server", "换个模型试试。");

  return {
    text,
    model,
    firstTokenMs,
    totalMs: Date.now() - startedAt,
    usage: null,
    aborted: aborted || opts.signal?.aborted === true,
  };
}

/* ------------------------------------------------------------------ *
 * 设置面板用的小工具
 * ------------------------------------------------------------------ */

/** 「测试连接」：发一个 max_tokens=1 的最小请求，验证 URL / Key / 模型三件事 */
export async function testConnection(settings: AiSettings): Promise<{ ok: boolean; message: string; model?: string }> {
  const t0 = Date.now();
  try {
    assertConfigured(settings);
    const res = await withTimeout(
      requestUrl({
        url: chatEndpoint(settings.baseUrl),
        method: "POST",
        headers: chatHeaders(settings),
        contentType: "application/json",
        body: JSON.stringify({
          model: settings.model.trim(),
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
        throw: false,
      }),
      30_000,
    );
    if (res.status < 200 || res.status >= 300) {
      const err = describeFailure(res.status, res.text ?? "", settings);
      return { ok: false, message: `${err.message}${err.hint ? `\n${err.hint}` : ""}` };
    }
    const model = extractModel(res.json, settings.model);
    return { ok: true, message: `连接正常（${Date.now() - t0} ms）· 模型 ${model}`, model };
  } catch (err) {
    const e = err instanceof AiError ? err : describeNetworkError(err, settings);
    return { ok: false, message: `${e.message}${e.hint ? `\n${e.hint}` : ""}` };
  }
}

/** 拉模型列表（OpenAI 的 /v1/models，Ollama 也支持） */
export async function fetchModels(settings: AiSettings): Promise<{ models: string[]; error?: string }> {
  try {
    const res = await withTimeout(
      requestUrl({
        url: modelsEndpoint(settings.baseUrl),
        method: "GET",
        headers: chatHeaders(settings),
        throw: false,
      }),
      20_000,
    );
    if (res.status < 200 || res.status >= 300) {
      return { models: [], error: describeFailure(res.status, res.text ?? "", settings).message };
    }
    const data = res.json as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    const names = [...(data.data ?? []).map((m) => m.id), ...(data.models ?? []).map((m) => m.name)].filter(
      (n): n is string => typeof n === "string" && n.length > 0,
    );
    return { models: Array.from(new Set(names)).sort() };
  } catch (err) {
    return { models: [], error: (err instanceof Error ? err.message : String(err)) };
  }
}

/* ------------------------------------------------------------------ */

/** requestUrl 不可取消，只能"不再等"（底层请求仍会跑完并被丢弃） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new AiError(`请求超时（${Math.round(ms / 1000)} 秒）`, "network", "服务端可能过载，或 Base URL 指向了不可达的内网地址。"));
    }, ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
}
