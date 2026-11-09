/**
 * demo/entry.ts —— 纯浏览器验证页（不进插件包）
 *
 * 目的：不启动 Obsidian，也能用真实浏览器核对
 *   ① 绘制层的 viewBox 缩放是否等价（同一批批注放在 100% 与 60% 两页上）
 *   ② 高亮的 multiply 叠色、铅笔轮廓带的形状、箭头三角形、便签图钉的恒定像素尺寸
 *   ③ 工具栏 / 取色弹层的排版
 *   ④ 阶段三：回链高亮的叠色与 hover 描边、反向链接面板、跟随提示条、拖拽幽灵块
 *
 * 构建：npx esbuild demo/entry.ts --bundle --format=iife --outfile=demo/demo.js \
 *          --alias:obsidian=./demo/obsidian-stub.ts
 */

import { PageLayer } from "../src/annot/pageLayer";
import { ToolState } from "../src/annot/toolState";
import type { Annotation, BacklinkMark, InkAnnotation } from "../src/annot/types";
import { BacklinkPanel } from "../src/ui/backlinkPanel";
import { NoteEditor } from "../src/ui/noteEditor";
import type { BacklinkEntry } from "../src/link/scan";
import type { PdfLinkTarget } from "../src/link/format";

const NOW = Date.now();

/* ------------------------------------------------------------------ *
 * 回链高亮（阶段三）
 * ------------------------------------------------------------------ */

function mockTarget(page: number, color: string, hex: string): PdfLinkTarget {
  return {
    linkpath: "社会保险法实施评估报告.pdf",
    page,
    selection: [8, 0, 10, 45],
    rect: null,
    color: { param: color, hex, name: color },
    colorRaw: color,
    offset: null,
    annotationId: null,
    alias: null,
    subpath: `page=${page}&selection=8,0,10,45&color=${color}`,
  };
}

function makeEntries(): BacklinkEntry[] {
  const mk = (i: number, path: string, page: number, color: string, hex: string, quote: string): BacklinkEntry => ({
    key: `e${i}`,
    sourcePath: path,
    sourceName: path.split("/").pop() ?? path,
    position: {
      start: { line: 10 + i * 3, col: 0, offset: 100 * i },
      end: { line: 10 + i * 3, col: 40, offset: 100 * i + 40 },
    },
    page,
    target: mockTarget(page, color, hex),
    quote,
  });

  return [
    mk(1, "读书笔记/社会保险法评估.md", 3, "yellow", "#FFE066", "制度体系尚未成熟，当前面临的根本问题是改革初期轻信世界银行……"),
    mk(2, "读书笔记/社会保险法评估.md", 3, "red", "#FF8C8C", "路径偏差的根源不在技术，而在制度设计的初始假设。"),
    mk(3, "读书笔记/社会保险法评估.md", 7, "blue", "#8FC5F5", "统筹层次过低导致地区间费率竞争。"),
    mk(4, "读书笔记/第三章 制度分析.md", 3, "green", "#A3E2A8", "精算平衡是名义账户制的核心约束。"),
    mk(5, "方法笔记.md", 12, "gray", "#C4C4C4", "（矩形区域：表 3-2 的测算结果）"),
  ];
}

