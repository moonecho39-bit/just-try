/**
 * commentTarget.ts —— 「哪条批注可以写评论」「这条评论落在页面的哪个盒子」
 *
 * 全部是纯函数（无 DOM、无状态），因为"点一下高亮该不该弹评论框"这类判断
 * 一旦混进事件流就很难测；放在这里可以拿假数据直接跑断言。
 *
 * ── 为什么评论最终存成 NoteAnnotation，而不是给每条批注加一个 comment 字段 ──
 *   · 落盘格式只有一种（伴生笔记里一条 Callout），不需要发明第二套格式；
 *   · 注释本身（高亮/下划线/框选）是**内存态**的，关掉视图就没了；
 *     而"我在这段话上写了什么"必须活下来 —— 只有便签这条路是落盘的；
 *   · 撤销/删除/回填（hydrate）复用同一套代码，少一整套分支。
 * 代价是"高亮"会变成"kind: note + rects"，所以这里额外记一个 `mark`
 * 字段来描述它原本长什么样（底纹 / 下划线 / 空心框），渲染时按原样画回来。
 */

import type { Rect } from "../coords";
import type { Annotation, AnnotationKind, NoteAnnotation, NoteMarkStyle, Point } from "./types";
import { ANNOT_DEFAULTS } from "./types";
import { boxFromPoints } from "./geometry";

/** 被评论的那块区域原本是什么样子（只影响渲染，不进落盘格式） */
export type MarkStyle = NoteMarkStyle;

/** 各 kind 在浮层标题里怎么称呼 */
export const KIND_LABEL: Record<AnnotationKind, string> = {
  highlight: "高亮",
  underline: "下划线",
  rect: "框选",
  arrow: "箭头",
  ink: "手绘",
  note: "批注",
};

/**
 * 能不能给它写评论。
 *
 * 箭头 / 手绘**故意不开放**：它们没有"一块可以圈住的文字"，
 * 硬要落盘只能拿外接框凑数 —— 重新打开 PDF 时箭头会退化成一个色块，
 * 与其让人困惑，不如明确说一句"用框选圈出来再评论"。
 */
export function canComment(a: Annotation): boolean {
  return a.kind === "highlight" || a.kind === "underline" || a.kind === "rect" || a.kind === "note";
}

/**
 * 这条批注在页面上的占位矩形（NORM）。
 * 评论框的锚点、卡片引线的落点都用它，所以每种 kind 都必须给得出来。
 */
export function annotationRects(a: Annotation): Rect[] {
  switch (a.kind) {
    case "highlight":
    case "underline":
      return a.rects;
    case "note":
      return a.rects ?? [];
    case "rect":
      return [boxFromPoints(a.from, a.to)];
    case "arrow":
      return [boxFromPoints(a.from, a.to)];
    case "ink": {
      if (a.points.length === 0) return [];
      let x1 = 1;
      let y1 = 1;
      let x2 = 0;
      let y2 = 0;
      for (const [x, y] of a.points) {
        if (x < x1) x1 = x;
        if (y < y1) y1 = y;
        if (x > x2) x2 = x;
        if (y > y2) y2 = y;
      }
      return [{ x: x1, y: y1, w: Math.max(0.001, x2 - x1), h: Math.max(0.001, y2 - y1) }];
    }
  }
}

/** 已经有评论了吗？返回原文（Markdown），没有则 null */
export function commentText(a: Annotation): string | null {
  return a.kind === "note" ? a.body : null;
}

/** 这条便签是不是「从某段文字升级来的」（有 rects 才会落卡片） */
export function hasMark(a: Annotation): a is NoteAnnotation {
  return a.kind === "note" && (a.rects?.length ?? 0) > 0;
}

/** 原来的形态：缺省按高亮处理（老笔记里没有这个字段） */
export function markStyleOf(a: Annotation): MarkStyle {
  if (a.kind === "underline") return "underline";
  if (a.kind === "rect") return "box";
  if (a.kind === "note") return a.mark ?? "highlight";
  return "highlight";
}

/**
 * 便签图钉 / 评论气泡该钉在哪。
 *
 * 取第一行的**右端**而不是左端：钉在左上角会正好压住第一个字
 * （批注多半就是冲着那行字去的，遮住它最难受）。
 */
export function commentAnchorPoint(rects: Rect[]): Point {
  const first = rects[0];
  if (!first) return { x: 0.5, y: 0.5 };
  return {
    x: Math.min(0.998, first.x + first.w),
    y: Math.min(0.998, first.y + first.h / 2),
  };
}

/**
 * 把一条标记变成「带评论的便签」。
 *
 * 保留原 id 是刻意的：store.update 只记一条 before/after，
 * Ctrl+Z 一步就能撤回"我刚才加了个评论"，而不是先撤出一堆空图钉。
 * 已经是 note 的直接换正文。
 */
export function noteFromMark(a: Annotation, body: string): NoteAnnotation | null {
  if (!canComment(a)) return null;

  if (a.kind === "note") {
    return { ...a, body, updatedAt: Date.now() };
  }

  const rects = annotationRects(a).map((r) => ({ ...r }));
  if (rects.length === 0) return null;

  return {
    id: a.id,
    kind: "note",
    page: a.page,
    color: a.color,
    at: commentAnchorPoint(rects),
    body,
    rects,
    opacity: a.kind === "highlight" ? a.opacity : ANNOT_DEFAULTS.highlightOpacity,
    mark: markStyleOf(a),
    createdAt: a.createdAt,
    updatedAt: Date.now(),
  };
}

/**
 * 气泡锚点用的"点是否落在某个矩形里"。
 * 命中多层（同一段字叠了两条高亮）时取最上面那条，与 layer 的倒序命中一致。
 */
export function rectAtPoint(rects: Rect[], p: Point): Rect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return r;
  }
  return null;
}
