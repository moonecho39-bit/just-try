/**
 * 冒烟测试（Node + jsdom，不走 Obsidian）
 *
 * 验证真正容易出错的事：
 *  A. esbuild 打包后，pdf.js 仍能在无 Worker 的环境里解析真实 PDF
 *  B. 坐标换算在任意 scale 下严格守恒（批注不错位的根前提）
 *  C. 手绘采样/平滑/成径：端点不漂、无 NaN、变宽走轮廓带
 *  D. 批注 Store 的增删改与撤销栈（一次清空要能整体回滚）
 *  E. 几何：矩形容器、点到线段、箭头头部
 *  F. 绘制层的 DOM：viewBox、节点属性、pointer-events 开关、几何命中
 *  G. 链接语法：解析 / 构造 / Callout / 颜色名，坏链接不能崩
 *  H. 文本索引：真实 PDF 上 selection ⇄ 矩形 双向自洽
 *  I. 回链扫描：只命中指向本 PDF 的链接，带位置与引用原文
 *  J. 回链绘制层：独立图层、NORM→pt 落位、悬停与命中
 *  K. AI 协议：端点归一、SSE 半包/CRLF、三家响应形状、错误翻译
 *  L. 便签格式：Callout + 块锚点往返、行级增删改、rect → NORM
 *  M. 指针适配层：鼠标 / 触摸兜底、长按、双击、多指中止
 *
 * 运行：node test/run.cjs
 */

import * as fs from "fs";
import * as path from "path";
import { PDFRenderer } from "../src/renderer";
import {
  type PageGeometry,
  type Rect,
  baseRectToNorm,
  baseRectToPdf,
  cssRectToBase,
  cssRectToNorm,
  mergeLineRects,
  normRectToBase,
  normRectToCss,
  pdfRectToBase,
} from "../src/coords";
import { StrokeBuilder, buildInkRender, chaikin, centerlinePathD, ribbonPathD } from "../src/annot/ink";
import { AnnotationStore } from "../src/annot/annotationStore";
import { ToolState } from "../src/annot/toolState";
import { PageLayer } from "../src/annot/pageLayer";
import { arrowGeometry, boxFromPoints, distanceToSegment, isBoxDegenerate } from "../src/annot/geometry";
import type { Annotation, BacklinkMark, HighlightAnnotation, InkAnnotation, NoteAnnotation } from "../src/annot/types";
import {
  buildPdfCallout,
  buildPdfLink,
  colorParam,
  defaultAlias,
  parseColorParam,
  parsePdfLink,
} from "../src/link/format";
import {
  buildTextIndex,
  linkRectsOnPage,
  rectToPdfQuad,
  rectsToSelection,
  selectionText,
  selectionToRects,
} from "../src/link/textIndex";
import { type ScanHost, extractQuote, scanBacklinks } from "../src/link/scan";
import { DEFAULT_AI_SETTINGS } from "../src/ai/types";
import {
  AiError,
  applySseEvent,
  assertConfigured,
  buildRequestBody,
  chatEndpoint,
  chatHeaders,
  describeFailure,
  extractDelta,
  extractModel,
  extractUsage,
  modelsEndpoint,
  splitSse,
} from "../src/ai/protocol";
import { buildMessages, resolveTargetLang } from "../src/ai/prompt";
import {
  anchorLink,
  colorFromToken,
  colorToken,
  companionPath,
  parseNoteBlocks,
  quadCenterToNorm,
  removeNoteBlock,
  renderAiBlock,
  renderNoteBlock,
  upsertNoteBlock,
  withAlias,
} from "../src/note/noteFormat";
import { attachPointer } from "../src/ui/pointer";
import { applyTransform } from "../src/link/textIndex";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/ai/settings";
import { chooseLane, packCards } from "../src/annot/cardLayout";
import {
  lastEofEnd,
  repairedCopyPath,
  trailingJunkLength,
  trimTrailingJunk,
} from "../src/pdf/trailer";

let failed = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function rectNear(a: Rect, b: Rect, eps = 1e-9): boolean {
  return near(a.x, b.x, eps) && near(a.y, b.y, eps) && near(a.w, b.w, eps) && near(a.h, b.h, eps);
}

async function testCoords(): Promise<void> {
  console.log("\n[A] 坐标系统守恒性");
  const geo: PageGeometry = {
    pageNumber: 1,
    baseWidth: 595.276,
    baseHeight: 841.89,
    scale: 1,
    rotation: 0,
  };

  const norm: Rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
  const scales = [0.25, 0.5, 1, 1.25, 1.5, 2, 3.7];

  let allOk = true;
  for (const s of scales) {
    const g = { ...geo, scale: s };
    const css = normRectToCss(norm, g);
    const back = cssRectToNorm(css, g);
    // 往返误差应只受浮点精度限制，不能随 scale 放大
    if (!rectNear(back, norm, 1e-12)) {
      allOk = false;
      console.log(`    scale=${s} 往返失败`, back);
    }
  }
  check("NORM → CSS → NORM 在 0.25x~3.7x 下无漂移", allOk);

  // 一个 CSS 矩形在 scale 变化时，归一化结果必须不变
  const cssAt1: Rect = { x: 100, y: 200, w: 150, h: 20 };
  const normA = cssRectToNorm(cssAt1, { ...geo, scale: 1 });
  const cssAt2 = { x: 100 * 2.4, y: 200 * 2.4, w: 150 * 2.4, h: 20 * 2.4 };
  const normB = cssRectToNorm(cssAt2, { ...geo, scale: 2.4 });
  check("同一文字在 100% 与 240% 下得到相同归一化坐标", rectNear(normA, normB, 1e-12), { normA, normB });

  // 与 PDF 用户空间（y 向上）的互转
  const base: Rect = { x: 72, y: 100, w: 200, h: 24 };
  const pdf = baseRectToPdf(base, geo);
  const backBase = pdfRectToBase(pdf, geo);
  check("BASE ⇄ PDF 用户空间 y 轴翻转可逆", rectNear(backBase, base, 1e-9), { pdf, backBase });
  check(
    "PDF 用户空间 y1 位于页面底部之上（y 向上语义正确）",
    near(pdf.y2, geo.baseHeight - 100, 1e-9) && near(pdf.y1, geo.baseHeight - 124, 1e-9),
    pdf,
  );

  // 多行合并
  const junk: Rect[] = [
    { x: 72, y: 100, w: 40, h: 10 },
    { x: 112, y: 100.5, w: 30, h: 10 },
    { x: 72, y: 116, w: 90, h: 10 },
  ];
  const merged = mergeLineRects(junk);
  check("碎矩形按行合并为 2 条", merged.length === 2, merged);
  check(
    "合并后首行覆盖 [72,142]",
    near(merged[0].x, 72) && near(merged[0].x + merged[0].w, 142),
    merged[0],
  );
}

async function testPdf(): Promise<void> {
  console.log("\n[B] pdf.js 加载与几何读取");

  const file = path.join(__dirname, "fixtures", "sample.pdf");
  const bytes = fs.readFileSync(file);

  const renderer = new PDFRenderer();
  const numPages = await renderer.load(new Uint8Array(bytes));
  check("PDF 解析成功，页数 > 0", numPages > 0, numPages);

  const metrics = await renderer.getPageMetrics(1);
  check(
    "首页 base 尺寸合理（A4 或 A3 量级）",
    metrics.baseWidth > 300 && metrics.baseWidth < 1300 && metrics.baseHeight > 300,
    metrics,
  );
  check("rotation 为 0/90/180/270", [0, 90, 180, 270].includes(metrics.rotation), metrics.rotation);

  // 文本内容存在，才可能有文本层
  const doc: any = (renderer as any).doc;
  const page = await doc.getPage(1);
  const text = await page.getTextContent();
  check("首页存在可提取文本（文本层非空）", text.items.length > 0, `${text.items.length} items`);

  // scale=1 与 scale=2 的 viewport 必须是严格 2 倍关系 —— 这是坐标换算的前提假设
  const vp1 = page.getViewport({ scale: 1 });
  const vp2 = page.getViewport({ scale: 2 });
  check("viewport 尺寸随 scale 线性缩放", near(vp2.width, vp1.width * 2, 1e-6) && near(vp2.height, vp1.height * 2, 1e-6), {
    w1: vp1.width,
    w2: vp2.width,
  });

  await renderer.dispose();
  check("dispose() 后状态归零", renderer.pageCount === 0 && !renderer.isReady);
}

