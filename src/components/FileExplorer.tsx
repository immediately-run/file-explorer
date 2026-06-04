// The read-only file explorer (UI_AS_APPS_SPEC §4 / §3.2 / §8.7; design brief 10;
// Phase 03 pilot). A tree view of a MOUNT's contents — a space or a granted
// subtree the user has shared with this app. It lists active mounts via the SDK
// (`useMounts`), shows each mount's grant scope, and reads file entries from the
// sandbox fs at the mount path. Read-only: no create / rename / delete.
//
// It explores GRANTED MOUNTS, not the host's edited repo — a sandboxed app can
// only ever see what its mounts expose (chroot per grant, §8.7). With no mount
// (e.g. signed-out), it shows how to grant one.
import { useEffect, useState } from "react";
import {
  useMounts,
  openAppSpace,
  type SandboxMount,
} from "@immediately-run/sdk/mounts";
import {
  FolderTree,
  Folder,
  FolderOpen,
  File as FileIcon,
  Lock,
  Loader2,
} from "lucide-react";
import { readdir, type DirEntry } from "../fs/mountFs";

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

/** A lazily-loaded tree node following the ARIA tree pattern. */
function TreeNode({
  path,
  name,
  isDir,
  depth,
  defaultOpen = false,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [errored, setErrored] = useState(false);
  // Loading is DERIVED (not effect-set state) so the lazy fetch needs no
  // synchronous setState in the effect: a dir that's open with nothing loaded
  // yet and no error is loading.
  const loading = isDir && open && entries === null && !errored;

  useEffect(() => {
    if (!isDir || !open || entries !== null || errored) return;
    let live = true;
    readdir(path)
      .then((list) => live && setEntries(list))
      .catch(() => live && setErrored(true));
    return () => {
      live = false;
    };
  }, [isDir, open, entries, errored, path]);

  const toggle = () => isDir && setOpen((v) => !v);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!isDir) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowRight" && !open) {
      setOpen(true);
    } else if (e.key === "ArrowLeft" && open) {
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
        onClick={toggle}
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
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** One mount: a scope header (grant boundary made legible) + its tree. */
function MountTree({ mount }: { mount: SandboxMount }) {
  const label = mount.id ?? mount.path;
  return (
    <div className="mount">
      <div className="scope" title={`${mount.path} · read-only`}>
        <span className="scope__name">{label}</span>
        <span className="scope__chip">
          <Lock size={11} aria-hidden="true" />
          {mount.path} · read-only
        </span>
      </div>
      <ul role="tree" aria-label={`Files in ${label}`} className="tree">
        <TreeNode path={mount.path} name={label} isDir depth={0} defaultOpen />
      </ul>
    </div>
  );
}

function FileExplorer() {
  const mounts = useMounts();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openWorkspace = async () => {
    setOpening(true);
    setError(null);
    try {
      await openAppSpace();
    } catch (e) {
      const msg = (e as { code?: string })?.code;
      // `auth-required` / `cancelled` are normal — the host drives that UX.
      if (msg && msg !== "auth-required" && msg !== "cancelled") {
        setError("Couldn’t open a workspace. Try again.");
      }
    } finally {
      setOpening(false);
    }
  };

  return (
    <section className="panel" aria-label="Files">
      <header className="panel__head">
        <span className="panel__glyph">
          <FolderTree size={15} aria-hidden="true" />
        </span>
        <span className="panel__title">Files</span>
      </header>

      <div className="panel__body">
        {mounts.length === 0 ? (
          <div className="state">
            <span className="state__icon">
              <FolderTree size={20} aria-hidden="true" />
            </span>
            <h4>Nothing mounted yet.</h4>
            <p>
              This explorer shows files from a space you grant it — never the
              project you’re editing. Open your workspace to get started.
            </p>
            <button
              type="button"
              className="cta"
              onClick={openWorkspace}
              disabled={opening}
            >
              {opening ? "Opening…" : "Open my workspace"}
            </button>
            {error && <p className="state__err">{error}</p>}
          </div>
        ) : (
          mounts.map((m) => <MountTree key={m.path} mount={m} />)
        )}
      </div>
    </section>
  );
}

export default FileExplorer;
