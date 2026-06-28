// Read a mount's directory entries from the sandbox filesystem.
//
// Mounts (a space / a granted subtree / the working tree) are attached into the
// sandbox's own filesystem at their absolute `path` (e.g. `/spaces/{id}`,
// `/mnt/{hash}`) by ZenFS's global `mount()`. To LIST a directory we need a
// node-compatible fs (`promises.readdir`/`stat`) rooted at `/` so those absolute
// mount paths resolve.
//
// IMPORTANT: that is NOT `module.evaluation.module.bundler.fs` — despite the name
// that is the bundler's own layered `FileSystem` (memory + zenfs + node-modules
// layers) whose surface is only `readFile`/`isFile`/`writeFile`; it has no
// `readdir`/`promises`, so reading through it throws on every call. The
// node-compatible fs is the ZenFS bound context the sandbox creates at
// `globalThis.__sandpackSharedFs` (`bindContext({root:'/'})`), mirrored by the
// bundler's `zenFsLayer.boundContext.fs`. We read through its `promises` API and
// tolerate the two common `readdir` shapes (Dirent[] vs string[]).
//
// This helper only works inside the sandbox (where these globals exist); it is
// not exercised in local `vite` dev, so every access is guarded.
import type { DirEntry, FsSource } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hasReaddir = (fs: any): boolean =>
  typeof fs?.promises?.readdir === "function" || typeof fs?.readdir === "function";

function sandboxFs(): any | null {
  // 1. The sandbox publishes a '/'-rooted bound ZenFS on globalThis — the
  //    canonical node-compatible fs that sees every mount.
  try {
    const shared = (globalThis as any).__sandpackSharedFs;
    if (hasReaddir(shared)) return shared;
  } catch {
    /* not in the sandbox */
  }
  // 2. Fall back to the bundler's ZenFS layer bound context (also '/'-rooted),
  //    reached the same way the SDK reaches other bundler services.
  try {
    // @ts-expect-error - `module` is injected by the sandbox runtime (see SDK mounts.ts)
    const layers = module?.evaluation?.module?.bundler?.fs?.layers;
    if (Array.isArray(layers)) {
      for (const layer of layers) {
        const fs = layer?.boundContext?.fs;
        if (hasReaddir(fs)) return fs;
      }
    }
  } catch {
    /* not in the sandbox */
  }
  return null;
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

/**
 * Read a file's raw bytes from a mount (R3-83 drag-out: the source inlines a small
 * file's content so the host can relay it to the previewed app — the source can only
 * ever hand over bytes it can already read). Throws if the sandbox fs is unavailable
 * or the read fails; callers fall back to a reference-only drag.
 */
export async function readFile(path: string): Promise<Uint8Array> {
  const fs = sandboxFs();
  if (!fs) throw new Error("sandbox filesystem unavailable");
  const p = fs.promises ?? fs;
  const data = await p.readFile(path);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/** The default {@link FsSource}: the ZenFS sandbox accessor. The headless view
 *  reads bytes/entries through this in the shipped app (a consumer with a
 *  different filesystem supplies its own `FsSource`). */
export const sdkFsSource: FsSource = { readdir, readFile };
