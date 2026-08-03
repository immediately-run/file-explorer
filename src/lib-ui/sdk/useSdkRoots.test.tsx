// LIBRARY_MOUNTS_SPEC §8.3 / L5 — a git-dependency LIBRARY mount (tagged with a
// `moduleName`) is plumbing and must be EXCLUDED from the file view, while a user's
// own explicitly-mounted repo (no `moduleName`) still shows.
import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// A controllable mount set for the mocked `useMounts`.
const mounts: Array<Record<string, unknown>> = [];
vi.mock("@immediately-run/sdk", () => ({
  useMounts: () => mounts,
}));

import { useSdkRoots } from "./useSdkRoots";

describe("useSdkRoots — library-mount exclusion (§8.3)", () => {
  it("drops moduleName-tagged library mounts; keeps worktree, space, and user-mounted repos", () => {
    mounts.length = 0;
    mounts.push(
      { path: "/mnt/wt", type: "worktree", id: "wt", name: "repo" },
      { path: "/mnt/sp", type: "space", id: "space:1", name: "My space" },
      // a git-dependency library mount — EXCLUDED (has moduleName)
      { path: "/mnt/lib", type: "github", id: "github:o/r@main", name: "o/r", moduleName: "@scope/lib" },
      // a user's OWN runtime-mounted repo — KEPT (no moduleName)
      { path: "/mnt/usr", type: "github", id: "github:me/notes@main", name: "me/notes" },
    );

    const { result } = renderHook(() => useSdkRoots());
    const ids = result.current.map((r) => r.id);

    expect(ids).toEqual(["wt", "space:1", "github:me/notes@main"]);
    expect(ids).not.toContain("github:o/r@main"); // the library mount is hidden
  });

  it("hides per-app settings stores by default, and reveals them with showAll (R3-238)", () => {
    mounts.length = 0;
    mounts.push(
      { path: "/mnt/wt", type: "worktree", id: "wt", name: "repo" },
      { path: "/mnt/set", type: "settings", id: "settings:color-picker", name: "color-picker" },
      { path: "/mnt/sp", type: "space", id: "space:1", name: "My space" },
      { path: "/mnt/set2", type: "settings", id: "settings:agent-demo", name: "agent-demo" },
    );

    const hidden = renderHook(() => useSdkRoots());
    expect(hidden.result.current.map((r) => r.id)).toEqual(["wt", "space:1"]);

    // …and the flag brings them back, in the host's original mount order (this only
    // ever filters — it never reorders, so `orderMounts` downstream is unaffected).
    const shown = renderHook(() => useSdkRoots(true));
    expect(shown.result.current.map((r) => r.id)).toEqual([
      "wt",
      "settings:color-picker",
      "space:1",
      "settings:agent-demo",
    ]);
  });

  it("still drops library mounts when showAll is on (that exclusion is not user-toggleable)", () => {
    mounts.length = 0;
    mounts.push(
      { path: "/mnt/lib", type: "github", id: "github:o/r@main", name: "o/r", moduleName: "@scope/lib" },
      { path: "/mnt/set", type: "settings", id: "settings:app", name: "app" },
    );
    expect(renderHook(() => useSdkRoots(true)).result.current.map((r) => r.id)).toEqual([
      "settings:app",
    ]);
  });

  it("returns all mounts when none are library mounts", () => {
    mounts.length = 0;
    mounts.push(
      { path: "/mnt/wt", type: "worktree", id: "wt", name: "repo" },
      { path: "/mnt/sp", type: "space", id: "space:1", name: "My space" },
    );
    const { result } = renderHook(() => useSdkRoots());
    expect(result.current.map((r) => r.id)).toEqual(["wt", "space:1"]);
  });
});
