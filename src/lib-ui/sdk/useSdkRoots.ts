// `useSdkRoots()` — the SDK adapter's roots source (Phase 02 §B.2). Subscribes to
// the host's mounts via `useMounts()` and maps each `SandboxMount` onto the
// library's generalized `ExplorerRoot` (via `toExplorerRoot`), so the headless
// view never sees a host mount shape.
import { useMemo } from "react";
import { useMounts, type SandboxMount } from "@immediately-run/sdk";
import type { ExplorerRoot } from "../types";
import { toExplorerRoot, isSettingsMount } from "./mounts";

// A git-dependency LIBRARY mount carries a `moduleName` (the host tags it so the
// bundler registers it under `/node_modules/<name>/` — LIBRARY_MOUNTS_SPEC L3/§8.3).
// It is plumbing, not a user document, so it is EXCLUDED from the file view (§8.3).
// `moduleName` isn't in the SDK's `SandboxMount` type yet, so read it via a local
// widening (the field is present on the descriptor at runtime). A user's *own*
// explicitly-mounted repo (runtime `mount('github:…')`) has NO `moduleName`, so it
// still shows — the flag, not the `github` type, is the discriminator.
const isLibraryMount = (m: SandboxMount): boolean =>
  typeof (m as { moduleName?: unknown }).moduleName === "string" &&
  (m as { moduleName?: string }).moduleName !== "";

// A per-app `settings:<app>` store is app-local CONFIGURATION, not a user document —
// the same "plumbing, not a document" argument that hides library mounts above, and
// the reason SPACES_UI_SPEC §3 (R-SPACES-3) already excludes them from eject. So they
// are hidden by the same seam, but unlike library mounts they are *reachable*: the
// "show all filesystems" flag (R3-238) brings them back (see `useShowAllFilesystems`).

/** The active mounts (excluding library/module mounts, and — unless `showAll` —
 *  per-app settings stores), mapped to `ExplorerRoot[]` for
 *  `<FileExplorerView roots=…>`. Relative mount order is preserved: this only ever
 *  filters, so `orderMounts` downstream sees the same sequence it always did. */
export function useSdkRoots(showAll: boolean = false): ExplorerRoot[] {
  const mounts = useMounts();
  return useMemo(
    () =>
      mounts
        .filter((m) => !isLibraryMount(m) && (showAll || !isSettingsMount(m)))
        .map(toExplorerRoot),
    [mounts, showAll],
  );
}
