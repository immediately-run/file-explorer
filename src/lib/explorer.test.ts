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
  subtreeLabel,
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

  it("mountMode defaults to ro and subtreeLabel reads the first rule", () => {
    expect(mountMode(m({ type: "space", path: "/s/1" }))).toBe("ro");
    expect(subtreeLabel(m({ type: "space", path: "/s/1", rules: [{ subtree: "/notes", mode: "ro" }] }))).toBe("/notes");
    expect(subtreeLabel(m({ type: "space", path: "/s/1" }))).toBe("/");
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
