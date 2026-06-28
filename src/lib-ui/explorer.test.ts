// Pure-helper unit tests (R3-79..R3-83). No DOM, no SDK — these operate on the
// library's generalized ExplorerRoot. The SandboxMount→ExplorerRoot mapping and
// its mount-shape classifiers are tested in `sdk/mounts.test.ts`.
import { describe, expect, it } from "vitest";
import {
  joinPath,
  basename,
  dirOf,
  toMountRel,
  mountLabel,
  isWritableMount,
  isEjectable,
  mountSpaceId,
  subtreeLabel,
  mountKind,
  mountScopes,
  orderMounts,
  moveRejection,
} from "./explorer";
import type { ExplorerRoot } from "./types";

const r = (o: Partial<ExplorerRoot> & { path: string }): ExplorerRoot => ({
  id: o.id ?? o.path,
  path: o.path,
  label: o.label ?? "",
  kind: o.kind ?? "other",
  writable: o.writable ?? false,
  scopes: o.scopes,
  ejectable: o.ejectable,
  spaceId: o.spaceId,
});

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

describe("root metadata (R3-79) over ExplorerRoot", () => {
  it("mountLabel reads the resolved label", () => {
    expect(mountLabel(r({ path: "/s/1", label: "My space" }))).toBe("My space");
    expect(mountLabel(r({ path: "/mnt/x", label: "Working tree" }))).toBe("Working tree");
  });

  it("isWritableMount reflects the root's writable flag", () => {
    expect(isWritableMount(r({ path: "/mnt/x", writable: true }))).toBe(true);
    expect(isWritableMount(r({ path: "/s/1", writable: false }))).toBe(false);
  });

  it("eject reads ejectable + spaceId", () => {
    expect(mountSpaceId(r({ path: "/mnt/a", spaceId: "abc" }))).toBe("abc");
    expect(isEjectable(r({ path: "/mnt/a", spaceId: "abc", ejectable: true }))).toBe(true);
    expect(isEjectable(r({ path: "/app", kind: "worktree" }))).toBe(false);
    expect(mountSpaceId(r({ path: "/app", kind: "worktree" }))).toBe(null);
    expect(isEjectable(r({ path: "/mnt/n" }))).toBe(false);
  });

  it("subtreeLabel reads the first scope", () => {
    expect(subtreeLabel(r({ path: "/s/1", scopes: [{ subtree: "/notes", mode: "ro" }] }))).toBe("/notes");
    expect(subtreeLabel(r({ path: "/s/1" }))).toBe("/");
  });

  it("mountKind reads the root's kind", () => {
    expect(mountKind(r({ path: "/app", kind: "worktree" }))).toBe("worktree");
    expect(mountKind(r({ path: "/mnt/s", kind: "settings" }))).toBe("settings");
    expect(mountKind(r({ path: "/mnt/a", kind: "space" }))).toBe("space");
    expect(mountKind(r({ path: "/mnt/n", kind: "other" }))).toBe("other");
  });

  it("mountScopes lists each scope, root-first, deduped", () => {
    const out = mountScopes(
      r({
        path: "/mnt/a",
        kind: "space",
        scopes: [
          { subtree: "/notes", mode: "ro" },
          { subtree: "/", mode: "ro" },
          { subtree: "/notes", mode: "ro" }, // duplicate subtree → collapsed
        ],
      }),
    );
    expect(out).toEqual([
      { subtree: "/", mode: "ro" },
      { subtree: "/notes", mode: "ro" },
    ]);
  });

  it("mountScopes falls back to a whole-mount row from writability when scopes absent", () => {
    expect(mountScopes(r({ path: "/app", kind: "worktree", writable: true }))).toEqual([
      { subtree: "/", mode: "rw" },
    ]);
    expect(mountScopes(r({ path: "/s/1", kind: "space", writable: false }))).toEqual([
      { subtree: "/", mode: "ro" },
    ]);
  });

  it("orders worktree first, then spaces, then others, A→Z", () => {
    const out = orderMounts([
      r({ path: "/s/2", kind: "space", label: "Zeta" }),
      r({ path: "/o/1", kind: "other", label: "Misc" }),
      r({ path: "/mnt/x", kind: "worktree", label: "Working tree" }),
      r({ path: "/s/1", kind: "space", label: "Alpha" }),
    ]).map((x) => x.kind + ":" + mountLabel(x));
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
