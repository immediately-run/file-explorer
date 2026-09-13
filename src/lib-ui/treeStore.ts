// Path-keyed tree state, lifted OUT of the recursive TreeNode (migrate-sidebars
// Phase 03 + the file-explorer-rendering-fixes plan, FX-1/FX-2/FX-4a).
//
// Why this exists: expansion used to live in each node's `useState`, so it was
// bound to the component INSTANCE — any remount (e.g. a worktree mount
// re-announce after `editor:open`) dropped it, collapsing the clicked file's
// parent directory (FX-2), and selecting a file repainted/remounted the whole
// tree (FX-1, visible flicker). Holding expansion / the lazily-read child cache /
// the selected path here — keyed by ABSOLUTE PATH — makes that state durable
// across re-renders and remounts and independent of component identity.
//
// R3-79 (FILE_EXPLORER_SPEC §2): the store is now MULTI-ROOT — one root per
// mounted filesystem (worktree + spaces + granted subtrees). A single store with
// a `roots` set (rather than one store per mount) keeps selection/active global
// and the per-scope invariants intact (expansion is per-absolute-path, so two
// scopes never collide), with less machinery. Adding/removing a mount reconciles
// the root set; a removed mount's subtree state is purged.
//
// Each node subscribes to ONLY its own slice via `useSyncExternalStore`, so a
// toggle or a selection re-renders just the affected rows, never the tree.
import { useEffect, useSyncExternalStore } from "react";
import { compareEntries } from "./entryMeta";
import type { DirEntry, FsSource } from "./types";

export class TreeStore {
  private expanded = new Set<string>();
  private entries = new Map<string, DirEntry[]>();
  private errored = new Set<string>();
  private inflight = new Set<string>();
  private selected: string | null = null;
  // Optimistically inserted rows whose write has not settled yet (absolute
  // paths). A pending row renders in a pending treatment; the write's own
  // return settles it (R-IX-3/R-IX-4) — never a blanket refetch.
  private pending = new Set<string>();
  // The last-focused row (absolute path), shared by every layout — the roving
  // tab stop. Null until a row takes focus; each tree then keeps its tab stop
  // on its root row.
  private focused: string | null = null;
  // A multi-select SET (absolute paths), DISTINCT from `selected` (the single
  // cursor / active-open path). Used by a batch consumer (file-commander) under
  // `selectionMode === "multi"`: a row click toggles membership here rather than
  // moving the single cursor. Held here — keyed by absolute path — so it survives
  // remounts and each row subscribes to only its own membership via
  // `useInSelection`. A stable snapshot (`selectionSnapshot`) is cached so
  // `getSelection` returns the same array identity until the set actually changes,
  // avoiding `useSyncExternalStore` tearing.
  private selection = new Set<string>();
  private selectionSnapshot: string[] = [];
  // The editor's active file (mount-relative, e.g. `/src/App.tsx`), mirrored from
  // the host `editor-context` channel. Held here — NOT threaded as a prop through
  // the memoized tree — so a change re-renders ONLY the two rows whose active state
  // flips (via `useSyncExternalStore`), never the whole tree (FX-1 / FX-4b).
  private activeFile: string | null = null;
  // The stage's viewed-document hint (mount-relative), mirrored from the host
  // `editor-context.viewedFile` (R3-268). Same store-not-prop shape as
  // `activeFile` (FX-4b): a change re-renders only the affected rows.
  // Highlight-only by contract — the store never scrolls or selects on it.
  private viewedFile: string | null = null;
  private roots = new Set<string>();
  private listeners = new Set<() => void>();

  // The injected filesystem source the store reads directory entries through. The
  // view constructs the store with a concrete `FsSource` (the SDK adapter's ZenFS
  // `sdkFsSource`, file-commander's in-memory fs, or a test fake), so the store
  // never imports a concrete fs (Phase 02 §A.2). An explicit field assignment
  // (not a parameter property) keeps `erasableSyntaxOnly` happy.
  private fs: FsSource;
  constructor(fs: FsSource) {
    this.fs = fs;
  }

