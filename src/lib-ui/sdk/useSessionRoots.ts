// `useSessionRoots()` — the SDK adapter's SESSION-lens roots source (R3-95;
// PRINCIPALS_SPEC §9 B2). Subscribes to the host's first-party `useSessionMounts()`
// and maps each `SessionMount` onto the library's `ExplorerRoot`, so the headless
// view never sees a host mount shape (same contract as `useSdkRoots`).
//
// First-party only by construction: the host gates the `session-mounts` channel on
// the first-party-only `mounts:registry` capability, so a URL-loaded fork of the
// explorer receives `[]` and this returns no roots — the Session lens never appears
// (the fork-denied-session-signal invariant). We treat presence-of-data as the
// signal: `available` is true only when the host actually delivered session mounts.
import { useMemo } from "react";
import { useSessionMounts, type SessionMount } from "@immediately-run/sdk";
import type { ExplorerRoot } from "../types";
import { toExplorerRoot } from "./mounts";

/** A session mount, as an `ExplorerRoot` plus whether it is also forwarded into the
 *  app's own `useMounts()` (App lens) — the lens can mark editor/agent-only mounts. */
export interface SessionRoot extends ExplorerRoot {
  forwardedToApp: boolean;
}

export interface SessionRootsResult {
  /** The session's mounts as explorer roots (empty for a non-first-party frame). */
  roots: SessionRoot[];
  /** True iff the host delivered a session signal — i.e. this is a first-party frame
   *  with session mounts. Drives whether the "App | Session" toggle renders at all. */
  available: boolean;
}

/** The session-scope mounts mapped to `ExplorerRoot[]`, for the first-party Session
 *  lens. `available` is false for a fork/preview (no session signal), so the caller
 *  hides the lens toggle entirely. */
export function useSessionRoots(): SessionRootsResult {
  const mounts: SessionMount[] = useSessionMounts();
  return useMemo(() => {
    const roots = mounts.map((m) => ({ ...toExplorerRoot(m), forwardedToApp: m.forwardedToApp }));
    return { roots, available: roots.length > 0 };
  }, [mounts]);
}
