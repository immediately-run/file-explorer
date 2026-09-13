// `makeSdkActions()` — the SDK adapter's `ExplorerActions` (Phase 02 §B.3). Each
// method wraps the matching host-gated intent (`editor:open` / `editor:write`) or
// the cross-app drag-out, carrying over the EXACT path conversion and per-file
// upload cap the original `FileExplorer.tsx` used. The view passes mount-relative
// paths (it already trimmed the owning root), so these forward them straight to
// the SDK; rejections (`{ code }`) propagate to the view's `runWrite`, which maps
// them through `WRITE_ERR`.
import {
  openInEditor,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  uploadFile,
  startItemDrag,
  cancelItemDrag,
  unmountSpace,
} from "@immediately-run/sdk";
import { basename, dirOf, joinPath, joinRel, MAX_UPLOAD_BYTES } from "../explorer";
import { sdkFsSource } from "./mountFs";
import type { Entry, ExplorerActions } from "../types";

/** Build the SDK-backed action bundle for the shipped file-explorer app. */
export function makeSdkActions(): ExplorerActions {
  return {
    // R3-79/§4: open a file in the neighboring editor (`editor:open`). `not-found`
    // is swallowed (the file may have just been deleted); the call is best-effort.
    open: (_root, relPath) => {
      void openInEditor(relPath).catch(() => undefined);
    },

    // Create / rename / delete: the app NAMES a mount-relative path; the host
    // performs the COW write behind `editor:write`. Each write resolves the
    // entry it produced (the caller renders and settles the write's own
    // result — R-IX-4); rejections flow to the view's write flow. `rename`
    // derives the settled entry from the destination listing — the authority's
    // own answer, including whether the moved thing is a folder — and degrades
    // to the name it asked for if the listing can't be read.
    createFile: async (_root, relPath) => {
      await createFile(relPath);
      return { name: basename(relPath), isDir: false } satisfies Entry;
    },
    createFolder: async (_root, relPath) => {
      await createFolder(relPath);
      return { name: basename(relPath), isDir: true } satisfies Entry;
    },
    rename: async (root, fromRel, toRel, isDir) => {
      await renameEntry(fromRel, toRel);
      const name = basename(toRel);
      const parentAbs = joinRel(root.path, dirOf(toRel));
      try {
        const list = await sdkFsSource.readdir(parentAbs);
        const hit = list.find((e) => e.name === name);
        if (hit) return hit;
      } catch {
        /* unreadable listing — the narrow refetch is still the authority */
      }
      // Degraded settle: the name it asked for, and the caller's own fact
      // about the row (never a fabricated file).
      return { name, isDir: isDir ?? false } satisfies Entry;
    },
    delete: async (_root, relPath) => {
      await deleteEntry(relPath);
      return relPath;
    },

    // R3-82 upload: inline each file's bytes; a per-file soft cap throws `too-large`
    // (the host enforces the real one), mapped by WRITE_ERR.
    upload: async (_root, dirRel, files) => {
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) {
          throw Object.assign(new Error("too large"), { code: "too-large" });
        }
        const bytes = new Uint8Array(await f.arrayBuffer());
        await uploadFile(joinPath(dirRel, basename(f.name)), bytes);
      }
    },

    // R3-83 drag-out: ask the host to begin a cross-app drag. Reference-only for
    // dirs / large files; inline bytes for a small file (best-effort — the source
    // can only relay bytes it can already read). `forbidden`/no host is swallowed:
    // the internal move still works.
    beginDragOut: (root, relPath, isDir) => {
      void (async () => {
        const item = {
          kind: (isDir ? "dir" : "file") as "dir" | "file",
          name: basename(relPath),
          mountId: root.id,
          relPath,
        } as Parameters<typeof startItemDrag>[0];
        if (!isDir) {
          try {
            const abs = joinPath(root.path, relPath.replace(/^\/+/, ""));
            const bytes = await sdkFsSource.readFile!(abs);
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
    cancelDragOut: () => cancelItemDrag(),

    // R-SPACES-3 eject: detach a space for this session (`unmountSpace`). The mount
    // disappears via the `useMounts()` subscription; typed errors degrade quietly.
    eject: async (root) => {
      if (!root.spaceId) return;
      await unmountSpace({ spaceId: root.spaceId });
    },
  };
}
