// Headless-view contract (Phase 02 §D): exercises `FileExplorerView` with a FAKE
// `FsSource` and SPY `actions` and NO SDK mock at all. This proves the view is
// fully decoupled from the host SDK — a non-SDK consumer (file-commander) drives
// it exactly this way.
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileExplorerView from "./FileExplorerView";
import type { DirEntry, ExplorerRoot, FsSource } from "./types";

// A two-level fixture tree the fake FsSource resolves from.
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

const readdir = vi.fn((path: string) => Promise.resolve(TREE[path] ?? []));
const fakeFs: FsSource = {
  readdir,
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const worktree: ExplorerRoot = {
  id: "repo",
  path: "/mnt/abc",
  label: "repo",
  kind: "worktree",
  writable: true,
  scopes: [{ subtree: "/", mode: "rw" }],
  ejectable: false,
};

beforeEach(() => readdir.mockClear());
afterEach(() => vi.clearAllMocks());

describe("FileExplorerView (headless, no SDK)", () => {
  it("renders a scope per root and lazily reads a directory via fs.readdir on expand", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} />);

    // Root is open by default → its tree was read.
    expect(await screen.findByRole("tree", { name: "repo" })).toBeInTheDocument();
    await screen.findByText("src");
    expect(readdir).toHaveBeenCalledWith("/mnt/abc");

    // Expanding a subdirectory reads it through the injected fs.
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");
    expect(readdir).toHaveBeenCalledWith("/mnt/abc/src");
  });

  it("R3-268: the viewed-document marker renders on its row, coexists with active, and never selects", async () => {
    const { rerender } = render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} activePath="/README.md" viewedPath="/README.md" />,
    );
    // Both states on ONE row: active (aria-current) + the "on stage" marker.
    const marker = await screen.findByLabelText("Shown in the running app");
    expect(marker).toBeInTheDocument();
    const row = screen.getByText("README.md").closest(".tnode")!;
    expect(row.className).toContain("tnode--active");
    expect(row.className).toContain("tnode--viewed");
    // Highlight-only: the marker confers no selection.
    expect(row.className).not.toContain("tnode--selected");
    // The hint moving is just a marker move — the active row is untouched.
    rerender(
      <FileExplorerView roots={[worktree]} fs={fakeFs} activePath="/README.md" viewedPath={null} />,
    );
    expect(screen.queryByLabelText("Shown in the running app")).toBeNull();
    expect(row.className).toContain("tnode--active");
  });

  it("activating a file calls actions.open with the mount-relative path + onActivate/onSelect", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const onActivate = vi.fn();
    const onSelect = vi.fn();
    render(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        actions={{ open }}
        onActivate={onActivate}
        onSelect={onSelect}
      />,
    );
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await user.click(await screen.findByText("index.ts"));

    expect(open).toHaveBeenCalledWith(worktree, "/src/index.ts");
    expect(onActivate).toHaveBeenCalledWith(worktree, "/src/index.ts", false);
    expect(onSelect).toHaveBeenCalledWith(worktree, "/src/index.ts");
    // The clicked row is marked selected.
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveAttribute("aria-selected", "true");
  });

  it("an absent action hides its affordance — no delete button when actions.delete is missing", async () => {
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ open: vi.fn() }} />);
    await screen.findByText("README.md");
    // delete is NOT provided → no per-row delete button, even on a writable root.
    expect(screen.queryByLabelText(/^Delete /)).not.toBeInTheDocument();
    // …and the context menu offers no Delete / write items, only Open.
    fireEvent.contextMenu(screen.getByText("README.md"));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open/ })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Delete/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /New file here/ })).not.toBeInTheDocument();
  });

  it("a provided action shows its affordance — delete button + a working confirm→delete", async () => {
    const del = vi.fn(() => Promise.resolve());
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ delete: del }} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(screen.getByLabelText("Delete index.ts"));
    expect(del).toHaveBeenCalledWith(worktree, "/src/index.ts");
    confirm.mockRestore();
  });

  it("extraMenuItems are appended to the row context menu", async () => {
    const onSummarize = vi.fn();
    const extraMenuItems = vi.fn(() => [
      { key: "summarize", label: "Summarize…", onSelect: onSummarize },
    ]);
    const user = userEvent.setup();
    render(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        actions={{ open: vi.fn() }}
        extraMenuItems={extraMenuItems}
      />,
    );
    await screen.findByText("README.md");
    fireEvent.contextMenu(screen.getByText("README.md"));
    const menu = await screen.findByRole("menu");
    const item = within(menu).getByRole("menuitem", { name: /Summarize/ });
    expect(item).toBeInTheDocument();
    await user.click(item);
    expect(onSummarize).toHaveBeenCalled();
  });

  it("renders the empty state when there are no roots", () => {
    render(<FileExplorerView roots={[]} fs={fakeFs} />);
    expect(screen.getByRole("heading", { name: /No files to show yet/i })).toBeInTheDocument();
  });

  it("fires onNavigate with (root, relPath) when the list layout browses into a directory", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} layout="list" onNavigate={onNavigate} />,
    );
    // The list starts at the roots-root (the single root shown as a row). Enter it…
    await user.click(await screen.findByText("repo"));
    // …then into `src`. onNavigate reports the destination directory per navigation.
    await user.click(await screen.findByText("src"));

    expect(onNavigate).toHaveBeenCalledWith(worktree, expect.stringMatching(/(^|\/)src$/));
    // Always the owning root, never a foreign one.
    for (const call of onNavigate.mock.calls) expect(call[0]).toBe(worktree);
  });

  it("controlled cwd: renders the prop's directory; navigating fires onNavigate but does NOT change what's shown until the prop updates", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { rerender } = render(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        layout="list"
        cwd="/mnt/abc"
        onNavigate={onNavigate}
      />,
    );
    // The controlled cwd (`/mnt/abc`) is shown — its entries, not the roots-root.
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();

    // Navigating into `src` reports via onNavigate but the view stays put (the
    // consumer owns cwd) — `src`'s children are NOT shown yet.
    await user.click(screen.getByText("src"));
    expect(onNavigate).toHaveBeenCalledWith(worktree, expect.stringMatching(/(^|\/)src$/));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();

    // Feeding the new cwd prop back in shows that directory.
    rerender(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        layout="list"
        cwd="/mnt/abc/src"
        onNavigate={onNavigate}
      />,
    );
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(screen.getByText("util.ts")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("multi-select: clicking two files reports a 2-element set; clicking one again toggles it off; rows show selected styling", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        layout="list"
        cwd="/mnt/abc/src"
        selectionMode="multi"
        onSelectionChange={onSelectionChange}
      />,
    );
    const indexRow = (await screen.findByText("index.ts")).closest('[role="option"]')!;
    const utilRow = screen.getByText("util.ts").closest('[role="option"]')!;

    // Click two files → the set grows to two (mount-relative paths, owning root).
    await user.click(indexRow);
    expect(onSelectionChange).toHaveBeenLastCalledWith(worktree, ["/src/index.ts"]);
    await user.click(utilRow);
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      worktree,
      expect.arrayContaining(["/src/index.ts", "/src/util.ts"]),
    );
    expect(onSelectionChange.mock.calls.at(-1)![1]).toHaveLength(2);
    // Both marked rows carry the selected styling.
    expect(indexRow).toHaveClass("lrow--selected");
    expect(utilRow).toHaveClass("lrow--selected");

    // Clicking `index.ts` again toggles it OFF → back to a 1-element set.
    await user.click(indexRow);
    expect(onSelectionChange).toHaveBeenLastCalledWith(worktree, ["/src/util.ts"]);
    expect(indexRow).not.toHaveClass("lrow--selected");
    expect(utilRow).toHaveClass("lrow--selected");
  });

  it("the inline rename prompt is labelled with operation + target, and Escape cancels back to the triggering row without committing", async () => {
    const user = userEvent.setup();
    const rename = vi.fn(() => Promise.resolve());
    const createFile = vi.fn(() => Promise.resolve());
    render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ rename, createFile }} />,
    );
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");

    // Rename… on index.ts → a labelled input (not placeholder-only naming).
    const row = screen.getByText("index.ts").closest("div.tnode") as HTMLElement;
    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /Rename/ }));
    const input = screen.getByRole("textbox", { name: "Rename index.ts" });
    expect(input).toHaveFocus();
    await user.type(input, "x");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(rename).not.toHaveBeenCalled(); // a cancel is not a blur-commit
    expect(row).toHaveFocus(); // focus returns to the row that opened it

    // The create prompt names its operation and directory the same way.
    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu2 = await screen.findByRole("menu");
    await user.click(within(menu2).getByRole("menuitem", { name: /New file here/ }));
    expect(screen.getByRole("textbox", { name: "New file in /src" })).toBeInTheDocument();
  });

  it("the transient error banner is dismissed by a focusable Dismiss button", async () => {
    const user = userEvent.setup();
    const rename = vi.fn(() => Promise.resolve());
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ rename }} />);
    await screen.findByText("src");
    // A cross-root drop is rejected with the banner (the easiest headless path).
    const srcRow = screen.getByText("src").closest("div.tnode") as HTMLElement;
    fireEvent.drop(srcRow, {
      dataTransfer: {
        types: ["application/x-ir-file-move"],
        files: [],
        getData: (t: string) =>
          t === "application/x-ir-file-move"
            ? JSON.stringify({ from: "/spaces/s1/x.md", rootPath: "/spaces/s1" })
            : "",
        setData: () => {},
        dropEffect: "",
        effectAllowed: "",
      },
    });
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/spaces/i);
    await user.click(within(banner).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