  /** Stable subscribe fn for `useSyncExternalStore` (identity must not change). */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  /**
   * Reconcile the set of mounted roots (R3-79). Each root starts open. Idempotent
   * and side-effect-free when the set is unchanged, so it is safe to call during
   * render; it does NOT emit (new scopes read the seeded state on first render; a
   * removed scope simply stops rendering). Purges the subtree state of any root no
   * longer present so it can't leak.
   */
  ensureRoots(rootPaths: string[]): void {
    const next = new Set(rootPaths);
    if (next.size === this.roots.size && [...next].every((p) => this.roots.has(p))) return;

    // Purge state under roots that went away.
    for (const gone of this.roots) {
      if (next.has(gone)) continue;
      this.purgeUnder(gone);
    }
    // Open each (still-/newly-) present root by default.
    for (const p of next) this.expanded.add(p);
    this.roots = next;
  }

  /** Drop expansion / entry / error / selection state at `root` and everything
   *  under it (a `root/`-prefixed path). */
  private purgeUnder(root: string) {
    const under = (p: string) => p === root || p.startsWith(root + "/") || p.startsWith(root.replace(/\/+$/, "") + "/");
    for (const p of [...this.expanded]) if (under(p)) this.expanded.delete(p);
    for (const p of [...this.entries.keys()]) if (under(p)) this.entries.delete(p);
    for (const p of [...this.errored]) if (under(p)) this.errored.delete(p);
    for (const p of [...this.pending]) if (under(p)) this.pending.delete(p);
    if (this.selected && under(this.selected)) this.selected = null;
    if (this.focused && under(this.focused)) this.focused = null;
    let dropped = false;
    for (const p of [...this.selection]) {
      if (under(p)) {
        this.selection.delete(p);
        dropped = true;
      }
    }
    if (dropped) this.refreshSelectionSnapshot();
  }

  // --- per-path selectors (stable primitive / array snapshots) ---
  isExpanded = (p: string): boolean => this.expanded.has(p);
  isSelected = (p: string): boolean => this.selected === p;
  isErrored = (p: string): boolean => this.errored.has(p);
  getEntries = (p: string): DirEntry[] | undefined => this.entries.get(p);
  /** The selected absolute path (shared across every layout). */
  getSelected = (): string | null => this.selected;
  /** Is `p` (absolute) in the multi-select set? Drives the `lrow--selected`
   *  highlight under `selectionMode === "multi"`. */
  isInSelection = (p: string): boolean => this.selection.has(p);
  /** The multi-select set as a stable-identity array (absolute paths). The
   *  returned array is cached and only re-created when the set changes, so
   *  `useSyncExternalStore` sees a stable snapshot between real mutations. */
  getSelection = (): string[] => this.selectionSnapshot;
  /** Is `repoRel` (mount-relative) the editor's active file? Drives the FX-4b row
   *  highlight without a per-node prop (compared mount-relative, matching the
   *  host's `editor-context.activeFile`). */
  isActive = (repoRel: string): boolean => this.activeFile === repoRel;
  /** The editor's active file, mount-relative (shared across every layout). */
  getActiveFile = (): string | null => this.activeFile;
  /** Is `repoRel` the file the STAGE claims to be rendering (R3-268)? Drives the
   *  "on stage" marker, visually distinct from the editor-active highlight. */
  isViewed = (repoRel: string): boolean => this.viewedFile === repoRel;
  /** The stage's viewed-document hint, mount-relative (or null — no hint). */
  getViewedFile = (): string | null => this.viewedFile;
  /** Is the row at absolute `p` a write in flight (optimistically inserted)? */
  isPending = (p: string): boolean => this.pending.has(p);
  /** The last-focused row's absolute path (the roving tab stop), or null. */
  getFocused = (): string | null => this.focused;
  /** Does any focused row sit inside the tree rooted at `rootPath`? */
  isFocusInTree = (rootPath: string): boolean =>
    this.focused !== null &&
    (this.focused === rootPath || this.focused.startsWith(rootPath + "/"));
  /** Is `repoRel` (a DIRECTORY, mount-relative) an ancestor of the viewed
   *  document? Drives the collapsed-folder "contains the on-stage file" dot —
   *  a corpus under a chroot subdir stays discoverable while the tree itself is
   *  untouched (the highlight-only contract). */
  isViewedAncestor = (repoRel: string): boolean => {
    if (!this.viewedFile) return false;
    if (repoRel === "/") return true;
    return this.viewedFile.startsWith(repoRel + "/");
  };
  /** Is `repoRel` (a DIRECTORY, mount-relative) an ancestor of the editor's
   *  active file? The counterpart of {@link isViewedAncestor} for the FX-4b
   *  signal: once the user collapses the folder holding the edited file, the
   *  marker must not simply vanish. */
  isActiveAncestor = (repoRel: string): boolean => {
    if (!this.activeFile) return false;
    if (repoRel === "/") return true;
    return this.activeFile.startsWith(repoRel + "/");
  };