function makeAnnotations(): Annotation[] {
  const highlight: Annotation = {
    id: "h1",
    kind: "highlight",
    page: 1,
    color: "#FFE066",
    opacity: 0.34,
    rects: [
      { x: 0.1, y: 0.078, w: 0.62, h: 0.026 },
      { x: 0.1, y: 0.112, w: 0.44, h: 0.026 },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };

  const underline: Annotation = {
    id: "u1",
    kind: "underline",
    page: 1,
    color: "#E03131",
    thickness: 2,
    rects: [{ x: 0.1, y: 0.152, w: 0.52, h: 0.026 }],
    createdAt: NOW,
    updatedAt: NOW + 1,
  };

  const rect: Annotation = {
    id: "r1",
    kind: "rect",
    page: 1,
    color: "#AEBAC6",
    strokeWidth: 2,
    from: { x: 0.1, y: 0.24 },
    to: { x: 0.55, y: 0.36 },
    createdAt: NOW,
    updatedAt: NOW + 2,
  };

  const arrow: Annotation = {
    id: "ar1",
    kind: "arrow",
    page: 1,
    color: "#E03131",
    strokeWidth: 2,
    from: { x: 0.62, y: 0.36 },
    to: { x: 0.9, y: 0.24 },
    createdAt: NOW,
    updatedAt: NOW + 3,
  };

  // 铅笔：正弦 + 速度调制出来的宽度差（模拟真实手写）
  const pencilPts: InkAnnotation["points"] = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60;
    pencilPts.push([0.1 + t * 0.75, 0.46 + Math.sin(t * Math.PI * 2.2) * 0.035, 1.2 + Math.sin(t * 9) * 0.9 + 1.1]);
  }
  const pencil: Annotation = {
    id: "p1",
    kind: "ink",
    page: 1,
    color: "#2F3437",
    mode: "pencil",
    points: pencilPts,
    width: 2,
    opacity: 1,
    createdAt: NOW,
    updatedAt: NOW + 4,
  };

  // 马克笔：等宽、半透明、multiply
  const markerPts: InkAnnotation["points"] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    markerPts.push([0.12 + t * 0.68, 0.62 + Math.sin(t * Math.PI) * 0.02, 11]);
  }
  const marker: Annotation = {
    id: "m1",
    kind: "ink",
    page: 1,
    color: "#FFD43B",
    mode: "marker",
    points: markerPts,
    width: 11,
    opacity: 0.36,
    createdAt: NOW,
    updatedAt: NOW + 5,
  };

  const note: Annotation = {
    id: "n1",
    kind: "note",
    page: 1,
    at: { x: 0.8, y: 0.42 },
    body: "这里要回看第三章的推导",
    color: "#F2A93B",
    createdAt: NOW,
    updatedAt: NOW + 6,
  };

  return [highlight, underline, rect, arrow, pencil, marker, note];
}

