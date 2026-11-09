/**
 * emitter.ts —— 极简订阅器
 *
 * 为什么不用 Obsidian 的 Events / 自己造 EventTarget：
 *  · 批注 Store 与工具 Store 都需要“同一次变更通知一次”的语义，
 *    DOM EventTarget 每次 dispatch 都要造 Event 对象，且没有类型。
 *  · 这里只需要 30 行：on() 返回退订函数，emit 时快照监听器，
 *    允许监听器在回调里退订/再订阅而不打乱遍历。
 */

export type Unsubscribe = () => void;
export type Listener<T> = (payload: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(fn: Listener<T>): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit(payload: T): void {
    // 快照：回调里可能 on()/退订，直接遍历 Set 会漏发或重复发
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(payload);
      } catch (err) {
        // 一个监听器炸掉不能影响其他页面重绘 / 插件主流程
        console.error("[pdf-annotator] 监听器异常", err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
