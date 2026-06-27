// Pure-helper unit tests (R3-79..R3-83). No DOM, no SDK.
import { describe, expect, it } from "vitest";
import {
  joinPath,
  basename,
  dirOf,
  toMountRel,
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
  moveRejection,
} from "./explorer";
import type { SandboxMount } from "@immediately-run/sdk";

const m = (o: Partial<SandboxMount> & { type: string; path: string }): SandboxMount => o as SandboxMount;

describe("path helpers", () => {
  it("joinPath / basename / dirOf / toMountRel", () => {
    expect(joinPath("/a/b/", "c")).toBe("/a/b/c");
    expect(basename("/a/b/c.ts")).toBe("c.ts");
    expect(dirOf("/a/b/c.ts")).toBe("/a/b");
    expect(dirOf("/a")).toBe("/");
    expect(toMountRel("/mnt/abc", "/mnt/abc/src/App.tsx")).toBe("/src/App.tsx");
    expect(toMountRel("/mnt/abc", "/mnt/abc")).toBe("/");
  });
});

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

  it("eject (R-SPACES-3): spaces eject, worktree + settings never", () => {
    // space mounts (universal `space:{id}` or a bare id) are ejectable
    expect(mountSpaceId(m({ type: "firestore", path: "/mnt/a", id: "space:abc" }))).toBe("abc");
    expect(mountSpaceId(m({ type: "firestore", path: "/mnt/a", id: "abc" }))).toBe("abc");
    expect(isEjectable(m({ type: "firestore", path: "/mnt/a", id: "space:abc" }))).toBe(true);
    // the worktree is "close the project", never an eject
    expect(isEjectable(m({ type: "worktree", path: "/app" }))).toBe(false);
    expect(mountSpaceId(m({ type: "worktree", path: "/app" }))).toBe(null);
    // a per-app settings store is excluded entirely
    expect(isSettingsMount(m({ type: "firestore", path: "/mnt/s", id: "settings:x" }))).toBe(true);
    expect(isEjectable(m({ type: "firestore", path: "/mnt/s", id: "settings:x" }))).toBe(false);
    // an id-less mount has nothing to unmount
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
    // a non-worktree grant of rw is still rendered read-only (never shown-then-EROFS)
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

describe("moveRejection (R3-81)", () => {
  const root = "/mnt/abc";
  it("allows a move into a sibling directory", () => {
    expect(moveRejection("/mnt/abc/a.ts", "/mnt/abc/src", root, root)).toBeNull();
  });
  it("rejects a no-op move into the current directory", () => {
    expect(moveRejection("/mnt/abc/src/a.ts", "/mnt/abc/src", root, root)).toBe("same-dir");
  });
  it("rejects dropping a directory onto itself or a descendant", () => {
    expect(moveRejection("/mnt/abc/src", "/mnt/abc/src", root, root)).toBe("into-self");
    expect(moveRejection("/mnt/abc/src", "/mnt/abc/src/sub", root, root)).toBe("into-self");
  });
  it("rejects a cross-mount move", () => {
    expect(moveRejection("/mnt/abc/a.ts", "/spaces/1/x", root, "/spaces/1")).toBe("cross-mount");
  });
});
