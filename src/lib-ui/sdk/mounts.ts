// Mount classification — the SDK-shape-specific helpers that read a
// `SandboxMount`'s fields (`type`, `id`, `mode`, `rules`, `name`) and the mapper
// that turns a `SandboxMount` into the library's generalized {@link ExplorerRoot}.
// These live in the SDK adapter (not the pure core) because they are coupled to
// the host's mount shape; the core view only ever sees `ExplorerRoot`.
//
// (R3-79 / FILE_EXPLORER_SPEC §2; SPACES_UI_SPEC §3, R-SPACES-3; PRINCIPALS §9 B1.)
import type { SandboxMount } from "@immediately-run/sdk";
import type { ExplorerRoot } from "../types";

/** Is this the editor session's working tree (the repo being edited)? */
export const isWorktree = (m: SandboxMount): boolean => m.type === "worktree";

/** A per-app settings store mount (`settings:<app>`) — app-local configuration,
 *  surfaced only by the elevated `settings:all` file-manager surface, never the
 *  user's own spaces. Excluded from eject (SPACES_UI_SPEC §3, R-SPACES-3). */
export const isSettingsMount = (m: SandboxMount): boolean =>
  !!m.id?.startsWith("settings:");

/** The spaceId of a space mount, for `unmountSpace`. Space mounts are announced
 *  with the universal `space:{spaceId}` id; tolerate a bare id too. Returns null
 *  for non-space mounts (worktree, settings). */
export const mountSpaceId = (m: SandboxMount): string | null => {
  if (isWorktree(m) || isSettingsMount(m)) return null;
  const id = m.id?.trim();
  if (!id) return null;
  return id.startsWith("space:") ? id.slice("space:".length) : id;
};

/**
 * Whether the explorer offers an EJECT (detach) affordance on this scope
 * (SPACES_UI_SPEC §3, R-SPACES-3). Offered for spaces / granted subtrees; NEVER
 * for the worktree (that is "close the project", a host action) or the per-app
 * `settings:` store. Eject is independent of writability.
 */
export const isEjectable = (m: SandboxMount): boolean => mountSpaceId(m) !== null;

/** A human-readable scope label: prefer the host-supplied name (R3-69), else the
 *  id, else a generic by type. Never the opaque `/mnt/{hash}` path. */
export const mountLabel = (m: SandboxMount): string => {
  if (m.name && m.name.trim()) return m.name.trim();
  if (m.id && m.id.trim()) {
    const id = m.id.trim();
    if (id.startsWith("settings:")) return `settings · ${id.slice("settings:".length)}`;
    return id;
  }
  return isWorktree(m) ? "Working tree" : m.type === "space" ? "Space" : "Files";
};

/** The mount's access mode for the scope chip — defaults to `ro` when unknown
 *  (fail-safe: never imply write access we don't know we have). */
export const mountMode = (m: SandboxMount): "ro" | "rw" => m.mode ?? "ro";

/**
 * The mount's SOURCE writability — can the user change this file in their editing
 * session at all, as opposed to "may this frame write through this particular port".
 *
 * The two are not the same and the difference is the whole point here. `m.mode` is the
 * port's authority, and for `panel.files` the host sets it to `ro` **unconditionally**
 * (`exposesWorkingTree: "ro"`): the explorer is deliberately port-less for writes, and
 * mutates through the kernel-gated `editor:write` host actions instead — which the
 * host gates on the SOURCE mode, not on our port. So `m.mode` answers a question the
 * explorer is not asking, and answers it `ro` every single time.
 *
 * Read defensively: an older host publishes no `sourceMode`, and there we fall back to
 * the port mode — the pre-existing behavior, never a widening.
 */
const sourceModeOf = (m: SandboxMount): "ro" | "rw" | undefined => {
  const v = (m as { sourceMode?: unknown }).sourceMode;
  return v === "ro" || v === "rw" ? v : undefined;
};