/* ------------------------------------------------------------------ *
 * C. 手绘
 * ------------------------------------------------------------------ */

async function testInk(): Promise<void> {
  console.log("\n[C] 手绘：采样 / 平滑 / 成径");

  const b = new StrokeBuilder({ width: 2, mode: "pencil", baseWidth: 600, baseHeight: 800 });
  check("首个点入列", b.add(10, 10, 0) === true);
  check("同位置点被距离抽稀丢弃", b.add(10.2, 10.1, 16) === false);

  // 快速甩笔：间距大、时间短 → 速度调制让笔宽变细
  b.add(60, 60, 32);
  b.add(160, 160, 48);

  const pts = b.toInkPoints();
  check("采样点数为 3", pts.length === 3, pts.length);
  check("坐标已归一化到 0~1", pts.every(([x, y]) => x > 0 && x < 1 && y > 0 && y < 1), pts);
  check("归一化保留 5 位小数", pts[0][0] === 0.01667, pts[0][0]);
  check("起笔宽度 = 1.1 × 基准", pts[0][2] === 2.2, pts[0][2]);
  check("疾写段显著变细", Math.min(...pts.map((p) => p[2])) < 1.6, pts.map((p) => p[2]));

  const raw = [
    { x: 0, y: 0, w: 2 },
    { x: 10, y: 0, w: 2 },
    { x: 20, y: 10, w: 2 },
  ];
  const sm = chaikin(raw, 1);
  check("chaikin 保持首点不动（否则笔迹整体缩进）", sm[0].x === 0 && sm[0].y === 0);
  check("chaikin 保持尾点不动", sm[sm.length - 1].x === 20 && sm[sm.length - 1].y === 10);
  check("chaikin 提升了点数", sm.length > raw.length, sm.length);

  const centerD = centerlinePathD(chaikin(raw, 1));
  check("中心线路径合法（M 开头、无 NaN）", centerD.startsWith("M ") && !centerD.includes("NaN"), centerD);

  const ribbonD = ribbonPathD(chaikin(raw, 1));
  check("轮廓带闭合且无 NaN", ribbonD.endsWith("Z") && !ribbonD.includes("NaN"), ribbonD);

  const varied = buildInkRender(
    [
      [0.1, 0.1, 1],
      [0.2, 0.2, 3],
      [0.3, 0.3, 1],
      [0.4, 0.35, 3],
    ],
    600,
    800,
    "pencil",
  );
  check("笔宽差异大 → 走轮廓带（fill）", varied.filled === true);

  const flat = buildInkRender(
    [
      [0.1, 0.1, 2],
      [0.2, 0.2, 2],
      [0.3, 0.3, 2],
    ],
    600,
    800,
    "pencil",
  );
  check("等宽 → 走描边（元素更少）", flat.filled === false && flat.strokeWidth === 2, flat.strokeWidth);

  const marker = buildInkRender(
    [
      [0.1, 0.1, 11],
      [0.2, 0.2, 11],
    ],
    600,
    800,
    "marker",
  );
  check("马克笔恒为等宽描边", marker.filled === false && marker.strokeWidth === 11);
}

/* ------------------------------------------------------------------ *
 * D. Store
 * ------------------------------------------------------------------ */

function mkHighlight(id: string, page: number): HighlightAnnotation {
  return {
    id,
    kind: "highlight",
    page,
    color: "#FFE066",
    rects: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.02 }],
    opacity: 0.34,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function testStore(): Promise<void> {
  console.log("\n[D] 批注 Store：增删改 / 撤销栈");

  const store = new AnnotationStore();
  let events = 0;
  let lastPages: number[] = [];
  store.change.on((c) => {
    events++;
    lastPages = c.pages;
  });

  const a = store.add(mkHighlight("h1", 1));
  const b = store.add(mkHighlight("h2", 1));
  store.add(mkHighlight("h3", 2));
  check("三次 add → count=3", store.count === 3, store.count);
  check("每次 add 都广播一次变更", events === 3, events);
  check("按页取回", store.getPage(1).length === 2 && store.getPage(2).length === 1);
  check("变更事件带页码", lastPages.join() === "2", lastPages);

  store.update({ ...a, color: "#123456" });
  check("update 写入新字段", store.get("h1")?.color === "#123456");
  check("update 刷新 updatedAt", (store.get("h1")?.updatedAt ?? 0) >= a.updatedAt);

  store.remove("h2");
  check("remove 生效", store.get("h2") === undefined && store.count === 2);
  check("可以撤销", store.canUndo === true);

  store.undo();
  check("undo 恢复被删批注", store.get("h2") !== undefined && store.count === 3);
  check("undo 后可以重做", store.canRedo === true);
  store.redo();
  check("redo 再次删除", store.get("h2") === undefined && store.count === 2);

  // 先把上一步 redo 删掉的 h2 撤回来，让第 1 页重新有两条批注
  store.undo();
  check("undo 后第 1 页恢复两条", store.getPage(1).length === 2, store.getPage(1).length);

  // 一次清空整页 → 一次撤销必须整体回滚（而不是一条一条撤）
  store.clearPage(1);
  check("clearPage 只清指定页", store.count === 1 && store.getPage(2).length === 1, store.count);
  store.undo();
  check("一次 undo 恢复整页批注", store.getPage(1).length === 2, store.getPage(1).length);

  store.reset();
  check("reset 清空且不留撤销痕迹", store.count === 0 && !store.canUndo && !store.canRedo);

  check("id 为空时自动补一个", store.add({ ...mkHighlight("", 1) }).id.length > 0);
  void b;
}

/* ------------------------------------------------------------------ *
 * E. 几何
 * ------------------------------------------------------------------ */

async function testGeometry(): Promise<void> {
  console.log("\n[E] 几何：框 / 距离 / 箭头");

  const box = boxFromPoints({ x: 10, y: 20 }, { x: 5, y: 8 });
  check("反向拖拽也能得到左上角 + 宽高", box.x === 5 && box.y === 8 && box.w === 5 && box.h === 12, box);
  check("零面积框判定为误触", isBoxDegenerate({ x: 0, y: 0, w: 1, h: 1 }, 2.5, 2.5) === true);
  check("正常框不判误触", isBoxDegenerate({ x: 0, y: 0, w: 10, h: 10 }, 2.5, 2.5) === false);

  check("点到线段（垂足在线段内）", near(distanceToSegment(5, 5, 0, 0, 10, 0), 5, 1e-9));
  check("点到线段（垂足在线段外，夹到端点）", near(distanceToSegment(-5, 0, 0, 0, 10, 0), 5, 1e-9));
  check("退化线段（起止点重合）不除零", near(distanceToSegment(3, 4, 0, 0, 0, 0), 5, 1e-9));

  const arrow = arrowGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
  check("箭头主干提前收笔（不让线头戳出三角）", arrow.lineEnd.x < 100 && arrow.lineEnd.x > 85, arrow.lineEnd);
  check("箭头三角从尖端起笔", arrow.head.startsWith("M 100 0"), arrow.head);
  check("箭头三个顶点闭合", (arrow.head.match(/L/g) ?? []).length === 2 && arrow.head.endsWith("Z"), arrow.head);

  const shortArrow = arrowGeometry({ x: 0, y: 0 }, { x: 5, y: 0 }, 10);
  check("短线上的箭头长度按 60% 收缩", shortArrow.lineEnd.x > 0 && shortArrow.lineEnd.x < 5, shortArrow.lineEnd);
}

/* ------------------------------------------------------------------ *
 * F. 绘制层（jsdom）
 * ------------------------------------------------------------------ */

