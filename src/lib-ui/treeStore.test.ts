// The store's write-path contract (R-IX-3/R-IX-4): a pending row renders at
// its final position the moment it is dispatched, the write's own return
// settles it with NO read at all, and the post-write authority refetch
// (`refreshDir`) re-reads exactly one directory — never every open one.
// The fixture tree below is a REAL two-level tree read through a counting
// FsSource; every fetch-count assertion is against that tree, not literals.
import { describe, expect, it, vi } from "vitest";
import { TreeStore } from "./treeStore";
import type { DirEntry, FsSource } from "./types";

const TREE: Record<string, DirEntry[]> = {
  "/mnt/abc": [
    { name: "src", isDir: true },
    { name: "README.md", isDir: false },
  ],
  "/mnt/abc/src": [
    { name: "index.ts", isDir: false },
    { name: "util.ts", isDir: false },
  ],
  "/mnt/abc/docs": [{ name: "guide.md", isDir: false }],
};

function countingFs() {
  const readdir = vi.fn((path: string) => Promise.resolve(TREE[path] ?? []));
  const fs: FsSource = { readdir };
  return { fs, readdir };
}

/** A store with the root and two subdirectories expanded and loaded — the
 *  "several open directories" shape `refresh()` used to re-read wholesale. */
async function loadedStore() {
  const { fs, readdir } = countingFs();
  const store = new TreeStore(fs);
  store.ensureRoots(["/mnt/abc"]);
  store.open("/mnt/abc/src");
  store.open("/mnt/abc/docs");
  store.ensureLoaded("/mnt/abc");
  store.ensureLoaded("/mnt/abc/src");
  store.ensureLoaded("/mnt/abc/docs");
  await vi.waitFor(() => {
    expect(store.getEntries("/mnt/abc")).toBeDefined();
    expect(store.getEntries("/mnt/abc/src")).toBeDefined();
    expect(store.getEntries("/mnt/abc/docs")).toBeDefined();
  });
  return { store, readdir };
}

describe("TreeStore write path", () => {
  it("refreshDir re-reads ONE directory — the changed one, not every open one", async () => {
    const { store, readdir } = await loadedStore();
    const callsBefore = readdir.mock.calls.length;
    expect(callsBefore).toBe(3); // the fixture tree's three directories

    store.refreshDir("/mnt/abc/src");

    await vi.waitFor(() => expect(readdir.mock.calls.length).toBe(callsBefore + 1));
    expect(readdir.mock.calls.at(-1)).toEqual(["/mnt/abc/src"]);
  });

  it("a write settles from the action's return with NO refresh at all", async () => {
    const { store, readdir } = await loadedStore();
    const callsBefore = readdir.mock.calls.length;

    // Dispatch: the pending row appears at its final position.
    store.insertPending("/mnt/abc/src", { name: "aaa.ts", isDir: false });
    expect(store.getEntries("/mnt/abc/src")!.map((e) => e.name)).toEqual([
      "aaa.ts",
      "index.ts",
      "util.ts",
    ]);
    expect(store.isPending("/mnt/abc/src/aaa.ts")).toBe(true);

    // Settle from the return — no read happens.
    store.settleEntry("/mnt/abc/src", "aaa.ts", { name: "aaa.ts", isDir: false, size: 0 });
    const names = store.getEntries("/mnt/abc/src")!.map((e) => e.name);
    expect(names).toEqual(["aaa.ts", "index.ts", "util.ts"]);
    expect(store.getEntries("/mnt/abc/src")!.find((e) => e.name === "aaa.ts")!.size).toBe(0);
    expect(store.isPending("/mnt/abc/src/aaa.ts")).toBe(false);
    expect(readdir.mock.calls.length).toBe(callsBefore);
  });

  it("insertPending places the row at its final position: folders first, then names", async () => {
    const { store } = await loadedStore();
    store.insertPending("/mnt/abc", { name: "zzz", isDir: true });
    store.insertPending("/mnt/abc", { name: "aardvark.ts", isDir: false });
    expect(store.getEntries("/mnt/abc")!.map((e) => e.name)).toEqual([
      "src",
      "zzz",
      "aardvark.ts",
      "README.md",
    ]);
  });

  it("removeEntry + insertEntry round-trips a failed write's restore", async () => {
    const { store } = await loadedStore();
    const before = store.getEntries("/mnt/abc/src")!;
    store.removeEntry("/mnt/abc/src", "index.ts");
    expect(store.getEntries("/mnt/abc/src")!.map((e) => e.name)).toEqual(["util.ts"]);
    store.insertEntry("/mnt/abc/src", { name: "index.ts", isDir: false });
    expect(store.getEntries("/mnt/abc/src")).toEqual(before);
  });

  it("settleEntry re-sorts when the authority normalized the name", async () => {
    const { store } = await loadedStore();
    store.insertPending("/mnt/abc/src", { name: "draft.md", isDir: false });
    store.settleEntry("/mnt/abc/src", "draft.md", { name: "Draft.md", isDir: false });
    expect(store.getEntries("/mnt/abc/src")!.map((e) => e.name)).toEqual([
      "Draft.md",
      "index.ts",
      "util.ts",
    ]);
  });

  it("removeEntry drops a stale focus on the removed row", async () => {
    const { store } = await loadedStore();
    store.setFocus("/mnt/abc/src/index.ts");
    expect(store.getFocused()).toBe("/mnt/abc/src/index.ts");
    store.removeEntry("/mnt/abc/src", "index.ts");
    expect(store.getFocused()).toBeNull();
  });

  it("collapsing a folder that holds the focus hands the focus to the folder", async () => {
    const { store } = await loadedStore();
    store.setFocus("/mnt/abc/src/index.ts");
    store.toggle("/mnt/abc/src"); // collapse
    expect(store.getFocused()).toBe("/mnt/abc/src");
  });
});

