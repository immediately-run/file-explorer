// Shared roving-focus movement for the tree-shaped surfaces (the view's tree
// and the move-picker's directory tree): Up/Down/Home/End move focus between
// the rendered rows in DOM order — which is visual order, because a collapsed
// directory's rows are simply not rendered. Returns whether the key was
// consumed, so a caller can leave anything else to the browser.
const ROVING_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** Move focus within `container`'s `[role="treeitem"]` rows per `key`. */
export function rovingTreeFocus(container: HTMLElement | null, key: string): boolean {
  if (!container) return false;
  if (!ROVING_KEYS.has(key)) return false;
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-hidden="true"])'),
  );
  if (!rows.length) return false;
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? rows.length - 1
        : key === "ArrowDown"
          ? Math.min(rows.length - 1, i + 1)
          : Math.max(0, i - 1);
  rows[next < 0 ? 0 : next]?.focus();
  return true;
}
