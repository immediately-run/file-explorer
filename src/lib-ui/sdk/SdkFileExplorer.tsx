// `SdkFileExplorer` — the shipped file-explorer app, assembled from the headless
// library + the SDK adapter (Phase 02 §B.5). This IS the former app: it wires
// `useSdkRoots()` → roots, `sdkFsSource` → fs, `makeSdkActions()` → actions, the
// editor's active file (`useEditorContext`) → activePath, the per-app settings
// roots (`listSettingsApps`/`openSettingsOf`), and the "Summarize…" feature (an
// `extraMenuItems` contribution + the modal) into `<FileExplorerView/>`.
//
// The existing FileExplorer test suite renders THIS and keeps the same SDK mocks —
// the parity proof that the extraction is behavior-preserving.
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderTree, Eye, EyeOff, Plus, Users, BookOpen } from "lucide-react";
import {
  useEditorContext,
  listSettingsApps,
  openSettingsOf,
  requestMount,
  useMounts,
  useRegion,
} from "@immediately-run/sdk";
import { addListener } from "@immediately-run/sdk/sandboxUtils";
import FileExplorerView from "../FileExplorerView";
import LensSwitcher, { type Lens } from "../LensSwitcher";
import { useShowAllFilesystems } from "../hooks/useShowAllFilesystems";
import { isSettingsMount } from "./mounts";
import { useSdkRoots } from "./useSdkRoots";
import { useSessionRoots } from "./useSessionRoots";
import { sdkFsSource } from "./mountFs";
import { makeSdkActions } from "./actions";
import { summarizeMenuItems } from "./summarize";
import { useOpensWith } from "./useOpensWith";
import { openWith } from "./openWith";
import SummaryModal, { type SummaryTarget } from "./SummaryModal";
import type { ExplorerActions, MenuItem, RowCtx } from "../types";

// The action bundle + fs are stable for the lifetime of the app.
const actions: ExplorerActions = makeSdkActions();

// The HOST origin, recovered from the iframe's `?href=` boot param (the sandbox URL
// carries the host page it renders for). Needed to open host routes (`/spaces`) in a
// new tab — a relative URL would resolve against the sandbox origin. Null when absent
// (plain `vite dev`), in which case host-route affordances are hidden, never broken.
const getHostOrigin = (): string | null => {
  try {
    const href = new URLSearchParams(window.location.search).get("href");
    return href ? new URL(href).origin : null;
  } catch {
    return null;
  }
};

/** The full-tab space-manager, at a space (R3-269 D4: entry point only — the
 *  membership/share/create VERBS stay in space-manager, R-SPACES-7). */
const openManageSharing = (spaceId: string) => {
  const hostOrigin = getHostOrigin();
  if (!hostOrigin) return;
  window.open(
    `${hostOrigin}/spaces?space=${encodeURIComponent(spaceId)}`,
    "_blank",
    "noopener,noreferrer",
  );
};

