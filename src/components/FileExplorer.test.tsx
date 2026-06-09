// FX-3 regression guard for the file-explorer rendering/expansion fixes.
//
// Covers the two reported defects and the selection indicator:
// - FX-2: clicking a file in an expanded subdirectory must NOT collapse it, and
//   opens it with the repo-relative path.
// - FX-4a: the clicked row is marked selected, and the selection survives a
//   benign worktree re-announce.
// - FX-1 (no-remount proxy): a benign worktree re-announce (a new mount object
//   with the same path) must not remount/reload the tree — asserted via the
//   `readdir` call count staying flat and expansion being preserved.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../fs/mountFs";

// A two-level fixture tree; `readdir` resolves from it.
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

// Mutable test doubles, shared with the hoisted module mocks below.
const h = vi.hoisted(() => ({
  mounts: [] as Array<{ type: string; path: string; id?: string }>,
  // The editor-context active file (FX-4b). Mutable so a test can move it and
  // re-render, mirroring a host push.
  activeFile: null as string | null,
  // The arg is recorded by the spy via the factory call below, so the impl needs
  // no param; assertions use `toHaveBeenCalledWith`.
  openInEditor: vi.fn((): Promise<void> => Promise.resolve()),
  readdir: vi.fn((path: string) => Promise.resolve(TREE[path] ?? [])),
}));

vi.mock("@immediately-run/sdk", () => ({
  useMounts: () => h.mounts,
  useEditorContext: () => ({ dirtyPaths: [], openFiles: [], activeFile: h.activeFile }),
  openInEditor: (path: string) => h.openInEditor(path),
  createFile: vi.fn(() => Promise.resolve()),
  createFolder: vi.fn(() => Promise.resolve()),
  deleteEntry: vi.fn(() => Promise.resolve()),
  uploadFile: vi.fn(() => Promise.resolve()),
}));

vi.mock("../fs/mountFs", () => ({
  readdir: (path: string) => h.readdir(path),
}));

import FileExplorer from "./FileExplorer";

const worktree = (id = "repo") => ({ type: "worktree", path: "/mnt/abc", id });

beforeEach(() => {
  h.mounts = [worktree()];
  h.activeFile = null;
  h.openInEditor.mockClear();
  h.readdir.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Render, wait for the root to load, expand `src`, wait for its children. */
async function renderWithSrcExpanded() {
  const user = userEvent.setup();
  const utils = render(<FileExplorer />);
  // Root is open by default → top-level entries appear.
  await screen.findByText("src");
  await user.click(screen.getByText("src"));
  // Subdirectory children appear once readdir resolves.
  await screen.findByText("index.ts");
  return { user, ...utils };
}

describe("FileExplorer", () => {
  it("FX-2: clicking a file in a subdirectory keeps the subdirectory open", async () => {
    const { user } = await renderWithSrcExpanded();

    await user.click(screen.getByText("index.ts"));

    // Opened with the repo-relative path (mount prefix stripped), not /mnt/...
    expect(h.openInEditor).toHaveBeenCalledTimes(1);
    expect(h.openInEditor).toHaveBeenCalledWith("/src/index.ts");

    // The subdirectory is still expanded and its contents still visible.
    const src = screen.getByRole("treeitem", { name: "src" });
    expect(src).toHaveAttribute("aria-expanded", "true");
    expect(within(src).getByText("index.ts")).toBeInTheDocument();
    expect(within(src).getByText("util.ts")).toBeInTheDocument();
  });

  it("FX-4a: the clicked file is marked selected and stays selected across a re-announce", async () => {
    const { user, rerender } = await renderWithSrcExpanded();

    await user.click(screen.getByText("index.ts"));
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // A benign worktree re-announce: a NEW mount object, same path.
    h.mounts = [worktree()];
    rerender(<FileExplorer />);

    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("FX-4b: the editor's active file is highlighted, and the highlight moves without collapsing the tree", async () => {
    h.activeFile = "/src/index.ts";
    const { rerender } = await renderWithSrcExpanded();

    const rowOf = (name: string) =>
      screen.getByText(name).closest("div.tnode") as HTMLElement;

    // The active file's row is marked --active (distinct from selection); a sibling
    // file in the same open directory is not.
    expect(rowOf("index.ts")).toHaveClass("tnode--active");
    expect(rowOf("index.ts")).toHaveAttribute("aria-current", "true");
    expect(rowOf("util.ts")).not.toHaveClass("tnode--active");
    // Active highlight is independent of explorer selection — nothing was clicked.
    expect(screen.getByRole("treeitem", { name: "index.ts" })).not.toHaveAttribute(
      "aria-selected",
      "true",
    );

    // The host moves the active file → the highlight follows, and `src` stays open
    // (no remount, no collapse).
    h.activeFile = "/src/util.ts";
    rerender(<FileExplorer />);

    expect(rowOf("util.ts")).toHaveClass("tnode--active");
    expect(rowOf("index.ts")).not.toHaveClass("tnode--active");
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("FX-1: a benign worktree re-announce does not reload or collapse the tree", async () => {
    const { rerender } = await renderWithSrcExpanded();

    // readdir was called once for the root and once for src.
    const callsBefore = h.readdir.mock.calls.length;
    expect(callsBefore).toBe(2);

    h.mounts = [worktree()]; // new object, same path
    rerender(<FileExplorer />);

    // No remount/reload: readdir is not called again, and src stays expanded.
    expect(h.readdir.mock.calls.length).toBe(callsBefore);
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("index.ts")).toBeInTheDocument();
  });

  it("clicking a file does not trigger a directory reload", async () => {
    const { user } = await renderWithSrcExpanded();
    const callsBefore = h.readdir.mock.calls.length;

    await user.click(screen.getByText("index.ts"));

    expect(h.readdir.mock.calls.length).toBe(callsBefore);
  });
});
