// Resolve a current directory (`cwd`) into the rows the flat layouts (list, icons)
// render, plus the owning root (R3-84). `cwd === null` is the "Spaces" root: the
// rows are the roots themselves (each a folder you open into), so a deep grant is
// always reachable and the root list is never lost. Inside a root, the rows are
// that directory's entries, read through the SAME shared, lazily-loaded store
// cache the tree uses (`useDir`), so switching layout re-reads nothing.
import { TreeStore, useDir } from "../treeStore";
import { joinPath, mountLabel, isWritableMount } from "../explorer";
import type { ExplorerRoot, RowCtx } from "../types";

export interface BrowseRow {
  name: string;
  ctx: RowCtx;
}

export interface Browse {
  mount: ExplorerRoot | null;
  rows: BrowseRow[];
  loading: boolean;
  errored: boolean;
  empty: boolean;
  atRoot: boolean;
}

const rowForMount = (m: ExplorerRoot): BrowseRow => ({
  name: mountLabel(m),
  ctx: {
    absPath: m.path,
    isDir: true,
    rootPath: m.path,
    mountId: m.id,
    writable: isWritableMount(m),
  },
});

export function useBrowse(
  store: TreeStore,
  cwd: string | null,
  ordered: ExplorerRoot[],
): Browse {
  const atRoot = cwd === null;
  const mount = atRoot
    ? null
    : ordered.find((m) => cwd === m.path || cwd.startsWith(m.path + "/")) ?? null;

  // Hooks must run unconditionally — `useDir(null)` is a no-op that returns empty.
  const { entries, errored } = useDir(store, atRoot ? null : cwd);

  if (atRoot) {
    return {
      mount: null,
      rows: ordered.map(rowForMount),
      loading: false,
      errored: false,
      empty: ordered.length === 0,
      atRoot,
    };
  }

  const rows: BrowseRow[] =
    mount && entries
      ? entries.map((e) => ({
          name: e.name,
          ctx: {
            absPath: joinPath(cwd as string, e.name),
            isDir: e.isDir,
            rootPath: mount.path,
            mountId: mount.id,
            writable: isWritableMount(mount),
          },
        }))
      : [];

  return {
    mount,
    rows,
    loading: !!mount && entries === undefined && !errored,
    errored,
    empty: !!mount && entries?.length === 0,
    atRoot,
  };
}