function SdkFileExplorer() {
  // R3-238: settings stores and the affordance that opens them are advanced plumbing,
  // hidden unless the user opts in. One flag governs BOTH halves — a session that shows
  // no `settings:` roots must not still advertise `settings · <app>` buttons.
  const [showAll, setShowAll] = useShowAllFilesystems();
  const roots = useSdkRoots(showAll);
  const mounts = useMounts();
  const editorContext = useEditorContext();
  const { activeFile } = editorContext;
  // The stage's viewed-document hint (R3-268). Read defensively so this app
  // works against both SDK generations: an SDK without the field yields
  // `undefined` → no marker, never a crash.
  const viewedFile =
    (editorContext as { viewedFile?: string | null }).viewedFile ?? null;
  const [summary, setSummary] = useState<SummaryTarget | null>(null);
  // Gesture-gated reveal (R3-268 follow-up): the HOST sends a one-shot
  // `viewed-reveal` only for navigations that provably rode a real user click
  // (it samples its own transient activation — this frame cannot fake it) and
  // only to `editor:read` frames. The view expands ancestors + scrolls the row
  // into view; focus never moves. Everything else stays highlight-only.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null);
  const revealNonceRef = useRef(0);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    try {
      dispose = addListener("viewed-reveal", (m: { path?: unknown }) => {
        if (typeof m.path === "string") {
          revealNonceRef.current += 1;
          setReveal({ path: m.path, nonce: revealNonceRef.current });
        }
      });
    } catch {
      /* no host transport — a standalone dev-server render */
    }
    return () => dispose?.();
  }, []);

  // The first-party "App | Session" lens (PRINCIPALS §9 B2). `sessionAvailable` is
  // true only when the host delivered a session signal (first-party frame); a
  // URL-loaded fork gets none, so the toggle never renders and the app is App-only.
  const {
    roots: sessionRoots,
    available: sessionAvailable,
    hidden: sessionHidden,
  } = useSessionRoots(showAll);
  // PRINCIPALS §9 B4 (R3-96): as the standalone User-scope `page.commander` surface this
  // app IS the cross-app "everything you've ever opened" navigator, so it defaults to the
  // broad `mounts:registry` lens rather than the app's own mounts. In the workbench
  // `panel.files` projection it defaults to App as before. (A fork never holds
  // `mounts:registry`, so `sessionAvailable` is false there and it stays App-only anyway.)
  const isCommander = useRegion() === "page.commander";
  const [lens, setLens] = useState<Lens>(isCommander ? "session" : "app");
  // Fall back to App if the session signal goes away (mounts revoked / not first-party).
  const effectiveLens: Lens = sessionAvailable ? lens : "app";
  const shownRoots = effectiveLens === "session" ? sessionRoots : roots;

  // The "file commander": every app that has per-user settings (elevated
  // `settings:all`). Empty for a fork/preview lacking the capability. Each opened
  // app's settings mount flows in as its own root via `useSdkRoots()`; this slice
  // only drives a "click to open" affordance for apps not yet mounted.
  const [settingsApps, setSettingsApps] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void listSettingsApps()
      .then((apps) => live && setSettingsApps(apps))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const openAppSettings = useCallback((appKey: string) => {
    void openSettingsOf(appKey).catch(() => undefined);
  }, []);

  // R3-269 D5: "Add a space…" asks the HOST powerbox to enumerate + grant
  // (R-SPACES-2: the explorer never lists spaces or mints mounts itself). The granted
  // mount then flows in through `useMounts()` like any other. `cancelled` is a normal
  // outcome, not an error.
  const addSpace = useCallback(() => {
    void requestMount().catch(() => undefined);
  }, []);

  // R3-267: the `opensWith` caller. The wrapped fs probes each listed directory for
  // its content marker, so a folder that declares what opens it can be offered one.
  const { fs: opensWithFs, offerFor, withdraw } = useOpensWith(sdkFsSource);
  const rootByPath = useCallback(
    (absPath: string) => shownRoots.find((r) => absPath === r.path || absPath.startsWith(`${r.path}/`)) ?? null,
    [shownRoots],
  );
  const runOpenWith = useCallback(
    (absPath: string) => {
      const root = rootByPath(absPath);
      const offer = offerFor(absPath);
      if (!root || !offer) return;
      // Fire-and-forget: the host draws the viewer. Every refusal is handled inside
      // `openWith` — `cancelled` is the ordinary close, and a contract-level refusal
      // withdraws the affordance rather than putting a protocol code on screen.
      void openWith(root, absPath, offer).then((outcome) => {
        if (outcome.status === "withdraw") withdraw(outcome.task);
      });
    },
    [rootByPath, offerFor, withdraw],
  );

  const extraMenuItems = useCallback((ctx: RowCtx): MenuItem[] => {
    const items = summarizeMenuItems(ctx, setSummary);
    // The affordance is on the ITEM, offered by the marker's own `kind` — no task name
    // reaches this code, so a folder declaring a later contract works with no change
    // here (only a manifest entry, which the host enforces anyway).
    const offer = ctx.isDir ? offerFor(ctx.absPath) : null;
    if (offer) {
      items.unshift({
        key: "open-with",
        label: offer.label,
        icon: <BookOpen size={14} aria-hidden="true" />,
        onSelect: () => runOpenWith(ctx.absPath),
      });
    }
    // R3-269 D4: the per-space "Manage sharing →" entry point, on the space's ROOT row
    // only. Opens the full-tab space-manager AT that space — the verbs live there.
    const spaceId = ctx.mountId.startsWith("space:")
      ? ctx.mountId.slice("space:".length)
      : null;
    if (getHostOrigin() && spaceId && ctx.absPath === ctx.rootPath) {
      items.push({
        key: "manage-sharing",
        label: "Manage sharing →",
        icon: <Users size={14} aria-hidden="true" />,
        onSelect: () => openManageSharing(spaceId),
      });
    }
    return items;
  }, [offerFor, runOpenWith]);

  // Apps with per-user settings that aren't mounted yet — click to open
  // (`settings:all`). An already-opened settings mount renders as its own root
  // (via `useSdkRoots`), so filter those out. Surfaced in the header (the view is
  // settings-app-agnostic per Phase 02 §A.1).
  const unmountedSettingsApps = settingsApps.filter(
    (ak) => !mounts.some((m) => m.id === `settings:${ak}`),
  );
  const settingsButtons =
    showAll && unmountedSettingsApps.length > 0
      ? unmountedSettingsApps.map((ak) => (
          <button
            key={ak}
            type="button"
            className="settings-app"
            onClick={() => openAppSettings(ak)}
            title={`Open ${ak} settings`}
          >
            <FolderTree size={14} aria-hidden="true" />
            {/* The label is its own element so it can ellipsis-truncate (R3-239):
                `text-overflow` needs a block container, and a bare text node inside
                a flex button is an anonymous item that can only overflow. */}
            <span className="settings-app__label">settings · {ak}</span>
          </button>
        ))
      : null;

  // The reveal affordance is offered only when this session actually HAS something
  // hidden — otherwise every ordinary session pays for an advanced control it can
  // never use. Once the flag is on it stays offered, so the door swings both ways.
  const hasHidden =
    mounts.some(isSettingsMount) || sessionHidden > 0 || unmountedSettingsApps.length > 0;
  const showAllToggle =
    showAll || hasHidden ? (
      <button
        type="button"
        className="panel__action"
        aria-pressed={showAll}
        title={showAll ? "Hide advanced filesystems" : "Show all filesystems"}
        aria-label={showAll ? "Hide advanced filesystems" : "Show all filesystems"}
        onClick={() => setShowAll(!showAll)}
      >
        {showAll ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
      </button>
    ) : null;

  // R3-269 D5: the explorer is the add-a-space entry point — a header affordance
  // that invokes the host powerbox. Always offered (it may be the very control that
  // produces the first root).
  const addSpaceButton = (
    <button
      type="button"
      className="panel__action"
      title="Add a space…"
      aria-label="Add a space…"
      onClick={addSpace}
    >
      <Plus size={15} aria-hidden="true" />
    </button>
  );

  // The Session lens toggle leads the header actions, but only when the host
  // delivered a session signal (first-party). A fork never sees it.
  const headerActions = (
    <>
      {sessionAvailable && <LensSwitcher value={effectiveLens} onChange={setLens} />}
      {addSpaceButton}
      {showAllToggle}
    </>
  );
  // NOT in `headerActions`: there is one of these per app with settings, so the count
  // grows with the session. Sharing a fixed row out among an unbounded N is what
  // squashed them into overlapping slivers on a phone; the tray is a row of their own.
  const headerTray = settingsButtons;

  return (
    <>
      <FileExplorerView
        roots={shownRoots}
        fs={opensWithFs}
        actions={actions}
        activePath={activeFile}
        viewedPath={viewedFile}
        extraMenuItems={extraMenuItems}
        reveal={reveal}
        header={{ actions: headerActions, tray: headerTray }}
        emptyState={
          <div className="state">
            <span className="state__icon">
              <FolderTree size={20} aria-hidden="true" />
            </span>
            <h4>No files to show yet.</h4>
            {/* R3-269 D6 first-timer sentence, R-SPACES-1 vocabulary. */}
            <p>
              A space is a folder that lives in your account. You can share it with
              others and open it from any app.
            </p>
            <button type="button" className="state__action" onClick={addSpace}>
              <Plus size={14} aria-hidden="true" />
              Add a space…
            </button>
          </div>
        }
      />
      {summary && <SummaryModal target={summary} onClose={() => setSummary(null)} />}
    </>
  );
}

export default SdkFileExplorer;
