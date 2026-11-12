/**
 * renderer.ts —— PDF.js 渲染层（与 Obsidian 完全解耦，可单测）
 *
 * ── 为什么用 pdfjs-dist 3.x 的 legacy 构建 ──────────────────────────
 * ① Obsidian 插件最终只是一个 CommonJS 的 main.js，没有打包器帮我们处理
 *    worker 的 URL 与 MIME。pdfjs-dist 4+ 的 worker 是纯 ESM，
 *    在 app:// 协议下 new Worker(url, {type:"module"}) 极易撞 MIME 限制。
 * ② 3.x 提供 `pdf.worker.entry`，import 之后会挂到 window.pdfjsWorker，
 *    pdf.js 检测到它就不会去 new Worker，直接在主线程跑 —— 在 Obsidian 里
 *    零配置、零外部资源，这是最稳的“能跑起来”方案。
 * 代价：大文档渲染会占用主线程。阶段二会换成 Blob + Worker 的真并发方案，
 * 本文件已经预留了 `setupWorker()` 这个唯一的改动点。
 * ──────────────────────────────────────────────────────────────────
 */

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf";
// 副作用导入：把 WorkerMessageHandler 挂到 window.pdfjsWorker（主线程 fake worker）
import "pdfjs-dist/legacy/build/pdf.worker.entry";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { PageGeometry } from "./coords";
import type { PdfTextContentLike } from "./link/textIndex";
import { EmbeddedCMapReaderFactory } from "./pdf/cmapFactory";

type PageViewportLike = ReturnType<PDFPageProxy["getViewport"]>;
type RenderTaskLike = ReturnType<PDFPageProxy["render"]>;
type TextLayerTaskLike = { promise: Promise<void>; cancel?: () => void };

export interface RenderPageOptions {
  /** 渲染缩放倍率，1.0 = PDF 原始尺寸（1pt 对应 1 CSS px） */
  scale: number;
  /** 默认取 window.devicePixelRatio，高清屏下保证文字锐利 */
  devicePixelRatio?: number;
  /** 是否同时重建文本层，默认 true */
  withTextLayer?: boolean;
}

export interface PageRenderResult {
  pageNumber: number;
  /** 该页的几何真值（含 scale=1 尺寸 + 当前 scale） */
  geometry: PageGeometry;
  /** 当前视口尺寸（CSS px），用来设置容器宽高 */
  viewportWidth: number;
  viewportHeight: number;
}

/** 渲染被主动取消：不是错误，调用方应当静默忽略 */
export function isCancelledError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "RenderingCancelledException" || name === "AbortException";
}

/** 文本内容 + 该页的坐标系信息：构造文本索引所需的全部原料 */
export interface PageTextInfo {
  pageNumber: number;
  content: PdfTextContentLike;
  /** viewport(scale=1) 的仿射矩阵，[a,b,c,d,e,f] */
  transform: number[];
  width: number;
  height: number;
}

const MAX_TEXT_CACHE = 300;

export class PDFRenderer {
  private doc: PDFDocumentProxy | null = null;
  private pageCache = new Map<number, PDFPageProxy>();
  private metricsCache = new Map<number, { baseWidth: number; baseHeight: number; rotation: number }>();
  private renderTasks = new Map<number, RenderTaskLike>();
  private textTasks = new Map<number, TextLayerTaskLike>();
  /**
   * 文本内容缓存。
   * 回链解析只需要文本内容（不需要位图），所以打开文档后**不需要**先把页渲染出来
   * 就能算出高亮位置 —— 这让"第 300 页有 3 条回链"也能立刻显示。
   * 单页文本约几十 KB，超过 MAX_TEXT_CACHE 就整体清空（比写 LRU 划算：
   * 重新取一次的代价只有几毫秒，而 LRU 的记账成本会让这里变复杂）。
   */
  private textContentCache = new Map<number, PageTextInfo>();

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  /**
   * @param data PDF 字节流（Obsidian 里来自 vault.readBinary）
   */
  async load(data: ArrayBuffer | Uint8Array): Promise<number> {
    await this.dispose();

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    const loadingTask = pdfjsLib.getDocument({
      data: bytes,
      // 关键：关掉 eval，Obsidian 的 CSP 不允许 new Function
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: false,
      /*
       * CJK 的 CMap 表。
       *
       * 中文期刊 PDF（知网、万方）普遍用 GBK-EUC-H / UniGB-UCS2-H 这类双字节
       * 编码，而且**字体不嵌入**。pdf.js 必须靠这张表才能把编码映射到字形，
       * 缺表时它不报错，只是中文整片消失、剩下数字和标点——用户看到的
       * 就是「乱码」。
       *
       * 官方做法是给 cMapUrl 让它去 fetch，但 Obsidian 的 app:// 协议下
       * 没有可用的静态资源地址，且社区插件只分发三个文件。所以这里换成
       * 内嵌表：CMap 内容随 main.js 一起走，离线、零外部依赖。
       */
      cMapPacked: true,
      CMapReaderFactory: EmbeddedCMapReaderFactory,
    } as Parameters<typeof pdfjsLib.getDocument>[0]);

    this.doc = await loadingTask.promise;
    return this.doc.numPages;
  }

