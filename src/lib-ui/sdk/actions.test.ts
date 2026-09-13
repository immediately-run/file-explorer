// The SDK adapter's write contract: create/rename resolve the ENTRY they
// produced (rename derives it from the destination listing — the authority's
// own answer, including isDir), delete resolves the removed path, and a null
// return is reserved for a user cancel. The SDK and the sandbox fs are the
// same hoisted fakes the FileExplorer suite uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../types";

const TREE: Record<string, DirEntry[]> = {
  "/mnt/abc": [
    { name: "src", isDir: true },
    { name: "README.md", isDir: false },
  ],
  "/mnt/abc/src": [
    { name: "index.ts", isDir: false },
    { name: "util.ts", isDir: false },
  ],
};

const h = vi.hoisted(() => ({
  createFile: vi.fn((): Promise<void> => Promise.resolve()),
  createFolder: vi.fn((): Promise<void> => Promise.resolve()),
  renameEntry: vi.fn((): Promise<void> => Promise.resolve()),
  deleteEntry: vi.fn((): Promise<void> => Promise.resolve()),
  uploadFile: vi.fn((): Promise<void> => Promise.resolve()),
  readdir: vi.fn((path: string) => Promise.resolve(TREE[path] ?? [])),
}));

vi.mock("@immediately-run/sdk", () => ({
  createFile: (path: string) => h.createFile(path),
  createFolder: (path: string) => h.createFolder(path),
  renameEntry: (from: string, to: string) => h.renameEntry(from, to),
  deleteEntry: (path: string) => h.deleteEntry(path),
  uploadFile: (path: string, bytes: Uint8Array) => h.uploadFile(path, bytes),
}));

vi.mock("./mountFs", () => ({
  readdir: (path: string) => h.readdir(path),
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  sdkFsSource: {
    readdir: (path: string) => h.readdir(path),
    readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  },
}));

import { makeSdkActions } from "./actions";
import type { ExplorerRoot } from "../types";

const worktree: ExplorerRoot = {
  id: "repo",
  path: "/mnt/abc",
  label: "repo",
  kind: "worktree",
  writable: true,
  scopes: [{ subtree: "/", mode: "rw" }],
  ejectable: false,
};

const actions = makeSdkActions();

beforeEach(() => {
  h.createFile.mockClear();
  h.createFolder.mockClear();
  h.renameEntry.mockClear();
  h.deleteEntry.mockClear();
  h.uploadFile.mockClear();
  h.readdir.mockClear();
});

describe("makeSdkActions write contract", () => {
  it("createFile resolves the entry it created", async () => {
    await expect(actions.createFile!(worktree, "/src/new.ts")).resolves.toEqual({
      name: "new.ts",
      isDir: false,
    });
    expect(h.createFile).toHaveBeenCalledWith("/src/new.ts");
  });

  it("createFolder resolves the entry it created (a folder)", async () => {
    await expect(actions.createFolder!(worktree, "/lib")).resolves.toEqual({
      name: "lib",
      isDir: true,
    });
    expect(h.createFolder).toHaveBeenCalledWith("/lib");
  });

  it("rename resolves the destination entry from the REAL destination listing", async () => {
    // Move README.md into src/: the settled entry is read from the store's own
    // fs (the fixture's /mnt/abc/src listing), so isDir comes from the
    // authority, not from a guess.
    TREE["/mnt/abc/src"].push({ name: "README.md", isDir: false });
    try {
      const entry = await actions.rename!(worktree, "/README.md", "/src/README.md");
      expect(h.renameEntry).toHaveBeenCalledWith("/README.md", "/src/README.md");
      expect(h.readdir).toHaveBeenCalledWith("/mnt/abc/src");
      expect(entry).toEqual({ name: "README.md", isDir: false });
    } finally {
      TREE["/mnt/abc/src"] = TREE["/mnt/abc/src"].filter((e) => e.name !== "README.md");
    }
  });

  it("rename of a FOLDER resolves isDir=true from the listing", async () => {
    // Rename src → sources: the fixture gains the destination entry first (the
    // write landed — the listing is what the store's own fs would return).
    TREE["/mnt/abc"].push({ name: "sources", isDir: true });
    try {
      const entry = await actions.rename!(worktree, "/src", "/sources");
      expect(entry).toEqual({ name: "sources", isDir: true });
    } finally {
      TREE["/mnt/abc"] = TREE["/mnt/abc"].filter((e) => e.name !== "sources");
    }
  });

  it("delete resolves the removed path", async () => {
    await expect(actions.delete!(worktree, "/src/index.ts")).resolves.toBe("/src/index.ts");
    expect(h.deleteEntry).toHaveBeenCalledWith("/src/index.ts");
  });

  it("upload still resolves void (a batch is not an entry) and enforces the size cap", async () => {
    await expect(
      actions.upload!(worktree, "/src", [new File(["x"], "note.txt")]),
    ).resolves.toBeUndefined();
    expect(h.uploadFile).toHaveBeenCalledWith("/src/note.txt", expect.any(Uint8Array));

    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 1024 * 1024 });
    await expect(actions.upload!(worktree, "/src", [big])).rejects.toMatchObject({
      code: "too-large",
    });
  });
});

describe("makeSdkActions degraded rename settle", () => {
  it("falls back to the CALLER's isDir when the destination listing misses the name", async () => {
    // A folder rename whose destination listing is empty (the fs view lags):
    // the settle must not flip the folder row into a file row.
    h.readdir.mockResolvedValueOnce([]);
    const entry = await actions.rename!(worktree, "/src", "/sources", true);
    expect(entry).toEqual({ name: "sources", isDir: true });
  });
});
