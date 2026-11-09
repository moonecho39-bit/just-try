/**
 * mdRender.ts —— 把 Markdown 渲染进一个容器（AI 结果 / 便签预览共用）
 *
 * 两个必须处理的细节：
 *  ① `MarkdownRenderer.render` 是**异步**的（要解析图片尺寸、渲染数学公式）。
 *     同一容器连续触发多次时，后发的渲染可能先完成，导致"旧内容盖掉新内容"。
 *     这里用序号（token）作废旧调用。
 * ② 它需要一个 `Component` 来托管子组件（embed 的 iframe、mermaid 等）的生命周期。
 *     每次渲染新建一个 Component，`unload()` 时会把内部挂的子组件一并清掉，
 *     否则反复预览会累积一堆没人释放的渲染器。
 */

import { Component, MarkdownRenderer } from "obsidian";
import type { App } from "obsidian";

export class MarkdownPreview {
  private component: Component | null = null;
  private token = 0;

  constructor(private readonly app: App) {}

  /** 渲染到容器（会先清空） */
  async render(el: HTMLElement, markdown: string, sourcePath: string): Promise<void> {
    const my = ++this.token;
    this.component?.unload();
    const comp = new Component();
    comp.load();
    this.component = comp;

    /*
     * 刻意用原生 `textContent = ""` / `classList` 而不是 Obsidian 的
     * `el.empty()` / `addClass()`：那两个是宿主往 HTMLElement 原型上挂的扩展，
     * 组件一旦放到别处（比如不启动 Obsidian 的样式校验页）就会 TypeError，
     * 表现为"预览永远是空白"，还很难看出原因。
     */
    el.textContent = "";
    if (!markdown.trim()) {
      el.classList.add("is-empty");
      return;
    }
    el.classList.remove("is-empty");

    try {
      await MarkdownRenderer.render(this.app, markdown, el, sourcePath, comp);
    } catch (err) {
      // 渲染失败不该让整个预览变空白：退回纯文本，至少内容还在
      console.warn("[pdf-annotator] Markdown 渲染失败", err);
      el.textContent = "";
      el.classList.add("pdfa-md-fallback");
      el.textContent = markdown;
      return;
    }
    if (my !== this.token) return; // 已被更新的渲染取代
  }

  /** 清空并释放子组件 */
  clear(el?: HTMLElement): void {
    this.token++;
    this.component?.unload();
    this.component = null;
    if (el) el.textContent = "";
  }

  destroy(): void {
    this.component?.unload();
    this.component = null;
  }
}