  // --- mutations (called from handlers / effects, never during render) ---
  toggle = (p: string): void => {
    if (this.expanded.has(p)) {
      this.expanded.delete(p);
      // The rows underneath are about to unmount — a focus pointing at one of
      // them would leave its tree with no tab stop. Hand it to the folder.
      if (this.focused !== null && this.focused !== p && this.focused.startsWith(p + "/")) {
        this.focused = p;
      }
    } else {
      this.expanded.add(p);
    }
    this.emit();
  };

  /** Expand every ancestor of the mount-relative `path` under EVERY root. Used
   *  by the gesture-gated stage reveal (the host's one-shot `viewed-reveal`) and
   *  by the editor-active reveal. A path that
   *  doesn't exist under a root never renders, so over-expansion is inert.
   *  Rendering only — never focuses; the caller owns the (optional) scroll. */
  revealPath = (path: string): void => {
    const segs = path.split("/").filter(Boolean);
    segs.pop(); // the file itself — expansion applies to its ancestor dirs
    let changed = false;
    for (const root of this.roots) {
      let p = root;
      for (const seg of segs) {
        p = `${p}/${seg}`;
        if (!this.expanded.has(p)) {
          this.expanded.add(p);
          changed = true;
        }
      }
    }
    if (changed) this.emit();
  };

  /** Force a directory open (used when revealing a drop target / a created path). */
  open = (p: string): void => {
    if (this.expanded.has(p)) return;
    this.expanded.add(p);
    this.emit();
  };

  /** Record the selected file (absolute path). Drives the FX-4a row highlight. */
  select = (p: string): void => {
    if (this.selected === p) return;
    this.selected = p;
    this.emit();
  };

  /** Record the focused row (absolute path) — moves the roving tab stop. */
  setFocus = (p: string | null): void => {
    if (this.focused === p) return;
    this.focused = p;
    this.emit();
  };

  // --- optimistic write mutations (called by the write flow, never render) ---
  // Every mutation replaces the directory's array (never mutates it in place)
  // so `getEntries` snapshots change identity and `useSyncExternalStore` sees
  // the update.

  /** Insert `entry` into `dir`'s cached listing at its final (sorted)
   *  position. A directory whose listing is not loaded yet (collapsed,
   *  never read) is left alone — nothing renders there until it loads, and
   *  the post-settle `refreshDir` is the authority. */
  private sortedInsert = (dir: string, entry: DirEntry, asPending: boolean): void => {
    const list = this.entries.get(dir);
    if (!list) return;
    const next = [...list];
    let i = next.findIndex((e) => compareEntries(entry, e, "name") < 0);
    if (i < 0) i = next.length;
    next.splice(i, 0, entry);
    this.entries.set(dir, next);
    if (asPending) this.pending.add(`${dir}/${entry.name}`);
    this.emit();
  };

  /** Insert an entry that is NOT yet real — the row the user just asked for,
   *  rendered immediately at its final position in a pending treatment
   *  (R-IX-3). The write's own return settles it via {@link settleEntry}. */
  insertPending = (dir: string, entry: DirEntry): void => {
    this.sortedInsert(dir, entry, true);
  };

  /** Insert (or restore, after a failed write) a real entry. */
  insertEntry = (dir: string, entry: DirEntry): void => {
    this.sortedInsert(dir, entry, false);
  };

