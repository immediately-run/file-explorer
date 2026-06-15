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
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  "/spaces/s1": [{ name: "note.md", isDir: false }],
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
  deleteEntry: vi.fn((): Promise<void> => Promise.resolve()),
  renameEntry: vi.fn((): Promise<void> => Promise.resolve()),
  uploadFile: vi.fn((): Promise<void> => Promise.resolve()),
  startItemDrag: vi.fn((): Promise<void> => Promise.resolve()),
  cancelItemDrag: vi.fn(() => {}),
  readdir: vi.fn((path: string) => Promise.resolve(TREE[path] ?? [])),
  listSettingsApps: vi.fn((): Promise<string[]> => Promise.resolve([])),
}));

vi.mock("@immediately-run/sdk", () => ({
  useMounts: () => h.mounts,
  useEditorContext: () => ({ dirtyPaths: [], openFiles: [], activeFile: h.activeFile }),
  openInEditor: (path: string) => h.openInEditor(path),
  createFile: vi.fn(() => Promise.resolve()),
  createFolder: vi.fn(() => Promise.resolve()),
  deleteEntry: (path: string) => h.deleteEntry(path),
  renameEntry: (from: string, to: string) => h.renameEntry(from, to),
  uploadFile: (path: string, bytes: Uint8Array) => h.uploadFile(path, bytes),
  startItemDrag: (item: unknown) => h.startItemDrag(item),
  cancelItemDrag: () => h.cancelItemDrag(),
  // settings:all enumeration — default to none so the base file tree is unaffected.
  listSettingsApps: () => h.listSettingsApps(),
  openSettingsOf: vi.fn(() => Promise.resolve({ type: "firestore", path: "/mnt/set", id: "settings:x" })),
}));

vi.mock("../fs/mountFs", () => ({
  readdir: (path: string) => h.readdir(path),
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
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

// --- R3-79: multiple mounts -------------------------------------------------
const space = () => ({ type: "space", path: "/spaces/s1", id: "s1", name: "Shared notes", mode: "ro" as const });

describe("R3-79 — multiple mounts", () => {
  beforeEach(() => {
    h.mounts = [worktree(), space()];
  });

  it("renders one scope per mount (worktree + space)", async () => {
    render(<FileExplorer />);
    expect(await screen.findByRole("tree", { name: "repo" })).toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "Shared notes" })).toBeInTheDocument();
  });

  it("a read-only space mount shows a read-only chip and no delete affordance", async () => {
    render(<FileExplorer />);
    const spaceTree = await screen.findByRole("tree", { name: "Shared notes" });
    const scope = spaceTree.closest(".mount") as HTMLElement;
    expect(within(scope).getByText(/read-only/)).toBeInTheDocument();
    // The space scope root row has no delete button (read-only).
    expect(within(scope).queryByLabelText(/^Delete /)).not.toBeInTheDocument();
  });

  it("a revoked mount's scope disappears within one re-announce", async () => {
    const { rerender } = render(<FileExplorer />);
    expect(await screen.findByRole("tree", { name: "Shared notes" })).toBeInTheDocument();
    h.mounts = [worktree()]; // space unshared
    rerender(<FileExplorer />);
    expect(screen.queryByRole("tree", { name: "Shared notes" })).not.toBeInTheDocument();
    expect(screen.getByRole("tree", { name: "repo" })).toBeInTheDocument();
  });
});

// --- R3-80: context menu ----------------------------------------------------
describe("R3-80 — context menu", () => {
  it("right-clicking a worktree file opens a menu with Open + write actions", async () => {
    const { user } = await renderWithSrcExpanded();
    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    for (const label of ["Open", "New file here", "New folder here", "Rename…", "Delete"]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(label) })).toBeInTheDocument();
    }
    // Delete from the menu confirms then calls deleteEntry with the mount-rel path.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
    expect(h.deleteEntry).toHaveBeenCalledWith("/src/index.ts");
    confirm.mockRestore();
  });

  it("a read-only space file's menu offers only Open (no write actions)", async () => {
    h.mounts = [space()];
    render(<FileExplorer />);
    // The space root is open by default → its file appears once readdir resolves.
    fireEvent.contextMenu(await screen.findByText("note.md"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /New file here/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).not.toBeInTheDocument();
  });
});

// --- helpers for synthetic drag events --------------------------------------
function dataTransfer(opts: { move?: string; files?: File[] }) {
  const types: string[] = [];
  if (opts.move) types.push("application/x-ir-file-move");
  if (opts.files?.length) types.push("Files");
  return {
    types,
    files: opts.files ?? [],
    getData: (t: string) => (t === "application/x-ir-file-move" ? (opts.move ?? "") : ""),
    setData: () => {},
    dropEffect: "",
    effectAllowed: "",
  };
}

// --- R3-81: drag to move ----------------------------------------------------
describe("R3-81 — drag to move within a filesystem", () => {
  it("dropping a file onto a sibling directory calls renameEntry", async () => {
    await renderWithSrcExpanded();
    const srcRow = screen.getByText("src").closest(".tnode") as HTMLElement;
    fireEvent.drop(srcRow, {
      dataTransfer: dataTransfer({ move: JSON.stringify({ from: "/mnt/abc/README.md", rootPath: "/mnt/abc" }) }),
    });
    expect(h.renameEntry).toHaveBeenCalledWith("/README.md", "/src/README.md");
  });

  it("a cross-mount drop is rejected (no rename)", async () => {
    await renderWithSrcExpanded();
    const srcRow = screen.getByText("src").closest(".tnode") as HTMLElement;
    fireEvent.drop(srcRow, {
      dataTransfer: dataTransfer({ move: JSON.stringify({ from: "/spaces/s1/x.md", rootPath: "/spaces/s1" }) }),
    });
    expect(h.renameEntry).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/filesystems/);
  });
});

// --- R3-82: drag to upload --------------------------------------------------
describe("R3-82 — drag local files to upload into a directory", () => {
  it("dropping an OS file onto a directory uploads it into that directory", async () => {
    await renderWithSrcExpanded();
    const srcRow = screen.getByText("src").closest(".tnode") as HTMLElement;
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.drop(srcRow, { dataTransfer: dataTransfer({ files: [file] }) });
    await vi.waitFor(() => expect(h.uploadFile).toHaveBeenCalled());
    expect(h.uploadFile.mock.calls[0][0]).toBe("/src/note.txt");
  });
});

// --- R3-83: drag-out source -------------------------------------------------
describe("R3-83 — drag-out asks the host to begin a cross-app drag", () => {
  it("dragging a file row calls startItemDrag with a reference to that file", async () => {
    await renderWithSrcExpanded();
    const fileRow = screen.getByText("index.ts").closest(".tnode") as HTMLElement;
    fireEvent.dragStart(fileRow, { dataTransfer: dataTransfer({}) });
    await vi.waitFor(() => expect(h.startItemDrag).toHaveBeenCalled());
    expect(h.startItemDrag.mock.calls[0][0]).toMatchObject({
      kind: "file",
      name: "index.ts",
      relPath: "/src/index.ts",
    });
  });
});
