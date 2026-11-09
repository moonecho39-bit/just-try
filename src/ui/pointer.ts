/**
 * pointer.ts —— 跨平台指针适配层（桌面鼠标 / 触控笔 / 移动端手指）
 *
 * ── 为什么不直接用 Pointer Events 就完事 ────────────────────────────
 * Pointer Events 确实是超集，现代 WebView 都支持，本插件也一直用它。
 * 但在**移动端**有三个它自己解决不了的问题，必须在这一层补掉：
 *
 *  ① **没有右键**。长按（~500ms 不动）必须映射成 contextmenu，否则
 *     手机上永远打不开批注菜单。桌面端长按鼠标不算，只对 touch/pen 生效。
 *  ② **没有 dblclick**。双击回链跳转在移动端不会触发（浏览器把它当缩放）。
 *     只能自己数「两次 tap 间隔 < 320ms 且位移 < 30px」。
 *  ③ **多指 = 缩放**。画到一半第二根手指落下，如果不中止，会画出一条
 *     从上一笔末尾直线连到新触点的鬼线。这里一旦检测到第二指就 cancel 整个手势，
 *     并且直到所有手指抬起前不再接受新的 down。
 *
 * 再往下一层，极老的 WebView 可能连 PointerEvent 都没有（Android 4.4 时代的
 * 内嵌浏览器），所以还保留了 TouchEvent / MouseEvent 的兜底路径。
 * 三条路径最终都归一成同一个 `PointerSample`，上层代码不需要知道现在是哪种。
 *
 * ── 用样本对象而不是原生事件 ────────────────────────────────────────
 * 原生事件会被复用/回收（TouchEvent 的 touches 就是活的），
 * 一旦 await 过就取不到值了。样本是**值类型快照**，可以安全地传给异步流程。
 */

export type PointerPhase = "down" | "move" | "up" | "cancel";

export interface PointerSample {
  phase: PointerPhase;
  /** pointerId / touch identifier；鼠标兜底时恒为 1 */
  id: number;
  clientX: number;
  clientY: number;
  /** 0~1；不支持压感时为 0.5（鼠标）/ 0.5（触摸） */
  pressure: number;
  pointerType: "mouse" | "touch" | "pen";
  /** 0=左键 1=中键 2=右键；触摸恒 0 */
  button: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** 原生事件（需要 preventDefault / stopPropagation 时用），可能已被浏览器回收 */
  native: Event;
}

export interface PointerHandlers {
  onDown?(s: PointerSample): void;
  onMove?(s: PointerSample): void;
  onUp?(s: PointerSample): void;
  onCancel?(s: PointerSample): void;
  /** 长按（触屏/笔，默认 520ms 未移动）—— 移动端的"右键" */
  onLongPress?(s: PointerSample): void;
  /** 双击（触屏自绘判定；桌面端仍由原生 dblclick 负责） */
  onDoubleTap?(s: PointerSample): void;
}

export interface AttachPointerOptions {
  /** down 时是否 preventDefault。绘制层要（防选中文字/防滚动），页面容器不要 */
  preventDefaultOnDown?: boolean;
  /** 多指出现时是否中止手势（默认 true） */
  abortOnMultiTouch?: boolean;
  longPressMs?: number;
  /** 长按允许的抖动（px） */
  longPressSlop?: number;
  /** 双击判定的最大间隔（ms） */
  doubleTapMs?: number;
}

const DEFAULT_LONG_PRESS = 520;
const DEFAULT_LONG_PRESS_SLOP = 10;
const DEFAULT_DOUBLE_TAP = 320;
const DOUBLE_TAP_SLOP = 30;

/** 当前环境是否支持 PointerEvent（现代桌面/移动 WebView 都是 true） */
export function supportsPointerEvents(): boolean {
  return typeof window !== "undefined" && "PointerEvent" in window;
}

/** 是否粗指针（手指）。UI 上据此放大点击目标，例如把图钉从 10px 增到 14px */
export function isCoarsePointer(): boolean {
  try {
    return window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  } catch {
    return false;
  }
}

/**
 * 绑定指针事件。返回解绑函数。
 *
 * 内部状态机：
 *   idle ──down──▶ tracking ──move(>slop)──▶ dragging
 *                    │                        │
 *                    ├─(500ms 未动)─▶ longPress(结束手势，等 up 只做清理)
 *                    └─up(<320ms 内第二次)─▶ doubleTap
 */
