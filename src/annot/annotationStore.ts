/**
 * annotationStore.ts —— 批注内存库
 *
 * 阶段二只做内存态：视图关闭即丢弃。这是刻意的 —— 真正落盘在阶段三，
 * 落点是 **Markdown**（`> [!pdf-annotation]` 块 + 反向链接），不是 JSON 旁挂文件。
 * 所以这里所有数据结构都按“能直接序列化成 Markdown 元数据”的形状设计：
 * 只有 NORM 坐标、只有基本类型、没有 DOM 引用、没有循环引用。
 *
 * 撤销栈用「整条快照」而不是「字段 diff」：
 * 一条批注最多几百字节（手绘点的上限也就几千），换来的是 undo 逻辑
 * 只有十几行、且永不出现“撤销后字段半新半旧”的经典 bug。
 *
 * 一次操作 = 一组条目（entries）：单条增删改是长度 1 的组，
 * 「清空本页」是长度 N 的组 —— 这样一次 Ctrl+Z 能整体回滚，
 * 而不是把用户刚才删掉的十条批注一条一条地撤销回来。
 */

import type { Annotation } from "./types";
import { createAnnotationId } from "./types";
import { Emitter } from "./emitter";

export type ChangeReason = "add" | "update" | "remove" | "clear" | "undo" | "redo";

export interface StoreChange {
  /** 本次变更涉及的页码（去重）；一次操作跨页时会有多个 */
  pages: number[];
  reason: ChangeReason;
  canUndo: boolean;
  canRedo: boolean;
}

interface OpEntry {
  id: string;
  /** null = 变更前不存在（新增） */
  before: Annotation | null;
  /** null = 变更后被删除 */
  after: Annotation | null;
}

interface Op {
  entries: OpEntry[];
  pages: number[];
}

const MAX_HISTORY = 120;

export class AnnotationStore {
  private items = new Map<string, Annotation>();
  private undoStack: Op[] = [];
  private redoStack: Op[] = [];

  readonly change = new Emitter<StoreChange>();

  /* ---------------------------------------------------------------- *
   * 读
   * ---------------------------------------------------------------- */

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  getPage(page: number): Annotation[] {
    const out: Annotation[] = [];
    for (const a of this.items.values()) {
      if (a.page === page) out.push(a);
    }
    // 绘制顺序 = 创建顺序：后画的压在上面，符合直觉
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  all(): Annotation[] {
    return Array.from(this.items.values());
  }

  get count(): number {
    return this.items.size;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /* ---------------------------------------------------------------- *
   * 写
   * ---------------------------------------------------------------- */

  add(anno: Annotation, silent = false): Annotation {
    const withId: Annotation = anno.id ? anno : { ...anno, id: createAnnotationId() };
    this.items.set(withId.id, withId);
    if (silent) {
      /*
       * silent = 从磁盘读回来的批注（伴生笔记里的便签）。
       * 它们不是"用户刚做的编辑"，不该占撤销栈 ——
       * 否则打开一篇有 20 条便签的 PDF，Ctrl+Z 二十次才开始撤自己刚画的东西。
       */
      this.emit([withId.page], "add");
    } else {
      this.commit([{ id: withId.id, before: null, after: withId }], [withId.page], "add");
    }
    return withId;
  }

  /**
   * 整体替换一条批注。
   * 不用 Partial 合并：`{...a, body}` 的写法在联合类型上更安全，
   * 也让调用方必须显式读一次当前值，避免盲改字段。
   */
  update(next: Annotation): void {
    const before = this.items.get(next.id);
    if (!before) return;
    const after: Annotation = { ...next, updatedAt: Date.now() };
    this.items.set(after.id, after);
    this.commit([{ id: after.id, before, after }], [after.page], "update");
  }

  remove(id: string): void {
    const before = this.items.get(id);
    if (!before) return;
    this.items.delete(id);
    this.commit([{ id, before, after: null }], [before.page], "remove");
  }

  clearPage(page: number): void {
    const victims = this.getPage(page);
    if (victims.length === 0) return;
    for (const a of victims) this.items.delete(a.id);
    this.commit(
      victims.map((a) => ({ id: a.id, before: a, after: null })),
      [page],
      "clear",
    );
  }

  clearAll(): void {
    const victims = this.all();
    if (victims.length === 0) return;
    const pages = Array.from(new Set(victims.map((a) => a.page)));
    for (const a of victims) this.items.delete(a.id);
    this.commit(
      victims.map((a) => ({ id: a.id, before: a, after: null })),
      pages,
      "clear",
    );
  }

  /** 换文件时用：不留撤销痕迹（否则 Ctrl+Z 会"撤销"回另一个文件的批注） */
  reset(): void {
    this.items.clear();
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit([], "clear");
  }

  /**
   * 静默移除：把已经在笔记里"落盘"的草稿撤掉，不产生撤销记录。
   *
   * 场景：用户高亮 → 链接被粘进笔记 → 重扫发现这条已经有了 →
   * 内存里那条草稿就成了重复的（两层叠在一起颜色会变深）。
   * 但这不是用户的一次编辑操作，不该占用 Ctrl+Z。
   */
  removeSilently(ids: readonly string[]): number {
    if (ids.length === 0) return 0;
    const pages = new Set<number>();
    let removed = 0;
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item) continue;
      this.items.delete(id);
      pages.add(item.page);
      removed++;
    }
    if (removed > 0) this.emit(Array.from(pages), "remove");
    return removed;
  }

  /* ---------------------------------------------------------------- *
   * 撤销 / 重做
   * ---------------------------------------------------------------- */

  undo(): boolean {
    const op = this.undoStack.pop();
    if (!op) return false;
    this.apply(op, "before");
    this.redoStack.push(op);
    this.emit(op.pages, "undo");
    return true;
  }

  redo(): boolean {
    const op = this.redoStack.pop();
    if (!op) return false;
    this.apply(op, "after");
    this.undoStack.push(op);
    this.emit(op.pages, "redo");
    return true;
  }

  /** 方向：before = 回滚到旧态，after = 前进到新态 */
  private apply(op: Op, dir: "before" | "after"): void {
    for (const entry of op.entries) {
      const target = entry[dir];
      if (target) this.items.set(entry.id, target);
      else this.items.delete(entry.id);
    }
  }

  /* ---------------------------------------------------------------- */

  private commit(entries: OpEntry[], pages: number[], reason: ChangeReason): void {
    this.undoStack.push({ entries, pages });
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    // 新操作让“重做”失效，这是所有编辑器的共识
    this.redoStack.length = 0;
    this.emit(pages, reason);
  }

  private emit(pages: number[], reason: ChangeReason): void {
    this.change.emit({
      pages: pages.filter((p) => p > 0),
      reason,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
    });
  }
}
