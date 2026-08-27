// Public surface of the headless file-explorer library (the core view, NO SDK).
// `FileExplorerView` is the entry point; the rest are the types, helpers, store,
// hooks, and presentational pieces consumers build on.

// The headless view.
export { default as FileExplorerView } from "./FileExplorerView";
export type { FileExplorerViewProps } from "./FileExplorerView";

// The row gesture bundle + its types.
export { useRowInteractions } from "./hooks/useRowInteractions";
export type { NodeHandlers, RowProps } from "./hooks/useRowInteractions";

// Types (the injected interfaces — 00-overview §3.1).
export type {
  ExplorerRoot,
  DirEntry,
  FsSource,
  ExplorerActions,
  Layout,
  MenuItem,
  MenuAnchor,
  RowCtx,
} from "./types";

// Pure helpers (path math, root metadata, drag/move validity).
export {
  joinPath,
  basename,
  dirOf,
  toMountRel,
  mountLabel,
  mountKind,
  mountSpaceId,
  isEjectable,
  isWritableMount,
  grantedModeAt,
  mountScopes,
  subtreeLabel,
  orderMounts,
  isProtected,
  breadcrumbFor,
  moveRejection,
  MOVE_MIME,
  MAX_UPLOAD_BYTES,
  WRITE_ERR,
} from "./explorer";
export type { MountKind, MountScope, Crumb, MovePayload } from "./explorer";

// R3-267: the `opensWith` decision — pure, so any file manager built on this library
// can offer a marked folder without re-deriving the rules.
export {
  CONTENT_MARKER_FILE,
  openWithLabel,
  opensWithOffer,
  parseOpensWith,
  withdrawsOffer,
} from "./opensWith";
export type { OpensWithMarker, OpensWithOffer, OpensWithPolicy } from "./opensWith";

export { extOf, fileTypeLabel, compareEntries } from "./entryMeta";
export type { SortKey, SortableEntry } from "./entryMeta";

// The path-keyed tree store + its per-slice subscription hooks.
export { TreeStore, useNode, useSelected, useActive, useDir } from "./treeStore";

// Presentational pieces + the layouts.
export { default as ContextMenu } from "./ContextMenu";
export { default as FileGlyph } from "./FileGlyph";
export { default as LayoutSwitcher } from "./LayoutSwitcher";
export { default as Breadcrumb } from "./Breadcrumb";
export { default as ListView } from "./ListView";
export { default as ColumnView } from "./ColumnView";
export { default as IconGrid } from "./IconGrid";

// Hooks.
export { useLongPress, LONG_PRESS_MS } from "./hooks/useLongPress";
export { useLayout, LAYOUTS } from "./hooks/useLayout";
export { useBrowse } from "./hooks/useBrowse";
export type { BrowseRow, Browse } from "./hooks/useBrowse";
