// The file explorer (UI_AS_APPS_SPEC §4 / §3.5; migrate-sidebars Phase 03). A
// tree view of the EDITOR SESSION's working tree — the repo you're editing —
// surfaced to this app as a scoped `/mnt/{hash}` mount (`type: 'worktree'`, §3.5).
// Clicking a file asks the host to open it in the editor (`openInEditor`, the §4
// `editor:open` intent — the editor stays host-owned, §2).
//
// Read-only for now: no create / rename / delete / upload (working-tree mutation
// is a separate kernel-gated host action, migrate-sidebars Phase 04). With no
// editor session (e.g. signed-out, or no working tree), it shows an empty state.
//
// Known v1 gap: a system app keeps its OWN route (drivesHostRoute=false), so it
// can't read the host editor's ACTIVE file from routing — there is no
// active-file highlight / auto-reveal yet. Surfacing the active file to a panel is
// a small additive editor-context channel (a later phase).
import { useEffect, useState } from "react";
import { useMounts, openInEditor, type SandboxMount } from "@immediately-run/sdk";
import {
  FolderTree,
  Folder,
  FolderOpen,
  File as FileIcon,
  Loader2,
  ChevronsDownUp,
} from "lucide-react";
import { readdir, type DirEntry } from "../fs/mountFs";

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

// The working-tree fs can lag its mount descriptor at boot: `useMounts()` surfaces
// the worktree as soon as the host announces it, but the sandbox-local ZenFS mount
// it points at may not be attached the instant the root folder first reads. A
// single failure used to latch a permanent "Couldn't read this folder"; instead we
// retry a bounded number of times before giving up, so the common boot race heals
// itself. ~READ_MAX_ATTEMPTS × READ_RETRY_MS ≈ a few seconds of patience.
const READ_MAX_ATTEMPTS = 12;
const READ_RETRY_MS = 250;

/** A lazily-loaded tree node following the ARIA tree pattern. File rows are
 *  buttons that open the file in the host editor; directory rows expand/collapse. */
function TreeNode({
  path,
  name,
  isDir,
  depth,
  rootPath,
  collapseEpoch,
  defaultOpen = false,
  onOpenFile,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  /** The mount root, so a file's repo-relative path can be derived for opening. */
  rootPath: string;
  /** Bumping this collapses every node (the header's "collapse all"). */
  collapseEpoch: number;
  defaultOpen?: boolean;
  onOpenFile: (repoRelativePath: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [errored, setErrored] = useState(false);
  // Bumped to re-trigger the read effect when a read fails transiently (the
  // boot-time fs race). Counts toward READ_MAX_ATTEMPTS before we give up.
  const [attempt, setAttempt] = useState(0);
  // Loading is DERIVED (not effect-set state): a dir that's open with nothing
  // loaded yet and no error is loading (including while we retry).
  const loading = isDir && open && entries === null && !errored;

  // A "collapse all" closes every node; re-opening a folder re-reads it.
  useEffect(() => {
    if (!defaultOpen) setOpen(false);
  }, [collapseEpoch, defaultOpen]);

  useEffect(() => {
    if (!isDir || !open || entries !== null || errored) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    readdir(path)
      .then((list) => live && setEntries(list))
      .catch(() => {
        if (!live) return;
        // Transient at boot (fs not yet attached at the mount path) — retry a
        // bounded number of times before surfacing the error, so a too-early
        // first read doesn't strand the folder permanently.
        if (attempt < READ_MAX_ATTEMPTS) {
          timer = setTimeout(() => live && setAttempt((a) => a + 1), READ_RETRY_MS);
        } else {
          setErrored(true);
        }
      });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [isDir, open, entries, errored, path, attempt]);

  const openFile = () => {
    // Repo-relative path = the mount-rooted path minus the `/mnt/{hash}` prefix
    // (openInEditor accepts a leading slash). NOT the sandbox `/mnt/...` path.
    onOpenFile(path.slice(rootPath.length) || "/" + name);
  };
  const activate = () => (isDir ? setOpen((v) => !v) : openFile());
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
              collapseEpoch={collapseEpoch}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileExplorer() {
  const mounts = useMounts();
  const [collapseEpoch, setCollapseEpoch] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);

  // The working tree (the repo being edited) is published to this panel as a
  // `type: 'worktree'` mount (§3.5). Prefer it; there is at most one.
  const worktree: SandboxMount | undefined = mounts.find((m) => m.type === "worktree");

  const onOpenFile = (repoRelativePath: string) => {
    setOpenError(null);
    void openInEditor(repoRelativePath).catch((e) => {
      const code = (e as { code?: string })?.code;
      // `forbidden` shouldn't happen for the correctly-bound panel; `not-found`
      // is a benign race (file deleted under us). Surface only the unexpected.
      if (code && code !== "not-found") setOpenError("Couldn’t open that file.");
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
          <button
            type="button"
            className="panel__action"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            onClick={() => setCollapseEpoch((e) => e + 1)}
          >
            <ChevronsDownUp size={15} aria-hidden="true" />
          </button>
        )}
      </header>

      {openError && (
        <div className="panel__error" role="alert" onClick={() => setOpenError(null)}>
          {openError}
        </div>
      )}

      <div className="panel__body">
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
              collapseEpoch={collapseEpoch}
              defaultOpen
              onOpenFile={onOpenFile}
            />
          </ul>
        )}
      </div>
    </section>
  );
}

export default FileExplorer;