/**
 * Whether the explorer should offer WRITE affordances on this mount. v1: only the
 * worktree is writable (mutation rides the first-party `editor:write` host actions);
 * non-worktree mounts are read-only until per-mount write (UI_AS_APPS_SPEC §3.5)
 * lands — the affordances are HIDDEN, never shown-then-`EROFS`.
 *
 * A worktree whose SOURCE is read-only (local provider / ro space / zip) still hides
 * them: writing there would be refused by the host action, and a shown-then-refused
 * affordance is the thing #20 removed. What changed is only WHICH mode is consulted —
 * the source ceiling rather than our own clamped port — because consulting the port
 * made the answer permanently `false` and left the explorer unable to offer a write
 * the user was perfectly entitled to make (FILE_EXPLORER_SPEC §2: "the worktree is
 * writable via the first-party `editor:write` host actions").
 */
export const isWritableMount = (m: SandboxMount): boolean =>
  isWorktree(m) && (sourceModeOf(m) ?? m.mode) !== "ro";

/** A short subtree label for the single-chip layouts ("/" for a whole-mount grant). */
export const subtreeLabel = (m: SandboxMount): string => {
  const rule = m.rules?.[0];
  return rule?.subtree && rule.subtree !== "/" ? rule.subtree : "/";
};

/** The provider/type kind of a mount, for the App-scope header icon (PRINCIPALS
 *  §9 B1). A classifier only — the icon mapping lives in the view. */
export type MountKind = ExplorerRoot["kind"];
export const mountKind = (m: SandboxMount): MountKind =>
  isWorktree(m) ? "worktree" : isSettingsMount(m) ? "settings" : mountSpaceId(m) ? "space" : "other";

export interface MountScope {
  subtree: string;
  mode: "ro" | "rw";
}

/**
 * The granted scopes of a mount as display rows — one per `rules` entry. Falls
 * back to a single whole-mount row from `m.mode` when `rules` is absent. The
 * displayed mode is the EFFECTIVE mode: v1 only the worktree is writable, so every
 * non-worktree scope renders `ro` regardless of the granted rule mode (never
 * shown-then-`EROFS`). De-duped by subtree, ordered root-first then A→Z.
 */
export const mountScopes = (m: SandboxMount): MountScope[] => {
  const mode: "ro" | "rw" = isWritableMount(m) ? "rw" : "ro";
  const rules = m.rules?.length ? m.rules : [{ subtree: "/", mode }];
  const seen = new Map<string, MountScope>();
  for (const r of rules) {
    const subtree = r.subtree && r.subtree.trim() && r.subtree !== "/" ? r.subtree.trim() : "/";
    if (seen.has(subtree)) continue;
    seen.set(subtree, { subtree, mode });
  }
  return [...seen.values()].sort((a, b) =>
    a.subtree === "/" ? -1 : b.subtree === "/" ? 1 : a.subtree.localeCompare(b.subtree),
  );
};

/** Order mounts for display: worktree first, then spaces, then others, A→Z. */
export const orderMounts = (mounts: SandboxMount[]): SandboxMount[] =>
  [...mounts].sort((a, b) => {
    const rank = (m: SandboxMount) => (isWorktree(m) ? 0 : m.type === "space" ? 1 : 2);
    return rank(a) - rank(b) || mountLabel(a).localeCompare(mountLabel(b));
  });

/** Map one `SandboxMount` onto the library's generalized {@link ExplorerRoot}. The
 *  view reads only `ExplorerRoot`, so all mount-shape coupling stops here. */
export const toExplorerRoot = (m: SandboxMount): ExplorerRoot => ({
  id: m.id ?? m.path,
  path: m.path,
  label: mountLabel(m),
  kind: mountKind(m),
  writable: isWritableMount(m),
  scopes: mountScopes(m),
  ejectable: isEjectable(m),
  spaceId: mountSpaceId(m) ?? undefined,
});
