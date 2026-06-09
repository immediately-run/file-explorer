// The file explorer (UI_AS_APPS_SPEC §4 / §3.5; migrate-sidebars Phase 03+04). A
// tree view of the EDITOR SESSION's working tree — the repo you're editing —
// surfaced to this app as a scoped `/mnt/{hash}` mount (`type: 'worktree'`, §3.5).
// Clicking a file opens it in the editor (`openInEditor`, the §4 `editor:open`
// intent). Creating / deleting / uploading files go through the §4 `editor:write`
// gated host actions: the app NAMES a path and the HOST performs the COW write (and
// refreshes the preview) — the COW/journal stays in the kernel (§2/§4), the app
// holds no write port.
//
// Known v1 gap: a system app keeps its OWN route (drivesHostRoute=false), so it
// can't read the host editor's ACTIVE file — no active-file highlight/auto-reveal.
import { useEffect, useState } from "react";
import {
  useMounts,
  openInEditor,
  createFile,
  createFolder,
  deleteEntry,
  uploadFile,
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
} from "lucide-react";
import { readdir, type DirEntry } from "../fs/mountFs";

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

// Files the host refuses to delete — hide the affordance to match (the host also
// enforces it, returning `protected`).
const PROTECTED = new Set(["/package.json"]);

const MAX_UPLOAD_BYTES = 512 * 1024; // soft client cap; the host enforces the real one

