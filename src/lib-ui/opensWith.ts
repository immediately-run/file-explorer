// R3-267 — the `opensWith` caller: decide whether a folder gets an "open it with the
// app it belongs to" affordance, and what that affordance says.
//
// Background. The directory-as-content pipeline shipped its callee (a bound viewer),
// its contract table (`open-project` / `open-wiki`), its binding and its host
// delegation plumbing — and no CALLER. A folder carrying
// `immediately.run.json` → `{ "opensWith": { "task": … }, "kind": … }` was read by
// nothing, so the trigger the specs describe could not fire. This module is the
// decision half of that caller. It is pure (no SDK, no React, no fs) so the rules
// below are testable without a host; the adapter under `sdk/` does the reading and
// the invoking.
//
// Three properties are deliberate, and each one is a rule the tests pin:
//
//   • **The marker is untrusted author input.** It travels with a folder anyone may
//     have written, so nothing here throws, and every field is validated before it is
//     shown or used. A marker we cannot vouch for yields NO offer — never a partial
//     one, and never an error in front of the user.
//   • **No task name appears in this file.** The affordance is offered by the marker's
//     own `kind` and invoked with the marker's own `task`; which contracts this app may
//     invoke arrives as data ({@link OpensWithPolicy.offerable}), mirroring the
//     `invokes` declaration the host enforces anyway (UI_AS_APPS_SPEC §5.8). A future
//     contract therefore works by declaring it, with no change here.
//   • **The marker names a CONTRACT, never an app.** Nothing in a marker can name,
//     become, or reach the app that opens it — the host's binding table decides that
//     (REPO_CONTENT_DISPATCH_SPEC §4). So there is nothing app-shaped to parse.

/** The marker file a directory carries to declare what opens it. */
export const CONTENT_MARKER_FILE = "immediately.run.json";

/** What a marker declares, once validated. */
export interface OpensWithMarker {
  /** The task CONTRACT that opens this directory. */
  task: string;
  /** The contract shape version the author wrote (`"1.0"` when omitted). */
  version: string;
  /** What the directory IS, in the author's words — the label's only source. */
  kind?: string;
}

/** An offer the file manager may render for a directory. */
export interface OpensWithOffer {
  task: string;
  version: string;
  /** The menu label, derived from the marker's `kind`. */
  label: string;
}

/** What the app may currently offer. Data, not code — see the header. */
export interface OpensWithPolicy {
  /** The task contracts this app declares it invokes (its `invokes` manifest). */
  offerable: readonly string[];
  /** Contracts the host has refused at invoke time this session, so the affordance
   *  withdraws itself instead of offering a second dead click. */
  unavailable?: ReadonlySet<string>;
}

// A `kind` is author-authored text that lands in UI. Keep it to a short, boring,
// single-line token: letters, digits, spaces and the two joiners a compound kind
// plausibly uses. Anything else (control characters, markup, a paragraph, a
// right-to-left override) is not sanitized into shape — it is simply not used, and
// the generic label is shown instead. Refusing is always safe here: the label is
// decoration, and the contract still opens.
const KIND_RE = /^[a-z0-9][a-z0-9 _-]{0,23}$/i;

/** The label for a marker `kind`, or the generic one when there is no usable kind. */
export function openWithLabel(kind: string | undefined): string {
  const trimmed = typeof kind === "string" ? kind.trim() : "";
  return KIND_RE.test(trimmed) ? `Open as ${trimmed.toLowerCase()}` : "Open with its app";
}

/**
 * Parse a marker file's TEXT into a validated marker, or null.
 *
 * Never throws: unreadable bytes, invalid JSON, a non-object, a missing or non-string
 * `opensWith.task` all mean "no marker" — the same outcome as a folder that carries
 * none at all.
 */
export function parseOpensWith(text: string | null | undefined): OpensWithMarker | null {
  if (typeof text !== "string" || text.trim() === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const opensWith = (obj as { opensWith?: unknown }).opensWith;
  if (!opensWith || typeof opensWith !== "object" || Array.isArray(opensWith)) return null;
  const task = (opensWith as { task?: unknown }).task;
  if (typeof task !== "string" || task.trim() === "") return null;
  const version = (opensWith as { version?: unknown }).version;
  const kind = (obj as { kind?: unknown }).kind;
  return {
    task: task.trim(),
    // An omitted version means the contract's v1 shape. The host still enforces the
    // T31 compatibility check against the BOUND app at invoke time, so defaulting
    // here widens nothing.
    version: typeof version === "string" && version.trim() !== "" ? version.trim() : "1.0",
    ...(typeof kind === "string" && kind.trim() !== "" ? { kind: kind.trim() } : {}),
  };
}

/**
 * The offer for a directory's marker text under a policy, or null for no affordance.
 *
 * Null — an absent affordance — is the outcome for every negative case, including a
 * marker naming a contract this app does not invoke: an unbound or unknown contract
 * must degrade to *nothing to click*, not to a protocol error the user has to read.
 */
export function opensWithOffer(
  text: string | null | undefined,
  policy: OpensWithPolicy,
): OpensWithOffer | null {
  const marker = parseOpensWith(text);
  if (!marker) return null;
  if (!policy.offerable.includes(marker.task)) return null;
  if (policy.unavailable?.has(marker.task)) return null;
  return { task: marker.task, version: marker.version, label: openWithLabel(marker.kind) };
}

/**
 * Should a refusal WITHDRAW the affordance for this contract for the rest of the
 * session, or was it about this one attempt?
 *
 * `cancelled` is the user closing the viewer — the most ordinary outcome there is, and
 * the affordance must survive it. A refusal that is a property of the CONTRACT (nothing
 * bound to it, this app not declared for it, the versions no longer meet) will repeat
 * identically on every click, so the honest response is to stop offering it. Anything
 * else (a transient host failure, an unknown code) leaves the offer standing.
 */
export function withdrawsOffer(code: string | undefined): boolean {
  return code === "no-such-task" || code === "not-declared" || code === "task-version-mismatch";
}
