// The headless file-explorer view (00-overview §3.2; Phase 02 §A). This is the
// former `FileExplorer.tsx` orchestrator with EVERY host/SDK call severed into an
// injected prop: it reads roots through `roots: ExplorerRoot[]`, bytes/entries
// through `fs: FsSource`, the active file through `activePath`, and emits intents
// through `actions`/`onActivate`/`onSelect`. It imports NO SDK — the SDK adapter
// (`sdk/SdkFileExplorer.tsx`) wires all of that up and re-creates the shipped app.
// A non-SDK consumer (file-commander) supplies its own fs/roots and simply omits
// the actions it doesn't implement (the affordance then hides).
//
// Behavior is byte-for-byte the same as the pre-extraction app: the same four
// layouts, the same `TreeStore` + `useLayout`, the same context menu, breadcrumb,
// scope headers, gestures, and the FX-1/FX-2/FX-4a/FX-4b invariants.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  FolderTree,
  Folder,
  FolderOpen,
  FolderGit2,
  Users,
  Settings as SettingsIcon,
  File as FileIcon,
  Loader2,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  Trash2,
  Pencil,
  Upload,
  ExternalLink,
  Lock,
  CircleArrowUp,
  Play,
  type LucideIcon,
} from "lucide-react";
import {
  TreeStore,
  useNode,
  useActive,
  useActiveAncestor,
  useViewed,
  useViewedAncestor,
} from "./treeStore";
import ContextMenu from "./ContextMenu";
import LayoutSwitcher from "./LayoutSwitcher";
import ListView from "./ListView";
import IconGrid from "./IconGrid";
import ColumnView from "./ColumnView";
import { useLongPress } from "./hooks/useLongPress";
import { useLayout } from "./hooks/useLayout";
import { type NodeHandlers } from "./hooks/useRowInteractions";
import {
  joinPath,
  basename,
  dirOf,
  toMountRel,
  mountLabel,
  mountKind,
  mountScopes,
  isWritableMount,
  isEjectable,
  isProtected,
  orderMounts,
  moveRejection,
  MOVE_MIME,
  WRITE_ERR,
} from "./explorer";
import type {
  ExplorerRoot,
  FsSource,
  ExplorerActions,
  Layout,
  MenuAnchor,
  MenuItem,
  RowCtx,
} from "./types";

/** Optional extension slots + chrome supplied by a consumer. */
export interface FileExplorerViewProps {
  roots: ExplorerRoot[];
  fs: FsSource;
  /** Optional privileged operations; an omitted action hides its affordance. */
  actions?: ExplorerActions;
  /** Controlled highlight (the editor's open file, mount-relative). */
  activePath?: string | null;
  /** The stage's viewed-document hint (mount-relative, leading slash; R3-268) —
   *  the file the RUNNING APP claims to be rendering, or null. Rendered as a
   *  marker visually distinct from the editor-active highlight. Highlight-only:
   *  the explorer never scrolls, selects, or navigates on it. */
  viewedPath?: string | null;
  /** Gesture-gated reveal (host `viewed-reveal`, one-shot per nonce): expand the
   *  viewed file's ancestors and scroll its row into view — NEVER focus. Only
   *  fired by the host for navigations that provably rode a real user click;
   *  everything else stays highlight-only + ancestor dot. */
  reveal?: { path: string; nonce: number } | null;
  selectionMode?: "single" | "multi" | "none";
  onSelect?: (root: ExplorerRoot, relPath: string) => void;
  /**
   * Controlled multi-select notification (for a batch consumer, e.g.
   * file-commander's copy/move). Fired under `selectionMode === "multi"` whenever
   * the multi-select SET changes, with the owning `root` and the mount-relative
   * paths of the current set. Distinct from `onSelect` (the single cursor), which
   * still fires as before. For a single-panel consumer the set lives within one
   * root; that root is reported.
   */
  onSelectionChange?: (root: ExplorerRoot, relPaths: string[]) => void;
  /**
   * Semi-controlled current directory for the flat LIST and ICONS layouts: an
   * ABSOLUTE directory path the `FsSource` understands — a root's `path` joined
   * with the browsed subpath, or `null` for the synthetic roots-root. When
   * provided (`!== undefined`) the prop WINS over internal state: the view renders
   * that directory and navigation fires `onNavigate(root, relPath)` WITHOUT
   * mutating internal state, so a controlled consumer updates its own `cwd` and
   * passes it back (the standard controlled pattern). When omitted the list/icons
   * cwd is uncontrolled (today's behavior). The COLUMNS layout is always
   * uncontrolled — `cwd` control covers list/icons (file-commander uses list).
   */
  cwd?: string | null;
  onActivate?: (root: ExplorerRoot, relPath: string, isDir: boolean) => void;
  /**
   * Fired when the browsed directory changes in a flat layout (list / icons /
   * columns) — a consumer (e.g. file-commander) observes each panel's current
   * directory, the destination for a cross-panel copy/move. `relPath` is the
   * mount-relative directory within `root`. Not fired for the tree layout (no
   * single "current directory") nor for the synthetic roots-root view.
   */
  onNavigate?: (root: ExplorerRoot, relPath: string) => void;
  /** Controlled layout, or omit and pass `storageKey` for the persisted default. */
  layout?: Layout;
  onLayoutChange?: (next: Layout) => void;
  storageKey?: string;
  /** Append items to a row's context menu (e.g. "Summarize…"). */
  extraMenuItems?: (ctx: RowCtx) => MenuItem[];
  /** Render an accessory next to a row's delete button. */
  renderRowAccessory?: (ctx: RowCtx) => ReactNode;
  /** Panel header chrome. `actions` is the one-row cluster beside the title; it holds
   *  controls whose count is FIXED, because a single row can only be shared out so far.
   *  `tray` is a second row below the header for controls whose count grows with DATA
   *  (one per app with settings, say) — an unbounded N cannot be squeezed into a fixed
   *  row, so it gets its own scrollable strip instead of shrinking its siblings to
   *  slivers. */
  header?: { title?: string; glyph?: ReactNode; actions?: ReactNode; tray?: ReactNode };
  /** Replaces the built-in "no files" empty state. */
  emptyState?: ReactNode;
}