  /** Replace the pending row `pendingName` in `dir` with the authoritative
   *  `entry` the write returned — the settle, with no read at all (R-IX-4). */
  settleEntry = (dir: string, pendingName: string, entry: DirEntry): void => {
    const list = this.entries.get(dir);
    this.pending.delete(`${dir}/${pendingName}`);
    if (!list) return;
    const i = list.findIndex((e) => e.name === pendingName);
    if (i < 0) return;
    const next = [...list];
    next[i] = entry;
    // The authority may have normalized the name; keep the listing sorted.
    next.sort((a, b) => compareEntries(a, b, "name"));
    this.entries.set(dir, next);
    this.emit();
  };

  /** Drop `name` from `dir`'s cached listing (an optimistic remove, or the
   *  cleanup of a pending row). No-op when the listing is not loaded. */
  removeEntry = (dir: string, name: string): void => {
    const gone = `${dir}/${name}`;
    const list = this.entries.get(dir);
    this.pending.delete(gone);
    if (this.focused === gone) this.focused = null;
    if (!list) return;
    const i = list.findIndex((e) => e.name === name);
    if (i < 0) return;
    const next = [...list];
    next.splice(i, 1);
    this.entries.set(dir, next);
    this.emit();
  };

  /** Recompute the cached selection snapshot after a set mutation. */
  private refreshSelectionSnapshot() {
    this.selectionSnapshot = [...this.selection];
  }

  /** Toggle `p` (absolute) in the multi-select set and emit. */
  toggleInSelection = (p: string): void => {
    if (this.selection.has(p)) this.selection.delete(p);
    else this.selection.add(p);
    this.refreshSelectionSnapshot();
    this.emit();
  };

  /** Clear the multi-select set (emits only if it held anything). */
  clearSelection = (): void => {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.refreshSelectionSnapshot();
    this.emit();
  };

  /** Mirror the editor's active file (mount-relative). Emits only on a real change,
   *  so the editor-context push re-renders just the two affected rows (FX-4b). */
  setActiveFile = (next: string | null): void => {
    if (this.activeFile === next) return;
    this.activeFile = next;
    this.emit();
  };

  /** Mirror the stage's viewed-document hint (mount-relative; R3-268). Emits only
   *  on a real change so a navigation re-renders just the affected rows. */
  setViewedFile = (next: string | null): void => {
    if (this.viewedFile === next) return;
    this.viewedFile = next;
    this.emit();
  };

  /** Collapse every directory but keep the mounted roots open ("collapse all"). */
  collapseAll = (): void => {
    this.expanded = new Set(this.roots);
    this.emit();
  };

  /** Lazily read a directory's children once. Dedupes concurrent/repeat reads. */
  ensureLoaded = (p: string): void => {
    if (this.entries.has(p) || this.errored.has(p) || this.inflight.has(p)) return;
    this.inflight.add(p);
    void this.fs.readdir(p).then(
      (list) => {
        this.inflight.delete(p);
        this.entries.set(p, list);
        this.errored.delete(p);
        this.emit();
      },
      () => {
        this.inflight.delete(p);
        this.errored.add(p);
        this.emit();
      },
    );
  };

  /**
   * Re-read every currently-open directory in place — the EXPLICIT reload
   * (layout switches, a consumer's "refresh" affordance). The post-write path
   * does NOT use this; it settles from the write's return and then calls the
   * narrow {@link refreshDir}. Stale content stays visible until fresh entries
   * land — no spinner flash — and expansion/selection are untouched.
   */
  refresh = (): void => {
    for (const p of [...this.expanded]) {
      void this.fs.readdir(p).then(
        (list) => {
          this.entries.set(p, list);
          this.errored.delete(p);
          this.emit();
        },
        () => {
          this.errored.add(p);
          this.emit();
        },
      );
    }
  }

  /**
   * Re-read ONE directory in place — the narrow post-write authority refetch
   * (R-IX-4: refetch what changed, not everything that happens to be open).
   * Settles the write's directory against the authority; pending rows are
   * dropped for the fresh listing (a still-in-flight write re-inserts nothing —
   * its settle is the action's return, and a later write re-adds its row).
   */
  refreshDir = (p: string): void => {
    void this.fs.readdir(p).then(
      (list) => {
        this.entries.set(p, list);
        for (const entry of list) this.pending.delete(`${p}/${entry.name}`);
        this.errored.delete(p);
        this.emit();
      },
      () => {
        this.errored.add(p);
        this.emit();
      },
    );
  };
}

