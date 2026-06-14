// Long-press detection for the touch context menu (R3-80 / FILE_EXPLORER_SPEC §3).
//
// On a touch device the context menu opens after a press of LONG_PRESS_MS (3s per
// the issue) on a row. The timer starts on pointerdown and is cancelled on a move
// past a small slop threshold, on lift, or on scroll — so it never competes with a
// tap (short press) or a scroll/drag gesture. A real-pointer right-click uses the
// native `contextmenu` event instead (see ContextMenu/FileExplorer), not this hook.
import { useCallback, useRef } from "react";

export const LONG_PRESS_MS = 3000;
const SLOP_PX = 10;

interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * Returns pointer handlers that fire `onLongPress(x, y)` after a 3s stationary
 * touch press. Mouse/pen pointers are ignored (they use right-click). The timer is
 * always cleared on move-past-slop / up / cancel.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "touch") return; // right-click handles mouse/pen
      origin.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      timer.current = window.setTimeout(() => onLongPress(clientX, clientY), LONG_PRESS_MS);
    },
    [onLongPress],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const o = origin.current;
      if (!o) return;
      if (Math.abs(e.clientX - o.x) > SLOP_PX || Math.abs(e.clientY - o.y) > SLOP_PX) clear();
    },
    [clear],
  );

  return { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear };
}