const TreeNode = memo(function TreeNode({
  path,
  name,
  isDir,
  depth,
  rootPath,
  mountId,
  writable,
  store,
  handlers,
  renderRowAccessory,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  rootPath: string;
  mountId: string;
  writable: boolean;
  store: TreeStore;
  handlers: NodeHandlers;
  renderRowAccessory?: (ctx: RowCtx) => ReactNode;
}) {
  const { expanded, selected, errored, entries } = useNode(store, path);
  const open = isDir && expanded;
  const loading = isDir && open && entries === undefined && !errored;
  const [dropTarget, setDropTarget] = useState(false);

  useEffect(() => {
    if (isDir && open && entries === undefined && !errored) store.ensureLoaded(path);
  }, [isDir, open, entries, errored, path, store]);

  const repoRel = toMountRel(rootPath, path);
  // Active highlight via a per-node store subscription (NOT a threaded prop), so
  // an active-path change re-renders only the affected rows (FX-4b).
  const activeMatch = useActive(store, repoRel);
  const active = !isDir && activeMatch;
  // The collapsed-ancestor dot for the EDITOR's file, mirroring the on-stage one
  // below: a closed folder holding the edited file keeps saying so, so collapsing
  // `src/` doesn't make the answer to "what am I editing?" disappear entirely.
  const activeAncestorMatch = useActiveAncestor(store, repoRel);
  const containsActive = isDir && !open && activeAncestorMatch;
  // The "on stage" marker (R3-268) — same per-node subscription shape as active.
  const viewedMatch = useViewed(store, repoRel);
  const viewed = !isDir && viewedMatch;
  // The collapsed-ancestor dot: a closed folder whose subtree contains the
  // on-stage file shows a dimmed marker, so the viewed highlight is discoverable
  // without the tree ever moving on its own (the highlight-only contract).
  const ancestorMatch = useViewedAncestor(store, repoRel);
  const containsViewed = isDir && !open && ancestorMatch;
  const deletable = writable && !isProtected(repoRel) && !!handlers.onDelete;
  const rowCtx: RowCtx = { absPath: path, isDir, rootPath, mountId, writable };

  const longPress = useLongPress((x, y) => handlers.onMenu({ clientX: x, clientY: y }, rowCtx));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlers.onActivate(path, isDir);
    } else if (isDir && e.key === "ArrowRight" && !open) {
      store.toggle(path);
    } else if (isDir && e.key === "ArrowLeft" && open) {
      store.toggle(path);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      handlers.onMenu({ clientX: r.left + 12, clientY: r.bottom }, rowCtx);
    }
  };

  // Drag-out (R3-83) + internal move (R3-81) both start here. We set the private
  // move payload (used only for an in-explorer drop) AND ask the host to begin a
  // cross-app drag-out; whichever drop fires wins (the other is cancelled).
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MOVE_MIME, JSON.stringify({ from: path, rootPath }));
    e.dataTransfer.effectAllowed = "copyMove";
    handlers.beginDragOut(path, isDir, mountId, rootPath);
  };
  const onDragEnd = () => handlers.cancelDragOut();

  // A directory row is a drop target for internal moves and OS-file uploads.
  const onDragOver = (e: React.DragEvent) => {
    if (!isDir) return;
    const isMove = e.dataTransfer.types.includes(MOVE_MIME);
    const isUpload = e.dataTransfer.types.includes("Files");
    if (!isMove && !isUpload) return;
    if (isUpload && !writable) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isMove ? "move" : "copy";
    setDropTarget(true);
  };
  const onDragLeave = () => setDropTarget(false);
  const onDrop = (e: React.DragEvent) => {
    if (!isDir) return;
    const move = e.dataTransfer.getData(MOVE_MIME);
    const files = Array.from(e.dataTransfer.files);
    if (!move && !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);
    handlers.cancelDragOut(); // the drop landed inside the explorer → not a drag-out
    if (move) {
      const { from, rootPath: fromRoot } = JSON.parse(move) as { from: string; rootPath: string };
      handlers.onMoveDrop(from, fromRoot, path, rootPath);
    } else if (files.length) {
      handlers.onUploadDrop(files, path, writable);
    }
  };

  const Icon = isDir ? (open ? FolderOpen : Folder) : FileIcon;

  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={!isDir ? selected : undefined} aria-label={name}>
      <div
        className={
          "tnode" +
          (selected ? " tnode--selected" : "") +
          (active ? " tnode--active" : "") +
          (viewed ? " tnode--viewed" : "") +
          (dropTarget ? " tnode--droptarget" : "")
        }
        style={{ paddingLeft: 8 + depth * 14 }}
        tabIndex={0}
        draggable
        onClick={() => handlers.onActivate(path, isDir)}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          handlers.onMenu(e, rowCtx);
        }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
        data-dir={isDir ? "1" : "0"}
        aria-current={active ? "true" : undefined}
      >
        <span className="tnode__icon">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="tnode__name">{name}</span>
        {active && (
          <span
            className="tnode__active"
            role="img"
            aria-label="Open in the editor"
            title="Open in the editor"
          >
            <Pencil size={11} aria-hidden="true" />
          </span>
        )}
        {containsActive && (
          <span
            className="tnode__active tnode__active--ancestor"
            role="img"
            aria-label="Contains the file open in the editor"
            title="Contains the file open in the editor"
          >
            <Pencil size={11} aria-hidden="true" />
          </span>
        )}
        {viewed && (
          <span
            className="tnode__viewed"
            role="img"
            aria-label="Shown in the running app"
            title="Shown in the running app"
          >
            <Play size={11} aria-hidden="true" />
          </span>
        )}
        {containsViewed && (
          <span
            className="tnode__viewed tnode__viewed--ancestor"
            role="img"
            aria-label="Contains the file shown in the running app"
            title="Contains the file shown in the running app"
          >
            <Play size={11} aria-hidden="true" />
          </span>
        )}
        {loading && (
          <span className="tnode__spin" aria-hidden="true">
            <Loader2 size={13} />
          </span>
        )}
        {renderRowAccessory?.(rowCtx)}
        {deletable && (
          <button
            type="button"
            className="tnode__del"
            aria-label={`Delete ${name}`}
            title={`Delete ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              handlers.onDelete(path, isDir, rootPath);
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>

      {isDir && open && (
        <ul role="group">
          {errored && (
            <li className="tnode tnode--muted" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              Couldn’t read this folder.
            </li>
          )}
          {entries?.length === 0 && (
            <li className="tnode tnode--muted" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              Empty
            </li>
          )}
          {entries?.map((entry) => (
            <TreeNode
              key={entry.name}
              path={joinPath(path, entry.name)}
              name={entry.name}
              isDir={entry.isDir}
              depth={depth + 1}
              rootPath={rootPath}
              mountId={mountId}
              writable={writable}
              store={store}
              handlers={handlers}
              renderRowAccessory={renderRowAccessory}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

/** Provider/type icon for the App-scope header (R3-94 / PRINCIPALS §9 B1). */
const MOUNT_ICON: Record<ReturnType<typeof mountKind>, LucideIcon> = {
  worktree: FolderGit2,
  settings: SettingsIcon,
  space: Users,
  other: Folder,
};

/** A single browsable root: scope header (type icon + name + per-subtree mode
 *  chips + optional eject) + its tree. */
const Scope = memo(function Scope({
  root,
  store,
  handlers,
  onEject,
  renderRowAccessory,
}: {
  root: ExplorerRoot;
  store: TreeStore;
  handlers: NodeHandlers;
  onEject?: (root: ExplorerRoot) => Promise<void>;
  renderRowAccessory?: (ctx: RowCtx) => ReactNode;
}) {
  const writable = isWritableMount(root);
  const mountId = root.id;
  // Eject (detach) — spaces / granted subtrees only, never the worktree or a
  // settings store (SPACES_UI_SPEC §3, R-SPACES-3). Closes the space for this
  // session; membership/grant are untouched and it re-adds via the powerbox.
  const canEject = isEjectable(root) && !!onEject;
  const [ejecting, setEjecting] = useState(false);
  const doEject = useCallback(async () => {
    if (!onEject || ejecting) return;
    setEjecting(true);
    try {
      await onEject(root);
    } catch {
      setEjecting(false);
    }
  }, [onEject, ejecting, root]);
  const label = mountLabel(root);
  const scopes = mountScopes(root);
  const TypeIcon = MOUNT_ICON[mountKind(root)];
  return (
    <div className="mount">
      <div className="scope">
        <div className="scope__head">
          <TypeIcon className="scope__icon" size={13} aria-hidden="true" />
          <span className="scope__name">{label}</span>
        </div>
        <div className="scope__chips">
          {scopes.map((s) => {
            const sro = s.mode === "ro";
            return (
              <span key={s.subtree} className="scope__chip">
                {sro && <Lock size={11} aria-hidden="true" />}
                {s.subtree} · {sro ? "read-only" : "read-write"}
              </span>
            );
          })}
        </div>
        {canEject && (
          <button
            type="button"
            className="scope__eject"
            onClick={doEject}
            disabled={ejecting}
            aria-label={`Eject ${label}`}
            title={`Eject ${label} (closes it here; your access is unchanged)`}
          >
            {ejecting ? (
              <Loader2 size={13} className="tnode__spin" aria-hidden="true" />
            ) : (
              <CircleArrowUp size={13} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      <ul role="tree" aria-label={label} className="tree">
        <TreeNode
          key={root.path}
          path={root.path}
          name={label}
          isDir
          depth={0}
          rootPath={root.path}
          mountId={mountId}
          writable={writable}
          store={store}
          handlers={handlers}
          renderRowAccessory={renderRowAccessory}
        />
      </ul>
    </div>
  );
});

function FileExplorerView({
  roots,
  fs,
  actions,
  activePath = null,
  viewedPath = null,
  reveal = null,
  selectionMode = "single",
  onSelect,
  onSelectionChange,
  onActivate,
  onNavigate,
  cwd: cwdProp,
  layout: layoutProp,
  onLayoutChange,
  storageKey,
  extraMenuItems,
  renderRowAccessory,
  header,
  emptyState,
}: FileExplorerViewProps) {
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  // Inline prompt for create / rename: a single targeted input.
  const [prompt, setPrompt] = useState<
    | { mode: "create-file" | "create-folder"; baseDir: string; rootPath: string }
    | { mode: "rename"; targetAbs: string; rootPath: string; initial: string }
    | null
  >(null);
  const [promptValue, setPromptValue] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ dir: string; rootPath: string } | null>(null);

  // The store reads through the injected fs. `fs` is stable per consumer, so the
  // store is constructed once (a changing `fs` would warrant a fresh store).
  const [store] = useState(() => new TreeStore(fs));

  const [layoutState, setLayoutState] = useLayout(storageKey);
  const layout = layoutProp ?? layoutState;
  const setLayout = useCallback(
    (next: Layout) => {
      if (onLayoutChange) onLayoutChange(next);
      if (layoutProp === undefined) setLayoutState(next);
    },
    [onLayoutChange, layoutProp, setLayoutState],
  );
  const [cwd, setCwd] = useState<string | null>(null);
  const [colPath, setColPath] = useState<string[]>([]);

  const ordered = useMemo(() => orderMounts(roots), [roots]);
  const rootByPath = useCallback(
    (p: string) => ordered.find((m) => p === m.path || p.startsWith(m.path + "/")) ?? null,
    [ordered],
  );
  // Idempotent + emit-free: safe during render so new scopes paint open.
  store.ensureRoots(ordered.map((m) => m.path));

  // Mirror the controlled active path into the store (FX-4b). Held in the store —
  // not threaded as a prop through the memoized tree — so a change re-renders only
  // the two rows whose active state flips, never the whole tree.
  useEffect(() => {
    store.setActiveFile(activePath);
  }, [store, activePath]);
  // Mirror the stage's viewed-document hint the same way (R3-268).
  useEffect(() => {
    store.setViewedFile(viewedPath);
  }, [store, viewedPath]);

  // Gesture-gated reveal: one-shot per nonce. Expand the ancestors, then scroll
  // the row into view once it renders (children load lazily on expand, so poll
  // briefly and give up quietly). scrollIntoView only — focus NEVER moves.
  const panelElRef = useRef<HTMLElement | null>(null);
  const lastRevealNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!reveal) return;
    if (lastRevealNonceRef.current === reveal.nonce) return;
    lastRevealNonceRef.current = reveal.nonce;
    store.revealPath(reveal.path);
    let tries = 0;
    const timer = setInterval(() => {
      const el = panelElRef.current?.querySelector(".tnode--viewed");
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        clearInterval(timer);
      } else if (++tries > 16) {
        clearInterval(timer); // rows never appeared (path not in this tree) — stay put
      }
    }, 150);
    return () => clearInterval(timer);
  }, [reveal, store]);

  // Reveal the EDITOR's active file (FX-4b). Distinct from the stage hint above in
  // both trust and intent: `activeFile` rides the elevated `editor-context` push
  // from the host, and it only ever changes because a user opened that file (or
  // because the initial route seeded the editor) — so following it is not the
  // untrusted, activation-free highlight the R3-268 contract governs. Without this
  // the very first thing an edit-mode session shows is an entrypoint deep under a
  // COLLAPSED folder, with nothing in the tree saying which file that is.
  // Expand-only (a folder the user closed is never re-opened) + `scrollIntoView`;
  // focus never moves. Children load lazily on expand, so poll briefly for the row
  // and give up quietly when the path isn't in this tree.
  // `rootKey` is in the deps because the two inputs RACE: the editor's active file
  // routinely lands before the mounts do, and `revealPath` can only expand under
  // roots the store already knows — a reveal against an empty root set is silently
  // inert, and `activePath` alone would never fire again to retry it.
  const rootKey = useMemo(() => ordered.map((m) => m.path).join("\u0000"), [ordered]);
  useEffect(() => {
    if (!activePath) return;
    store.revealPath(activePath);
    let tries = 0;
    const timer = setInterval(() => {
      const el = panelElRef.current?.querySelector(".tnode--active");
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        clearInterval(timer);
      } else if (++tries > 16) {
        clearInterval(timer); // rows never appeared (path not in this tree) — stay put
      }
    }, 150);
    return () => clearInterval(timer);
  }, [activePath, rootKey, store]);

  // The multi-select SET, subscribed via the store's STABLE snapshot (identity
  // changes only on a real mutation — see `getSelection`), so this doesn't tear.
  // On each change, report the mount-relative paths of the set to a batch consumer
  // via `onSelectionChange`, resolving the owning root (single-panel consumers keep
  // the set within one root). Runs only under `selectionMode === "multi"`.
  const selectionSet = useSyncExternalStore(store.subscribe, store.getSelection);
  const prevSelectionRef = useRef(selectionSet);
  useEffect(() => {
    // Skip the mount-time run (no change yet) so we don't emit a spurious empty set.
    const changed = prevSelectionRef.current !== selectionSet;
    prevSelectionRef.current = selectionSet;
    if (!changed) return;
    if (selectionMode !== "multi" || !onSelectionChange) return;
    const root = selectionSet.length ? rootByPath(selectionSet[0]) : null;
    const owner = root ?? ordered[0] ?? null;
    if (!owner) return;
    onSelectionChange(
      owner,
      selectionSet.map((abs) => toMountRel(owner.path, abs)),
    );
  }, [selectionSet, selectionMode, onSelectionChange, rootByPath, ordered]);

  // Keep the flat-layout cursors valid as roots come and go — derive, don't store.
  // When `cwd` is controlled (prop `!== undefined`) it WINS over internal state; a
  // navigation only fires `onNavigate` (below) and the consumer feeds the new cwd
  // back. When uncontrolled, the internal state drives it (today's behavior). Either
  // way the value is validated against the live roots so a stale path can't linger.
  const controlledCwd = cwdProp !== undefined;
  const sourceCwd = controlledCwd ? cwdProp : cwd;
  const effCwd =
    sourceCwd && ordered.some((m) => sourceCwd === m.path || sourceCwd.startsWith(m.path + "/"))
      ? sourceCwd
      : null;
  const effColPath =
    colPath.length && ordered.some((m) => m.path === colPath[0]) ? colPath : [];

  // Navigate the flat (list/icons) layout's browsed directory, and report it to a
  // consumer via `onNavigate` (the extension point file-commander uses to track a
  // panel's current directory — the copy/move destination). A `null` cwd is the
  // synthetic roots-root (no single directory) and is not reported.
  const navigateCwd = useCallback(
    (path: string | null) => {
      // Controlled: don't touch internal state — just report; the consumer updates
      // its own `cwd` and passes it back. Uncontrolled: set internal + report (today).
      if (!controlledCwd) setCwd(path);
      if (path) {
        const root = rootByPath(path);
        if (root) onNavigate?.(root, toMountRel(root.path, path));
      }
    },
    [rootByPath, onNavigate, controlledCwd],
  );
  // The Miller-columns analog: the focused column is the deepest path segment.
  const navigateCols = useCallback(
    (path: string[]) => {
      setColPath(path);
      const last = path[path.length - 1];
      if (last) {
        const root = rootByPath(last);
        if (root) onNavigate?.(root, toMountRel(root.path, last));
      }
    },
    [rootByPath, onNavigate],
  );

  // Switching layout seeds the new view from the current selection so the selected
  // file stays in view (acceptance: selection survives a switch).
  const chooseLayout = useCallback(
    (next: Layout) => {
      if (next !== layout) {
        const sel = store.getSelected();
        if (next === "list" || next === "icons") {
          setCwd(sel ? dirOf(sel) : ordered.length === 1 ? ordered[0].path : null);
        } else if (next === "columns") {
          const mount = sel
            ? ordered.find((m) => sel === m.path || sel.startsWith(m.path + "/"))
            : ordered.length === 1
              ? ordered[0]
              : undefined;
          if (!mount) setColPath([]);
          else {
            const path = [mount.path];
            const segs = toMountRel(mount.path, sel ? dirOf(sel) : mount.path).split("/").filter(Boolean);
            let acc = mount.path;
            for (const s of segs) {
              acc = joinPath(acc, s);
              path.push(acc);
            }
            setColPath(path);
          }
        }
      }
      setLayout(next);
    },
    [layout, ordered, store, setLayout],
  );

  const runWrite = useCallback(
    async (op: () => Promise<void>) => {
      setError(null);
      try {
        await op();
        store.refresh();
      } catch (e) {
        const code = (e as { code?: string })?.code ?? "unknown";
        setError(WRITE_ERR[code] ?? "Couldn’t complete that change.");
      }
    },
    [store],
  );

  // --- stable node handlers (so the memoized tree doesn't re-render) ---
  // Open is dispatched where the owning root is known (onActivate / the menu); it
  // calls onActivate then actions.open with the mount-relative path.
  const dispatchOpen = useCallback(
    (root: ExplorerRoot, mountRel: string) => {
      setError(null);
      onActivate?.(root, mountRel, false);
      if (!actions?.open) return;
      try {
        actions.open(root, mountRel);
      } catch {
        setError("Couldn’t open that file.");
      }
    },
    [actions, onActivate],
  );

  const handleActivate = useCallback(
    (absPath: string, isDir: boolean) => {
      const root = rootByPath(absPath);
      if (isDir) {
        store.toggle(absPath);
        if (root) onActivate?.(root, toMountRel(root.path, absPath), true);
      } else {
        if (selectionMode !== "none") store.select(absPath);
        if (!root) return; // a row always belongs to a rendered root
        const rel = toMountRel(root.path, absPath);
        onSelect?.(root, rel);
        dispatchOpen(root, rel);
      }
    },
    [store, rootByPath, onActivate, onSelect, dispatchOpen, selectionMode],
  );

  const onMoveDrop = useCallback(
    (fromAbs: string, fromRoot: string, targetDir: string, targetRoot: string) => {
      if (!actions?.rename) return;
      const reason = moveRejection(fromAbs, targetDir, fromRoot, targetRoot);
      if (reason) {
        if (reason === "cross-mount") setError(WRITE_ERR["cross-mount"]);
        return; // same-dir / into-self: silent no-op
      }
      const root = rootByPath(targetDir);
      if (!root) return;
      const from = toMountRel(fromRoot, fromAbs);
      const to = toMountRel(targetRoot, joinPath(targetDir, basename(fromAbs)));
      void runWrite(() => actions.rename!(root, from, to));
    },
    [actions, runWrite, rootByPath],
  );

  const onUploadDrop = useCallback(
    (files: File[], targetDirAbs: string, writable: boolean) => {
      if (!actions?.upload || !writable || !files.length) return;
      const root = rootByPath(targetDirAbs);
      if (!root) return;
      void runWrite(() => actions.upload!(root, toMountRel(root.path, targetDirAbs), files));
    },
    [actions, runWrite, rootByPath],
  );

  const beginDragOut = useCallback(
    (absPath: string, isDir: boolean) => {
      if (!actions?.beginDragOut) return;
      const root = rootByPath(absPath);
      if (!root) return;
      actions.beginDragOut(root, toMountRel(root.path, absPath), isDir);
    },
    [actions, rootByPath],
  );

  const cancelDragOut = useCallback(() => {
    actions?.cancelDragOut?.();
  }, [actions]);

  const onDelete = useCallback(
    (absPath: string, isDir: boolean, rootPath: string) => {
      if (!actions?.delete) return;
      const root = rootByPath(absPath);
      if (!root) return;
      const mountRel = toMountRel(rootPath, absPath);
      if (!window.confirm(`Delete ${isDir ? "folder" : "file"} ${mountRel}?`)) return;
      void runWrite(() => actions.delete!(root, mountRel));
    },
    [actions, runWrite, rootByPath],
  );

  // --- context menu construction (gated items only) ---
  const openMenu = useCallback(
    (e: { clientX: number; clientY: number }, ctx: RowCtx) => {
      const items: MenuItem[] = [];
      const root = rootByPath(ctx.absPath);
      const mountRel = toMountRel(ctx.rootPath, ctx.absPath);
      if (!ctx.isDir && actions?.open && root) {
        items.push({ key: "open", label: "Open", icon: <ExternalLink size={14} />, onSelect: () => dispatchOpen(root, mountRel) });
      }
      if (ctx.writable) {
        const baseDir = ctx.isDir ? ctx.absPath : dirOf(ctx.absPath);
        if (actions?.createFile) {
          items.push({
            key: "new-file",
            label: "New file here",
            icon: <FilePlus size={14} />,
            onSelect: () => {
              setPrompt({ mode: "create-file", baseDir, rootPath: ctx.rootPath });
              setPromptValue("");
            },
          });
        }
        if (actions?.createFolder) {
          items.push({
            key: "new-folder",
            label: "New folder here",
            icon: <FolderPlus size={14} />,
            onSelect: () => {
              setPrompt({ mode: "create-folder", baseDir, rootPath: ctx.rootPath });
              setPromptValue("");
            },
          });
        }
        if (actions?.upload) {
          items.push({
            key: "upload",
            label: "Upload here…",
            icon: <Upload size={14} />,
            onSelect: () => {
              uploadTargetRef.current = { dir: toMountRel(ctx.rootPath, baseDir), rootPath: ctx.rootPath };
              uploadInputRef.current?.click();
            },
          });
        }
        if (!isProtected(mountRel) && ctx.absPath !== ctx.rootPath) {
          if (actions?.rename) {
            items.push({
              key: "rename",
              label: "Rename…",
              icon: <Pencil size={14} />,
              onSelect: () => {
                setPrompt({ mode: "rename", targetAbs: ctx.absPath, rootPath: ctx.rootPath, initial: basename(ctx.absPath) });
                setPromptValue(basename(ctx.absPath));
              },
            });
          }
          if (actions?.delete) {
            items.push({
              key: "delete",
              label: "Delete",
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => onDelete(ctx.absPath, ctx.isDir, ctx.rootPath),
            });
          }
        }
      }
      // Consumer extension slot (e.g. the SDK adapter's "Summarize…").
      if (extraMenuItems) items.push(...extraMenuItems(ctx));
      if (!items.length) return;
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [actions, rootByPath, dispatchOpen, onDelete, extraMenuItems],
  );

  const handlers: NodeHandlers = useMemo(
    () => ({
      onActivate: handleActivate,
      onMenu: openMenu,
      onMoveDrop,
      onUploadDrop,
      beginDragOut: (absPath, isDir) => beginDragOut(absPath, isDir),
      cancelDragOut,
      onDelete: actions?.delete ? onDelete : (undefined as unknown as NodeHandlers["onDelete"]),
    }),
    [handleActivate, openMenu, onMoveDrop, onUploadDrop, beginDragOut, cancelDragOut, onDelete, actions],
  );

  const submitPrompt = () => {
    const p = prompt;
    setPrompt(null);
    if (!p) return;
    const value = promptValue.trim().replace(/^\/+/, "");
    setPromptValue("");
    if (!value) return;
    const root = rootByPath(p.rootPath === "" ? "" : p.rootPath) ?? ordered.find((m) => m.path === p.rootPath) ?? null;
    if (!root) return;
    if (p.mode === "rename") {
      if (!actions?.rename) return;
      const from = toMountRel(p.rootPath, p.targetAbs);
      const to = joinPath(dirOf(from), basename(value));
      void runWrite(() => actions.rename!(root, from, to));
    } else {
      const rel = joinPath(toMountRel(p.rootPath, p.baseDir), value);
      if (p.mode === "create-file") {
        if (!actions?.createFile) return;
        void runWrite(() => actions.createFile!(root, rel));
      } else {
        if (!actions?.createFolder) return;
        void runWrite(() => actions.createFolder!(root, rel));
      }
    }
  };

  const onUploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!files.length || !target || !actions?.upload) return;
    // The owning root was captured at menu time (target.rootPath).
    const root = rootByPath(target.rootPath);
    if (!root) return;
    void runWrite(() => actions.upload!(root, target.dir, files));
  };

  const hasRoots = ordered.length > 0;
  const title = header?.title ?? "Files";
  const glyph = header?.glyph ?? <FolderTree size={15} aria-hidden="true" />;

  return (
    <section className="panel fx-root" aria-label={title} ref={panelElRef}>
      <header className="panel__head">
        <span className="panel__glyph">{glyph}</span>
        <span className="panel__title">{title}</span>
        {/* The view's OWN affordances (layout, collapse) act on roots, so they stay
            gated on having some. A caller-supplied action may be the very thing that
            PRODUCES roots (R3-238's "show all filesystems" reveal), so the cluster
            renders for it even when the list is empty — a control that disappears
            exactly when it is needed is a trap. */}
        {(hasRoots || header?.actions) && (
          // `--extra` marks a header carrying consumer-supplied controls on top of
          // the view's own. The stylesheet uses it to keep the view switcher compact
          // until the panel is genuinely wide (R3-239): the switcher's text labels
          // are the header's largest single consumer, and a container query cannot
          // see how many siblings it is competing with.
          <div className={"panel__actions" + (header?.actions ? " panel__actions--extra" : "")}>
            {hasRoots && (
              <>
                <LayoutSwitcher value={layout} onChange={chooseLayout} />
                {layout === "tree" && (
                  <button
                    type="button"
                    className="panel__action"
                    title="Collapse all folders"
                    aria-label="Collapse all folders"
                    onClick={() => store.collapseAll()}
                  >
                    <ChevronsDownUp size={15} aria-hidden="true" />
                  </button>
                )}
              </>
            )}
            {header?.actions}
          </div>
        )}
      </header>

      {/* The overflow row. Controls whose COUNT is data-driven live here rather than in
          the header cluster above: three "settings · <app>" pills in a 354px panel each
          shrank to 17px — narrower than the 14px icon they contain, which then spilled
          out over its neighbour and off the panel edge. R3-239 made ONE such control
          shrink-and-truncate gracefully; N of them is a different problem, and the fix
          for it is a row of their own. Children never shrink; the strip scrolls. */}
      {header?.tray && <div className="panel__tray">{header.tray}</div>}

      {error && (
        <div className="panel__error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {prompt && (
        <div className="panel__create">
          <input
            className="panel__create-input"
            autoFocus
            spellCheck={false}
            placeholder={prompt.mode === "rename" ? "new name" : prompt.mode === "create-folder" ? "folder/path" : "path/name.ext"}
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPrompt();
              else if (e.key === "Escape") {
                setPrompt(null);
                setPromptValue("");
              }
            }}
            onBlur={submitPrompt}
          />
        </div>
      )}

      <input ref={uploadInputRef} type="file" multiple hidden onChange={onUploadInput} aria-hidden="true" tabIndex={-1} />

      <div className="panel__body">
        {!hasRoots ? (
          emptyState ?? (
            <div className="state">
              <span className="state__icon">
                <FolderTree size={20} aria-hidden="true" />
              </span>
              <h4>No files to show yet.</h4>
              <p>Open a project or add a space and its files appear here.</p>
            </div>
          )
        ) : layout === "list" ? (
          <ListView store={store} ordered={ordered} cwd={effCwd} setCwd={navigateCwd} activeFile={activePath} selectionMode={selectionMode} handlers={handlers} />
        ) : layout === "icons" ? (
          <IconGrid store={store} ordered={ordered} cwd={effCwd} setCwd={navigateCwd} activeFile={activePath} viewedFile={viewedPath} handlers={handlers} />
        ) : layout === "columns" ? (
          <ColumnView store={store} ordered={ordered} colPath={effColPath} setColPath={navigateCols} activeFile={activePath} viewedFile={viewedPath} handlers={handlers} />
        ) : (
          ordered.map((m) => (
            <Scope
              key={m.path}
              root={m}
              store={store}
              handlers={handlers}
              onEject={actions?.eject}
              renderRowAccessory={renderRowAccessory}
            />
          ))
        )}
      </div>

      {menu && <ContextMenu anchor={menu} onClose={() => setMenu(null)} />}
    </section>
  );
}

export default FileExplorerView;
