// Read a mount's directory entries from the sandbox filesystem, over the SDK's typed
// sandbox-fs accessor.
//
// The ZenFS resolution order (globalThis.__sandpackSharedFs, with the bundler-layer
// fallback) used to be hand-rolled here AND in the editor app, kept in sync by hand. It
// now lives ONCE in `@immediately-run/sdk/fs` (`sandboxFs`/`fsAvailable`,
// SDK_FS_SURFACE_SPEC). This file keeps only the file-explorer's domain helpers — a
// directories-first `readdir` and a raw `readFile` — over absolute mount paths
// (`/spaces/{id}`, `/mnt/{hash}`), so it uses the SDK's `sandboxFs` escape hatch rather
// than a single mount-anchored `openFs`.
import { sandboxFs, fsAvailable } from '@immediately-run/sdk/fs';

/** Is the sandbox fs reachable at all? (false in local dev / before boot.) Re-exported
 *  from the SDK so existing imports of `mountFs` are unchanged. */
export { fsAvailable };

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

/** List `path`'s immediate entries, directories first then files, A→Z. */
export async function readdir(path: string): Promise<DirEntry[]> {
  const fs: any = sandboxFs();
  if (!fs) throw new Error("sandbox filesystem unavailable");
  const p = fs.promises ?? fs;

  let raw: any[];
  try {
    raw = await p.readdir(path, { withFileTypes: true });
  } catch {
    raw = await p.readdir(path);
  }

  const entries: DirEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      // string[] shape — stat each to learn directory-ness.
      let isDir = false;
      try {
        const st = await p.stat(joinPath(path, item));
        isDir = typeof st?.isDirectory === "function" ? st.isDirectory() : !!st?.isDirectory;
      } catch {
        /* unreadable entry — treat as a file */
      }
      entries.push({ name: item, isDir });
    } else {
      // Dirent shape.
      const isDir =
        typeof item?.isDirectory === "function" ? item.isDirectory() : !!item?.isDirectory;
      entries.push({ name: String(item?.name ?? item), isDir });
    }
  }

  return entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
  );
}

/**
 * Read a file's raw bytes from a mount (R3-83 drag-out: the source inlines a small
 * file's content so the host can relay it to the previewed app — the source can only
 * ever hand over bytes it can already read). Throws if the sandbox fs is unavailable
 * or the read fails; callers fall back to a reference-only drag.
 */
export async function readFile(path: string): Promise<Uint8Array> {
  const fs: any = sandboxFs();
  if (!fs) throw new Error("sandbox filesystem unavailable");
  const p = fs.promises ?? fs;
  const data = await p.readFile(path);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}
