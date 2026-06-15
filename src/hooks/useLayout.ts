// The explorer's view layout (R3-84): tree (default, narrow-panel) · list ·
// icons · columns. App-local view state ONLY — no SDK, no host, no platform
// primitive (FILE_EXPLORER_SPEC §6). Persisted per app in `localStorage` so the
// choice sticks across reloads; a bad/absent value degrades to "tree".
import { useCallback, useEffect, useState } from "react";

export type Layout = "tree" | "list" | "icons" | "columns";

export const LAYOUTS: Layout[] = ["tree", "list", "icons", "columns"];

const KEY = "ir.fileexplorer.layout";

const isLayout = (v: unknown): v is Layout =>
  typeof v === "string" && (LAYOUTS as string[]).includes(v);

function read(): Layout {
  try {
    const v = localStorage.getItem(KEY);
    if (isLayout(v)) return v;
  } catch {
    /* localStorage unavailable (private mode / SSR) → default */
  }
  return "tree";
}

/** Persisted layout selection. `setLayout` writes through to `localStorage`. */
export function useLayout(): [Layout, (next: Layout) => void] {
  const [layout, setLayoutState] = useState<Layout>(read);

  const setLayout = useCallback((next: Layout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  // Reflect a change made in another tab/pane of the same app.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY && isLayout(e.newValue)) setLayoutState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [layout, setLayout];
}