function mount(host: HTMLElement, width: number, height: number, label: string): void {
  const page = document.createElement("div");
  page.className = "pdfa-page";
  page.style.width = `${width}px`;
  page.style.height = `${height}px`;

  const text = document.createElement("div");
  text.className = "textLayer pdfa-text-layer";
  text.style.cssText = `color:#333;font:13px/1.55 "Segoe UI",system-ui,sans-serif;padding:${height * 0.07}px ${width * 0.09}px;`;
  text.innerHTML = `
    <p style="margin:0 0 ${height * 0.012}px">PDF 批注的坐标必须能在任意缩放下复现，所以渲染层与批注层是分离的。</p>
    <p style="margin:0 0 ${height * 0.012}px">文本层只负责命中与选区，绘制层只负责几何 —— 两层通过 pt 坐标对齐。</p>
    <p style="margin:0">underline 落在这行文字的基线上，用来验证 thickness 与行高的关系。</p>`;
  page.appendChild(text);

  const geo = { pageNumber: 1, baseWidth: 600, baseHeight: 800, scale: width / 600, rotation: 0 };
  const layer = new PageLayer(page, geo, new ToolState(), {
    onCreate: () => undefined,
    onPlaceNote: () => undefined,
    onOpenNote: () => undefined,
    onContextMenu: () => undefined,
  });
  layer.setAnnotations(makeAnnotations());

  const wrap = document.createElement("figure");
  wrap.className = "demo-figure";
  wrap.innerHTML = `<figcaption>${label}（容器 ${width}×${height}px，viewBox 恒为 600×800pt）</figcaption>`;
  wrap.appendChild(page);
  host.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * 阶段三：回链高亮页
 * ------------------------------------------------------------------ */

/** 页面（600×800pt）上的四行文字：top 单位 pt，字号 13pt */
const LINES = [
  { top: 64, text: "PDF 批注的坐标必须能在任意缩放下复现，所以渲染层与批注层是分离的。" },
  { top: 94, text: "文本层只负责命中与选区，绘制层只负责几何 —— 两层通过 pt 坐标对齐。" },
  { top: 124, text: "underline 落在这行文字的基线上，用来验证 thickness 与行高的关系。" },
  { top: 154, text: "这一行没有回链，用来对照 multiply 叠色是否只压暗被高亮的行。" },
];

/**
 * 回链色块直接由 LINES 的同一份坐标生成 —— 于是截图里"色块是否正好盖住文字"
 * 检验的是归一化与 viewBox 的换算，而不是我手抄的像素值。
 */
function backlinksFor(): BacklinkMark[] {
  const marks: BacklinkMark[] = [];
  const colors = ["#FFE066", "#8FC5F5", "#C4C4C4"];
  const widths = [0.86, 0.7, 0.62];
  LINES.slice(0, 3).forEach((line, i) => {
    marks.push({
      key: `bl-${i}`,
      page: 1,
      // 行高 17pt（比字号略高），与 13pt 文字叠加后上下各留 2pt 余量
      rects: [{ x: 0.09, y: (line.top - 2) / 800, w: widths[i] * 0.82, h: 17 / 800 }],
      color: colors[i],
      opacity: 0.3,
      title: `笔记.md · 第 ${12 + i * 5} 行`,
      sourcePath: "读书笔记/笔记.md",
      line: 11 + i * 5,
    });
  });
  return marks;
}

function mountBacklinkPage(host: HTMLElement): void {
  const page = document.createElement("div");
  page.className = "pdfa-page";
  page.style.width = "600px";
  page.style.height = "800px";

  const text = document.createElement("div");
  text.className = "textLayer pdfa-text-layer";
  text.style.cssText = "color:#2b2b2b;font-family:'Segoe UI',system-ui,sans-serif;";
  for (const line of LINES) {
    const el = document.createElement("div");
    el.style.cssText = [
      "position:absolute",
      "left:9%",
      "width:82%",
      `top:${(line.top / 800) * 100}%`,
      "font-size:13px",
      "line-height:1.3",
    ].join(";");
    el.textContent = line.text;
    text.appendChild(el);
  }
  page.appendChild(text);

  const layer = new PageLayer(page, { pageNumber: 1, baseWidth: 600, baseHeight: 800, scale: 1, rotation: 0 }, new ToolState(), {
    onCreate: () => undefined,
    onPlaceNote: () => undefined,
    onOpenNote: () => undefined,
    onContextMenu: () => undefined,
  });
  layer.setBacklinks(backlinksFor());
  // 第二块处于 hover：验证 non-scaling-stroke 的强调描边
  layer.setHoverBacklink("bl-1");

  const wrap = document.createElement("figure");
  wrap.className = "demo-figure";
  wrap.innerHTML = `<figcaption>回链高亮（阶段三）—— 黄 / 蓝 / 灰三色 multiply 叠色，第二块为 hover 态</figcaption>`;
  wrap.appendChild(page);
  host.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * 阶段三：反向链接面板
 * ------------------------------------------------------------------ */

function mountPanel(host: HTMLElement): void {
  const panel = new BacklinkPanel({
    onActivate: () => undefined,
    onHover: () => undefined,
    onFilterChange: () => undefined,
    onClose: () => undefined,
  });
  panel.el.classList.add("is-open");

  const box = document.createElement("div");
  box.className = "demo-panel-box";
  box.appendChild(panel.el);

  const wrap = document.createElement("figure");
  wrap.className = "demo-figure";
  wrap.innerHTML = `<figcaption>反向链接面板（真实组件）—— 按来源笔记分组，第三项为 hover 态</figcaption>`;
  wrap.appendChild(box);
  host.appendChild(wrap);

  panel.setEntries(makeEntries(), 3);
  box.querySelector<HTMLElement>('[data-key="e3"]')?.classList.add("is-active");
}

const pagesHost = document.getElementById("pages");
if (pagesHost) {
  mount(pagesHost, 600, 800, "100%");
  mount(pagesHost, 360, 480, "60% —— 同一批批注，位置应等比一致");
  mount(pagesHost, 300, 400, "50% —— 图钉应保持同样的视觉大小");
}

const stage3Host = document.getElementById("stage3");
if (stage3Host) {
  mountBacklinkPage(stage3Host);
  mountPanel(stage3Host);
}

const stage4Host = document.getElementById("stage4");
if (stage4Host) {
  mountNoteEditor(stage4Host);
  mountAiModal(stage4Host);
}

/* ------------------------------------------------------------------ *
 * 阶段四 / 五：富文本便签 + AI 弹窗（纯样式预览）
 * ------------------------------------------------------------------ */

/**
 * 便签浮层用的是**真实组件**（NoteEditor），所以这里能同时校验：
 * 双栏比例、预览区宽度、工具条图标基线、图片是否被限制在栏宽内。
 */
function mountNoteEditor(host: HTMLElement): void {
  const editor = new NoteEditor({
    app: {} as never,
    sourcePath: () => "论文/社会保险法 (pdf-notes).md",
    onCommit: () => undefined,
    onDelete: () => undefined,
    onOpenInNote: () => undefined,
  });

  const anno = {
    id: "n1",
    kind: "note" as const,
    page: 3,
    at: { x: 0.8, y: 0.42 },
    color: "#F2A93B",
    createdAt: NOW,
    updatedAt: NOW,
    body: [
      "## 这一段的三个前提",
      "",
      "1. **精算平衡**是名义账户制的核心约束",
      "2. 统筹层次过低 → 地区间费率竞争",
      "",
      "> 制度体系尚未成熟，当前面临的根本问题是改革初期轻信世界银行…",
      "",
      "参考 `NDC` 的记账利率设定，另见 ![[附件/pasted-20261109-003217.png]]",
    ].join("\n"),
  };

  // 锚点给一个屏幕中央的方块，浮层就会出现在它下方
  editor.open(anno, { left: 40, top: 10, right: 62, bottom: 32, width: 22, height: 22 });

  const wrap = document.createElement("figure");
  wrap.className = "demo-figure";
  wrap.innerHTML = `<figcaption>富文本便签（真实组件）—— 左编辑 / 右 Markdown 预览，粘贴图片落成 ![[…]]</figcaption>`;
  host.appendChild(wrap);

  // NoteEditor 是 fixed 浮层，挂在 body 上；截图时把它挪到 figure 里便于对照
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(".pdfa-note-editor");
    if (!el) return;
    el.style.position = "static";
    el.style.margin = "0 auto";
    wrap.appendChild(el);
  }, 0);
}

