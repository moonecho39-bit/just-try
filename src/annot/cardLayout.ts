/**
 * cardLayout.ts —— 批注卡片的**纯几何计算**（零 DOM、零 Obsidian 依赖）
 *
 * 卡片要解决的两个问题，都只跟数字有关，所以单独抽出来单测：
 *   ① **纵向避让**：一条高亮引出两张卡片时，卡片不能叠在一起。
 *      按锚点从上到下排，后一张若会压到前一张，就往下推。
 *   ② **横向选道**：页面两侧的空白能放下卡片就放外面（像 PDF++ 那样，
 *      不挡正文）；两边都放不下（窄窗口 / 放大到很大）才压回页面内侧。
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
  /** 浮层可用宽度（= 滚动区宽） */
  viewWidth: number;
  cardWidth: number;
  /** 卡片与页面之间的空隙 */
  gap?: number;
}

export interface LaneResult {
  side: CardSide;
  /** 卡片左边缘，相对浮层原点 */
  left: number;
}

/**
 * 横向选道。
 *
 * 优先级：右侧空白 → 左侧空白 → 页面内侧右边。
 * 内侧也靠右放，因为阅读时视线集中在行首，右下角相对最不心疼。
 */
export function chooseLane(input: LaneInput): LaneResult {
  const gap = input.gap ?? 12;
  const rightRoom = input.viewWidth - input.pageRight - gap;
  if (rightRoom >= input.cardWidth) {
    return { side: "right", left: input.pageRight + gap };
  }
  const leftRoom = input.pageLeft - gap;
  if (leftRoom >= input.cardWidth) {
    return { side: "left", left: input.pageLeft - gap - input.cardWidth };
  }
  // 兜底：压在页面内侧右边，并且保证不出左边界
  const left = Math.max(gap, input.pageRight - input.cardWidth - gap);
  return { side: "inside", left };
}
