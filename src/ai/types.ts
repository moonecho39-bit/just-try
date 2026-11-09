/**
 * types.ts —— AI 层的类型与默认值（纯类型 + 常量，零依赖）
 *
 * ── 一个刻意的决定：只做「OpenAI 兼容」一种协议 ──────────────────────
 * Ollama 从 0.1.24 起就提供了 `/v1/chat/completions`（OpenAI 兼容端点），
 * 默认监听 `http://localhost:11434`。所以 provider 的差异**只在** baseUrl、
 * 是否需要 apiKey、默认模型名这三件事上，请求体/响应体完全一样。
 *
 * 写两套请求逻辑的代价不是多几十行代码，而是：
 *   · 两套错误处理、两套流式解析、两套「测试连接」—— 每套都会各自长歪；
 *   · 用户换 provider 时行为不一致（一个能流式一个不能、一个报错友好一个不友好）。
 * 所以这里 provider 只是一个**预设三元组**，不是一条代码分支。
 */

/** OpenAI 兼容服务的预设 */
export type AiProvider = "openai" | "ollama" | "custom";

export interface AiProviderPreset {
  id: AiProvider;
  label: string;
  /** 缺省 baseUrl（不含 /chat/completions） */
  baseUrl: string;
  /** 缺省模型 */
  model: string;
  /** 是否必须有 apiKey 才能用 */
  requiresKey: boolean;
  /** 一句话说明，直接显示在设置面板里 */
  hint: string;
}

/**
 * 预设只用于「首次填默认值」和「切换 provider 时自动带出」。
 * 用户改过 baseUrl 后不会被覆盖（见 settingsTab 的切换逻辑）。
 */
export const AI_PRESETS: ReadonlyArray<AiProviderPreset> = [
  {
    id: "openai",
    label: "OpenAI 兼容（OpenAI / DeepSeek / 硅基流动 / OneAPI…）",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    requiresKey: true,
    hint: "任何遵循 /v1/chat/completions 的服务都能用，把 Base URL 换成对方的即可。",
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5:7b",
    requiresKey: false,
    hint: "先 `ollama serve` 并 `ollama pull qwen2.5:7b`。API Key 留空即可。",
  },
  {
    id: "custom",
    label: "自定义（局域网 / 反代 / vLLM / LM Studio…）",
    baseUrl: "http://localhost:8000/v1",
    model: "",
    requiresKey: false,
    hint: "Base URL 要写到 /v1 为止，不要带 /chat/completions。",
  },
];

export function presetOf(id: AiProvider): AiProviderPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0];
}

/** 三种伴读动作 */
export type AiTask = "translate" | "explain" | "summarize";

export interface AiTaskMeta {
  id: AiTask;
  label: string;
  /** 工具栏/菜单里的图标（Obsidian 内置 lucide 名） */
  icon: string;
  /** 结果块的标题，插入笔记时用 */
  heading: string;
}

export const AI_TASKS: ReadonlyArray<AiTaskMeta> = [
  { id: "translate", label: "翻译", icon: "languages", heading: "AI 翻译" },
  { id: "explain", label: "解释", icon: "help-circle", heading: "AI 解释" },
  { id: "summarize", label: "总结", icon: "align-left", heading: "AI 总结" },
];

export function taskMeta(id: AiTask): AiTaskMeta {
  return AI_TASKS.find((t) => t.id === id) ?? AI_TASKS[0];
}

export interface AiSettings {
  provider: AiProvider;
  /** 不含尾部斜杠，不含 /chat/completions */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 0~2 */
  temperature: number;
  /** 输出上限（tokens），0 = 不传，交给服务端默认 */
  maxTokens: number;
  /** 翻译目标语言；"auto" = 中→英、其它→中 */
  targetLang: "auto" | "zh" | "en" | "ja";
  /**
   * 是否用流式输出（打字机效果）。
   * 默认 **关**，原因见 client.ts 文件头：requestUrl 不能流式，
   * 一旦开流式就必须换成 fetch，而 fetch 在移动端/自建服务上会撞 CORS。
   */
  stream: boolean;
  /** 插入笔记时是否附带原文引用（`> > 原文`） */
  includeQuote: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  temperature: 0.3,
  maxTokens: 0,
  targetLang: "auto",
  stream: false,
  includeQuote: true,
};

/** 一次请求要发给模型的东西 */
export interface AiRequest {
  task: AiTask;
  /** 用户选中的原文（可能是空：总结整页时没有选区） */
  quote: string;
  /** 上下文：文件名、页码，帮助模型别把「页眉」当成正文 */
  context: { documentTitle: string; page: number };
  settings: AiSettings;
}

/** 流式回调：增量文本 */
export type AiDeltaHandler = (delta: string) => void;

export interface AiResult {
  text: string;
  /** 实际使用的模型名（响应里回显的，可能和设置不同） */
  model: string;
  /** 首字延迟 / 总耗时（ms），显示在弹窗角上，方便用户判断该不该换模型 */
  firstTokenMs: number | null;
  totalMs: number;
  /** token 用量（服务端给了才有） */
  usage: { prompt: number; completion: number } | null;
  /** 是否被用户中断 */
  aborted: boolean;
}
