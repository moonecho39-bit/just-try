/**
 * cardLayout.ts —— 批注卡片的**纯几何计算**（零 DOM、零 Obsidian 依赖）
 *
 * 卡片要解决的两个问题，都只跟数字有关，所以单独抽出来单测：
 *   ① **纵向避让**：两条高亮挨得很近时，卡片不能叠在一起。
 *      按锚点从上到下排，后一张若会压到前一张，就往下推。
 *   ② **横向选道**：卡片要待在页面**外侧的空白**里（像 PDF++ / MarginNote 那样），
 *      并且宽度必须按那条空白实际有多宽来定 —— 不是固定 236px。
 *
 * 为什么宽度要自适应（0.8.1 的教训）：
 *   原来卡片写死 236px，而笔记本屏上页面两侧的空白往往只有 200~220px，
 *   判定"放不下"就退回页面内侧，结果卡片正好糊在正文上。
 *   现在先量空白，能放多宽就放多宽（148 ~ 236），实在放不下才退回内侧。
 *
 * 为什么不用绝对定位 + transform 硬算：卡片高度取决于正文行数与字号，
 * 只有渲染完才知道。所以这里按"量完高度再排"的顺序设计，把测量留给调用方。
 */

/** 一张卡片的测量结果（由调用方量完 offsetHeight 后传入） */
export interface CardMetric {
  id: string;
  /** 锚点在容器坐标系里的纵坐标（卡片想对齐到这里） */
  top: number;
  /** 卡片实测高度 */
  height: number;
}

export interface PlacedTop {
  id: string;
  top: number;
}

/** 卡片之间至少留的空隙（CSS px） */
export const CARD_GAP = 10;

/** 卡片宽度上限：再宽就变成"第二栏"，读起来抢正文 */
export const CARD_MAX_W = 236;

/**
 * 卡片宽度下限：比这更窄就没法读了，宁可退回页面内侧（压一小块正文）。
 *
 * 为什么定 116 这么低：滚动条要占 15px，实测常见布局下"看起来 161px 的空白"
 * 真正可用的只有 126px。阈值定 132 会让这种窗口直接退回内侧 ——
 * 用户抱怨的正是"压在文字上"，所以宁可给一张很窄的卡，也要待在空白里。
 */
export const CARD_MIN_W = 116;

/** 卡片与页面之间的横向空隙 */
export const CARD_PAGE_GAP = 12;

/**
 * 纵向排布：保持相对次序，遇到冲突就往下推。
 *
 * 注意这是**单列**排布（所有卡片都在同一侧的一条道上）。
 * 不做双列，是因为一旦分列，用户就分不清哪张卡片对应哪段高亮了 ——
 * 连线会交叉，比"往下推一点"难读得多。
 */
export function packCards(items: readonly CardMetric[], gap: number = CARD_GAP): PlacedTop[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || a.id.localeCompare(b.id));
  const out: PlacedTop[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const it of sorted) {
    const top = cursor === Number.NEGATIVE_INFINITY ? it.top : Math.max(it.top, cursor + gap);
    out.push({ id: it.id, top });
    cursor = top + Math.max(0, it.height);
  }
  return out;
}

export type CardSide = "right" | "left" | "inside";

export interface LaneInput {
  /** 页面左边缘，相对浮层原点 */
  pageLeft: number;
  /** 页面右边缘，相对浮层原点 */
  pageRight: number;
  /** 浮层可用宽度（= 滚动区可视宽） */
  viewWidth: number;
  /** 卡片宽度上限，缺省 CARD_MAX_W */
  maxWidth?: number;
  /** 卡片宽度下限，缺省 CARD_MIN_W */
  minWidth?: number;
  /** 卡片与页面之间的空隙，缺省 CARD_PAGE_GAP */
  gap?: number;
}

export interface LaneResult {
  side: CardSide;
  /** 卡片左边缘，相对浮层原点 */
  left: number;
  /** 这条道实际能给的宽度 */
  width: number;
}

/**
 * 横向选道。
 *
 * 规则：
 *   1. 量左右两侧的空白，挑更宽的一侧；
 *   2. 卡片宽度 = min(上限, 那侧空白 - gap)，但不低于下限；
 *   3. 两侧都不到下限，才退回页面内侧（右对齐）。
 *
 * 第 2 步是关键：只要那侧有 160px，卡片就做 160px 宽待在空白里，
 * 而不是"要么 236 要么压正文"。
 */
export function chooseLane(input: LaneInput): LaneResult {
  const gap = input.gap ?? CARD_PAGE_GAP;
  const maxW = input.maxWidth ?? CARD_MAX_W;
  const minW = Math.min(input.minWidth ?? CARD_MIN_W, maxW);

  // 留 6px 右缘余量：不然卡片会紧贴滚动条，看着像被切掉
  const rightRoom = input.viewWidth - input.pageRight - gap - 6;
  const leftRoom = input.pageLeft - gap;
  const room = Math.max(rightRoom, leftRoom);

  if (room >= minW) {
    const width = Math.min(maxW, room);
    const left = rightRoom >= leftRoom ? input.pageRight + gap : input.pageLeft - gap - width;
    return { side: rightRoom >= leftRoom ? "right" : "left", left, width };
  }

  // 兜底：压在页面内侧右边，并且保证不出左右边界
  const pageW = input.pageRight - input.pageLeft;
  const width = Math.max(96, Math.min(maxW, pageW - gap * 2));
  const left = Math.max(gap, Math.min(input.viewWidth - 6 - width, input.pageRight - gap - width));
  return { side: "inside", left, width };
}