  get pageCount(): number {
    return this.doc?.numPages ?? 0;
  }

  get isReady(): boolean {
    return this.doc !== null;
  }

  private getDoc(): PDFDocumentProxy {
    if (!this.doc) throw new Error("[pdf-annotator] PDFRenderer 尚未 load()");
    return this.doc;
  }

  private async getPage(pageNumber: number): Promise<PDFPageProxy> {
    const cached = this.pageCache.get(pageNumber);
    if (cached) return cached;
    const page = await this.getDoc().getPage(pageNumber);
    this.pageCache.set(pageNumber, page);
    return page;
  }

  /* ---------------------------------------------------------------- *
   * 几何真值：scale = 1 的页面尺寸
   * ---------------------------------------------------------------- */

  /**
   * 取某页在 scale=1 下的尺寸。
   * ★ 这是所有批注坐标的基准，必须在任何渲染之前就能拿到（占位骨架要用）。
   */
  async getPageMetrics(pageNumber: number) {
    const cached = this.metricsCache.get(pageNumber);
    if (cached) return cached;

    const page = await this.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const metrics = {
      baseWidth: baseViewport.width,
      baseHeight: baseViewport.height,
      rotation: baseViewport.rotation,
    };
    this.metricsCache.set(pageNumber, metrics);
    return metrics;
  }

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  /**
   * 渲染一页：Canvas 负责视觉，独立 TextLayer 负责文本选中。
   *
   * 为什么必须分开：
   *  - Canvas 是位图，浏览器无法在上面选中文字；
   *  - TextLayer 是一堆绝对定位、透明文字的 <span>，只有它能被 Range 选中；
   *  - 两者用同一个 viewport 计算尺寸，像素级对齐。
   *
   * @returns 渲染结果；若本次渲染被新的渲染请求取消，返回 null。
   */
  async renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    textLayerDiv: HTMLElement,
    options: RenderPageOptions,
  ): Promise<PageRenderResult | null> {
    const page = await this.getPage(pageNumber);
    const scale = options.scale;
    const dpr = options.devicePixelRatio ?? (window.devicePixelRatio || 1);

    const baseViewport = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });

    const cssW = Math.floor(viewport.width);
    const cssH = Math.floor(viewport.height);

    /*
     * 同页有未完成的渲染任务时先取消 —— 必须在改 canvas 尺寸**之前**。
     * pdf.js 的 cancel 是异步生效的：先把它叫停，再动画布，
     * 否则旧任务会继续往"已经换了尺寸的画布"上画，出来是一片撕开的色块。
     */
    this.cancelPage(pageNumber);

    /* --- Canvas：像素尺寸 = CSS 尺寸 × dpr --- */
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.max(1, Math.floor(cssW * dpr));
    canvas.height = Math.max(1, Math.floor(cssH * dpr));

    /*
     * 必须是 alpha: true。
     * alpha: false 的画布是"不透明"的：一旦 width/height 被重置（改尺寸 =
     * 丢弃整张位图），在下一次真正绘制之前浏览器把它当成**纯黑**填充。
     * 缩放时那几十毫秒的黑屏就是从这来的；如果这一帧因为竞态没补上，
     * 黑就会一直留着（用户的"持续黑屏"）。
     * 用透明画布，未绘制的部分透出 .pdfa-page 的白底，最坏也只是白屏一下。
     */
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("[pdf-annotator] 无法获取 2D 上下文");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const task = page.render({
      canvasContext: ctx,
      viewport,
      // 用 pdf.js 自己的 transform 做 dpr 缩放，比 ctx.scale 更稳妥：
      // pdf.js 内部计算裁剪区域时用的是 viewport，不认外部 ctx 状态。
      ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] as number[] } : {}),
      background: "rgb(255,255,255)",
    });
    this.renderTasks.set(pageNumber, task);

    try {
      await task.promise;
    } catch (err) {
      if (isCancelledError(err)) return null;
      throw err;
    } finally {
      if (this.renderTasks.get(pageNumber) === task) {
        this.renderTasks.delete(pageNumber);
      }
    }

    /* --- TextLayer --- */
    if (options.withTextLayer !== false) {
      await this.renderTextLayer(page, textLayerDiv, viewport, scale);
    }

    return {
      pageNumber,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      geometry: {
        pageNumber,
        baseWidth: baseViewport.width,
        baseHeight: baseViewport.height,
        scale,
        rotation: viewport.rotation,
      },
    };
  }

  /**
   * 构建文本层。
   *
   * ⚠️ 两个必踩的坑：
   * ① 容器上必须设置 CSS 变量 --scale-factor。pdf.js 3.9+ 的 span 字号是
   *    `calc(var(--scale-factor) * Npx)`，变量缺失时字号全部退化成 0，
   *    文字位置整体崩塌（表现：选中框在原位、文字却全挤在左上角）。
   * ② 必须显式给容器宽高。position:absolute + inset:0 在流式布局里
   *    拿不到正确高度，会导致滚动到页面中段就选不中文本。
   */
  private async renderTextLayer(
    page: PDFPageProxy,
    container: HTMLElement,
    viewport: PageViewportLike,
    scale: number,
  ): Promise<void> {
    const prev = this.textTasks.get(page.pageNumber);
    prev?.cancel?.();
    this.textTasks.delete(page.pageNumber);

    container.textContent = "";
    container.style.width = `${Math.floor(viewport.width)}px`;
    container.style.height = `${Math.floor(viewport.height)}px`;
    container.style.setProperty("--scale-factor", String(scale));
    // v4 起改名，提前写好以便将来平滑升级
    container.style.setProperty("--total-scale-factor", String(scale));

    const textContent = await page.getTextContent();

    // pdfjs 3.x：函数式 API。若将来升到 4.x，这里是唯一需要改的地方。
    const renderTextLayer = (pdfjsLib as unknown as {
      renderTextLayer?: (params: unknown) => TextLayerTaskLike;
    }).renderTextLayer;
    if (!renderTextLayer) {
      throw new Error("[pdf-annotator] 当前 pdfjs-dist 版本不提供 renderTextLayer，请锁定 3.11.x");
    }

    const task = renderTextLayer({
      textContentSource: textContent,
      container,
      viewport,
      textDivs: [],
    });
    this.textTasks.set(page.pageNumber, task);

    try {
      await task.promise;
    } catch (err) {
      if (!isCancelledError(err)) throw err;
    } finally {
      if (this.textTasks.get(page.pageNumber) === task) {
        this.textTasks.delete(page.pageNumber);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * 文本内容（回链解析用，与渲染解耦）
   * ---------------------------------------------------------------- */

  /**
   * 取某页的文本内容 + scale=1 的坐标系。
   *
   * 与 renderPage 分开的原因：解析回链只需要文本，不需要位图。
   * 如果耦合在一起，用户一打开 300 页的 PDF 就得把 300 页全渲染一遍
   * 才知道高亮在哪 —— 那是分钟级的等待；只取文本是毫秒级。
   */
  async getPageText(pageNumber: number): Promise<PageTextInfo | null> {
    if (!this.doc) return null;
    if (pageNumber < 1 || pageNumber > this.doc.numPages) return null;

    const cached = this.textContentCache.get(pageNumber);
    if (cached) return cached;

    const page = await this.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const content = (await page.getTextContent()) as unknown as PdfTextContentLike;
    const info: PageTextInfo = {
      pageNumber,
      content,
      transform: Array.from(baseViewport.transform),
      width: baseViewport.width,
      height: baseViewport.height,
    };

    if (this.textContentCache.size >= MAX_TEXT_CACHE) this.textContentCache.clear();
    this.textContentCache.set(pageNumber, info);
    return info;
  }

  /* ---------------------------------------------------------------- *
   * 取消 / 释放
   * ---------------------------------------------------------------- */

  cancelPage(pageNumber: number): void {
    const task = this.renderTasks.get(pageNumber);
    if (task) {
      try {
        task.cancel();
      } catch {
        /* 已完成的 task 取消会抛错，忽略 */
      }
      this.renderTasks.delete(pageNumber);
    }
    const textTask = this.textTasks.get(pageNumber);
    if (textTask?.cancel) {
      try {
        textTask.cancel();
      } catch {
        /* noop */
      }
      this.textTasks.delete(pageNumber);
    }
  }

  /** 页面滚出很远时调用：释放 pdf.js 的页面资源，只留几何缓存 */
  releasePage(pageNumber: number): void {
    this.cancelPage(pageNumber);
    const page = this.pageCache.get(pageNumber);
    if (page) {
      try {
        page.cleanup();
      } catch {
        /* noop */
      }
      this.pageCache.delete(pageNumber);
    }
    // metricsCache 保留：占位骨架随时要重新算尺寸
  }

  async dispose(): Promise<void> {
    for (const task of this.renderTasks.values()) {
      try {
        task.cancel();
      } catch {
        /* noop */
      }
    }
    this.renderTasks.clear();
    this.textTasks.clear();
    this.pageCache.clear();
    this.metricsCache.clear();
    this.textContentCache.clear();

    if (this.doc) {
      const doc = this.doc;
      this.doc = null;
      try {
        await doc.destroy();
      } catch {
        /* noop */
      }
    }
  }
}
