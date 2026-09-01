import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { api } from "../lib/api";

interface StripProps {
  onExpand: () => void;
}

/**
 * 收起态细条：悬停 400ms 展开；按住可上下拖动调整垂直位置（M3-4）。
 * 窗口带 WS_EX_NOACTIVATE 收不到系统拖动消息，拖动用 pointer capture 手动
 * 跟踪：位移增量经 rAF 合帧后 invoke 给 Rust 移动窗口，松手才落库。
 */
export function Strip({ onExpand }: StripProps) {
  const hoverTimer = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    lastClientY: number;
    pendingDelta: number;
    frame: number;
  } | null>(null);
  // 拖完指针仍停在细条上时不立刻触发展开，移出再进来才算一次悬停
  const suppressHover = useRef(false);

  function clearHoverTimer() {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  function handleMouseEnter() {
    if (suppressHover.current) {
      return;
    }
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      onExpand();
    }, 400);
  }

  function handleMouseLeave() {
    clearHoverTimer();
    suppressHover.current = false;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    clearHoverTimer();
    suppressHover.current = true;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { lastClientY: event.clientY, pendingDelta: 0, frame: 0 };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state) {
      return;
    }
    state.pendingDelta += event.clientY - state.lastClientY;
    state.lastClientY = event.clientY;
    if (state.frame === 0) {
      state.frame = window.requestAnimationFrame(() => {
        state.frame = 0;
        const delta = state.pendingDelta;
        state.pendingDelta = 0;
        if (delta !== 0) {
          void api.moveStripWindow(delta).catch(() => undefined);
        }
      });
    }
  }

  function endDrag() {
    const state = drag.current;
    if (!state) {
      return;
    }
    if (state.frame !== 0) {
      window.cancelAnimationFrame(state.frame);
    }
    drag.current = null;
    setDragging(false);
    // 先补发最后一段位移再落库；await 保证 Rust 侧先后顺序
    const flush = async () => {
      if (state.pendingDelta !== 0) {
        await api.moveStripWindow(state.pendingDelta).catch(() => undefined);
      }
      await api.persistStripPosition().catch(() => undefined);
    };
    void flush();
  }

  useEffect(
    () => () => {
      clearHoverTimer();
      const state = drag.current;
      if (state?.frame) {
        window.cancelAnimationFrame(state.frame);
      }
      drag.current = null;
    },
    [],
  );

  return (
    <div
      aria-label="展开待办面板"
      className={dragging ? "edge-strip dragging" : "edge-strip"}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      role="presentation"
    />
  );
}
