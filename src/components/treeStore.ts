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
// Each node subscribes to ONLY its own slice via `useSyncExternalStore`, so a
// toggle or a selection re-renders just the affected rows, never the tree.
import { useSyncExternalStore } from "react";
import { readdir, type DirEntry } from "../fs/mountFs";

export class TreeStore {
  private expanded = new Set<string>();
  private entries = new Map<string, DirEntry[]>();
  private errored = new Set<string>();
  private inflight = new Set<string>();
  private selected: string | null = null;
  private rootPath = "";
  private listeners = new Set<() => void>();

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
   * Seed the store for a worktree root (root starts open). Idempotent and
   * side-effect-free for an unchanged root, so it is safe to call during render;
   * it does NOT emit (the root subtree reads the seeded state on its first render,
   * and a root CHANGE remounts the subtree via its `key`).
   */
  ensureRoot(rootPath: string): void {
    if (rootPath === this.rootPath) return;
    this.rootPath = rootPath;
    this.expanded = new Set([rootPath]);
    this.entries = new Map();
    this.errored = new Set();
    this.inflight = new Set();
    this.selected = null;
  }

  // --- per-path selectors (stable primitive / array snapshots) ---
  isExpanded = (p: string): boolean => this.expanded.has(p);
  isSelected = (p: string): boolean => this.selected === p;
  isErrored = (p: string): boolean => this.errored.has(p);
  getEntries = (p: string): DirEntry[] | undefined => this.entries.get(p);

  // --- mutations (called from handlers / effects, never during render) ---
  toggle = (p: string): void => {
    if (this.expanded.has(p)) this.expanded.delete(p);
    else this.expanded.add(p);
    this.emit();
  };

  /** Record the selected file (absolute path). Drives the FX-4a row highlight. */
  select = (p: string): void => {
    if (this.selected === p) return;
    this.selected = p;
    this.emit();
  };

  /** Collapse every directory but keep the root open (the "collapse all" action). */
  collapseAll = (): void => {
    this.expanded = new Set(this.rootPath ? [this.rootPath] : []);
    this.emit();
  };

  /** Lazily read a directory's children once. Dedupes concurrent/repeat reads. */
  ensureLoaded = (p: string): void => {
    if (this.entries.has(p) || this.errored.has(p) || this.inflight.has(p)) return;
    this.inflight.add(p);
    void readdir(p).then(
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
   * Re-read every currently-open directory in place (after a create/delete/upload
   * elsewhere). Stale content stays visible until fresh entries land — no spinner
   * flash — and expansion/selection are untouched.
   */
  refresh = (): void => {
    for (const p of [...this.expanded]) {
      void readdir(p).then(
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
