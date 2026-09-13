// The dialog/menu contract for this library's overlays (R-IX-1): focus moves
// IN on open, Tab is trapped while open (unless the surface is a menu — menus
// do not trap Tab; Tab is leave, and the menu closes behind the move), Escape
// closes only the TOP of a module-level stack, and focus RETURNS to the
// element that opened the overlay. The stack exists because the surfaces
// overlap (a picker opened from a row's context menu, a modal above either):
// one Escape closes one overlay.
//
// Same spelling as the sibling apps' hook (grove R3-608) — one contract, not
// a per-component invention. This port adds `returnTo`: a menu opened from a
// pointer event (right-click, long-press) may have nothing focused, so the
// caller names the invoker it captured when the menu was opened.
import { useEffect, useRef } from "react";

/** Elements that can hold focus inside the overlay. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The open-overlay stack, newest last. Only the top entry answers Escape —
 *  a nested pair closes one per key, never both at once. */
const stack: { close: () => void }[] = [];

interface OverlayFocusDismissOptions {
  /** Menus do not trap Tab (the APG menu pattern keeps Tab as leave); dialogs
   *  do. Default true. */
  trapTab?: boolean;
  /** Where focus returns on close. Defaults to the element focused when the
   *  overlay opened — right for keyboard-opened overlays; a pointer-opened
   *  menu passes the row it was opened from instead. */
  returnTo?: HTMLElement | null;
}

/**
 * Wire the contract to an overlay root. Attach the returned ref to the element
 * that bounds the overlay (its panel/menu box).
 *
 * @param open    the overlay's open state — the effect arms on true and cleans
 *                up (returning focus) on false/unmount.
 * @param onClose Escape's meaning: close without committing.
 */
export function useOverlayFocusDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  opts: OverlayFocusDismissOptions = {},
) {
  const rootRef = useRef<T | null>(null);
  // The latest close callback, kept current in an effect (never a render-time
  // ref write — the react-hooks compiler forbids it, correctly).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const trapTab = opts.trapTab !== false;

  useEffect(() => {
    if (!open) return;
    // The trigger to return to, captured BEFORE focus moves in.
    const trigger = opts.returnTo ?? (document.activeElement as HTMLElement | null);
    const entry = {
      close: () => onCloseRef.current(),
    };
    stack.push(entry);
    // Set when a MENU surface closes because Tab left it: the browser's own
    // focus move must stand (APG Menu Button), so the cleanup below must NOT
    // yank focus back to the trigger.
    let closedViaTab = false;
    const root = rootRef.current;
    const focusables = root ? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)] : [];
    // Focus IN: the first control; a panel with no focusable content takes
    // focus itself so Escape has a home.
    (focusables[0] ?? root)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const isTop = stack[stack.length - 1] === entry;
      if (e.key === "Escape") {
        if (!isTop) return; // a nested overlay above owns this key
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (!trapTab && e.key === "Tab") {
        // APG Menu: Tab is LEAVE — the focus move proceeds (no preventDefault)
        // and the menu closes behind it, never stranded over a scrim. The
        // flag keeps the cleanup from pulling focus back to the trigger: the
        // move the browser just made is the contract.
        if (isTop) {
          closedViaTab = true;
          onCloseRef.current();
        }
        return;
      }
      if (!trapTab || e.key !== "Tab" || !root) return;
      const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
      if (!list.length) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase: the contract runs before any app-level key handling.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      // Focus RETURNS to the trigger (R-IX-1) — unless the menu closed BECAUSE
      // Tab left it: that move is the contract and stands. Guarded: the
      // trigger may be gone.
      if (!closedViaTab && trigger && document.contains(trigger)) trigger.focus();
    };
    // `opts.returnTo` is read once at open on purpose: the invoker is whatever
    // it was when the overlay opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trapTab]);

  return rootRef;
}
