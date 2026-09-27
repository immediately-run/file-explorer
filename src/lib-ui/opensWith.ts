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
//   • **No marker-chosen task name appears in this file.** A contract-form offer is
//     labelled by the marker's own `kind` and invoked with the marker's own `task`;
//     which contracts this app may invoke arrives as data
//     ({@link OpensWithPolicy.offerable}), mirroring the `invokes` declaration the host
//     enforces anyway (UI_AS_APPS_SPEC §5.8), so a future contract works by declaring
//     it, with no change here. The one name this file does hold is
//     {@link APP_FORM_CONTRACT}: not a marker's choice but the protocol's fixed door for
//     every app-form marker, and the one contract a marker may never name itself.
//   • **The caller never names an app.** A contract-form marker names a CONTRACT and
//     the host's binding table decides which app opens it (REPO_CONTENT_DISPATCH_SPEC
//     §4). An app-form marker (`opensWith.app`, BUNDLE_EMBEDDING §4b.1) does name an
//     app, and this file still never reads it: that form is invoked through the one
//     fixed contract {@link APP_FORM_CONTRACT} with the directory alone, and the HOST
//     reads the marker, resolves the opener and offers it before anything runs
//     (§4b.2 rule 2). So there is still nothing app-shaped to parse, or to pass on.

/**
 * The contract an APP-form marker is opened through (BUNDLE_EMBEDDING §4b.2 rule 2).
 * The one task name in this file, and deliberately so: it is not a marker's choice
 * but the protocol's single door for every app-declared bundle, whatever app it names.
 * A task-form marker naming it offers nothing (the host refuses the cycle).
 */
export const APP_FORM_CONTRACT = "open-declared";

/** The marker file a directory carries to declare what opens it. */
export const CONTENT_MARKER_FILE = "immediately.run.json";

/** What a marker declares, once validated. */
export interface OpensWithMarker {
  /** The task CONTRACT to invoke: the marker's own `task`, or {@link APP_FORM_CONTRACT}
   *  for an app-form marker. */
  task: string;
  /** The CONTRACT version: the one the author wrote for the task form (`"1.0"` when
   *  omitted), and always `"1.0"` for the app form — whose own `version` is a bundle
   *  format the host checks against the opener, not a contract version. */
  version: string;
  /** What the directory IS, in the author's words — the label's only source. */
  kind?: string;
}

/** An offer the file manager may render for a directory. */
export interface OpensWithOffer {
  task: string;
  version: string;
  /** The menu label, derived from the marker's `kind` (or a declared view's `name`). */
  label: string;
  /** R3-789 (BUNDLE_EMBEDDING §4b.1a) — the NAME of a view the marker declares, passed to
   *  `open-declared` as `view`. The view's app is never read here: the host resolves it. */
  view?: string;
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
/** §4b.1a: at most this many declared views per marker; names are plain text ≤ 40 chars. */
const MAX_VIEWS = 8;
const VIEW_NAME_MAX = 40;
// Control characters and bidi overrides — a label must read as what it is.
const isUnsafeLabelChar = (c: number): boolean =>
  c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
const hasUnsafeLabelChar = (s: string): boolean => [...s].some((ch) => isUnsafeLabelChar(ch.codePointAt(0) ?? 0));
const unsafeSubtree = (s: unknown): boolean =>
  typeof s !== "string" ||
  !s.startsWith("/") ||
  s.includes("\0") ||
  s.includes("\\") ||
  s.split("/").slice(1).some((seg, i, all) => seg === "." || seg === ".." || (seg === "" && i < all.length - 1));

/**
 * R3-789 (§4b.1a) — one offer per VIEW the marker declares, each invoking `open-declared`
 * with `view: <name>`. Mirrors the host's view refusals (`parseContentMarker`): app form only,
 * revision-less, no `entry`, a bundle-absolute traversal-free `subtree`, a plain name, no
 * duplicates, at most eight — a view the host would refuse is not offered (a dead click).
 * The view's app is validated but never returned: the host resolves it.
 */
export function viewOffers(text: string | null | undefined, policy: OpensWithPolicy): OpensWithOffer[] {
  if (!policy.offerable.includes(APP_FORM_CONTRACT) || policy.unavailable?.has(APP_FORM_CONTRACT)) return [];
  if (typeof text !== "string" || text.trim() === "") return [];
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return [];
  }
  const views = obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as { views?: unknown }).views : undefined;
  if (!Array.isArray(views)) return [];
  const out: OpensWithOffer[] = [];
  const seen = new Set<string>();
  for (const v of views) {
    if (out.length >= MAX_VIEWS) break;
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const e = v as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (name === "" || name.length > VIEW_NAME_MAX || hasUnsafeLabelChar(name) || seen.has(name)) continue;
    const ow = e.opensWith as Record<string, unknown> | undefined;
    if (!ow || typeof ow !== "object" || Array.isArray(ow) || "task" in ow || ow.entry !== undefined) continue;
    const app = ow.app;
    if (typeof app !== "string" || app === "" || app.includes("@") || app.includes("#")) continue;
    if (unsafeSubtree(e.subtree)) continue;
    seen.add(name);
    out.push({ task: APP_FORM_CONTRACT, version: "1.0", label: `Open as ${name}`, view: name });
  }
  return out;
}