/** Subscribe a node to exactly its own slice of the store. */
export function useNode(
  store: TreeStore,
  path: string,
): { expanded: boolean; selected: boolean; errored: boolean; entries: DirEntry[] | undefined } {
  const expanded = useSyncExternalStore(store.subscribe, () => store.isExpanded(path));
  const selected = useSyncExternalStore(store.subscribe, () => store.isSelected(path));
  const errored = useSyncExternalStore(store.subscribe, () => store.isErrored(path));
  const entries = useSyncExternalStore(store.subscribe, () => store.getEntries(path));
  return { expanded, selected, errored, entries };
}

/** Subscribe to the shared selected path (drives the highlight in every layout). */
export function useSelected(store: TreeStore): string | null {
  return useSyncExternalStore(store.subscribe, store.getSelected);
}

/** Subscribe a row to ONLY whether it is in the multi-select set. Mirrors
 *  `useSelected`/`useActive`: keyed by the row's absolute path so toggling one
 *  row re-renders just that row, not the whole list. */
export function useInSelection(store: TreeStore, path: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isInSelection(path));
}

/** Subscribe a node to ONLY whether it is the editor's active file (FX-4b). Keyed
 *  by the node's mount-relative path so a change re-renders just the two rows whose
 *  active state flips — not the whole memoized tree. */
export function useActive(store: TreeStore, repoRel: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isActive(repoRel));
}

/** Subscribe a node to ONLY whether it is the stage's viewed document (R3-268).
 *  Mirrors {@link useActive}: keyed per row so a navigation re-renders just the
 *  two rows whose viewed state flips. */
export function useViewed(store: TreeStore, repoRel: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isViewed(repoRel));
}

/** Subscribe a DIRECTORY row to whether its subtree contains the viewed document
 *  (the collapsed-ancestor dot). Same per-row shape as {@link useViewed}. */
export function useViewedAncestor(store: TreeStore, repoRel: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isViewedAncestor(repoRel));
}

/** Subscribe a DIRECTORY row to whether its subtree contains the editor's active
 *  file (the collapsed-ancestor dot). Same per-row shape as {@link useActive}. */
export function useActiveAncestor(store: TreeStore, repoRel: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isActiveAncestor(repoRel));
}

/** Subscribe a row to whether its write is still in flight (the pending
 *  treatment). Keyed by absolute path so a settle re-renders one row. */
export function usePending(store: TreeStore, path: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.isPending(path));
}

/** Subscribe to the shared focused row (the roving tab stop). */
export function useFocused(store: TreeStore): string | null {
  return useSyncExternalStore(store.subscribe, store.getFocused);
}

/** Subscribe a row to ONLY whether IT holds the roving tab stop — a boolean
 *  slice, so a focus move re-renders the two rows whose slice flipped, not
 *  every row (the string selector above re-renders all of its subscribers). */
export function useRowFocused(store: TreeStore, path: string): boolean {
  return useSyncExternalStore(store.subscribe, () => store.getFocused() === path);
}

/** Subscribe a tree to whether its roving tab stop lives on the root row (no
 *  row of this tree holds focus — some other tree, or nothing, does). */
export function useTreeUnfocused(store: TreeStore, rootPath: string): boolean {
  return useSyncExternalStore(store.subscribe, () => !store.isFocusInTree(rootPath));
}

/**
 * Read one directory's entries for the flat layouts (list / icons / columns) and
 * ensure they are lazily loaded — reusing the SAME path-keyed cache and dedupe as
 * the tree, so switching layout never re-reads what the tree already loaded.
 */
export function useDir(
  store: TreeStore,
  path: string | null,
): { entries: DirEntry[] | undefined; errored: boolean } {
  const entries = useSyncExternalStore(store.subscribe, () =>
    path ? store.getEntries(path) : undefined,
  );
  const errored = useSyncExternalStore(store.subscribe, () =>
    path ? store.isErrored(path) : false,
  );
  useEffect(() => {
    if (path && entries === undefined && !errored) store.ensureLoaded(path);
  }, [store, path, entries, errored]);
  return { entries, errored };
}
