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
import { FolderTree, Eye, EyeOff } from "lucide-react";
import { useEditorContext, listSettingsApps, openSettingsOf, useMounts, useRegion } from "@immediately-run/sdk";
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

function SdkFileExplorer() {
  // R3-238: settings stores and the affordance that opens them are advanced plumbing,
  // hidden unless the user opts in. One flag governs BOTH halves — a session that shows
  // no `settings:` roots must not still advertise `settings · <app>` buttons.
  const [showAll, setShowAll] = useShowAllFilesystems();
  const roots = useSdkRoots(showAll);
  const mounts = useMounts();
  const { activeFile } = useEditorContext();
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

  const extraMenuItems = useCallback(
    (ctx: RowCtx): MenuItem[] => summarizeMenuItems(ctx, setSummary),
    [],
  );

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

  // The Session lens toggle leads the header actions, but only when the host
  // delivered a session signal (first-party). A fork never sees it.
  const headerActions =
    sessionAvailable || showAllToggle || settingsButtons ? (
      <>
        {sessionAvailable && <LensSwitcher value={effectiveLens} onChange={setLens} />}
        {showAllToggle}
        {settingsButtons}
      </>
    ) : undefined;

  return (
    <>
      <FileExplorerView
        roots={shownRoots}
        fs={sdkFsSource}
        actions={actions}
        activePath={activeFile}
        extraMenuItems={extraMenuItems}
        header={{ actions: headerActions }}
      />
      {summary && <SummaryModal target={summary} onClose={() => setSummary(null)} />}
    </>
  );
}

export default SdkFileExplorer;