export function attachPointer(
  el: HTMLElement | SVGElement,
  handlers: PointerHandlers,
  options: AttachPointerOptions = {},
): () => void {
  const opts = {
    preventDefaultOnDown: options.preventDefaultOnDown ?? false,
    abortOnMultiTouch: options.abortOnMultiTouch ?? true,
    longPressMs: options.longPressMs ?? DEFAULT_LONG_PRESS,
    longPressSlop: options.longPressSlop ?? DEFAULT_LONG_PRESS_SLOP,
    doubleTapMs: options.doubleTapMs ?? DEFAULT_DOUBLE_TAP,
  };

  /** 正在跟踪的手指/鼠标；null = 空闲 */
  let activeId: number | null = null;
  /** 多指期间屏蔽一切手势，直到全部抬起 */
  let suppressed = false;
  let downX = 0;
  let downY = 0;
  let moved = false;
  let longPressTimer = 0;
  let longPressFired = false;
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  const clearLongPress = (): void => {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  };

  const startLongPress = (sample: PointerSample): void => {
    clearLongPress();
    if (sample.pointerType === "mouse") return; // 桌面端长按鼠标不是右键
    longPressFired = false;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      longPressFired = true;
      handlers.onLongPress?.(sample);
    }, opts.longPressMs);
  };

  const make = (phase: PointerPhase, source: PointerEvent | Touch | MouseEvent, type: PointerSample["pointerType"]): PointerSample => ({
    phase,
    id: "pointerId" in source ? source.pointerId : "identifier" in source ? source.identifier : 1,
    clientX: source.clientX,
    clientY: source.clientY,
    pressure: "pressure" in source && typeof source.pressure === "number" && source.pressure > 0 ? source.pressure : 0.5,
    pointerType: type,
    button: "button" in source ? source.button : 0,
    altKey: "altKey" in source ? source.altKey : false,
    ctrlKey: "ctrlKey" in source ? source.ctrlKey : false,
    metaKey: "metaKey" in source ? source.metaKey : false,
    shiftKey: "shiftKey" in source ? source.shiftKey : false,
    native: source as Event,
  });

  /* ---------------- 统一的四阶段处理 ---------------- */

  const handleDown = (s: PointerSample, ev: Event): void => {
    if (suppressed) return;
    if (activeId !== null) {
      // 第二根手指落下 → 这是缩放手势，不是绘制
      if (opts.abortOnMultiTouch) {
        suppressed = true;
        clearLongPress();
        handlers.onCancel?.(s);
        activeId = null;
      }
      return;
    }
    if (s.button !== 0) return;

    activeId = s.id;
    downX = s.clientX;
    downY = s.clientY;
    moved = false;
    longPressFired = false;

    if (opts.preventDefaultOnDown) ev.preventDefault();
    handlers.onDown?.(s);
    startLongPress(s);
  };

  const handleMove = (s: PointerSample, ev: Event): void => {
    if (suppressed) return;

    // 没有按下的移动 = 悬停。原样转发，不参与"是否越过抖动阈值"的判定，
    // 否则页面上的 hover 提示（回链、可拖拽光标）永远不亮。
    if (activeId === null) {
      handlers.onMove?.(s);
      return;
    }
    if (s.id !== activeId) return;

    if (!moved) {
      const dx = s.clientX - downX;
      const dy = s.clientY - downY;
      if (dx * dx + dy * dy > opts.longPressSlop * opts.longPressSlop) {
        moved = true;
        clearLongPress(); // 动了就不算长按
      }
    }
    if (!moved && !longPressFired) return;

    if (opts.preventDefaultOnDown) ev.preventDefault();
    handlers.onMove?.(s);
  };

  const handleUp = (s: PointerSample): void => {
    clearLongPress();
    if (suppressed) {
      suppressed = false;
      activeId = null;
      return;
    }
    if (activeId === null) return;
    activeId = null;

    // 长按已经消费了这次按下：up 只做清理，不再当成抬起（否则会误触发"点便签"）
    if (longPressFired) {
      longPressFired = false;
      handlers.onCancel?.(s);
      return;
    }

    handlers.onUp?.(s);

    // 双击判定：只有"没怎么动的一下"才算 tap
    if (moved) return;
    const t = Date.now();
    if (t - lastTapAt <= opts.doubleTapMs && Math.abs(s.clientX - lastTapX) < DOUBLE_TAP_SLOP && Math.abs(s.clientY - lastTapY) < DOUBLE_TAP_SLOP) {
      lastTapAt = 0;
      handlers.onDoubleTap?.(s);
    } else {
      lastTapAt = t;
      lastTapX = s.clientX;
      lastTapY = s.clientY;
    }
  };

  const handleCancel = (s: PointerSample): void => {
    clearLongPress();
    if (activeId === null) return;
    activeId = null;
    handlers.onCancel?.(s);
  };

  /* ---------------- 路径一：Pointer Events（首选） ---------------- */

  if (supportsPointerEvents()) {
    const onDown = (ev: PointerEvent): void => handleDown(make("down", ev, mapType(ev.pointerType)), ev);
    const onMove = (ev: PointerEvent): void => handleMove(make("move", ev, mapType(ev.pointerType)), ev);
    const onUp = (ev: PointerEvent): void => handleUp(make("up", ev, mapType(ev.pointerType)));
    const onCancel = (ev: PointerEvent): void => handleCancel(make("cancel", ev, mapType(ev.pointerType)));

    el.addEventListener("pointerdown", onDown as EventListener);
    el.addEventListener("pointermove", onMove as EventListener);
    el.addEventListener("pointerup", onUp as EventListener);
    el.addEventListener("pointercancel", onCancel as EventListener);
    // pointerleave 时不 cancel（拖出页面还要继续收 move）：交给上层自己处理 hover

    return () => {
      clearLongPress();
      el.removeEventListener("pointerdown", onDown as EventListener);
      el.removeEventListener("pointermove", onMove as EventListener);
      el.removeEventListener("pointerup", onUp as EventListener);
      el.removeEventListener("pointercancel", onCancel as EventListener);
    };
  }

  /* ---------------- 路径二：TouchEvent 兜底 ---------------- */

  const touchById = (list: TouchList, id: number): Touch | null => {
    for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
    return null;
  };

  const onTouchStart = (ev: TouchEvent): void => {
    if (ev.touches.length > 1) {
      suppressed = true;
      clearLongPress();
      const extra = ev.touches[0];
      if (extra) handlers.onCancel?.(make("cancel", extra, "touch"));
      return;
    }
    const t = ev.changedTouches[0];
    if (!t) return;
    handleDown(make("down", t, "touch"), ev);
  };

  const onTouchMove = (ev: TouchEvent): void => {
    if (activeId === null) return;
    const t = touchById(ev.touches, activeId);
    if (!t) return;
    handleMove(make("move", t, "touch"), ev);
  };

  const onTouchEnd = (ev: TouchEvent): void => {
    if (ev.touches.length > 0) return; // 还有手指在，等多指全抬
    const t = (activeId !== null ? touchById(ev.changedTouches, activeId) : null) ?? ev.changedTouches[0];
    if (!t) return;
    handleUp(make("up", t, "touch"));
  };

  const onTouchCancel = (ev: TouchEvent): void => {
    const t = ev.changedTouches[0];
    if (t) handleCancel(make("cancel", t, "touch"));
  };

  el.addEventListener("touchstart", onTouchStart as EventListener, { passive: false });
  el.addEventListener("touchmove", onTouchMove as EventListener, { passive: false });
  el.addEventListener("touchend", onTouchEnd as EventListener, { passive: false });
  el.addEventListener("touchcancel", onTouchCancel as EventListener, { passive: false });

  /* 再兜一层鼠标（没有 PointerEvent 的桌面浏览器） */
  const onMouseDown = (ev: MouseEvent): void => handleDown(make("down", ev, "mouse"), ev);
  const onMouseMove = (ev: MouseEvent): void => handleMove(make("move", ev, "mouse"), ev);
  const onMouseUp = (ev: MouseEvent): void => handleUp(make("up", ev, "mouse"));

  el.addEventListener("mousedown", onMouseDown as EventListener);
  el.addEventListener("mousemove", onMouseMove as EventListener);
  el.addEventListener("mouseup", onMouseUp as EventListener);

  return () => {
    clearLongPress();
    el.removeEventListener("touchstart", onTouchStart as EventListener);
    el.removeEventListener("touchmove", onTouchMove as EventListener);
    el.removeEventListener("touchend", onTouchEnd as EventListener);
    el.removeEventListener("touchcancel", onTouchCancel as EventListener);
    el.removeEventListener("mousedown", onMouseDown as EventListener);
    el.removeEventListener("mousemove", onMouseMove as EventListener);
    el.removeEventListener("mouseup", onMouseUp as EventListener);
  };
}

function mapType(t: string): PointerSample["pointerType"] {
  if (t === "touch") return "touch";
  if (t === "pen") return "pen";
  return "mouse";
}

/**
 * 指针捕获（只对 Pointer Events 有效）。
 * 手快速甩出页面边界时，up 仍然回到发起元素 —— 否则会留下一条画到一半的线。
 * 老环境/touch 路径下是空操作：touch 的 move 本来就跟着 target 走。
 */
export function capturePointer(el: Element, s: PointerSample): void {
  if (!supportsPointerEvents() || s.pointerType === "mouse") return;
  try {
    (el as Element & { setPointerCapture(id: number): void }).setPointerCapture(s.id);
  } catch {
    /* jsdom / 旧内核不支持，忽略 */
  }
}