/**
 * AI 弹窗：Modal 需要宿主才实例化，这里按同一套 class 复刻 DOM，
 * 只为校验样式（标题栏、打字机光标、错误块、底部按钮的排布）。
 */
function mountAiModal(host: HTMLElement): void {
  const wrap = document.createElement("figure");
  wrap.className = "demo-figure";
  wrap.innerHTML = `<figcaption>AI 伴读弹窗（样式预览）—— 流式态 + 元信息 + 「插入到当前笔记」</figcaption>`;

  const box = document.createElement("div");
  box.className = "modal pdfa-ai-modal is-streaming";
  box.style.cssText = "position:static;display:block;width:640px;max-width:100%;margin:0;";
  box.innerHTML = `
    <div class="modal-header pdfa-ai-title">
      <span class="pdfa-ai-title-icon svg-icon">✨</span>
      <span>翻译</span>
      <span class="pdfa-ai-title-src">第 3 页 · 社会保险法实施评估报告</span>
    </div>
    <div class="modal-content">
      <div class="pdfa-ai-body">
        <div class="pdfa-ai-stream is-markdown">
          <p>这段讲的是名义账户制的<strong>记账利率</strong>如何决定替代率。作者认为：</p>
          <ul>
            <li>记账利率若低于工资增长率，替代率会被动下降；</li>
            <li>制度设计之初假设的 5% 回报率，在人口老龄化下不可持续。</li>
          </ul>
          <blockquote>制度体系尚未成熟，当前面临的根本问题是改革初期轻信世界银行的预测。</blockquote>
        </div>
      </div>
      <div class="pdfa-ai-meta">
        <span>qwen2.5:7b · 首字 412 ms · 共 3.4 s · 620→184 tokens</span>
      </div>
      <div class="pdfa-ai-foot">
        <button class="pdfa-icon-btn svg-icon">⧉</button>
        <button class="pdfa-icon-btn svg-icon">⟳</button>
        <button class="pdfa-btn">停止</button>
        <span class="pdfa-ai-foot-spacer"></span>
        <button class="pdfa-btn pdfa-btn-primary">插入到当前笔记</button>
      </div>
    </div>`;
  wrap.appendChild(box);

  const err = document.createElement("div");
  err.className = "modal pdfa-ai-modal is-error";
  err.style.cssText = "position:static;display:block;width:640px;max-width:100%;margin:14px 0 0;";
  err.innerHTML = `
    <div class="modal-header pdfa-ai-title">
      <span class="pdfa-ai-title-icon svg-icon">✨</span>
      <span>解释</span>
      <span class="pdfa-ai-title-src">第 7 页 · 社会保险法实施评估报告</span>
    </div>
    <div class="modal-content">
      <div class="pdfa-ai-body"><div class="pdfa-ai-error">
        <div class="pdfa-ai-error-head"><span class="pdfa-ai-error-icon svg-icon">⚠</span><span>连不上服务：Failed to fetch</span></div>
        <div class="pdfa-ai-error-hint">① 确认已经 \`ollama serve\` 且 \`ollama run qwen2.5:7b\` 能跑；
② 流式模式需要给 Ollama 放行来源：设置环境变量 OLLAMA_ORIGINS=app://obsidian.md 后重启 ollama；
③ 手机上的 localhost 是你手机自己，连不到电脑。</div>
      </div></div>
      <div class="pdfa-ai-meta"></div>
      <div class="pdfa-ai-foot">
        <button class="pdfa-icon-btn svg-icon">⧉</button>
        <button class="pdfa-icon-btn svg-icon">⟳</button>
        <span class="pdfa-ai-foot-spacer"></span>
        <button class="pdfa-btn pdfa-btn-primary" disabled>插入到当前笔记</button>
      </div>
    </div>`;
  wrap.appendChild(err);

  host.appendChild(wrap);
}
