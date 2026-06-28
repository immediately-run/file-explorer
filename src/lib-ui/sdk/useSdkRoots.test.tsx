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
