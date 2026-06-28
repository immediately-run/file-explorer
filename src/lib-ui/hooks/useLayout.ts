// The explorer's view layout (R3-84): tree (default, narrow-panel) · list ·
// icons · columns. App-local view state ONLY — no SDK, no host, no platform
// primitive (FILE_EXPLORER_SPEC §6). Persisted per app in `localStorage` so the
// choice sticks across reloads; a bad/absent value degrades to "tree".
import { useCallback, useEffect, useState } from "react";
import type { Layout } from "../types";

export const LAYOUTS: Layout[] = ["tree", "list", "icons", "columns"];

// The shipped file-explorer's persistence key. A second panel in one app (e.g.
// File Commander's two panes) passes a distinct `storageKey` so the choices don't
// collide; consumers that don't care keep this default.
const DEFAULT_KEY = "ir.fileexplorer.layout";

const isLayout = (v: unknown): v is Layout =>
  typeof v === "string" && (LAYOUTS as string[]).includes(v);

function read(key: string): Layout {
  try {
    const v = localStorage.getItem(key);
    if (isLayout(v)) return v;
  } catch {
    /* localStorage unavailable (private mode / SSR) → default */
  }
  return "tree";
}

/** Persisted layout selection. `setLayout` writes through to `localStorage` under
 *  `storageKey` (default {@link DEFAULT_KEY}). */
export function useLayout(storageKey: string = DEFAULT_KEY): [Layout, (next: Layout) => void] {
  const [layout, setLayoutState] = useState<Layout>(() => read(storageKey));

  const setLayout = useCallback(
    (next: Layout) => {
      setLayoutState(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        /* best-effort persistence */
      }
    },
    [storageKey],
  );

  // Reflect a change made in another tab/pane of the same app.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey && isLayout(e.newValue)) setLayoutState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  return [layout, setLayout];
}
