/**
 * demo/obsidian-stub.ts —— 仅供 demo 打包用的 `obsidian` 替身
 *
 * 浏览器校验页要复用真实的 UI 组件（BacklinkPanel 会调用 setIcon），
 * 但 `obsidian` 模块只有宿主里才有。这里给一个最小实现：
 * 画一个内联 SVG 方框 + 首字母，足以校验排版（尺寸、对齐、间距）。
 *
 * 用法：esbuild --alias:obsidian=./demo/obsidian-stub.ts
 */

const GLYPHS: Record<string, string> = {
  "file-text": "▤",
  x: "✕",
  link: "🔗",
  "link-2": "⇄",
  quote: "❝",
  pencil: "✎",
  "trash-2": "🗑",
  sparkles: "✨",
  languages: "文",
  "help-circle": "?",
  "align-left": "¶",
  "external-link": "↗",
  bold: "B",
  italic: "I",
  code: "</>",
  list: "•",
  copy: "⧉",
  "rotate-cw": "⟳",
  "alert-triangle": "⚠",
  plus: "+",
  minus: "−",
  "chevron-up": "⌃",
  "chevron-left": "‹",
  "chevron-right": "›",
  "move-horizontal": "↔",
  "maximize": "⤢",
  "message-square": "💬",
  "message-square-plus": "💬✎",
  "undo-2": "↶",
  "redo-2": "↷",
};

export function setIcon(el: HTMLElement, name: string): void {
  el.textContent = GLYPHS[name] ?? "•";
  el.classList.add("svg-icon");
  el.setAttribute("aria-label", name);
}

export function setTooltip(el: HTMLElement, text: string): void {
  el.setAttribute("aria-label", text);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
}

export class Notice {
  constructor(message: string) {
    console.log("[notice]", message);
  }
}

export class Component {
  load(): void {}
  unload(): void {}
  addChild<T>(child: T): T {
    return child;
  }
}
export class ItemView {}
export class TFile {}
export class MarkdownView {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}

/**
 * MarkdownRenderer 的极简替身。
 * 只实现 demo 里用得到的子集（标题 / 加粗 / 斜体 / 行内代码 / 列表 / 引用 / 图片占位），
 * 目的是验证**排版容器**（宽度、行高、图片缩放、引用缩进），不是验证渲染正确性。
 */
export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, el: HTMLElement, _sourcePath: string, _comp?: unknown): Promise<void> {
    el.innerHTML = miniMarkdown(markdown);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/!\[\[([^\]]+)\]\]/g, (_m, p: string) => `<span class="demo-img">🖼 ${p}</span>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, p: string) => `<a class="internal-link">${p}</a>`);
}

function miniMarkdown(md: string): string {
  const out: string[] = [];
  let list = false;
  let quote = false;
  const closeBlocks = (): void => {
    if (list) {
      out.push("</ul>");
      list = false;
    }
    if (quote) {
      out.push("</blockquote>");
      quote = false;
    }
  };

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*$/.test(line)) {
      closeBlocks();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeBlocks();
      out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (!quote) {
        closeBlocks();
        out.push("<blockquote>");
        quote = true;
      }
      out.push(`<p>${inline(line.replace(/^>\s?/, ""))}</p>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (!list) {
        closeBlocks();
        out.push("<ul>");
        list = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    closeBlocks();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeBlocks();
  return out.join("");
}
