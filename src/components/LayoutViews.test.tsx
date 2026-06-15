// R3-84 alternative layouts: the view switcher persists, and list / icons /
// columns each render the same mount data, navigate, and preserve the shared
// selection across a layout switch (brief 13 acceptance). Mocks mirror
// FileExplorer.test.tsx (the SDK + the sandbox fs are stubbed from a fixture).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../fs/mountFs";

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
  mounts: [] as Array<{ type: string; path: string; id?: string }>,
  activeFile: null as string | null,
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
  renameEntry: vi.fn(() => Promise.resolve()),
  uploadFile: vi.fn(() => Promise.resolve()),
  startItemDrag: vi.fn(() => Promise.resolve()),
  cancelItemDrag: vi.fn(() => {}),
}));

vi.mock("../fs/mountFs", () => ({
  readdir: (path: string) => h.readdir(path),
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
}));

import FileExplorer from "./FileExplorer";

const worktree = (id = "repo") => ({ type: "worktree", path: "/mnt/abc", id });

beforeEach(() => {
  localStorage.clear();
  h.mounts = [worktree()];
  h.activeFile = null;
  h.openInEditor.mockClear();
  h.readdir.mockClear();
});

afterEach(() => vi.clearAllMocks());

const switchTo = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) =>
  user.click(screen.getByRole("radio", { name }));

describe("layout switcher", () => {
  it("defaults to tree and persists the chosen layout to localStorage", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("src");

    expect(screen.getByRole("radio", { name: /tree/i })).toHaveAttribute("aria-checked", "true");

    await switchTo(user, /list view/i);
    expect(screen.getByRole("radio", { name: /list/i })).toHaveAttribute("aria-checked", "true");
    expect(localStorage.getItem("ir.fileexplorer.layout")).toBe("list");
  });
});

describe("list layout", () => {
  it("shows the directory entries and opens a file with its mount-relative path", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("src");

    await switchTo(user, /list view/i);
    // Single mount → list drills straight into it; entries appear as options.
    const readme = await screen.findByRole("option", { name: /README\.md/ });
    expect(screen.getByRole("option", { name: /src/ })).toBeInTheDocument();

    await user.click(readme);
    expect(h.openInEditor).toHaveBeenCalledWith("/README.md");
  });
});

describe("columns layout", () => {
  it("lists mounts then drills folder → folder into a focus path", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("src");

    await switchTo(user, /column view/i);
    // Column 0 = mounts (the worktree), column 1 = its children.
    const srcRow = await screen.findByRole("option", { name: /src/ });
    await user.click(srcRow);
    // Drilling reveals src's children in a new column.
    expect(await screen.findByRole("option", { name: /index\.ts/ })).toBeInTheDocument();
  });
});

describe("selection survives a layout switch", () => {
  it("keeps the selected file highlighted when moving tree → list", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("README.md");

    // Select README.md in the tree.
    await user.click(screen.getByText("README.md"));
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveAttribute("aria-selected", "true");

    // Switch to list — the same file is still selected.
    await switchTo(user, /list view/i);
    const readme = await screen.findByRole("option", { name: /README\.md/ });
    expect(readme).toHaveAttribute("aria-selected", "true");
  });
});

describe("icons layout", () => {
  it("renders entries as grid cells", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("src");

    await switchTo(user, /icon view/i);
    expect(await screen.findByRole("gridcell", { name: /src/ })).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: /README\.md/ })).toBeInTheDocument();
  });
});
