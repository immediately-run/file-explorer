// Pure helpers for the file explorer — mount metadata, path math, and the
// move/upload/drag validity predicates. Framework-free and side-effect-free so
// they unit-test directly (ways_of_working §5; file-explorer CLAUDE.md: utilities
// live in src/lib/). No React, no SDK calls here.
import type { SandboxMount } from "@immediately-run/sdk";

/** Join a directory and a child name into one normalized absolute/rel path. */
export const joinPath = (dir: string, name: string): string =>
  `${dir.replace(/\/+$/, "")}/${name}`;

/** The last path segment (basename) of a slash path. */
export const basename = (p: string): string => p.split("/").filter(Boolean).pop() ?? "";

/** The parent directory of a slash path (no trailing slash; "/" for a root child). */
export const dirOf = (p: string): string => {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
};

/** A mount-absolute path made repo-/mount-relative (leading slash) for the SDK
 *  intents, which take mount-relative paths (e.g. `/src/App.tsx`). */
export const toMountRel = (rootPath: string, absPath: string): string =>
  absPath.slice(rootPath.replace(/\/+$/, "").length) || "/";

// ---------------------------------------------------------------------------
// Mount metadata (R3-79 / FILE_EXPLORER_SPEC §2)
// ---------------------------------------------------------------------------

/** Is this the editor session's working tree (the repo being edited)? */
export const isWorktree = (m: SandboxMount): boolean => m.type === "worktree";

/** A human-readable scope label: prefer the host-supplied name (R3-69), else the
 *  id, else a generic by type. Never the opaque `/mnt/{hash}` path. */
export const mountLabel = (m: SandboxMount): string => {
  if (m.name && m.name.trim()) return m.name.trim();
  if (m.id && m.id.trim()) {
    const id = m.id.trim();
    // Per-user app settings mounts (the "file commander", `settings:all`) read
    // nicer as "settings · <app>" than the raw `settings:<app>` id.
    if (id.startsWith("settings:")) return `settings · ${id.slice("settings:".length)}`;
    return id;
  }
  return isWorktree(m) ? "Working tree" : m.type === "space" ? "Space" : "Files";
};

/** The mount's access mode for the scope chip — defaults to `ro` when unknown
 *  (fail-safe: never imply write access we don't know we have). */
export const mountMode = (m: SandboxMount): "ro" | "rw" => m.mode ?? "ro";

/**
 * Whether the explorer should offer WRITE affordances (new/rename/delete/upload/
 * move) on this mount. v1: only the worktree is writable (mutation rides the
 * first-party `editor:write` host actions, which target the editor session's
 * working tree). Non-worktree mounts are read-only until per-mount write
 * (UI_AS_APPS_SPEC §3.5) lands — the affordances are HIDDEN, never shown-then-`EROFS`
 * (CLAUDE.md: never surface `EROFS` as UX).
 */
export const isWritableMount = (m: SandboxMount): boolean => isWorktree(m);

/** A short subtree label for the scope chip ("/" for a whole-mount grant). */
export const subtreeLabel = (m: SandboxMount): string => {
  const rule = m.rules?.[0];
  return rule?.subtree && rule.subtree !== "/" ? rule.subtree : "/";
};

/** Order mounts for display: worktree first, then spaces, then others, A→Z. */
export const orderMounts = (mounts: SandboxMount[]): SandboxMount[] =>
  [...mounts].sort((a, b) => {
    const rank = (m: SandboxMount) => (isWorktree(m) ? 0 : m.type === "space" ? 1 : 2);
    return rank(a) - rank(b) || mountLabel(a).localeCompare(mountLabel(b));
  });

// Files the host refuses to delete/rename — hide the affordance to match (the
// host also enforces it, returning `protected`). Shared by every layout so the
// gating is identical in tree / list / icons / columns. Mount-relative paths.
const PROTECTED = new Set(["/package.json"]);

/** Is this mount-relative path one the host protects from delete/rename? */
export const isProtected = (mountRel: string): boolean => PROTECTED.has(mountRel);

// ---------------------------------------------------------------------------
// Breadcrumb / current-directory navigation (R3-84 list + icons layouts)
// ---------------------------------------------------------------------------

export interface Crumb {
  /** Display label for the segment. */
  label: string;
  /** Absolute path the segment navigates to, or null for the "Mounts" root. */
  path: string | null;
}

/**
 * Resolve a current directory (`cwd`, absolute or null = the Mounts root) into the
 * owning mount and a breadcrumb trail. The trail always starts at "Mounts" so the
 * user can step back out to the mount list (mirroring the mobile projection in
 * brief 13). When `cwd` falls inside a mount, segments are: Mounts › <mount> ›
 * <subdir…>. When `cwd` is null (or unresolvable), only the Mounts root is shown.
 * Pure — no React, no I/O.
 */
export const breadcrumbFor = (
  cwd: string | null,
  ordered: SandboxMount[],
): { mount: SandboxMount | null; crumbs: Crumb[] } => {
  const root: Crumb = { label: "Mounts", path: null };
  if (!cwd) return { mount: null, crumbs: [root] };
  const mount = ordered.find((m) => cwd === m.path || cwd.startsWith(m.path + "/")) ?? null;
  if (!mount) return { mount: null, crumbs: [root] };

  const crumbs: Crumb[] = [root, { label: mountLabel(mount), path: mount.path }];
  const rel = toMountRel(mount.path, cwd); // e.g. "/src/components" or "/"
  const segs = rel.split("/").filter(Boolean);
  let acc = mount.path;
  for (const seg of segs) {
    acc = joinPath(acc, seg);
    crumbs.push({ label: seg, path: acc });
  }
  return { mount, crumbs };
};

// ---------------------------------------------------------------------------
// Drag-and-drop validity (R3-81 move / R3-82 upload)
// ---------------------------------------------------------------------------

/** Private MIME the explorer sets on an internal (same-app) move drag, so an
 *  internal row drag is distinguishable from an OS-file drop and a §7 drag-out. */
export const MOVE_MIME = "application/x-ir-file-move";

export interface MovePayload {
  /** Absolute source path. */
  from: string;
  /** The root path of the source mount (to forbid cross-mount moves). */
  rootPath: string;
}

/**
 * Can `from` be moved INTO directory `targetDir` (both absolute paths in the same
 * mount)? Rejects: a no-op (already in that dir), a directory dropped onto itself
 * or a descendant, and (the caller enforces) cross-mount drops. Returns the reason
 * code on rejection so the UI can hint, or `null` when the move is allowed.
 */
export const moveRejection = (
  from: string,
  targetDir: string,
  fromRoot: string,
  targetRoot: string,
): "cross-mount" | "same-dir" | "into-self" | null => {
  if (fromRoot !== targetRoot) return "cross-mount";
  if (dirOf(from) === targetDir.replace(/\/+$/, "")) return "same-dir";
  const f = from.replace(/\/+$/, "");
  const t = targetDir.replace(/\/+$/, "");
  if (t === f || t.startsWith(f + "/")) return "into-self";
  return null;
};

/** A soft client cap on inlined upload/drag bytes; the host enforces the real one. */
export const MAX_UPLOAD_BYTES = 512 * 1024;

/** Map a host write-outcome code to a friendly message (shared by every mutation). */
export const WRITE_ERR: Record<string, string> = {
  exists: "Something with that name already exists.",
  protected: "That file can’t be deleted.",
  "too-large": "That file is too large to upload.",
  "not-found": "That file no longer exists.",
  forbidden: "You don’t have permission to change files here.",
  "invalid-params": "That name isn’t valid.",
  "cross-mount": "Can’t move between filesystems yet.",
};