describe("TreeStore refreshDir vs concurrent writes", () => {
  it("a fresh listing never wipes the row of a write still in flight", async () => {
    const { fs, readdir } = countingFs();
    const store = new TreeStore(fs);
    store.ensureRoots(["/mnt/abc"]);
    store.ensureLoaded("/mnt/abc");
    await vi.waitFor(() => expect(store.getEntries("/mnt/abc")).toBeDefined());

    // Two creates dispatched; neither resolved yet. The fixture's listing
    // (what the authority returns) knows about neither.
    store.insertPending("/mnt/abc", { name: "aaa.ts", isDir: false });
    store.insertPending("/mnt/abc", { name: "zzz.ts", isDir: false });
    store.refreshDir("/mnt/abc");

    await vi.waitFor(() => expect(readdir.mock.calls.length).toBe(2));
    const names = store.getEntries("/mnt/abc").map((e) => e.name);
    expect(names).toEqual(["src", "aaa.ts", "README.md", "zzz.ts"]);
    expect(store.isPending("/mnt/abc/aaa.ts")).toBe(true);
    expect(store.isPending("/mnt/abc/zzz.ts")).toBe(true);
  });
});

describe("TreeStore selection records the row kind (FILE_EXPLORER_SPEC §5)", () => {
  it("select(path, isDir) answers getSelectedRow; a no-op re-select keeps the snapshot identity", () => {
    const { fs } = countingFs();
    const store = new TreeStore(fs);

    store.select("/mnt/abc/src", true);
    expect(store.getSelected()).toBe("/mnt/abc/src");
    expect(store.getSelectedRow()).toEqual({ path: "/mnt/abc/src", isDir: true });

    // The snapshot a useSyncExternalStore getter returns must be identity-stable
    // between real mutations — a no-op re-select must not mint a new object.
    const snapshot = store.getSelectedRow();
    store.select("/mnt/abc/src", true);
    expect(store.getSelectedRow()).toBe(snapshot);

    store.select("/mnt/abc/src/index.ts", false);
    expect(store.getSelectedRow()).toEqual({ path: "/mnt/abc/src/index.ts", isDir: false });
    expect(store.getSelectedRow()).not.toBe(snapshot);
  });

  it("purging a removed root clears the selected row, not just the path", async () => {
    const { fs } = countingFs();
    const store = new TreeStore(fs);
    store.ensureRoots(["/mnt/abc"]);
    store.select("/mnt/abc/src", true);
    expect(store.getSelectedRow()).toEqual({ path: "/mnt/abc/src", isDir: true });

    store.ensureRoots([]); // the mount went away
    expect(store.getSelected()).toBeNull();
    expect(store.getSelectedRow()).toBeNull();
  });
});