export function openWithLabel(kind: string | undefined): string {
  const trimmed = typeof kind === "string" ? kind.trim() : "";
  return KIND_RE.test(trimmed) ? `Open as ${trimmed.toLowerCase()}` : "Open with its app";
}

/**
 * Parse a marker file's TEXT into a validated marker, or null.
 *
 * Never throws: unreadable bytes, invalid JSON, a non-object, a marker with neither
 * (or both) of `opensWith.task` / `opensWith.app` all mean "no marker" — the same
 * outcome as a folder that carries none at all. An app-form marker comes back as
 * {@link APP_FORM_CONTRACT}; the app it names is never returned.
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
  const app = (opensWith as { app?: unknown }).app;
  const kind = (obj as { kind?: unknown }).kind;
  const kindPart = typeof kind === "string" && kind.trim() !== "" ? { kind: kind.trim() } : {};
  // The app form is offered only where the HOST would accept it (site-main
  // `parseContentMarker`, §4b.1), with the host's own untrimmed emptiness test. A marker
  // it refuses reaches `no-target` at invoke, which does not withdraw the shared
  // open-declared affordance — so offering one would be a dead click on every visit.
  const hostHasTask = typeof task === "string" && task !== "";
  const hostHasApp = typeof app === "string" && app !== "";
  if (hostHasTask && hostHasApp) return null; // ambiguous-opens
  if (hostHasApp) {
    if ((opensWith as { entry?: unknown }).entry !== undefined) return null; // entry-in-app
    // revision-in-app: a ref (`@…`) or a commit pin (`#…`) — the reader chooses the commit.
    if ((app as string).includes("@") || (app as string).includes("#")) return null;
    if (!(typeof kind === "string" && kind !== "")) return null; // missing-kind
    // Opened through the fixed contract at its own v1. The marker's `version` is the
    // BUNDLE format the opener must cover (§4b.1) — the host checks it against the
    // opener's `opens` range, so it is not a contract version and not ours.
    return { task: APP_FORM_CONTRACT, version: "1.0", ...kindPart };
  }
  const hasTask = typeof task === "string" && task.trim() !== "";
  if (!hasTask) return null;
  // A task-form marker naming the app-form door would re-enter the contract that read
  // it; the host refuses that as a cycle (`openDeclaredRefusal`), so it offers nothing.
  if ((task as string).trim() === APP_FORM_CONTRACT) return null;
  const version = (opensWith as { version?: unknown }).version;
  return {
    task: (task as string).trim(),
    // An omitted version means the contract's v1 shape. The host still enforces the
    // T31 compatibility check against the BOUND app at invoke time, so defaulting
    // here widens nothing.
    version: typeof version === "string" && version.trim() !== "" ? version.trim() : "1.0",
    ...kindPart,
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

/** What the app may currently LAUNCH into the stage (R3-159). Data, like
 *  {@link OpensWithPolicy} — `launchable` mirrors the `launches` manifest block. */
export interface OpensInPlacePolicy {
  /** The task contracts this app declares it launches (its `launches` manifest). */
  launchable: readonly string[];
}

/**
 * The into-stage twin of an open-with offer (R3-159): run the folder's project
 * TO-RUN in the stage region, replacing the focal app, rather than opening it
 * for-result. Offered only for a contract this app declares it LAUNCHES — one it
 * may merely invoke gets the for-result affordance alone, and a folder with no
 * offer gets nothing (an absent affordance, never an error).
 *
 * The label is FIXED, never derived from the marker's `kind`: the verb is the
 * product's ("open in place"), and the less untrusted text reaches a menu the
 * better.
 *
 * Unlike the for-result offer there is NO session withdrawal here: the host
 * resolves `unsupported` — the only launch code that could be a contract verdict —
 * for transient states too (the launch host not yet mounted, an absent launch
 * context, a create failing before bind), so no `LaunchErrorCode` is a safe
 * session-permanent verdict and a refusal simply leaves the affordance standing.
 */
export function opensInPlaceOffer(
  offer: OpensWithOffer | null,
  policy: OpensInPlacePolicy,
): OpensWithOffer | null {
  if (!offer) return null;
  if (!policy.launchable.includes(offer.task)) return null;
  return { task: offer.task, version: offer.version, label: "Open in place" };
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
