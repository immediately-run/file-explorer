// The file explorer (FILE_EXPLORER_SPEC; UI_AS_APPS_SPEC §4/§3.5; migrate-sidebars
// Phase 03+04). A tree view of EVERY filesystem the host mounts into this app — the
// editor session's working tree (`type:'worktree'`) PLUS any spaces / granted
// subtrees — one scope-headed tree per mount (R3-79). Clicking a file opens it in the
// editor (`openInEditor`, the §4 `editor:open` intent). Create / rename / delete /
// upload / move go through the §4 `editor:write` gated host actions: the app NAMES a
// path and the HOST performs the COW write — the COW/journal stays in the host
// (§2/§4), the app holds no write port. Those affordances appear only on a WRITABLE
// mount (v1: the worktree); other mounts are read-only (per-mount write is the §3.5
// open item) and never surface `EROFS` as UX.
//
// Gestures over those shipped actions:
//  - Context menu (R3-80): right-click, or a 3s long-press on touch.
//  - Move (R3-81): drag a row onto a directory in the SAME mount → `renameEntry`.
//  - Upload (R3-82): drop OS files onto a directory → `uploadFile` into that dir.
//  - Drag-out (R3-83): dragging a row also asks the host to begin a cross-app drag
//    (`startItemDrag`) so the user can drop it into the previewed app; if the drop
//    instead lands inside the explorer it is an internal move and the drag-out is
//    cancelled.
//
// Tree state (expansion, the lazily-read child cache, the selected path) lives in a
// single multi-root path-keyed `TreeStore` (`treeStore.ts`), so it survives re-renders
// and mount re-announcements. `TreeNode` is `React.memo`'d with stable callbacks, so a
// parent re-render doesn't cascade into the whole tree (FX-1). FX-4b: the file open in
// the neighboring editor is highlighted (`.tnode--active`) via `useEditorContext().activeFile`.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useMounts,
  useEditorContext,
  openInEditor,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  uploadFile,
  listSettingsApps,
  openSettingsOf,
  startItemDrag,
  cancelItemDrag,
  type SandboxMount,
} from "@immediately-run/sdk";
import {
  FolderTree,
  Folder,
  FolderOpen,
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
  Sparkles,
} from "lucide-react";
import { TreeStore, useNode, useActive } from "./treeStore";
import ContextMenu, { type MenuAnchor, type MenuItem } from "./ContextMenu";
import SummaryModal, { type SummaryTarget } from "./SummaryModal";
import LayoutSwitcher from "./LayoutSwitcher";
import ListView from "./ListView";
import IconGrid from "./IconGrid";
import ColumnView from "./ColumnView";
import { useLongPress } from "../hooks/useLongPress";
import { useLayout, type Layout } from "../hooks/useLayout";
import { type NodeHandlers, type RowCtx } from "../hooks/useRowInteractions";
import { readFile } from "../fs/mountFs";
import {
  joinPath,
  basename,
  dirOf,
  toMountRel,
  mountLabel,
  subtreeLabel,
  isWritableMount,
  isProtected,
  orderMounts,
  moveRejection,
  MOVE_MIME,
  MAX_UPLOAD_BYTES,
  WRITE_ERR,
} from "../lib/explorer";

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
  // an editor-context activeFile change re-renders only the affected rows (FX-4b).
  const activeMatch = useActive(store, repoRel);
  const active = !isDir && activeMatch;
  const deletable = writable && !isProtected(repoRel);
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
  const onDragEnd = () => cancelItemDrag();

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
    cancelItemDrag(); // the drop landed inside the explorer → not a drag-out
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
            />
          ))}
        </ul>
      )}
    </li>
  );
});