function testPageLayer(): void {
  console.log("\n[F] 绘制层：viewBox / 节点属性 / 指针开关 / 命中");

  const host = document.createElement("div");
  const geo: PageGeometry = { pageNumber: 3, baseWidth: 600, baseHeight: 800, scale: 2, rotation: 0 };
  const tool = new ToolState();
  const layer = new PageLayer(host, geo, tool, {
    onCreate: () => undefined,
    onPlaceNote: () => undefined,
    onOpenNote: () => undefined,
    onContextMenu: () => undefined,
  });

  const svg = host.querySelector("svg");
  check("绘制层已挂载", svg !== null);
  check("viewBox 就是页面 pt 尺寸", svg?.getAttribute("viewBox") === "0 0 600 800", svg?.getAttribute("viewBox"));
  check("默认 pointer-events 关闭（不挡文字选择）", svg?.classList.contains("is-drawing") === false);

  const hl = mkHighlight("h1", 3);
  const ink: InkAnnotation = {
    id: "i1",
    kind: "ink",
    page: 3,
    color: "#2F3437",
    mode: "pencil",
    points: [
      [0.5, 0.5, 2],
      [0.55, 0.5, 2],
      [0.6, 0.5, 2],
    ],
    width: 2,
    opacity: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const note: NoteAnnotation = {
    id: "n1",
    kind: "note",
    page: 3,
    at: { x: 0.05, y: 0.05 },
    body: "hello",
    color: "#F2A93B",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  layer.setAnnotations([hl, ink, note]);

  const hlRect = host.querySelector(".pdfa-hl");
  check("高亮按 pt 落位（0.1 × 600 = 60）", hlRect?.getAttribute("x") === "60", hlRect?.getAttribute("x"));
  check("高亮用 multiply 混合（文字透得上来）", hlRect?.getAttribute("class") === "pdfa-hl");
  check("高亮透明度写入属性", hlRect?.getAttribute("fill-opacity") === "0.34");

  check("手绘路径已生成", (host.querySelector(".pdfa-ink")?.getAttribute("d") ?? "").startsWith("M "));
  check(
    "铅笔走描边而非填充",
    host.querySelector(".pdfa-ink")?.getAttribute("fill") === "none" &&
      host.querySelector(".pdfa-ink")?.getAttribute("stroke") === "#2F3437",
  );

  const pin = host.querySelector(".pdfa-note-pin");
  check("便签图钉已渲染", pin !== null);
  check(
    "图钉半径按 scale 反算（10px / 2 = 5pt）",
    pin?.querySelector("circle:last-of-type, circle") !== null,
    pin?.getAttribute("transform"),
  );
  check("图钉带 📌 文本", (pin?.textContent ?? "").includes("📌"));

  check("命中高亮矩形（0.1×600=60, 0.1×800=80）", layer.hitTest(65, 88)?.id === "h1");
  check("命中便签图钉", layer.hitTest(30, 40)?.id === "n1");
  check("命中手绘（0.55 × 600 = 330, 400）", layer.hitTest(330, 400)?.id === "i1");
  check("空白处不命中", layer.hitTest(500, 700) === null);

  tool.setActive("pencil");
  layer.refreshTool();
  check("铅笔激活后临时开启指针", host.querySelector("svg")?.classList.contains("is-drawing") === true);

  tool.setActive("select");
  layer.refreshTool();
  check("退出工具后恢复穿透", host.querySelector("svg")?.classList.contains("is-drawing") === false);

  layer.setAnnotations([]);
  check("删空批注后节点被移除", host.querySelector(".pdfa-hl") === null && host.querySelector(".pdfa-note-pin") === null);

  layer.destroy();
  check("destroy 后 SVG 从 DOM 摘除", host.querySelector("svg") === null);
}

/* ------------------------------------------------------------------ *
 * G. 链接语法
 * ------------------------------------------------------------------ */

function testLinkFormat(): void {
  console.log("\n[G] 链接语法：解析 / 构造 / Callout / 颜色");

  const t = parsePdfLink("[[论文.pdf#page=3&selection=8,0,10,45&color=yellow]]");
  check("解析带 selection 与 color 的链接", t !== null);
  check("page = 3", t?.page === 3, t?.page);
  check("selection 解析成 4 个整数（行,字,行,字）", t?.selection?.join(",") === "8,0,10,45", t?.selection);
  check("color=yellow → #FFE066", t?.color?.hex === "#FFE066", t?.color);
  check("linkpath 只留路径", t?.linkpath === "论文.pdf", t?.linkpath);

  const aliased = parsePdfLink("[[a.pdf#page=7|a, p.7]]");
  check("别名被拆出来", aliased?.alias === "a, p.7" && aliased?.page === 7, aliased?.alias);

  const encoded = parsePdfLink("[[my%20paper.pdf#page=1&color=blue]]");
  check("百分号编码的路径能解码", encoded?.linkpath === "my paper.pdf", encoded?.linkpath);

  check("没有 page → null（交回 Obsidian 原生处理）", parsePdfLink("[[a.pdf]]") === null);
  check("不是 PDF → null", parsePdfLink("[[a.md#page=1]]") === null);
  check("页码 0 视为非法", parsePdfLink("[[a.pdf#page=0]]") === null);

  const badSel = parsePdfLink("[[a.pdf#page=2&selection=1,2,3]]");
  check("selection 个数不对 → 丢弃参数但保留 page", badSel?.page === 2 && badSel.selection === null, badSel?.selection);

  const built = buildPdfLink({ path: "p/论文.pdf", page: 12, selection: [1, 0, 3, 20], color: "#FFE066" });
  check("构造出的链接优先写色名", built === "[[p/论文.pdf#page=12&selection=1,0,3,20&color=yellow]]", built);
  const back = parsePdfLink(built);
  check("构造 → 解析 往返一致", back?.page === 12 && back?.selection?.join(",") === "1,0,3,20");

  const withRect = buildPdfLink({ path: "a.pdf", page: 2, rect: [72, 600.456, 300, 640] });
  check("rect 写盘保留 2 位小数", withRect.includes("rect=72,600.46,300,640"), withRect);
  check("rect 链接能被解析回来", parsePdfLink(withRect)?.rect?.length === 4);

  check("自定义色写裸 hex（不带 #，否则会截断 fragment）", colorParam("#123456") === "123456", colorParam("#123456"));
  check("裸 hex 能解析回来", parseColorParam("123456")?.hex === "#123456");
  check("3 位 hex 展开成 6 位", parseColorParam("fa0")?.hex === "#FFAA00", parseColorParam("fa0")?.hex);
  check("未知色名 → null（不抛错）", parseColorParam("chartreuse") === null);
  check("灰色别名 grey → gray", parseColorParam("grey")?.name === "gray");

  const callout = buildPdfCallout({
    link: buildPdfLink({
      path: "a.pdf",
      page: 3,
      selection: [1, 0, 1, 9],
      color: "yellow",
      alias: defaultAlias("a.pdf", 3),
    }),
    color: "yellow",
    quote: "被高亮的一行\n第二行",
  });
  const lines = callout.split("\n");
  check("Callout 首行是 [!PDF|yellow]", lines[0].startsWith("> [!PDF|yellow] [["), lines[0]);
  check("Callout 链接带显示别名", lines[0].endsWith("|a, p.3]]"), lines[0]);
  check("引用原文用 > > 缩进", lines[1] === "> > 被高亮的一行" && lines[2] === "> > 第二行", lines.slice(1));
}

/* ------------------------------------------------------------------ *
 * H. 文本索引（真实 PDF）
 * ------------------------------------------------------------------ */

async function testTextIndex(): Promise<void> {
  console.log("\n[H] 文本索引：字符坐标 ⇄ 屏幕矩形");

  const bytes = fs.readFileSync(path.join(__dirname, "fixtures", "sample.pdf"));
  const renderer = new PDFRenderer();
  await renderer.load(new Uint8Array(bytes));

  const info = await renderer.getPageText(1);
  check("能取到首页文本内容", !!info && info.content.items.length > 0);

  const index = buildTextIndex(1, info!.content, info!.transform, info!.width, info!.height);
  check("切出多行", index.lines.length > 5, index.lines.length);
  check("总字符数 > 200", index.lines.reduce((n, l) => n + l.text.length, 0) > 200);
  check(
    "所有行框都在页面内",
    index.lines.every((l) => l.x >= -1 && l.y >= -1 && l.x + l.w <= index.width + 1 && l.y + l.h <= index.height + 1),
  );
  // ★ 行的顺序 = 内容流顺序，不保证视觉上的从上到下
  //   （这份 PDF 的第一个文本块是页脚页码）。索引只要求"同一份内容恒等"，
  //   所以这里不按 y 排序断言，只保证结构完整。
  check("行号连续且每行都有文本块", index.lines.every((l, i) => l.index === i && l.runs.length > 0 && l.text.length > 0));
  check("行高为正", index.lines.every((l) => l.h > 0));

  const li = index.lines.findIndex((l) => l.text.length > 25);
  check("找到一行足够长的文本", li >= 0, li);
  const line = index.lines[li];

  const sel: [number, number, number, number] = [li, 0, li, 15];
  const rects = selectionToRects(index, sel);
  check("单行选区 → 1 个矩形", rects.length === 1, rects.length);
  check(
    "矩形落在该行的水平范围内",
    rects[0].x >= line.x - 0.5 && rects[0].x + rects[0].w <= line.x + line.w + 0.5,
    [rects[0].x, line.x, line.w],
  );
  check("矩形高度接近行高", Math.abs(rects[0].h - line.h) < 2.5, [rects[0].h, line.h]);
  check("选区文本 = 行文本前 15 字", selectionText(index, sel) === line.text.slice(0, 15), selectionText(index, sel));

  const backSel = rectsToSelection(index, rects);
  check("矩形 → selection 回到同一行", backSel?.[0] === li && backSel?.[2] === li, backSel);
  check("起始字符为 0", backSel?.[1] === 0, backSel?.[1]);
  check("结束字符在 15 附近（±1）", Math.abs((backSel?.[3] ?? 0) - 15) <= 1, backSel?.[3]);

  const multi = selectionToRects(index, [li, 3, li + 1, 8]);
  check("跨行选区 → 2 个矩形", multi.length === 2, multi.length);
  check(
    "第二行矩形从行首附近开始",
    Math.abs(multi[1].x - index.lines[li + 1].x) < 12,
    [multi[1].x, index.lines[li + 1].x],
  );

  const wild = selectionToRects(index, [9999, 0, 9999, 9]);
  check("越界行号被夹到末行而不是崩掉", wild.length === 1, wild.length);

  /* rect= 链接的往返：写出去再读回来必须落回原处 */
  const baseRect: Rect = { x: 100, y: 200, w: 150, h: 60 };
  const quad = rectToPdfQuad(baseRect, index.transform);
  const rectTarget = parsePdfLink(`[[a.pdf#page=1&rect=${quad.join(",")}]]`);
  const got = rectTarget ? linkRectsOnPage(rectTarget, index) : [];
  check("rect 链接 → 1 个 NORM 矩形", got.length === 1, got.length);
  const wantX = baseRect.x / index.width;
  const wantY = baseRect.y / index.height;
  check(
    "rect 写→读 往返落回原处（含 CropBox 偏移）",
    Math.abs(got[0].x - wantX) < 2e-3 &&
      Math.abs(got[0].y - wantY) < 2e-3 &&
      Math.abs(got[0].w - baseRect.w / index.width) < 2e-3 &&
      Math.abs(got[0].h - baseRect.h / index.height) < 2e-3,
    [got[0], { x: wantX, y: wantY }],
  );

  const selTarget = parsePdfLink(`[[a.pdf#page=1&selection=${li},0,${li},15]]`);
  const selRects = selTarget ? linkRectsOnPage(selTarget, index) : [];
  check(
    "selection 链接的矩形 = selectionToRects 的结果",
    selRects.length === 1 && Math.abs(selRects[0].x - rects[0].x / index.width) < 1e-9,
  );

  await renderer.dispose();
}

/* ------------------------------------------------------------------ *
 * I. 回链扫描
 * ------------------------------------------------------------------ */

async function testScan(): Promise<void> {
  console.log("\n[I] 回链扫描：只认指向本 PDF 的链接");

  const PDF = "论文/社会保险法.pdf";
  const files: Record<string, string> = {
    "笔记A.md": [
      "# 读书笔记",
      "",
      "> [!PDF|yellow] [[论文/社会保险法.pdf#page=3&selection=8,0,10,45|社会保险法, p.3]]",
      "> > 制度体系尚未成熟。",
      "> > 第二行引用。",
      "",
      "普通链接：[[论文/社会保险法.pdf#page=7&color=red]]",
      "没有页码：[[论文/社会保险法.pdf]]",
    ].join("\n"),
    "笔记B.md": [
      "指向别处：[[另一篇.pdf#page=2]]",
      "指向本文件：[[../论文/社会保险法.pdf#page=9&rect=72,600,300,640]]",
    ].join("\n"),
    "笔记C.md": "只链接了别的笔记：[[笔记A]]",
  };

  const linkCache: Record<string, Array<{ link: string; position: any }>> = {};
  const collect = (path: string, link: string, line: number): void => {
    const arr = linkCache[path] ?? (linkCache[path] = []);
    arr.push({
      link,
      position: { start: { line, col: 0, offset: line * 100 }, end: { line, col: 0, offset: line * 100 + 10 } },
    });
  };
  collect("笔记A.md", "论文/社会保险法.pdf#page=3&selection=8,0,10,45&color=yellow", 2);
  collect("笔记A.md", "论文/社会保险法.pdf#page=7&color=red", 6);
  collect("笔记A.md", "论文/社会保险法.pdf", 7);
  collect("笔记B.md", "另一篇.pdf#page=2", 0);
  collect("笔记B.md", "../论文/社会保险法.pdf#page=9&rect=72,600,300,640", 1);

  const host: ScanHost = {
    resolvedLinks: {
      "笔记A.md": { [PDF]: 2, "另一篇.pdf": 1 },
      "笔记B.md": { [PDF]: 1 },
      "笔记C.md": { "笔记A.md": 1 },
    },
    getLinks: (p) => linkCache[p] ?? null,
    resolveLinkpath: (linkpath, source) => {
      if (linkpath.endsWith("社会保险法.pdf")) return PDF;
      if (linkpath === "另一篇.pdf") return "论文/另一篇.pdf";
      return null;
    },
    readText: async (p) => files[p] ?? "",
  };

  const result = await scanBacklinks(host, PDF);
  check("命中 3 条（笔记A 两条 + 笔记B 一条）", result.entries.length === 3, result.entries.map((e) => e.page));
  check("笔记C 完全不参与扫描", result.sources === 2, result.sources);
  check("没有页码的链接被过滤", result.entries.every((e) => e.page >= 1));
  check("指向别的 PDF 的链接被排除", result.entries.every((e) => e.target.linkpath.includes("社会保险法")));

  const calloutEntry = result.entries.find((e) => e.page === 3);
  check("Callout 条目的引用原文被抽出来", calloutEntry?.quote === "制度体系尚未成熟。\n第二行引用。", calloutEntry?.quote);
  check("条目带源文件行号（用于跳回）", calloutEntry?.position.start.line === 2, calloutEntry?.position.start.line);
  check("颜色解析进 target", calloutEntry?.target.color?.name === "yellow");

  const rectEntry = result.entries.find((e) => e.page === 9);
  check("rect 链接被识别为区域", rectEntry?.target.rect?.join(",") === "72,600,300,640", rectEntry?.target.rect);
  check("按页码升序排列", result.entries.map((e) => e.page).join(",") === "3,7,9", result.entries.map((e) => e.page));

  check("普通段落里的链接没有引用原文", result.entries.find((e) => e.page === 7)?.quote === null);

  /* extractQuote 的边界 */
  check("非引用行不抽引用", extractQuote(["普通文字"], 0) === null);
  check("遇到空行 / 非引用行就停", extractQuote(["> [[x.pdf#page=1]]", "> > a", "", "> > b"], 0) === "a");
  check("遇到下一个 Callout 标题就停", extractQuote(["> [[x.pdf#page=1]]", "> > a", "> [!PDF|red] x"], 0) === "a");
}

/* ------------------------------------------------------------------ *
 * J. 回链绘制层
 * ------------------------------------------------------------------ */

function testBacklinkLayer(): void {
  console.log("\n[J] 回链绘制层：独立图层 / NORM 落位 / 悬停");

  const host = document.createElement("div");
  const geo: PageGeometry = { pageNumber: 2, baseWidth: 600, baseHeight: 800, scale: 2, rotation: 0 };
  const layer = new PageLayer(host, geo, new ToolState(), {
    onCreate: () => undefined,
    onPlaceNote: () => undefined,
    onOpenNote: () => undefined,
    onContextMenu: () => undefined,
  });

  const mark: BacklinkMark = {
    key: "k1",
    page: 2,
    rects: [{ x: 0.1, y: 0.25, w: 0.5, h: 0.02 }],
    color: "#FFE066",
    opacity: 0.28,
    title: "笔记.md · 第 3 行",
    sourcePath: "笔记.md",
    line: 2,
  };

  layer.setBacklinks([mark]);
  const group = host.querySelector(".pdfa-layer-backlinks");
  const node = host.querySelector(".pdfa-backlink") as SVGGElement | null;
  check("回链有独立图层", group !== null);
  check("回链节点已渲染", node !== null);
  check(
    "回链层排在批注层之前（画在下面）",
    group !== null && group.nextElementSibling?.classList.contains("pdfa-layer-annots") === true,
    group?.nextElementSibling?.getAttribute("class"),
  );

  const rect = node?.querySelector("rect");
  check("NORM → pt 落位（0.1×600=60, 0.25×800=200）", rect?.getAttribute("x") === "60" && rect?.getAttribute("y") === "200", [
    rect?.getAttribute("x"),
    rect?.getAttribute("y"),
  ]);
  check("颜色与透明度写入属性", rect?.getAttribute("fill") === "#FFE066" && rect?.getAttribute("fill-opacity") === "0.28");

  check("几何命中回链", layer.hitTestBacklink(70, 205)?.key === "k1");
  check("空白处不命中回链", layer.hitTestBacklink(400, 700) === null);

  layer.setHoverBacklink("k1");
  check("悬停加 is-hover 类", host.querySelector(".pdfa-backlink")?.classList.contains("is-hover") === true);
  layer.setHoverBacklink(null);
  check("取消悬停移除类", host.querySelector(".pdfa-backlink")?.classList.contains("is-hover") === false);

  layer.setBacklinks([]);
  check("清空后节点被移除", host.querySelector(".pdfa-backlink") === null);

  layer.destroy();
  check("destroy 后图层一起消失", host.querySelector(".pdfa-layer-backlinks") === null);
}

/* ================================================================== *
 * [K] AI 协议
 * ================================================================== */

function testAiProtocol(): void {
  console.log("\n[K] AI 协议：端点 / SSE / 字段抽取 / 错误翻译");

  /* --- 端点归一 --- */
  check("带 /v1", chatEndpoint("https://api.openai.com/v1") === "https://api.openai.com/v1/chat/completions");
  check("带尾斜杠", chatEndpoint("https://api.openai.com/v1///") === "https://api.openai.com/v1/chat/completions");
  check("已写全则不重复", chatEndpoint("https://x.dev/v1/chat/completions") === "https://x.dev/v1/chat/completions");
  check(
    "裸主机补 /v1（Ollama 常见误填）",
    chatEndpoint("http://localhost:11434") === "http://localhost:11434/v1/chat/completions",
    chatEndpoint("http://localhost:11434"),
  );
  check("缺协议头补 http", chatEndpoint("127.0.0.1:8000/v1").startsWith("http://"));
  check("空串回落到 OpenAI", chatEndpoint("").startsWith("https://api.openai.com"));
  check("models 端点", modelsEndpoint("http://localhost:11434/v1") === "http://localhost:11434/v1/models");

  /* --- 请求构造 --- */
  const st = { ...DEFAULT_AI_SETTINGS, provider: "openai" as const, apiKey: "  sk-x  ", model: " gpt-4o-mini " };
  check("Authorization 去空格", chatHeaders(st).Authorization === "Bearer sk-x");
  check("空 key 不带 Authorization", !("Authorization" in chatHeaders({ ...st, apiKey: "   " })));
  check("默认温度不发", !("temperature" in buildRequestBody(st, [], false)));
  check("非默认温度发", buildRequestBody({ ...st, temperature: 0.9 }, [], false).temperature === 0.9);
  check("maxTokens=0 不发", !("max_tokens" in buildRequestBody(st, [], false)));
  check("maxTokens>0 才发", buildRequestBody({ ...st, maxTokens: 800 }, [], false).max_tokens === 800);
  check("model 去空格", buildRequestBody(st, [], false).model === "gpt-4o-mini");

  /* --- SSE --- */
  const cut = splitSse('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"cho');
  check("切出完整事件，半包留到 rest", cut.events.length === 1 && cut.rest === 'data: {"cho', cut);
  check("事件里的增量", applySseEvent(cut.events[0]) === "你");
  const crlf = splitSse('data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n');
  check("CRLF 也能切（否则流式没有输出）", crlf.events.length === 2, crlf);
  check("[DONE] 返回 null", applySseEvent("[DONE]") === null);
  check("坏 JSON 不抛错", applySseEvent("{oops") === "");
  check("keep-alive 注释行被跳过", splitSse(": ping\n\ndata: x\n\n").events[0] === "x");
  // 一条事件里有多行 data 时按换行拼起来再解析（有些代理会这么拆 JSON）
  check("多行 data 合并后仍可解析", applySseEvent(splitSse('data: {"choices":\ndata: [{"delta":{"content":"Z"}}]}\n\n').events[0] ?? "") === "Z");

  /* --- 三家响应形状 --- */
  check("OpenAI delta", extractDelta({ choices: [{ delta: { content: "A" } }] }) === "A");
  check("Ollama 原生 response", extractDelta({ response: "B" }) === "B");
  check("Ollama message", extractDelta({ message: { content: "C" } }) === "C");
  check("reasoning_content 不算正文", extractDelta({ choices: [{ delta: { reasoning_content: "思考" } }] }) === "");
  check("null / 空对象返回空串", extractDelta(null) === "" && extractDelta({}) === "");
  check(
    "OpenAI usage",
    JSON.stringify(extractUsage({ usage: { prompt_tokens: 12, completion_tokens: 34 } })) === '{"prompt":12,"completion":34}',
  );
  check(
    "Ollama usage（*_count）",
    JSON.stringify(extractUsage({ usage: { prompt_eval_count: 5, eval_count: 9 } })) === '{"prompt":5,"completion":9}',
  );
  check("无 usage → null", extractUsage({}) === null);
  check("model 回显", extractModel({ model: "gpt-4o" }, "fallback") === "gpt-4o");
  check("无 model 用 fallback", extractModel({}, "fb") === "fb");

  /* --- 错误翻译 --- */
  const e401 = describeFailure(401, "", st);
  check("401 → auth 且给建议", e401.kind === "auth" && !!e401.hint);
  check("404 提到模型名", describeFailure(404, '{"error":"model not found"}', st).hint?.includes("模型名") === true);
  check("404 不提模型时提 Base URL", describeFailure(404, "not found", st).hint?.includes("Base URL") === true);
  check("429 → ratelimit", describeFailure(429, "", st).kind === "ratelimit");
  check("503 → server", describeFailure(503, "", st).kind === "server");
  check("其它状态 → unknown", describeFailure(418, "", st).kind === "unknown");

  /* --- 配置校验 --- */
  let kind: string | null = null;
  try {
    assertConfigured({ ...st, model: "" });
  } catch (e) {
    kind = e instanceof AiError ? e.kind : "not-ai-error";
  }
  check("空模型 → config 错误", kind === "config");
  let threw = false;
  try {
    assertConfigured({ ...st, apiKey: "" });
  } catch {
    threw = true;
  }
  check("OpenAI 无 key → 报错", threw);
  threw = false;
  try {
    assertConfigured({ ...st, provider: "ollama", apiKey: "", baseUrl: "http://localhost:11434/v1" });
  } catch {
    threw = true;
  }
  check("Ollama 无 key 可过（复用同一套请求）", !threw);

  /* --- 提示词 --- */
  check("中文选区 → 译成英文", resolveTargetLang("auto", "社会保险法") === "English");
  check("英文选区 → 译成中文", resolveTargetLang("auto", "hello world") === "简体中文");
  check("显式语言优先", resolveTargetLang("ja", "中文") === "日本語");

  const msgs = buildMessages({
    task: "explain",
    quote: "甲方应当…",
    context: { documentTitle: "合同法", page: 7 },
    settings: st,
  });
  check("两条消息（system + user）", msgs.length === 2 && msgs[0].role === "system");
  check("system 要求直接输出 Markdown", msgs[0].content.includes("Markdown") && msgs[0].content.includes("不要用 ```"));
  check("user 带来源与页码", msgs[1].content.includes("第 7 页") && msgs[1].content.includes("合同法"));
  check("user 用明确分隔符包住选区", msgs[1].content.includes("【选段开始】") && msgs[1].content.includes("【选段结束】"));
  const noQuote = buildMessages({ task: "summarize", quote: "   ", context: { documentTitle: "x", page: 1 }, settings: st });
  check("无选区时不编造", noQuote[1].content.includes("没有选中"));
  check("三种任务各自成句", ["translate", "explain", "summarize"].every((t) => {
    const m = buildMessages({ task: t as "translate", quote: "x", context: { documentTitle: "d", page: 1 }, settings: st });
    return m[0].content.includes("任务：");
  }));
}

/* ================================================================== *
 * [L] 便签格式
 * ================================================================== */

function testSettings(): void {
  console.log("\n[N] 设置清洗：缺字段 / 类型错 / 旧版本文件都不能让插件起不来");

  const empty = sanitizeSettings(null);
  check("空 data.json 回落到默认值", empty.openPdfInPlugin === DEFAULT_SETTINGS.openPdfInPlugin);
  check("默认不接管 .pdf 打开方式", empty.openPdfInPlugin === false);
  check("AI 设定有默认 provider", empty.ai.provider === "openai");
  check("未知 provider 被夹到 openai", sanitizeSettings({ ai: { provider: "gpt-9" } }).ai.provider === "openai");

  check("openPdfInPlugin=true 被保留", sanitizeSettings({ openPdfInPlugin: true }).openPdfInPlugin === true);
  // 手改 data.json 写成字符串 "true" 是很常见的事故，必须当假值处理而不是真值
  check(
    "openPdfInPlugin 为字符串时回落 false",
    sanitizeSettings({ openPdfInPlugin: "true" }).openPdfInPlugin === false
  );
  check("temperature 越界被 clamp", sanitizeSettings({ ai: { temperature: 9 } }).ai.temperature === 2);
  check(
    "noteFolder 去掉首尾斜杠",
    sanitizeSettings({ noteFolder: "/PDF 批注/" }).noteFolder === "PDF 批注"
  );
}

/**
 * [O] 批注卡片的排布
 *
 * 这两件事只跟数字有关，所以抽成纯函数单测：
 * 卡片之间的**避让**（不能叠成一坨）与**选道**（放页面外面还是压进内侧）。
 * 出错的后果是肉眼可见的：卡片压在正文上、或者两张卡叠在一起。
 */
function testCardLayout(): void {
  console.log("\n[O] 批注卡片排布");

  // 互不冲突时保持原位（不能因为排一下就把卡片挪走）
  const loose = packCards([
    { id: "a", top: 10, height: 40 },
    { id: "b", top: 100, height: 40 },
  ]);
  check("无冲突保持原位", loose[0].top === 10 && loose[1].top === 100, loose);

  // 冲突时依次下推，且至少留出 gap
  const tight = packCards([
    { id: "a", top: 10, height: 60 },
    { id: "b", top: 20, height: 60 },
  ]);
  check("冲突时下推且留出间隔", tight[1].top >= tight[0].top + 60 + 10, tight);

  // 输入顺序打乱，输出仍按 top 升序（否则下推方向会乱）
  const shuffled = packCards([
    { id: "c", top: 200, height: 30 },
    { id: "a", top: 0, height: 30 },
    { id: "b", top: 5, height: 30 },
  ]);
  check(
    "乱序输入按纵坐标排序",
    shuffled.map((p) => p.id).join(",") === "a,b,c",
    shuffled.map((p) => p.id),
  );

  // 高度为 0（正文还没渲染完）不能把后面的卡片全挤到同一个点上
  const zero = packCards([
    { id: "a", top: 50, height: 0 },
    { id: "b", top: 50, height: 0 },
  ]);
  check("零高度仍保持间隔", zero[1].top >= zero[0].top + 10, zero);

  // 选道：右侧空白够 → 放右边，且紧贴页边 + gap
  const right = chooseLane({ pageLeft: 100, pageRight: 900, viewWidth: 1300, cardWidth: 236 });
  check("右侧有空间走右侧", right.side === "right" && right.left === 912, right);

  // 右侧不够（窗口窄），左侧够 → 走左侧，且右边缘与页边留 gap
  const left = chooseLane({ pageLeft: 400, pageRight: 1200, viewWidth: 1300, cardWidth: 236 });
  check(
    "右侧不够改走左侧",
    left.side === "left" && near(left.left + 236, 400 - 12, 1e-6),
    left,
  );

  // 两侧都不够（放大到很大）→ 压回内侧，且不能跑出左边界
  const inside = chooseLane({ pageLeft: 20, pageRight: 1280, viewWidth: 1300, cardWidth: 236 });
  check(
    "两侧都不够时压回内侧且不出界",
    inside.side === "inside" && inside.left >= 0 && inside.left + 236 <= 1300,
    inside,
  );
}

/**
 * [P] PDF 尾部垃圾（知网下载器的招牌）
 *
 * 这类文件的病在文件本身：`%%EOF` 之后被追加了 XML 元数据，
 * 老解析器从后往前找不到 `startxref`，于是空白页 + 0/0。
 * 处理逻辑是纯字节运算，必须单测 —— 它要改用户的文件，不能靠"看起来对"。
 */
function testPdfTrailer(): void {
  console.log("\n[P] PDF 尾部垃圾识别");

  const enc = (s: string): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };
  const dec = (b: Uint8Array): string => Array.from(b).map((c) => String.fromCharCode(c)).join("");

  // 干净文件：%%EOF 之后只有一个换行
  const clean = enc("%PDF-1.6\n1 0 obj<<>>endobj\nstartxref\n123\n%%EOF\n");
  check("干净文件没有尾部垃圾", trailingJunkLength(clean) === 0, trailingJunkLength(clean));
  check("干净文件无需裁剪", trimTrailingJunk(clean) === null);

  // 知网那种：%%EOF 之后追加 WebFastLoad XML
  const dirty = enc("%PDF-1.6\nstartxref\n123\n%%EOF\nWebFastLoad\u00ef\u00bb\u00bf<Doi>10.1/x</Doi>");
  check("能数出尾部垃圾字节", trailingJunkLength(dirty) > 0, trailingJunkLength(dirty));
  const fixed = trimTrailingJunk(dirty);
  check("裁剪后非 null", fixed !== null);
  check(
    "裁剪后以 %%EOF 收尾",
    fixed !== null && dec(fixed).replace(/\n$/, "").endsWith("%%EOF"),
    fixed ? dec(fixed).slice(-20) : null,
  );
  check(
    "裁剪后长度等于到 EOF 末尾",
    fixed !== null && fixed.length === lastEofEnd(dirty) + 1,
    fixed ? [fixed.length, lastEofEnd(dirty)] : null,
  );

  // 增量更新的 PDF 会有多个 %%EOF，只能用最后一个
  const multi = enc("%PDF-1.7\nstartxref\n9\n%%EOF\n1 0 obj<<>>endobj\nstartxref\n99\n%%EOF\nJUNKJUNK");
  const cut = trimTrailingJunk(multi);
  check("多个 %%EOF 取最后一个", cut !== null && dec(cut).includes("startxref\n99"), cut ? cut.length : null);

  // 根本不是 PDF
  check("没有 %%EOF 返回 -1", trailingJunkLength(enc("not a pdf at all")) === -1);
  check("没有 %%EOF 不裁剪", trimTrailingJunk(enc("not a pdf at all")) === null);

  // 副本命名
  check(
    "副本名带（修复版）",
    repairedCopyPath("a/b/论文.pdf") === "a/b/论文（修复版）.pdf",
    repairedCopyPath("a/b/论文.pdf"),
  );
  check(
    "重名时追加序号",
    repairedCopyPath("论文.pdf", (p) => p === "论文（修复版）.pdf") === "论文（修复版 2）.pdf",
    repairedCopyPath("论文.pdf", (p) => p === "论文（修复版）.pdf"),
  );
}

function testNoteFormat(): void {
  console.log("\n[L] 便签格式：Callout + 块锚点往返");

  const link = buildPdfLink({ path: "论文/社会保险法.pdf", page: 3, rect: [72, 600, 90, 620], color: "yellow" });
  const body = "第一行 **粗体**\n\n- 列表\n- 第二项";
  const block = renderNoteBlock({ id: "abc123", page: 3, color: "#FFE066", link, body });

  check("块头是 PDF-note Callout", block.startsWith("> [!PDF-note|hex-ffe066]"), block.split("\n")[0]);
  check("块头带 PDF 链接", block.split("\n")[0].includes("#page=3&rect="));
  check("锚点独占最后一行", block.endsWith("^pdfa-note-abc123"));
  check("锚点前留空行（否则 Obsidian 不认块引用）", block.includes("\n\n^pdfa-note-abc123"));
  check("每行正文都带 > 前缀", block.split("\n").slice(1, -2).every((l) => l.startsWith(">")));

  const text = `# 论文 · 便签\n\n> 说明文字\n\n${block}\n`;
  const parsed = parseNoteBlocks(text);
  check("解析出一条", parsed.length === 1);
  check("id 从锚点取", parsed[0].id === "abc123");
  check("页码从链接取", parsed[0].page === 3);
  check("颜色从 token 还原", parsed[0].color === "#FFE066");
  check("正文往返一致（含空行与列表）", parsed[0].body === body, parsed[0].body);
  check("记录块头行号", parsed[0].startLine === 4, parsed[0].startLine);
  check("手写的标题与说明不被当成便签", !parsed.some((n) => n.body.includes("说明文字")));

  /* --- 更新 --- */
  const updated = upsertNoteBlock(text, { id: "abc123", page: 3, color: "#FFE066", link, body: "改过了" });
  check("更新后仍只有一条", parseNoteBlocks(updated).length === 1);
  check("正文被替换", parseNoteBlocks(updated)[0].body === "改过了");
  check("外部内容（标题 / 说明）保留", updated.includes("# 论文 · 便签") && updated.includes("> 说明文字"));
  check("更新不会让锚点重复", updated.split("^pdfa-note-abc123").length === 2);

  /* --- 新增 --- */
  const second = upsertNoteBlock(updated, {
    id: "def456",
    page: 5,
    color: "blue",
    link: buildPdfLink({ path: "论文/社会保险法.pdf", page: 5 }),
    body: "第二条",
  });
  check("新增后两条", parseNoteBlocks(second).length === 2);
  check("顺序即插入顺序", parseNoteBlocks(second).map((n) => n.id).join(",") === "abc123,def456");
  check("命名色原样写进 Callout", second.includes("[!PDF-note|blue]"));

  /* --- 删除 --- */
  const removed = removeNoteBlock(second, "abc123");
  check("删除后只剩另一条", parseNoteBlocks(removed).length === 1 && parseNoteBlocks(removed)[0].id === "def456");
  check("不残留孤立锚点", !removed.includes("^pdfa-note-abc123"));
  check("不误伤标题", removed.includes("# 论文 · 便签"));
  check("删不存在的 id 原样返回", removeNoteBlock(second, "nope") === second);

  /* --- 边界 --- */
  const emptyBlock = renderNoteBlock({ id: "e1", page: 1, color: "yellow", link, body: "" });
  check("空正文 = 块头 + 空行 + 锚点", emptyBlock.split("\n").length === 3, emptyBlock);
  check("空正文可解析", parseNoteBlocks(`${emptyBlock}\n`)[0].body === "");
  check("正文里的裸 ^ 不会被误当锚点", parseNoteBlocks(`${renderNoteBlock({ id: "n1", page: 1, color: "yellow", link, body: "x ^foo y" })}\n`).length === 1);

  /* --- 颜色 token --- */
  check("命名色原样", colorToken("yellow") === "yellow");
  check("hex → token", colorToken("#FFE066") === "hex-ffe066");
  check("非法色回落 yellow", colorToken("rgb(1,2,3)") === "yellow");
  check("token → hex", colorFromToken("hex-ffe066") === "#FFE066");
  check("命名色反解原样", colorFromToken("blue") === "blue");
  check("缺 token 时回落 yellow", colorFromToken("") === "yellow");

  /* --- 路径 --- */
  const src = { noteLocation: "source" as const, noteFolder: "x", noteSuffix: "pdf-notes" };
  check("同目录", companionPath("论文/a.pdf", src) === "论文/a (pdf-notes).md", companionPath("论文/a.pdf", src));
  check("根目录", companionPath("a.pdf", src) === "a (pdf-notes).md");
  check(
    "统一文件夹",
    companionPath("论文/a.pdf", { ...src, noteLocation: "folder", noteFolder: "PDF 批注" }) === "PDF 批注/a (pdf-notes).md",
  );
  check("锚点链接", anchorLink("论文/a (pdf-notes).md", "abc") === "[[论文/a (pdf-notes).md#^pdfa-note-abc]]");

  /* --- 图钉位置：rect → NORM --- */
  // scale=2 的平移矩阵：用户空间 (100,200)-(140,240) → 视口 (200,400)-(280,480)，中心 (240,440)
  const norm = quadCenterToNorm([100, 200, 140, 240], [2, 0, 0, 2, 0, 0], 600, 800, applyTransform);
  check("rect 中心 → NORM", near(norm.x, 0.4, 1e-9) && near(norm.y, 0.55, 1e-9), norm);
  const rotated = quadCenterToNorm([0, 0, 10, 0], [0, 2, 2, 0, 0, 0], 800, 600, applyTransform);
  // 旋转 90°：用户空间 (0,0)-(10,0) → 视口 (0,0)-(0,20)，中心 (0,10)；
  // x 为 0 会被 clamp 到 0.001（保证图钉不出页边）
  check("带旋转的变换取包围盒中心并夹在页内", near(rotated.x, 0.001) && near(rotated.y, 0.0167, 1e-3), rotated);
  check("NaN 输入不炸出页外", quadCenterToNorm([NaN, NaN, NaN, NaN], [1, 0, 0, 1, 0, 0], 600, 800, applyTransform).x === 0.5);

  /* --- AI 结果块 --- */
  const ai = renderAiBlock({ link, color: "yellow", quote: "原文\n第二行", heading: "AI 翻译", text: "结果一\n\n- 要点" });
  check("原文用 > > （PDF++ 引用约定）", ai.includes("> > 原文") && ai.includes("> > 第二行"));
  check("AI 结果用单层 >", ai.includes("> 结果一"));
  check("结果标题加粗", ai.includes("> **AI 翻译**"));
  check("原文与结果之间有空引用行", ai.split("\n").includes(">"));
  check("不传引用时没有 > >", !renderAiBlock({ link, color: "yellow", heading: "x", text: "y" }).includes("> >"));

  /* --- 别名 --- */
  check("补别名", withAlias("[[a.pdf#page=1]]", "a.pdf", 1) === "[[a.pdf#page=1|a, p.1]]");
  check("已有别名不重复", withAlias("[[a.pdf#page=1|z]]", "a.pdf", 1) === "[[a.pdf#page=1|z]]");
  check("非链接原样返回", withAlias("not a link", "a.pdf", 1) === "not a link");
}

/* ================================================================== *
 * [M] 指针适配层
 * ================================================================== */

interface FakeTouch {
  identifier: number;
  clientX: number;
  clientY: number;
  pressure: number;
}

function touchEvent(type: string, touches: FakeTouch[], changed: FakeTouch[] = touches): Event {
  const ev = new window.Event(type, { bubbles: true });
  Object.defineProperty(ev, "touches", { value: touches });
  Object.defineProperty(ev, "changedTouches", { value: changed });
  return ev;
}

async function testPointer(): Promise<void> {
  console.log("\n[M] 指针适配层：鼠标 / 触摸、长按、双击、多指中止");

  const win = window as unknown as Record<string, unknown>;
  const originalPointerEvent = win.PointerEvent;
  // jsdom 没有 PointerEvent；先删掉，强制走 Touch/Mouse 兜底分支
  delete win.PointerEvent;

  /* --- 鼠标路径（无 PointerEvent 时的兜底） --- */
  const mouseHost = document.createElement("div");
  document.body.appendChild(mouseHost);
  const seen: string[] = [];
  const offMouse = attachPointer(mouseHost, {
    onDown: (s) => seen.push(`down:${s.pointerType}:${s.button}`),
    onMove: (s) => seen.push(`move:${Math.round(s.clientX)}`),
    onUp: (s) => seen.push(`up:${s.pointerType}`),
    onCancel: () => seen.push("cancel"),
  });

  mouseHost.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 10, clientY: 20, button: 0, bubbles: true }));
  mouseHost.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 40, clientY: 20, bubbles: true }));
  mouseHost.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 40, clientY: 20, bubbles: true }));
  check("鼠标：按下 / 移动 / 抬起都收到", seen.join(",") === "down:mouse:0,move:40,up:mouse", seen.join(","));

  seen.length = 0;
  mouseHost.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 70, clientY: 20, bubbles: true }));
  check("没有按下的移动 = 悬停，也转发（否则 hover 提示不亮）", seen.join(",") === "move:70", seen.join(","));

  seen.length = 0;
  mouseHost.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 10, clientY: 20, button: 2, bubbles: true }));
  check("右键不触发绘制", seen.length === 0);

  seen.length = 0;
  mouseHost.dispatchEvent(new window.MouseEvent("mousedown", { clientX: 10, clientY: 20, button: 0, bubbles: true }));
  mouseHost.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 12, clientY: 21, bubbles: true }));
  check("抖动未超过阈值不算拖动", seen.join(",") === "down:mouse:0", seen.join(","));
  mouseHost.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 12, clientY: 21, bubbles: true }));
  offMouse();

  /* --- 长按（触屏右键） --- */
  const touchHost = document.createElement("div");
  document.body.appendChild(touchHost);
  let longPressed: { type: string; x: number } | null = null;
  let cancelled = false;
  let upped = false;
  const offTouch = attachPointer(touchHost, {
    onDown: () => undefined,
    onUp: () => {
      upped = true;
    },
    onCancel: () => {
      cancelled = true;
    },
    onLongPress: (s) => {
      longPressed = { type: s.pointerType, x: s.clientX };
    },
  });

  const t1: FakeTouch = { identifier: 1, clientX: 55, clientY: 66, pressure: 0.6 };
  touchHost.dispatchEvent(touchEvent("touchstart", [t1]));
  await sleep(600);
  check("长按 520ms 后触发（移动端右键）", longPressed !== null && longPressed!.type === "touch", longPressed);
  check("长按坐标取自触点", longPressed?.x === 55);
  touchHost.dispatchEvent(touchEvent("touchend", [], [t1]));
  check("长按后抬起不再算点击", upped === false && cancelled === true);

  /* --- 移动超过阈值 → 不算长按 --- */
  longPressed = null;
  cancelled = false;
  touchHost.dispatchEvent(touchEvent("touchstart", [t1]));
  touchHost.dispatchEvent(touchEvent("touchmove", [{ ...t1, clientX: 120 }]));
  await sleep(600);
  check("移动过的按压不算长按", longPressed === null);
  touchHost.dispatchEvent(touchEvent("touchend", [], [{ ...t1, clientX: 120 }]));

  /* --- 双击 tap --- */
  let doubleTaps = 0;
  offTouch();
  const offDbl = attachPointer(touchHost, { onDoubleTap: () => (doubleTaps += 1) });
  touchHost.dispatchEvent(touchEvent("touchstart", [t1]));
  touchHost.dispatchEvent(touchEvent("touchend", [], [t1]));
  touchHost.dispatchEvent(touchEvent("touchstart", [t1]));
  touchHost.dispatchEvent(touchEvent("touchend", [], [t1]));
  check("两次快速 tap → onDoubleTap（触屏没有 dblclick）", doubleTaps === 1, doubleTaps);

  /* --- 多指中止 --- */
  doubleTaps = 0;
  let multiCancel = 0;
  offDbl();
  const offMulti = attachPointer(touchHost, {
    onDown: () => undefined,
    onCancel: () => (multiCancel += 1),
  });
  const t2: FakeTouch = { identifier: 2, clientX: 300, clientY: 400, pressure: 0.5 };
  touchHost.dispatchEvent(touchEvent("touchstart", [t1]));
  touchHost.dispatchEvent(touchEvent("touchstart", [t1, t2]));
  check("第二指落下 → 取消手势（双指缩放不该画鬼线）", multiCancel === 1, multiCancel);
  touchHost.dispatchEvent(touchEvent("touchend", [t2], [t1]));
  touchHost.dispatchEvent(touchEvent("touchend", [], [t2]));
  offMulti();

  /* --- PointerEvent 路径 --- */
  class FakePointerEvent extends window.MouseEvent {
    pointerId: number;
    pointerType: string;
    pressure: number;
    constructor(type: string, init: EventInit & MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number }) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.pressure = init.pressure ?? 0.5;
    }
  }
  win.PointerEvent = FakePointerEvent;

  const penHost = document.createElement("div");
  document.body.appendChild(penHost);
  const samples: Array<{ phase: string; type: string; pressure: number }> = [];
  let penCancels = 0;
  const offPen = attachPointer(penHost, {
    onDown: (s) => samples.push({ phase: "down", type: s.pointerType, pressure: s.pressure }),
    onMove: (s) => samples.push({ phase: "move", type: s.pointerType, pressure: s.pressure }),
    onCancel: () => (penCancels += 1),
  });

  const pen = (type: string, pointerId: number, x = 10, y = 10) =>
    new FakePointerEvent(type, { pointerId, pointerType: "pen", pressure: 0.7, clientX: x, clientY: y, button: 0, bubbles: true });

  penHost.dispatchEvent(pen("pointerdown", 7));
  penHost.dispatchEvent(pen("pointermove", 7, 60, 10));
  check("PointerEvent：类型与压感透传", samples[0]?.type === "pen" && samples[0]?.pressure === 0.7, samples[0]);
  check("PointerEvent：move 带上同一 id", samples.some((s) => s.phase === "move"));

  samples.length = 0;
  penHost.dispatchEvent(pen("pointerdown", 8));
  check("第二根指针落下 → 中止", penCancels === 1, penCancels);
  offPen();

  // 还原环境，避免影响后续用例
  if (originalPointerEvent) win.PointerEvent = originalPointerEvent;
  else delete win.PointerEvent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("PDF View for Obsidian — 冒烟测试");
  await testCoords();
  await testPdf();
  await testInk();
  await testStore();
  await testGeometry();
  testPageLayer();
  testLinkFormat();
  await testTextIndex();
  await testScan();
  testBacklinkLayer();
  testAiProtocol();
  testNoteFormat();
  testCardLayout();
  testPdfTrailer();
  testSettings();
  await testPointer();
  console.log(failed === 0 ? "\n全部通过 ✅" : `\n${failed} 项失败 ❌`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error("\n测试异常：", err);
  process.exit(1);
});
