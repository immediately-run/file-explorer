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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  type LucideIcon,
} from "lucide-react";
import { TreeStore, useNode, useActive } from "./treeStore";
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
  selectionMode?: "single" | "multi" | "none";
  onSelect?: (root: ExplorerRoot, relPath: string) => void;
  onActivate?: (root: ExplorerRoot, relPath: string, isDir: boolean) => void;
  /** Controlled layout, or omit and pass `storageKey` for the persisted default. */
  layout?: Layout;
  onLayoutChange?: (next: Layout) => void;
  storageKey?: string;
  /** Append items to a row's context menu (e.g. "Summarize…"). */
  extraMenuItems?: (ctx: RowCtx) => MenuItem[];
  /** Render an accessory next to a row's delete button. */
  renderRowAccessory?: (ctx: RowCtx) => ReactNode;
  /** Panel header chrome. */
  header?: { title?: string; glyph?: ReactNode; actions?: ReactNode };
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
  selectionMode = "single",
  onSelect,
  onActivate,
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

  // Keep the flat-layout cursors valid as roots come and go — derive, don't store.
  const effCwd =
    cwd && ordered.some((m) => cwd === m.path || cwd.startsWith(m.path + "/")) ? cwd : null;
  const effColPath =
    colPath.length && ordered.some((m) => m.path === colPath[0]) ? colPath : [];

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
    <section className="panel fx-root" aria-label={title}>
      <header className="panel__head">
        <span className="panel__glyph">{glyph}</span>
        <span className="panel__title">{title}</span>
        {hasRoots && (
          <div className="panel__actions">
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
            {header?.actions}
          </div>
        )}
      </header>

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
          <ListView store={store} ordered={ordered} cwd={effCwd} setCwd={setCwd} activeFile={activePath} handlers={handlers} />
        ) : layout === "icons" ? (
          <IconGrid store={store} ordered={ordered} cwd={effCwd} setCwd={setCwd} activeFile={activePath} handlers={handlers} />
        ) : layout === "columns" ? (
          <ColumnView store={store} ordered={ordered} colPath={effColPath} setColPath={setColPath} activeFile={activePath} handlers={handlers} />
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
