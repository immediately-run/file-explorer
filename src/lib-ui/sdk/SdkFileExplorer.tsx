// `SdkFileExplorer` — the shipped file-explorer app, assembled from the headless
// library + the SDK adapter (Phase 02 §B.5). This IS the former app: it wires
// `useSdkRoots()` → roots, `sdkFsSource` → fs, `makeSdkActions()` → actions, the
// editor's active file (`useEditorContext`) → activePath, the per-app settings
// roots (`listSettingsApps`/`openSettingsOf`), and the "Summarize…" feature (an
// `extraMenuItems` contribution + the modal) into `<FileExplorerView/>`.
//
// The existing FileExplorer test suite renders THIS and keeps the same SDK mocks —
// the parity proof that the extraction is behavior-preserving.
import { useCallback, useEffect, useState } from "react";
import { FolderTree, Eye, EyeOff, Plus, Users } from "lucide-react";
import {
  useEditorContext,
  listSettingsApps,
  openSettingsOf,
  requestMount,
  useMounts,
  useRegion,
} from "@immediately-run/sdk";
import FileExplorerView from "../FileExplorerView";
import LensSwitcher, { type Lens } from "../LensSwitcher";
import { useShowAllFilesystems } from "../hooks/useShowAllFilesystems";
import { isSettingsMount } from "./mounts";
import { useSdkRoots } from "./useSdkRoots";
import { useSessionRoots } from "./useSessionRoots";
import { sdkFsSource } from "./mountFs";
import { makeSdkActions } from "./actions";
import { summarizeMenuItems } from "./summarize";
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

  const extraMenuItems = useCallback((ctx: RowCtx): MenuItem[] => {
    const items = summarizeMenuItems(ctx, setSummary);
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
  }, []);

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
      {settingsButtons}
    </>
  );

  return (
    <>
      <FileExplorerView
        roots={shownRoots}
        fs={sdkFsSource}
        actions={actions}
        activePath={activeFile}
        viewedPath={viewedFile}
        extraMenuItems={extraMenuItems}
        header={{ actions: headerActions }}
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
