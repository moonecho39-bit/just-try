/**
 * palettes.ts —— 色组与色槽
 *
 * 设计取舍：
 *  · 颜色不是“一个全局当前色”，而是**每个用途一个色槽**（色槽 = surface）。
 *    道理很朴素：用户用红色画框、用黄色高亮、用蓝黑写字，
 *    这三种选择必须各自记住，切工具时不能互相污染。
 *  · 色组（palette）只决定“取色器里展示哪些候选”，
 *    真正落到批注上的永远是具体色值 —— 所以换色组不会改动已有批注。
 */

export type SurfaceKey = "highlight" | "shape" | "ink" | "marker" | "note";

export type PaletteId = "macaron" | "morandi" | "native" | "custom";

export interface ColorGroup {
  id: PaletteId;
  label: string;
  hint: string;
  colors: string[];
}

export const COLOR_GROUPS: readonly ColorGroup[] = [
  {
    id: "macaron",
    label: "马卡龙",
    hint: "高明度低饱和，适合密集标注",
    colors: ["#FFB5BA", "#FFD8A8", "#FFF3A3", "#B8F0C8", "#A8D8F0", "#D8B8F0"],
  },
  {
    id: "morandi",
    label: "莫兰迪",
    hint: "灰调，长时间阅读不刺眼",
    colors: ["#C9BDB2", "#B5C0B0", "#C2B0B0", "#AEBAC6", "#D5C7B0", "#B9B3C4"],
  },
  {
    id: "native",
    label: "原生高亮",
    hint: "传统荧光笔色，投影/打印辨识度最高",
    colors: ["#FFE066", "#7BE38B", "#6FD3F2", "#FF9AC4", "#FFA94D", "#B197FC"],
  },
  {
    id: "custom",
    label: "自定义",
    hint: "自选色，可保存最近使用",
    colors: [],
  },
];

export function getColorGroup(id: PaletteId): ColorGroup {
  return COLOR_GROUPS.find((g) => g.id === id) ?? COLOR_GROUPS[0];
}

/**
 * 各色槽的默认色。
 * 高亮默认走“原生黄”：0.34 透明度叠在白纸上就是最常见的荧光笔效果。
 */
export const DEFAULT_COLORS: Record<SurfaceKey, string> = {
  highlight: "#FFE066",
  shape: "#E03131",
  ink: "#2F3437",
  marker: "#FFD43B",
  note: "#F2A93B",
};

/** 每个色槽记住自己的色组偏好，互不干扰 */
export const DEFAULT_PALETTES: Record<SurfaceKey, PaletteId> = {
  highlight: "native",
  shape: "morandi",
  ink: "morandi",
  marker: "native",
  note: "macaron",
};

export const SURFACE_LABELS: Record<SurfaceKey, string> = {
  highlight: "文本标记",
  shape: "框线",
  ink: "铅笔",
  marker: "马克笔",
  note: "便签",
};

/* ------------------------------------------------------------------ *
 * 自定义色持久化
 *
 * 用 localStorage 而不是插件 data.json：这些是“取色器历史”，
 * 丢了不影响任何批注数据；走 settings 反而要为它升版本、加迁移。
 * ------------------------------------------------------------------ */

const CUSTOM_KEY = "pdf-annotator:custom-colors";
const MAX_CUSTOM = 10;

export function loadCustomColors(): string[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x)).slice(0, MAX_CUSTOM);
  } catch {
    return [];
  }
}

export function rememberCustomColor(color: string): string[] {
  const next = [color, ...loadCustomColors().filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, MAX_CUSTOM);
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式下 localStorage 可能抛错，静默降级 */

  }
  return next;
}

/**
 * 文字色 → 是否适合用白色描边/白色图钉文字。
 * 只看亮度，不用完整的 WCAG 计算：这里只需要一个“别让白字糊在白底上”的判断。
 */
export function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return false;
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  // ITU-R BT.601 亮度
  return (r * 299 + g * 587 + b * 114) / 1000 > 168;
}