/** A single mounted filesystem: scope header (name + subtree·mode chip) + its tree. */
const Scope = memo(function Scope({
  mount,
  store,
  handlers,
}: {
  mount: SandboxMount;
  store: TreeStore;
  handlers: NodeHandlers;
}) {
  const writable = isWritableMount(mount);
  const mountId = mount.id ?? mount.path;
  // v1: the explorer can write only the worktree, so "read-only" reflects what it
  // can actually do here (never a misleading "read-write" it can't honor).
  const ro = !writable;
  return (
    <div className="mount">
      <div className="scope">
        <span className="scope__name">{mountLabel(mount)}</span>
        <span className="scope__chip">
          {ro && <Lock size={11} aria-hidden="true" />}
          {subtreeLabel(mount)} · {ro ? "read-only" : "read-write"}
        </span>
      </div>
      <ul role="tree" aria-label={mountLabel(mount)} className="tree">
        <TreeNode
          key={mount.path}
          path={mount.path}
          name={mountLabel(mount)}
          isDir
          depth={0}
          rootPath={mount.path}
          mountId={mountId}
          writable={writable}
          store={store}
          handlers={handlers}
        />
      </ul>
    </div>
  );
});

function FileExplorer() {
  const mounts = useMounts();
  const { activeFile } = useEditorContext();
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [summary, setSummary] = useState<SummaryTarget | null>(null);
  // Inline prompt for create / rename: a single targeted input.
  const [prompt, setPrompt] = useState<
    | { mode: "create-file" | "create-folder"; baseDir: string; rootPath: string }
    | { mode: "rename"; targetAbs: string; rootPath: string; initial: string }
    | null
  >(null);
  const [promptValue, setPromptValue] = useState("");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ dir: string } | null>(null);

  const [store] = useState(() => new TreeStore());

  // R3-84 alternative layouts. `layout` is the persisted view choice; `cwd` is the
  // browsed directory for the flat list/icon layouts (null = the Mounts root) and
  // `colPath` is the Miller-column focus path. Selection + active-file stay shared
  // via the store + editor context, so switching layout keeps both.
  const [layout, setLayout] = useLayout();
  const [cwd, setCwd] = useState<string | null>(null);
  const [colPath, setColPath] = useState<string[]>([]);

  const ordered = useMemo(() => orderMounts(mounts), [mounts]);
  // Idempotent + emit-free: safe during render so new scopes paint open.
  store.ensureRoots(ordered.map((m) => m.path));

  // Mirror the editor's active file into the store (FX-4b). Held in the store —
  // not threaded as a prop through the memoized tree — so a change re-renders only
  // the two rows whose active state flips, never the whole tree.
  useEffect(() => {
    store.setActiveFile(activeFile);
  }, [store, activeFile]);

  // Keep the flat-layout cursors valid as mounts come and go — derive, don't store:
  // a cwd/colPath that no longer resolves to a live mount reads as the Mounts root
  // until the user navigates again (no setState-in-effect cascade).
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

  // The "file commander": every app that has per-user settings (elevated
  // `settings:all`). Empty for a fork/preview that lacks the capability — the call
  // rejects `forbidden` and we simply show no settings section. Each opened app's
  // settings mount is surfaced as its own tree root below.
  const [settingsApps, setSettingsApps] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void listSettingsApps()
      .then((apps) => live && setSettingsApps(apps))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // Opened settings mounts flow through `ordered` (and `ensureRoots` above), so
  // they render as their own Scope; this slice is only used to hide a "click to
  // open" row for an app whose settings are already mounted.
  const settingsMounts = mounts.filter((m) => m.id?.startsWith("settings:"));
  const openAppSettings = useCallback((appKey: string) => {
    void openSettingsOf(appKey).catch(() => undefined);
  }, []);

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
  const onOpenFile = useCallback((mountRel: string) => {
    setError(null);
    void openInEditor(mountRel).catch((e) => {
      if ((e as { code?: string })?.code !== "not-found") setError("Couldn’t open that file.");
    });
  }, []);

  const onActivate = useCallback(
    (absPath: string, isDir: boolean) => {
      if (isDir) {
        store.toggle(absPath);
      } else {
        store.select(absPath);
        // mount-rel path is computed against the owning root; recover it by trimming
        // the longest root prefix among the mounted roots.
        const root = ordered.find((m) => absPath === m.path || absPath.startsWith(m.path + "/"));
        onOpenFile(root ? toMountRel(root.path, absPath) : absPath);
      }
    },
    [store, ordered, onOpenFile],
  );

  const onMoveDrop = useCallback(
    (fromAbs: string, fromRoot: string, targetDir: string, targetRoot: string) => {
      const reason = moveRejection(fromAbs, targetDir, fromRoot, targetRoot);
      if (reason) {
        if (reason === "cross-mount") setError(WRITE_ERR["cross-mount"]);
        return; // same-dir / into-self: silent no-op
      }
      const from = toMountRel(fromRoot, fromAbs);
      const to = toMountRel(targetRoot, joinPath(targetDir, basename(fromAbs)));
      void runWrite(() => renameEntry(from, to));
    },
    [runWrite],
  );

  const doUpload = useCallback(
    (files: File[], targetDirRel: string) => {
      void runWrite(async () => {
        for (const f of files) {
          if (f.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error("too large"), { code: "too-large" });
          const bytes = new Uint8Array(await f.arrayBuffer());
          await uploadFile(joinPath(targetDirRel, basename(f.name)), bytes);
        }
      });
    },
    [runWrite],
  );

  const onUploadDrop = useCallback(
    (files: File[], targetDirAbs: string, writable: boolean) => {
      if (!writable || !files.length) return;
      const root = ordered.find((m) => targetDirAbs === m.path || targetDirAbs.startsWith(m.path + "/"));
      if (!root) return;
      doUpload(files, toMountRel(root.path, targetDirAbs));
    },
    [ordered, doUpload],
  );

  const beginDragOut = useCallback(
    (absPath: string, isDir: boolean, mountId: string, rootPath: string) => {
      // Inform the host a cross-app drag started (R3-83). Reference-only for dirs/
      // large files; inline bytes for a small file (best-effort — the source can
      // only ever relay bytes it can already read). `forbidden` (non-first-party) is
      // swallowed: internal move still works.
      void (async () => {
        const item = {
          kind: (isDir ? "dir" : "file") as "dir" | "file",
          name: basename(absPath),
          mountId,
          relPath: toMountRel(rootPath, absPath),
        } as Parameters<typeof startItemDrag>[0];
        if (!isDir) {
          try {
            const bytes = await readFile(absPath);
            if (bytes.byteLength <= MAX_UPLOAD_BYTES) item.bytes = bytes;
          } catch {
            /* unreadable → reference-only */
          }
        }
        try {
          await startItemDrag(item);
        } catch {
          /* no dnd:source / no host → drag-out unavailable, internal move unaffected */
        }
      })();
    },
    [],
  );

  const onDelete = useCallback(
    (absPath: string, isDir: boolean, rootPath: string) => {
      const mountRel = toMountRel(rootPath, absPath);
      if (!window.confirm(`Delete ${isDir ? "folder" : "file"} ${mountRel}?`)) return;
      void runWrite(() => deleteEntry(mountRel));
    },
    [runWrite],
  );

  // --- context menu construction (gated items only) ---
  const openMenu = useCallback(
    (e: { clientX: number; clientY: number }, ctx: RowCtx) => {
      const items: MenuItem[] = [];
      const mountRel = toMountRel(ctx.rootPath, ctx.absPath);
      if (!ctx.isDir) {
        items.push({ key: "open", label: "Open", icon: <ExternalLink size={14} />, onSelect: () => onOpenFile(mountRel) });
        items.push({
          key: "summarize",
          label: "Summarize…",
          icon: <Sparkles size={14} />,
          onSelect: () =>
            setSummary({
              absPath: ctx.absPath,
              rootPath: ctx.rootPath,
              name: basename(ctx.absPath),
              writable: ctx.writable,
            }),
        });
      }
      if (ctx.writable) {
        const baseDir = ctx.isDir ? ctx.absPath : dirOf(ctx.absPath);
        items.push({
          key: "new-file",
          label: "New file here",
          icon: <FilePlus size={14} />,
          onSelect: () => {
            setPrompt({ mode: "create-file", baseDir, rootPath: ctx.rootPath });
            setPromptValue("");
          },
        });
        items.push({
          key: "new-folder",
          label: "New folder here",
          icon: <FolderPlus size={14} />,
          onSelect: () => {
            setPrompt({ mode: "create-folder", baseDir, rootPath: ctx.rootPath });
            setPromptValue("");
          },
        });
        items.push({
          key: "upload",
          label: "Upload here…",
          icon: <Upload size={14} />,
          onSelect: () => {
            uploadTargetRef.current = { dir: toMountRel(ctx.rootPath, baseDir) };
            uploadInputRef.current?.click();
          },
        });
        if (!isProtected(mountRel) && ctx.absPath !== ctx.rootPath) {
          items.push({
            key: "rename",
            label: "Rename…",
            icon: <Pencil size={14} />,
            onSelect: () => {
              setPrompt({ mode: "rename", targetAbs: ctx.absPath, rootPath: ctx.rootPath, initial: basename(ctx.absPath) });
              setPromptValue(basename(ctx.absPath));
            },
          });
          items.push({
            key: "delete",
            label: "Delete",
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => onDelete(ctx.absPath, ctx.isDir, ctx.rootPath),
          });
        }
      }
      if (!items.length) return;
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [onOpenFile, onDelete],
  );

  const handlers: NodeHandlers = useMemo(
    () => ({ onOpenFile, onActivate, onMenu: openMenu, onMoveDrop, onUploadDrop, beginDragOut, onDelete }),
    [onOpenFile, onActivate, openMenu, onMoveDrop, onUploadDrop, beginDragOut, onDelete],
  );

  const submitPrompt = () => {
    const p = prompt;
    setPrompt(null);
    if (!p) return;
    const value = promptValue.trim().replace(/^\/+/, "");
    setPromptValue("");
    if (!value) return;
    if (p.mode === "rename") {
      const to = joinPath(dirOf(toMountRel(p.rootPath, p.targetAbs)), basename(value));
      void runWrite(() => renameEntry(toMountRel(p.rootPath, p.targetAbs), to));
    } else {
      const rel = joinPath(toMountRel(p.rootPath, p.baseDir), value);
      void runWrite(() => (p.mode === "create-file" ? createFile(rel) : createFolder(rel)));
    }
  };

  const onUploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!files.length || !target) return;
    // dir here is mount-relative already (set at menu time).
    void runWrite(async () => {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error("too large"), { code: "too-large" });
        const bytes = new Uint8Array(await f.arrayBuffer());
        await uploadFile(joinPath(target.dir, basename(f.name)), bytes);
      }
    });
  };

  const hasMounts = ordered.length > 0;

  return (
    <section className="panel" aria-label="Files">
      <header className="panel__head">
        <span className="panel__glyph">
          <FolderTree size={15} aria-hidden="true" />
        </span>
        <span className="panel__title">Files</span>
        {hasMounts && (
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
        {!hasMounts && settingsApps.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <FolderTree size={20} aria-hidden="true" />
            </span>
            <h4>No files to show yet.</h4>
            <p>Open a project or mount a space and its files appear here.</p>
          </div>
        ) : layout === "list" ? (
          <ListView store={store} ordered={ordered} cwd={effCwd} setCwd={setCwd} activeFile={activeFile} handlers={handlers} />
        ) : layout === "icons" ? (
          <IconGrid store={store} ordered={ordered} cwd={effCwd} setCwd={setCwd} activeFile={activeFile} handlers={handlers} />
        ) : layout === "columns" ? (
          <ColumnView store={store} ordered={ordered} colPath={effColPath} setColPath={setColPath} activeFile={activeFile} handlers={handlers} />
        ) : (
          ordered.map((m) => (
            <Scope key={m.path} mount={m} store={store} handlers={handlers} />
          ))
        )}
        {/* Apps that have per-user settings but aren't mounted yet — click to open
            (`settings:all`). An already-opened settings mount renders above as its
            own Scope via `ordered`, so filter those out. Shown in every layout. */}
        {settingsApps
          .filter((ak) => !settingsMounts.some((m) => m.id === `settings:${ak}`))
          .map((ak) => (
            <button
              key={ak}
              type="button"
              className="settings-app"
              onClick={() => openAppSettings(ak)}
              title={`Open ${ak} settings`}
            >
              <FolderTree size={14} aria-hidden="true" /> settings · {ak}
            </button>
          ))}
      </div>

      {menu && <ContextMenu anchor={menu} onClose={() => setMenu(null)} />}
      {summary && <SummaryModal target={summary} onClose={() => setSummary(null)} />}
    </section>
  );
}

export default FileExplorer;
