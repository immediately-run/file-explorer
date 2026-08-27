// R3-267 — the SDK half of the `opensWith` caller: what this app may offer, how it
// finds a folder's marker, and how it invokes the contract that marker names.
//
// The DECISION is in `../opensWith` (pure, host-free). This file is the wiring: the
// declared contract list, the probe that reads a directory's marker, and the invoke.
import { invokeTask, capDir } from "@immediately-run/sdk";
import { CONTENT_MARKER_FILE, opensWithOffer, withdrawsOffer } from "../opensWith";
import type { OpensWithOffer } from "../opensWith";
import { grantedModeAt, joinPath, toMountRel } from "../explorer";
import type { ExplorerRoot, FsSource } from "../types";

/**
 * The task contracts this app declares it invokes.
 *
 * **This list MUST mirror `immediately.run.invokes` in package.json**, and
 * `openWith.test.ts` fails if it drifts — the host enforces that declaration at invoke
 * time (§5.8 least authority), so a contract missing from the manifest would be offered
 * and then refused, and one missing from here would be silently unofferable.
 *
 * It is DATA, deliberately: no code in this feature names a contract. Supporting a new
 * one is this line plus the manifest, and the marker's own `kind` supplies the label.
 */
export const DECLARED_TASKS = ["open-wiki", "open-project"] as const;

/** Read a directory's marker text, or null when it carries none / is unreadable. */
export async function readMarker(fs: FsSource, dirAbsPath: string): Promise<string | null> {
  if (!fs.readFile) return null;
  try {
    const bytes = await fs.readFile(joinPath(dirAbsPath, CONTENT_MARKER_FILE));
    // A marker is a small JSON file. Anything huge is not one, and decoding it would
    // be work done on behalf of whoever wrote the folder.
    if (bytes.byteLength > MAX_MARKER_BYTES) return null;
    return new TextDecoder().decode(bytes);
  } catch {
    // ENOENT is the overwhelmingly common answer — most folders are just folders.
    return null;
  }
}

/** A marker is a handful of keys; 64 KiB is already absurd for one. */
export const MAX_MARKER_BYTES = 64 * 1024;

/** Probe one directory: its offer under `policy`, or null for no affordance. */
export async function probeOffer(
  fs: FsSource,
  dirAbsPath: string,
  policy: { offerable: readonly string[]; unavailable?: ReadonlySet<string> },
): Promise<OpensWithOffer | null> {
  return opensWithOffer(await readMarker(fs, dirAbsPath), policy);
}

/** What an invoke did, so the caller can withdraw a structurally dead contract. */
export type OpenWithOutcome =
  | { status: "opened" }
  /** The user closed the viewer, or the attempt failed once — keep offering. */
  | { status: "declined" }
  /** Nothing is bound to this contract (or we may not call it) — stop offering it. */
  | { status: "withdraw"; task: string };

/**
 * Invoke the contract a folder's marker names, delegating THAT folder and nothing else.
 *
 * The delegation is a `capDir` at the folder, at the mount's own granted mode — dispatch
 * changes the packaging, not the authority, so a viewer opened on an `rw` mount can edit
 * what it renders and one opened on `ro` cannot (R3-266). The host resolves the cap
 * against this app's OWN grants and mints an attenuated chroot, so this can only ever
 * hand over a directory the explorer already holds.
 *
 * Never throws and never surfaces a protocol code: `cancelled` is the ordinary way a
 * viewer closes, and a contract-level refusal comes back as `withdraw` so the affordance
 * removes itself rather than offering a second dead click.
 */
export async function openWith(
  root: ExplorerRoot,
  dirAbsPath: string,
  offer: OpensWithOffer,
): Promise<OpenWithOutcome> {
  const relPath = toMountRel(root.path, dirAbsPath);
  try {
    await invokeTask(offer.task, {
      dir: capDir({ mountId: root.id, relPath }, { mode: grantedModeAt(root, relPath) }),
    });
    return { status: "opened" };
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    return withdrawsOffer(code) ? { status: "withdraw", task: offer.task } : { status: "declined" };
  }
}