/** A lazily-loaded tree node; re-reads its children when `refreshEpoch` bumps. */
function TreeNode({
  path,
  name,
  isDir,
  depth,
  rootPath,
  refreshEpoch,
  collapseEpoch,
  defaultOpen = false,
  onOpenFile,
  onDelete,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  rootPath: string;
  /** Bumped after a mutation → re-read open nodes. */
  refreshEpoch: number;
  /** Bumped by "collapse all". */
  collapseEpoch: number;
  defaultOpen?: boolean;
  onOpenFile: (repoRelativePath: string) => void;
  onDelete: (repoRelativePath: string, isDir: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [errored, setErrored] = useState(false);
  const loading = isDir && open && entries === null && !errored;

  useEffect(() => {
    if (!defaultOpen) setOpen(false);
  }, [collapseEpoch, defaultOpen]);

  // Read children when open, and RE-read on every refreshEpoch bump (so a create/
  // delete/upload elsewhere shows up without losing expansion state).
  useEffect(() => {
    if (!isDir || !open) return;
    let live = true;
    setErrored(false);
    readdir(path)
      .then((list) => live && setEntries(list))
      .catch(() => live && setErrored(true));
    return () => {
      live = false;
    };
  }, [isDir, open, path, refreshEpoch]);

  const repoRel = () => path.slice(rootPath.length) || "/" + name;
  const activate = () => (isDir ? setOpen((v) => !v) : onOpenFile(repoRel()));
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    } else if (isDir && e.key === "ArrowRight" && !open) {
      setOpen(true);
    } else if (isDir && e.key === "ArrowLeft" && open) {
      setOpen(false);
    }
  };

  const Icon = isDir ? (open ? FolderOpen : Folder) : FileIcon;
  const deletable = !PROTECTED.has(repoRel());

  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-label={name}>
      <div
        className="tnode"
        style={{ paddingLeft: 8 + depth * 14 }}
        tabIndex={0}
        onClick={activate}
        onKeyDown={onKeyDown}
        data-dir={isDir ? "1" : "0"}
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
              onDelete(repoRel(), isDir);
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
          {entries?.map((e) => (
            <TreeNode
              key={e.name}
              path={joinPath(path, e.name)}
              name={e.name}
              isDir={e.isDir}
              depth={depth + 1}
              rootPath={rootPath}
              refreshEpoch={refreshEpoch}
              collapseEpoch={collapseEpoch}
              onOpenFile={onOpenFile}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Map a host write outcome code to a friendly message.
const WRITE_ERR: Record<string, string> = {
  exists: "Something with that name already exists.",
  protected: "That file can’t be deleted.",
  "too-large": "That file is too large to upload.",
  "not-found": "That file no longer exists.",
  forbidden: "You don’t have permission to change files here.",
  "invalid-params": "That name isn’t valid.",
};

function FileExplorer() {
  const mounts = useMounts();
  const [collapseEpoch, setCollapseEpoch] = useState(0);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<null | "file" | "folder">(null);
  const [createName, setCreateName] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const worktree: SandboxMount | undefined = mounts.find((m) => m.type === "worktree");
  const refresh = () => setRefreshEpoch((e) => e + 1);

  const runWrite = async (op: () => Promise<void>) => {
    setError(null);
    try {
      await op();
      refresh();
    } catch (e) {
      const code = (e as { code?: string })?.code ?? "unknown";
      setError(WRITE_ERR[code] ?? "Couldn’t complete that change.");
    }
  };

  const onOpenFile = (repoRelativePath: string) => {
    setError(null);
    void openInEditor(repoRelativePath).catch((e) => {
      if ((e as { code?: string })?.code !== "not-found") setError("Couldn’t open that file.");
    });
  };

  const onDelete = (repoRelativePath: string, isDir: boolean) => {
    if (!window.confirm(`Delete ${isDir ? "folder" : "file"} ${repoRelativePath}?`)) return;
    void runWrite(() => deleteEntry(repoRelativePath));
  };

  const submitCreate = () => {
    const name = createName.trim().replace(/^\/+/, "");
    const kind = creating;
    setCreating(null);
    setCreateName("");
    if (!name || !kind) return;
    void runWrite(() => (kind === "file" ? createFile("/" + name) : createFolder("/" + name)));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    void runWrite(async () => {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES)
          throw Object.assign(new Error("too large"), { code: "too-large" });
        const bytes = new Uint8Array(await f.arrayBuffer());
        await uploadFile("/" + f.name.split(/[\\/]/).pop()!.trim(), bytes);
      }
    });
  };

  return (
    <section className="panel" aria-label="Files">
      <header className="panel__head">
        <span className="panel__glyph">
          <FolderTree size={15} aria-hidden="true" />
        </span>
        <span className="panel__title">Files</span>
        {worktree && (
          <div className="panel__actions">
            <button
              type="button"
              className="panel__action"
              title="New file"
              aria-label="New file"
              onClick={() => {
                setCreating("file");
                setCreateName("");
              }}
            >
              <FilePlus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="panel__action"
              title="New folder"
              aria-label="New folder"
              onClick={() => {
                setCreating("folder");
                setCreateName("");
              }}
            >
              <FolderPlus size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="panel__action"
              title="Collapse all folders"
              aria-label="Collapse all folders"
              onClick={() => setCollapseEpoch((e) => e + 1)}
            >
              <ChevronsDownUp size={15} aria-hidden="true" />
            </button>
          </div>
        )}
      </header>

      {error && (
        <div className="panel__error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {creating && (
        <div className="panel__create">
          <input
            className="panel__create-input"
            autoFocus
            spellCheck={false}
            placeholder={creating === "folder" ? "folder/path" : "path/name.ext"}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCreate();
              else if (e.key === "Escape") {
                setCreating(null);
                setCreateName("");
              }
            }}
            onBlur={submitCreate}
          />
        </div>
      )}

      <div
        className="panel__body"
        data-drag={dragOver ? "1" : "0"}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        {!worktree ? (
          <div className="state">
            <span className="state__icon">
              <FolderTree size={20} aria-hidden="true" />
            </span>
            <h4>No files to show yet.</h4>
            <p>Open a project in the editor and its files appear here.</p>
          </div>
        ) : (
          <ul role="tree" aria-label="Working tree" className="tree">
            <TreeNode
              key={worktree.path}
              path={worktree.path}
              name={worktree.id ?? "Files"}
              isDir
              depth={0}
              rootPath={worktree.path}
              refreshEpoch={refreshEpoch}
              collapseEpoch={collapseEpoch}
              defaultOpen
              onOpenFile={onOpenFile}
              onDelete={onDelete}
            />
          </ul>
        )}
      </div>
    </section>
  );
}

export default FileExplorer;
