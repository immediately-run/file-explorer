// "Show all filesystems" (R3-238) — the single advanced flag that reveals the
// plumbing mounts the explorer hides from an ordinary session: the per-app
// `settings:<app>` stores and the `settings · <app>` header affordance that opens
// them. App-local view state ONLY, exactly like `useLayout` (FILE_EXPLORER_SPEC §6).
//
// Persistence is BEST-EFFORT and, on the real host, currently a no-op: an app runs in
// a sandboxed opaque-origin frame (`https://sandbox.immediately.run`, no
// `allow-same-origin`), where touching `localStorage` throws `SecurityError` — verified
// against production. So the flag holds for the session and resets on reload. That is
// a platform fact, not a property of this flag: `useLayout` has always had it, and this
// mirrors its shape deliberately so both are fixed by one change if a host-backed
// preference channel arrives. (The natural store for a user preference would be the
// app's own `settings:` filesystem — the very thing this flag hides.)
//
// Default OFF: a settings store is app-local configuration, not a user document
// (SPACES_UI_SPEC §3, R-SPACES-3 already excludes them from eject) — it belongs
// behind an explicit opt-in, next to the library/module mounts `useSdkRoots` has
// always hidden.
import { useCallback, useEffect, useState } from "react";

// Sibling of `ir.fileexplorer.layout`. A second panel in one app passes a distinct
// `storageKey` so the two panes don't collide.
const DEFAULT_KEY = "ir.fileexplorer.showAllFilesystems";

// Only the exact opt-in string enables it — anything else (absent, stale, garbage,
// another app's value) degrades to the safe default.
const read = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    /* localStorage unavailable (sandboxed frame / private mode / SSR) → default */
    return false;
  }
};

/** Persisted "show all filesystems" flag. `setShowAll` writes through to
 *  `localStorage` under `storageKey` (default {@link DEFAULT_KEY}). */
export function useShowAllFilesystems(
  storageKey: string = DEFAULT_KEY,
): [boolean, (next: boolean) => void] {
  const [showAll, setShowAllState] = useState<boolean>(() => read(storageKey));

  const setShowAll = useCallback(
    (next: boolean) => {
      setShowAllState(next);
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* best-effort persistence */
      }
    },
    [storageKey],
  );

  // Reflect a change made in another tab/pane of the same app.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey) setShowAllState(e.newValue === "1");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  return [showAll, setShowAll];
}
