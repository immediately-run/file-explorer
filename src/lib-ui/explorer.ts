// Pure helpers for the file explorer — path math, root metadata read from the
// generalized ExplorerRoot, and the move/upload/drag validity predicates.
// Framework-free and side-effect-free so they unit-test directly (ways_of_working
// §5; file-explorer CLAUDE.md). No React, NO SDK import here — the view reads
// roots through ExplorerRoot, and the SDK adapter (`sdk/mounts.ts`) is what maps
// a SandboxMount onto that shape.
import type { ExplorerRoot } from "./types";

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
// Root metadata (R3-79 / FILE_EXPLORER_SPEC §2) — over the generalized
// ExplorerRoot. The SDK adapter populates these fields from a SandboxMount; the
// view reads them through these accessors so the layouts stay decoupled.
// ---------------------------------------------------------------------------

/** A human-readable scope label (already resolved onto the root by the adapter). */
export const mountLabel = (r: ExplorerRoot): string => r.label;

/** The provider/type kind of a root, for the App-scope header icon (PRINCIPALS
 *  §9 B1). A classifier only — the icon mapping lives in the view. */
export type MountKind = ExplorerRoot["kind"];
export const mountKind = (r: ExplorerRoot): MountKind => r.kind;

/** The spaceId of a space root, for eject (`unmountSpace`). Null for roots that
 *  aren't ejectable spaces (worktree, settings). */
export const mountSpaceId = (r: ExplorerRoot): string | null => r.spaceId ?? null;

/**
 * Whether the explorer offers an EJECT (detach) affordance on this root
 * (SPACES_UI_SPEC §3, R-SPACES-3). Eject = `unmountSpace` — closes the space for
 * this session only; it is NOT leave/revoke. Offered for spaces / granted
 * subtrees; NEVER for the worktree or the per-app `settings:` store.
 */
export const isEjectable = (r: ExplorerRoot): boolean => !!r.ejectable;

/**
 * Whether the explorer should offer WRITE affordances (new/rename/delete/upload/
 * move) on this root. The adapter computes effective writability; the view just
 * reflects it — the affordances are HIDDEN on a read-only root, never
 * shown-then-`EROFS` (CLAUDE.md: never surface `EROFS` as UX).
 */
export const isWritableMount = (r: ExplorerRoot): boolean => r.writable;

/** One display row in the App-scope header: a granted subtree and the mode shown
 *  there (PRINCIPALS §9 B1 / FILE_EXPLORER §2). */
export interface MountScope {
  subtree: string;
  mode: "ro" | "rw";
}

/**
 * The granted scopes of a root as display rows — one per scope, so a root with
 * several subtrees lists each (FILE_EXPLORER §2 step 2). Falls back to a single
 * whole-mount row from the root's effective writability when `scopes` is absent.
 * The displayed mode is the EFFECTIVE mode the adapter already baked into each
 * scope. De-duped by subtree and ordered root-first then A→Z.
 */
export const mountScopes = (r: ExplorerRoot): MountScope[] => {
  const fallbackMode: "ro" | "rw" = isWritableMount(r) ? "rw" : "ro";
  const scopes = r.scopes?.length ? r.scopes : [{ subtree: "/", mode: fallbackMode }];
  const seen = new Map<string, MountScope>();
  for (const s of scopes) {
    const subtree = s.subtree && s.subtree.trim() && s.subtree !== "/" ? s.subtree.trim() : "/";
    if (seen.has(subtree)) continue;
    seen.set(subtree, { subtree, mode: s.mode });
  }
  return [...seen.values()].sort((a, b) =>
    a.subtree === "/" ? -1 : b.subtree === "/" ? 1 : a.subtree.localeCompare(b.subtree),
  );
};

/** A short subtree label for the single-chip layouts (breadcrumb / columns) where
 *  only the current directory's owning root is shown ("/" for a whole-mount grant).
 *  The per-mount header uses {@link mountScopes} for the full list. */
export const subtreeLabel = (r: ExplorerRoot): string => {
  const first = r.scopes?.[0];
  return first?.subtree && first.subtree !== "/" ? first.subtree : "/";
};

/** Order roots for display: worktree first, then spaces, then others, A→Z. */
export const orderMounts = (roots: ExplorerRoot[]): ExplorerRoot[] =>
  [...roots].sort((a, b) => {
    const rank = (r: ExplorerRoot) =>
      r.kind === "worktree" ? 0 : r.kind === "space" ? 1 : 2;
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
  /** Absolute path the segment navigates to, or null for the "Spaces" root. */
  path: string | null;
}

/**
 * Resolve a current directory (`cwd`, absolute or null = the Spaces root) into the
 * owning root and a breadcrumb trail. The trail always starts at "Spaces" so the
 * user can step back out to the root list (mirroring the mobile projection in
 * brief 13). When `cwd` falls inside a root, segments are: Spaces > <root> >
 * <subdir...>. When `cwd` is null (or unresolvable), only the Spaces root is shown.
 * Pure — no React, no I/O.
 */
export const breadcrumbFor = (
  cwd: string | null,
  ordered: ExplorerRoot[],
): { mount: ExplorerRoot | null; crumbs: Crumb[] } => {
  const root: Crumb = { label: "Spaces", path: null };
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
  "cross-mount": "Can’t move between spaces yet.",
};
