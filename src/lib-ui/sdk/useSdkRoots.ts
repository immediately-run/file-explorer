// `useSdkRoots()` — the SDK adapter's roots source (Phase 02 §B.2). Subscribes to
// the host's mounts via `useMounts()` and maps each `SandboxMount` onto the
// library's generalized `ExplorerRoot` (via `toExplorerRoot`), so the headless
// view never sees a host mount shape.
import { useMemo } from "react";
import { useMounts } from "@immediately-run/sdk";
import type { ExplorerRoot } from "../types";
import { toExplorerRoot } from "./mounts";

/** The active mounts, mapped to `ExplorerRoot[]` for `<FileExplorerView roots=…>`. */
export function useSdkRoots(): ExplorerRoot[] {
  const mounts = useMounts();
  return useMemo(() => mounts.map(toExplorerRoot), [mounts]);
}
