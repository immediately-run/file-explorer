// The library's injected interfaces — the extension points the headless
// `FileExplorerView` is built on (00-overview §3.1). These are pure type
// declarations: NO React, NO SDK import. A consumer maps its own data (the SDK
// adapter maps `SandboxMount`; file-commander maps its drives) onto these shapes,
// so the view never imports a host type.

/**
 * A browsable root. Generalizes the SDK's `SandboxMount`: the consumer maps its
 * own filesystem(s) to this. The `path` is the absolute root path the injected
 * {@link FsSource} understands; everything else drives the scope header + gating.
 */
export interface ExplorerRoot {
  id: string;
  /** Absolute root path the FsSource understands. */
  path: string;
  label: string;
  kind: "worktree" | "space" | "settings" | "other";
  writable: boolean;
  scopes?: { subtree: string; mode: "ro" | "rw" }[];
  ejectable?: boolean;
  spaceId?: string;
  /**
   * The RAW granted rule-set of this root — each `{subtree, mode}` a path prefix the
   * app holds and at what access, longest-prefix wins.
   *
   * Deliberately NOT `scopes`, which is the DISPLAY view and clamps every non-worktree
   * scope to `ro` because the explorer's own writes ride the kernel-gated host actions.
   * This is the authority the host will check a DELEGATION against (R3-267 `openWith`),
   * so it must be the real thing: asking for `rw` where the grant is `ro` is refused as
   * a mode escalation, and asking for `ro` where the grant is `rw` needlessly hands a
   * dispatched viewer a read-only corpus (R3-266). Absent ⇒ unknown, treat as `ro`.
   */
  grants?: { subtree: string; mode: "ro" | "rw" }[];
}

/** One directory entry as the view consumes it (directories first, then files). */
export interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number | null;
  mtimeMs?: number;
}

/**
 * How the component reads bytes/entries. The default adapter is the ZenFS
 * `mountFs`; file-commander supplies its in-memory fs; a test supplies a fake.
 */
export interface FsSource {
  readdir(path: string): Promise<DirEntry[]>;
  readFile?(path: string): Promise<Uint8Array>;
}

/**
 * Optional privileged operations. An affordance renders ONLY when its action is
 * provided AND the row permits it (writable, not protected). A missing action =>
 * the affordance is absent (never a disabled button that returns `forbidden`).
 */
export interface ExplorerActions {
  open?(root: ExplorerRoot, relPath: string): void;
  createFile?(root: ExplorerRoot, relPath: string): Promise<void>;
  createFolder?(root: ExplorerRoot, relPath: string): Promise<void>;
  rename?(root: ExplorerRoot, fromRel: string, toRel: string): Promise<void>;
  delete?(root: ExplorerRoot, relPath: string): Promise<void>;
  upload?(root: ExplorerRoot, dirRel: string, files: File[]): Promise<void>;
  beginDragOut?(root: ExplorerRoot, relPath: string, isDir: boolean): void;
  cancelDragOut?(): void;
  eject?(root: ExplorerRoot): Promise<void>;
}

/** The explorer's view layout (R3-84): tree · list · icons · columns. */
export type Layout = "tree" | "list" | "icons" | "columns";

/** One item in the app-local context menu (R3-80). */
export interface MenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/** The positioned, built context menu the view opens at the pointer. */
export interface MenuAnchor {
  x: number;
  y: number;
  items: MenuItem[];
}

/** Everything a row needs to identify itself to the shared handlers + the
 *  extension slots (`extraMenuItems`, `renderRowAccessory`). */
export interface RowCtx {
  absPath: string;
  isDir: boolean;
  rootPath: string;
  mountId: string;
  writable: boolean;
}
