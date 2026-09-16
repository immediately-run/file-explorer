// App-local context menu for the file explorer (R3-80 / FILE_EXPLORER_SPEC §3).
//
// This is APP UI inside the explorer's own iframe — it is NOT host chrome and must
// not imitate the host's consent / seam / sign-in surfaces (UI_AS_APPS_SPEC §8
// anti-spoofing). It only ever lists actions the app can already perform on the
// target under its mount's grant; the caller passes a pre-filtered item list, so
// nothing here can offer an action that would come back forbidden/protected/EROFS.
//
// ARIA `menu`/`menuitem` with roving focus + arrow keys; dismiss on outside-click,
// Escape, or scroll. The dialog/menu contract (focus in, Escape, Tab-as-leave
// closing behind the move, focus returned to the invoker) is the shared
// useOverlayFocusDismiss hook — one spelling for this menu, the summarize modal
// and the move picker.
import { useEffect, useLayoutEffect, useState } from "react";
import { useOverlayFocusDismiss } from "./hooks/useOverlayFocusDismiss";
import type { MenuAnchor } from "./types";

function ContextMenu({ anchor, onClose }: { anchor: MenuAnchor; onClose: () => void }) {
  // A menu does not trap Tab (APG Menu Button): Tab is leave, and the menu
  // closes behind the browser's own focus move. Focus returns to the invoker
  // on every close path — including that one never yanking it back.
  const ref = useOverlayFocusDismiss<HTMLUListElement>(true, onClose, {
    trapTab: false,
    returnTo: anchor.invoker ?? null,
  });
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y });

  // Clamp into the viewport once measured.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(anchor.x, window.innerWidth - r.width - 6);
    const y = Math.min(anchor.y, window.innerHeight - r.height - 6);
    setPos({ x: Math.max(6, x), y: Math.max(6, y) });
    // Focus the first item for keyboard users.
    el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [anchor, ref]);

  // Dismiss on outside pointer or scroll (Escape and Tab are the hook's).
  useEffect(() => {
    const onDocPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      window.removeEventListener("scroll", onClose, true);
    };
    // R3-653 fault injection #2 (reverted by the next commit): `onClose` dropped from
    // the dependency array — a react-hooks/exhaustive-deps WARNING. Re-planted on the
    // SHIPPED invocation: the workflow now runs a bare `npm run lint` and the flag
    // lives in the script, which is not what run 35094258084 exercised.
  }, [ref]);

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <ul
      ref={ref}
      role="menu"
      aria-label="Actions"
      className="ctxmenu"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onMenuKeyDown}
    >
      {anchor.items.map((it) => (
        <li key={it.key} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={"ctxmenu__item" + (it.danger ? " ctxmenu__item--danger" : "")}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon && <span className="ctxmenu__icon">{it.icon}</span>}
            <span className="ctxmenu__label">{it.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default ContextMenu;
