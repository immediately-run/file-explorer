// The optimistic write flow (R-IX-3 / R-IX-4): every write renders its own
// result. A create/rename/move inserts the row the user just asked for —
// pending, at its final position — the moment it is dispatched; the write's
// RETURN settles it; only then does one narrow authority refetch (`refreshDir`)
// reconcile the changed directory. A delete removes the row immediately and
// restores it if the write fails. Failure always names its reason: in the
// visible error banner (`fail`) and through the live region (`announce`).
//
// Framework-free (R13): the view supplies the ports; tests drive these
// functions directly against a real TreeStore + fixture fs.
import { basename, dirOf, toMountRel, WRITE_ERR } from "./explorer";
import type { TreeStore } from "./treeStore";
import type { DirEntry, ExplorerActions, ExplorerRoot } from "./types";

/** What a write needs from its host: the shared store, the injected actions,
 *  the live-region announcer and the visible-failure sink. */
export interface WritePorts {
  store: TreeStore;
  actions: ExplorerActions;
  announce: (message: string) => void;
  fail: (message: string) => void;
  /** Called as the write is dispatched (clears the previous failure banner). */
  begin: () => void;
}

/** The friendly message for a thrown write error (host rejection code → text). */
export const writeError = (e: unknown): string =>
  WRITE_ERR[(e as { code?: string })?.code ?? "unknown"] ?? "Couldn’t complete that change.";

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Create a file or folder at `rel` (mount-relative) inside `baseDirAbs`
 * (absolute). Renders the pending row immediately; the action's return
 * settles it; a null return (user cancel) withdraws the row quietly.
 */
export function runCreate(
  ports: WritePorts,
  kind: "file" | "folder",
  root: ExplorerRoot,
  baseDirAbs: string,
  rel: string,
): void {
  const name = basename(rel);
  const action = kind === "file" ? ports.actions.createFile : ports.actions.createFolder;
  if (!action) return;
  const pendingEntry: DirEntry = { name, isDir: kind === "folder" };
  ports.begin();
  ports.store.insertPending(baseDirAbs, pendingEntry);
  ports.announce(`Creating ${name}…`);
  void (async () => {
    try {
      const entry = await action(root, rel);
      if (!entry) {
        // User-cancelled in the action layer: nothing happened, nothing failed.
        ports.store.removeEntry(baseDirAbs, name);
        return;
      }
      ports.store.settleEntry(baseDirAbs, name, entry);
      ports.announce(`Created ${entry.name}.`);
      ports.store.refreshDir(baseDirAbs);
    } catch (e) {
      ports.store.removeEntry(baseDirAbs, name);
      const msg = writeError(e);
      ports.fail(msg);
      ports.announce(`Couldn’t create ${name}: ${msg}`);
    }
  })();
}

/**
 * Rename or move the row at `fromAbs` (absolute) to `toRel` (mount-relative) —
 * one action for both, because a move IS a rename. The old row disappears and
 * the new one appears (pending) at its final position in the destination; a
 * failure restores the original row and names the reason.
 */
export function runRename(
  ports: WritePorts,
  root: ExplorerRoot,
  fromAbs: string,
  entry: DirEntry,
  toRel: string,
): void {
  const rename = ports.actions.rename;
  if (!rename) return;
  const fromDirAbs = dirOf(fromAbs);
  const toDirAbs = joinRel(root.path, dirOf(toRel));
  const toName = basename(toRel);
  const moving = dirOf(toRel) !== dirOf(toMountRel(root.path, fromAbs));
  ports.begin();
  ports.store.removeEntry(fromDirAbs, entry.name);
  ports.store.insertPending(toDirAbs, { name: toName, isDir: entry.isDir });
  ports.announce(
    moving
      ? `Moving ${entry.name} to ${dirOf(toRel)}…`
      : `Renaming ${entry.name} to ${toName}…`,
  );
  void (async () => {
    try {
      const settled = await rename(root, toMountRel(root.path, fromAbs), toRel);
      if (!settled) {
        ports.store.removeEntry(toDirAbs, toName);
        ports.store.insertEntry(fromDirAbs, entry);
        return;
      }
      ports.store.settleEntry(toDirAbs, toName, settled);
      ports.announce(
        moving
          ? `Moved ${entry.name} to ${dirOf(toRel)}.`
          : `Renamed ${entry.name} to ${settled.name}.`,
      );
      ports.store.refreshDir(fromDirAbs);
      if (toDirAbs !== fromDirAbs) ports.store.refreshDir(toDirAbs);
    } catch (e) {
      ports.store.removeEntry(toDirAbs, toName);
      ports.store.insertEntry(fromDirAbs, entry);
      const msg = writeError(e);
      ports.fail(msg);
      ports.announce(`Couldn’t ${moving ? "move" : "rename"} ${entry.name}: ${msg}`);
    }
  })();
}

/**
 * Delete the row `entry` from directory `dirAbs` (absolute) at mount-relative
 * `rel`. The row disappears immediately (the collection shows the change,
 * R-IX-3); the action resolves the removed path (undo fuel); a failure
 * restores the row and names the reason.
 */
export function runDelete(
  ports: WritePorts,
  root: ExplorerRoot,
  dirAbs: string,
  entry: DirEntry,
  rel: string,
): void {
  const del = ports.actions.delete;
  if (!del) return;
  ports.begin();
  ports.store.removeEntry(dirAbs, entry.name);
  ports.announce(`Deleting ${entry.name}…`);
  void (async () => {
    try {
      await del(root, rel);
      ports.announce(`Deleted ${entry.name}.`);
      ports.store.refreshDir(dirAbs);
    } catch (e) {
      ports.store.insertEntry(dirAbs, entry);
      const msg = writeError(e);
      ports.fail(msg);
      ports.announce(`Couldn’t delete ${entry.name}: ${msg}`);
    }
  })();
}

/**
 * Upload `files` into `dirRel` (mount-relative). A batch has no single entry
 * to render, so the pending signal is the announcement; the settle is the
 * narrow refetch of the target directory.
 */
export function runUpload(
  ports: WritePorts,
  root: ExplorerRoot,
  dirAbs: string,
  dirRel: string,
  files: File[],
): void {
  const upload = ports.actions.upload;
  if (!upload || !files.length) return;
  ports.begin();
  ports.announce(`Uploading ${plural(files.length, "file", "files")}…`);
  void (async () => {
    try {
      await upload(root, dirRel, files);
      ports.announce(`Uploaded ${plural(files.length, "file", "files")}.`);
      ports.store.refreshDir(dirAbs);
    } catch (e) {
      const msg = writeError(e);
      ports.fail(msg);
      ports.announce(`Couldn’t upload: ${msg}`);
    }
  })();
}

/** Absolute path of a mount-relative dir under `rootPath` ("/x" → "/root/x"). */
export const joinRel = (rootPath: string, relDir: string): string => {
  const trimmed = relDir.replace(/^\/+|\/+$/g, "");
  return trimmed ? `${rootPath.replace(/\/+$/, "")}/${trimmed}` : rootPath.replace(/\/+$/, "");
};
