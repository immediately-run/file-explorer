// Mount-classification unit tests (R3-79, R3-94, R-SPACES-3). These exercise the
// SDK-shape helpers and the SandboxMount→ExplorerRoot mapper — the parity contract
// for the classification logic that used to live in `lib/explorer.ts`.
import { describe, expect, it } from "vitest";
import {
  mountLabel,
  mountMode,
  isWritableMount,
  isWorktree,
  isSettingsMount,
  isEjectable,
  mountSpaceId,
  subtreeLabel,
  mountKind,
  mountScopes,
  orderMounts,
  toExplorerRoot,
} from "./mounts";
import type { SandboxMount } from "@immediately-run/sdk";

const m = (o: Partial<SandboxMount> & { type: string; path: string }): SandboxMount => o as SandboxMount;

describe("mount metadata (R3-79)", () => {
  it("labels prefer name, then id, then a type fallback", () => {
    expect(mountLabel(m({ type: "space", path: "/s/1", name: "My space" }))).toBe("My space");
    expect(mountLabel(m({ type: "space", path: "/s/1", id: "abc" }))).toBe("abc");
    expect(mountLabel(m({ type: "worktree", path: "/mnt/x" }))).toBe("Working tree");
  });

  it("only the worktree is writable in v1 (spaces read-only until per-mount write)", () => {
    expect(isWorktree(m({ type: "worktree", path: "/mnt/x" }))).toBe(true);
    expect(isWritableMount(m({ type: "worktree", path: "/mnt/x" }))).toBe(true);
    expect(isWritableMount(m({ type: "space", path: "/s/1", mode: "rw" }))).toBe(false);
  });

  it("a READ-ONLY worktree is not writable — honor mode, never show-then-EROFS", () => {
    // `panel.files` gets the edited repo as a `ro` port (`exposesWorkingTree: "ro"`);
    // a `ro` source clamps even an `rw` binding. Delete/rename/upload must be hidden.
    expect(isWritableMount(m({ type: "worktree", path: "/mnt/x", mode: "ro" }))).toBe(false);
    expect(isWritableMount(m({ type: "worktree", path: "/mnt/x", mode: "rw" }))).toBe(true);
    // A ro worktree renders read-only scopes, not the assumed rw.
    expect(mountScopes(m({ type: "worktree", path: "/mnt/x", mode: "ro" }))).toEqual([
      { subtree: "/", mode: "ro" },
    ]);
  });

  it("eject (R-SPACES-3): spaces eject, worktree + settings never", () => {
    expect(mountSpaceId(m({ type: "firestore", path: "/mnt/a", id: "space:abc" }))).toBe("abc");
    expect(mountSpaceId(m({ type: "firestore", path: "/mnt/a", id: "abc" }))).toBe("abc");
    expect(isEjectable(m({ type: "firestore", path: "/mnt/a", id: "space:abc" }))).toBe(true);
    expect(isEjectable(m({ type: "worktree", path: "/app" }))).toBe(false);
    expect(mountSpaceId(m({ type: "worktree", path: "/app" }))).toBe(null);
    expect(isSettingsMount(m({ type: "firestore", path: "/mnt/s", id: "settings:x" }))).toBe(true);
    expect(isEjectable(m({ type: "firestore", path: "/mnt/s", id: "settings:x" }))).toBe(false);
    expect(isEjectable(m({ type: "firestore", path: "/mnt/n" }))).toBe(false);
  });

  it("mountMode defaults to ro and subtreeLabel reads the first rule", () => {
    expect(mountMode(m({ type: "space", path: "/s/1" }))).toBe("ro");
    expect(subtreeLabel(m({ type: "space", path: "/s/1", rules: [{ subtree: "/notes", mode: "ro" }] }))).toBe("/notes");
    expect(subtreeLabel(m({ type: "space", path: "/s/1" }))).toBe("/");
  });

  it("mountKind classifies the provider/type for the header icon (R3-94)", () => {
    expect(mountKind(m({ type: "worktree", path: "/app" }))).toBe("worktree");
    expect(mountKind(m({ type: "firestore", path: "/mnt/s", id: "settings:x" }))).toBe("settings");
    expect(mountKind(m({ type: "firestore", path: "/mnt/a", id: "space:abc" }))).toBe("space");
    expect(mountKind(m({ type: "firestore", path: "/mnt/n" }))).toBe("other");
  });

  it("mountScopes lists each granted subtree, root-first, deduped (R3-94)", () => {
    const out = mountScopes(
      m({
        type: "firestore",
        path: "/mnt/a",
        id: "space:abc",
        rules: [
          { subtree: "/notes", mode: "rw" },
          { subtree: "/", mode: "ro" },
          { subtree: "/notes", mode: "ro" }, // duplicate subtree → collapsed
        ],
      }),
    );
    expect(out).toEqual([
      { subtree: "/", mode: "ro" },
      { subtree: "/notes", mode: "ro" }, // non-worktree → effective ro, never the granted rw
    ]);
  });

  it("mountScopes: the worktree shows the granted mode (rw); rules absent → whole-mount ro", () => {
    expect(mountScopes(m({ type: "worktree", path: "/app" }))).toEqual([{ subtree: "/", mode: "rw" }]);
    expect(mountScopes(m({ type: "space", path: "/s/1" }))).toEqual([{ subtree: "/", mode: "ro" }]);
    expect(
      mountScopes(m({ type: "space", path: "/s/1", mode: "rw", rules: [{ subtree: "/", mode: "rw" }] })),
    ).toEqual([{ subtree: "/", mode: "ro" }]);
  });

  it("orders worktree first, then spaces, then others, A→Z", () => {
    const out = orderMounts([
      m({ type: "space", path: "/s/2", name: "Zeta" }),
      m({ type: "other", path: "/o/1", name: "Misc" }),
      m({ type: "worktree", path: "/mnt/x" }),
      m({ type: "space", path: "/s/1", name: "Alpha" }),
    ]).map((x) => x.type + ":" + mountLabel(x));
    expect(out).toEqual(["worktree:Working tree", "space:Alpha", "space:Zeta", "other:Misc"]);
  });
});

describe("toExplorerRoot maps a SandboxMount onto ExplorerRoot", () => {
  it("worktree → writable, kind worktree, not ejectable", () => {
    const root = toExplorerRoot(m({ type: "worktree", path: "/mnt/x", id: "repo" }));
    expect(root).toMatchObject({
      id: "repo",
      path: "/mnt/x",
      label: "repo", // id wins over the type fallback (mountLabel precedence)
      kind: "worktree",
      writable: true,
      ejectable: false,
      scopes: [{ subtree: "/", mode: "rw" }],
    });
    expect(root.spaceId).toBeUndefined();
  });

  it("space → read-only, kind space, ejectable with spaceId", () => {
    const root = toExplorerRoot(
      m({ type: "firestore", path: "/spaces/s1", id: "space:s1", name: "Shared notes", mode: "ro" }),
    );
    expect(root).toMatchObject({
      id: "space:s1",
      path: "/spaces/s1",
      label: "Shared notes",
      kind: "space",
      writable: false,
      ejectable: true,
      spaceId: "s1",
    });
  });
});
