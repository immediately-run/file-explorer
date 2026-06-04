// Read a mount's directory entries from the sandbox filesystem.
//
// Mounts (a space / a granted subtree) are attached into the sandbox's own
// filesystem at their `path` (e.g. `/spaces/{id}`). App code reaches that fs the
// same way the SDK reaches the other bundler services — through the injected
// evaluation context at `module.evaluation.module.bundler.fs`. The parent-side
// file-resolver protocol only proxies `isFile`/`readFile` (for the bundler's
// lazy import resolution), so directory listing is served by the sandbox-LOCAL
// fs, which is node-compatible (ZenFS). We read through its `promises` API and
// tolerate the two common `readdir` shapes (Dirent[] vs string[]).
//
// This helper only works inside the sandbox (where `module` is injected); it is
// not exercised in local `vite` dev, so every access is guarded.

export interface DirEntry {
  name: string;
  isDir: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function sandboxFs(): any | null {
  try {
    // @ts-expect-error - `module` is injected by the sandbox runtime (see SDK mounts.ts)
    const fs = module?.evaluation?.module?.bundler?.fs;
    return fs ?? null;
  } catch {
    return null;
  }
}

const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

/** Is the sandbox fs reachable at all? (false in local dev / before boot). */
export function fsAvailable(): boolean {
  return sandboxFs() != null;
}

/** List `path`'s immediate entries, directories first then files, A→Z. */
export async function readdir(path: string): Promise<DirEntry[]> {
  const fs = sandboxFs();
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
