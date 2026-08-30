import { useEffect, useRef } from "react";

interface StripProps {
  onExpand: () => void;
}

export function Strip({ onExpand }: StripProps) {
  const hoverTimer = useRef<number | null>(null);

  function clearHoverTimer() {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }

  function handleMouseEnter() {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      onExpand();
    }, 400);
  }

  useEffect(() => clearHoverTimer, []);

  return (
    <div
      aria-label="展开待办面板"
      className="edge-strip"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={clearHoverTimer}
      role="presentation"
    />
  );
}
