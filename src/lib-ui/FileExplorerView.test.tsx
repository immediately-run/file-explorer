// Headless-view contract (Phase 02 §D): exercises `FileExplorerView` with a FAKE
// `FsSource` and SPY `actions` and NO SDK mock at all. This proves the view is
// fully decoupled from the host SDK — a non-SDK consumer (file-commander) drives
// it exactly this way.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FileExplorerView from "./FileExplorerView";
import type { DirEntry, ExplorerRoot, FsSource } from "./types";

// A two-level fixture tree the fake FsSource resolves from. Mutable: a write
// test can land its file in the tree before the action resolves, exactly as a
// real write lands it in the real fs, before the authority answers.
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

const readdir = vi.fn((path: string) => Promise.resolve(TREE[path] ?? []));
const fakeFs: FsSource = {
  readdir,
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const SRC_ENTRIES = [
  { name: "index.ts", isDir: false },
  { name: "util.ts", isDir: false },
];

const worktree: ExplorerRoot = {
  id: "repo",
  path: "/mnt/abc",
  label: "repo",
  kind: "worktree",
  writable: true,
  scopes: [{ subtree: "/", mode: "rw" }],
  ejectable: false,
};

// A read-only space mount — the §2 "affordances hidden on read-only scopes"
// case for the upload button's destination fallback.
const roSpace: ExplorerRoot = {
  id: "space:s1",
  path: "/spaces/s1",
  label: "s1",
  kind: "space",
  writable: false,
  scopes: [{ subtree: "/", mode: "ro" }],
  ejectable: false,
};

beforeEach(() => {
  readdir.mockClear();
  TREE["/mnt/abc/src"] = [...SRC_ENTRIES];
});
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

  it("a provided action shows its affordance — Delete from the row's menu confirms then deletes, and the row disappears optimistically", async () => {
    // The action IS the write: it lands the delete in the fixture tree, exactly
    // as the host's delete lands it in the real fs, before resolving.
    const del = vi.fn(() => {
      TREE["/mnt/abc/src"] = TREE["/mnt/abc/src"].filter((e) => e.name !== "index.ts");
      return Promise.resolve("/src/index.ts");
    });
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ delete: del }} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    expect(del).toHaveBeenCalledWith(worktree, "/src/index.ts");
    confirm.mockRestore();
    // The collection shows the change immediately (R-IX-3): the row is gone
    // before any refetch is granted a say.
    await vi.waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "index.ts" })).toBeNull(),
    );
  });

  it("cancelling the delete confirm removes nothing and leaves the row in place", async () => {
    const del = vi.fn(() => Promise.resolve("/src/index.ts"));
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ delete: del }} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /^Delete/ }));
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toBeInTheDocument();
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
    const rename = vi.fn(() => Promise.resolve({ name: "x", isDir: false }));
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
            ? JSON.stringify({ from: "/spaces/s1/x.md", rootPath: "/spaces/s1", isDir: false })
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

// --- R-IX-3 / R-IX-4: a write renders its own result ---------------------------
describe("FileExplorerView write path (optimistic rows, narrow refetch)", () => {
  async function renderSrcExpanded(ui: ReactElement) {
    const user = userEvent.setup();
    const utils = render(ui);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");
    return { user, ...utils };
  }

  it("a create renders its row immediately, pending, at final position; the return settles it; only the changed directory is refetched", async () => {
    let resolveCreate!: (v: { name: string; isDir: boolean } | null) => void;
    const createFile = vi.fn(
      () => new Promise<{ name: string; isDir: boolean } | null>((res) => (resolveCreate = res)),
    );
    const { user } = await renderSrcExpanded(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ createFile }} />,
    );
    const callsBefore = readdir.mock.calls.length;

    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /New file here/ }));
    await user.type(screen.getByRole("textbox", { name: "New file in /src" }), "aaa.ts{Enter}");

    // PENDING — the row is there between dispatch and settle, at its final
    // position (folders first, then names: aaa.ts < index.ts).
    const pending = screen.getByRole("treeitem", { name: "aaa.ts" });
    expect(pending).toHaveClass("tnode--pending");
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(
      pending.compareDocumentPosition(screen.getByText("index.ts")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("Creating aaa.ts…");
    expect(createFile).toHaveBeenCalledWith(worktree, "/src/aaa.ts");

    // The write lands, then the return settles the row — no read yet.
    TREE["/mnt/abc/src"] = [
      { name: "aaa.ts", isDir: false },
      ...SRC_ENTRIES,
    ];
    await act(async () => resolveCreate({ name: "aaa.ts", isDir: false }));
    const settled = await screen.findByRole("treeitem", { name: "aaa.ts" });
    expect(settled).not.toHaveClass("tnode--pending");
    expect(settled).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveTextContent("Created aaa.ts.");

    // The post-write authority refetch is NARROW: one call, for /mnt/abc/src —
    // never `refresh()`'s every-open-directory sweep (/mnt/abc is open too).
    await act(async () => {});
    expect(readdir.mock.calls.length).toBe(callsBefore + 1);
    expect(readdir.mock.calls.at(-1)).toEqual(["/mnt/abc/src"]);
  });

  it("a failed create restores the previous state and names the reason in text + announcement", async () => {
    let rejectCreate!: (e: unknown) => void;
    const createFile = vi.fn(
      () =>
        new Promise<{ name: string; isDir: boolean } | null>((_, rej) => (rejectCreate = rej)),
    );
    const { user } = await renderSrcExpanded(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ createFile }} />,
    );

    fireEvent.contextMenu(screen.getByText("index.ts"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /New file here/ }));
    await user.type(screen.getByRole("textbox", { name: "New file in /src" }), "zzz.ts{Enter}");
    expect(screen.getByRole("treeitem", { name: "zzz.ts" })).toBeInTheDocument();

    await act(async () =>
      rejectCreate(Object.assign(new Error("exists"), { code: "exists" })),
    );
    // Restored: the row is gone, the reason is in the banner AND the region.
    await vi.waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "zzz.ts" })).toBeNull(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something with that name already exists.",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Couldn’t create zzz\.ts/);
  });

  it("a move via the 'Move to…' picker commits through the SAME action the drag takes", async () => {
    const rename = vi.fn(() => Promise.resolve({ name: "README.md", isDir: false }));

    // The drag path: drop README.md onto the src directory row.
    {
      const user = userEvent.setup();
      const { unmount } = render(
        <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ rename }} />,
      );
      await screen.findByText("src");
      await user.click(screen.getByText("src"));
      await screen.findByText("index.ts");
      const move = { from: "/mnt/abc/README.md", rootPath: "/mnt/abc", isDir: false };
      fireEvent.drop(screen.getByText("src").closest("div.tnode") as HTMLElement, {
        dataTransfer: {
          types: ["application/x-ir-file-move"],
          files: [],
          getData: (t: string) =>
            t === "application/x-ir-file-move" ? JSON.stringify(move) : "",
          setData: () => {},
          dropEffect: "",
          effectAllowed: "",
        },
      });
      expect(rename).toHaveBeenCalledWith(worktree, "/README.md", "/src/README.md", false);
      unmount();
    }
    rename.mockClear();

    // The picker path, from a clean render: Move to… → choose src → Move here.
    {
      const user = userEvent.setup();
      render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ rename }} />);
      await screen.findByText("src");
      fireEvent.contextMenu(screen.getByText("README.md"));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: /Move to/ }));
      const dialog = await screen.findByRole("dialog", {
        name: "Move README.md to a folder",
      });
      await user.click(within(dialog).getByRole("treeitem", { name: "src" }));
      await user.click(within(dialog).getByRole("button", { name: "Move here" }));

      // One action, two triggers — identical arguments.
      expect(rename).toHaveBeenCalledWith(worktree, "/README.md", "/src/README.md", false);
      expect(screen.getByRole("status")).toHaveTextContent(/Moved README\.md to \/src/);
    }
  });
});

// --- APG Tree View: one tab stop, roving arrows, the row is the treeitem -------
describe("FileExplorerView tree keyboard (APG)", () => {
  it("exactly one tab stop; the focusable row itself is the treeitem carrying the filename (4.1.2)", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("util.ts");

    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeGreaterThan(1);
    expect(items.filter((el) => el.tabIndex === 0)).toHaveLength(1);

    const row = screen.getByRole("treeitem", { name: "index.ts" });
    expect(row).toHaveClass("tnode"); // the role is on the FOCUSABLE row element
    expect(row.tabIndex).toBe(-1); // …and only the stop is tabbable
  });

  it("Down/Home/End move focus across the visible rows", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("util.ts");

    screen.getByRole("treeitem", { name: "repo" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("treeitem", { name: "repo" })).toHaveFocus();
    await user.keyboard("{End}");
    // Visible order is repo, src, index.ts, util.ts, README.md (folders first).
    expect(screen.getByRole("treeitem", { name: "README.md" })).toHaveFocus();
  });

  it("the tab stop follows the focused row", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("util.ts");

    const util = screen.getByRole("treeitem", { name: "util.ts" });
    await user.click(util);
    expect(util.tabIndex).toBe(0);
    expect(
      screen.getAllByRole("treeitem").filter((el) => el.tabIndex === 0),
    ).toEqual([util]);
  });
});

// --- uploads: the batch write announces both halves and refetches narrowly ------
describe("FileExplorerView upload path", () => {
  it("announces Uploading…/Uploaded and refetches only the target directory", async () => {
    const callsBeforeBase = readdir.mock.calls.length;
    let resolveUpload!: () => void;
    const upload = vi.fn(
      () => new Promise<void>((res) => (resolveUpload = res)),
    );
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ upload }} />);
    await screen.findByText("src");
    const callsBefore = readdir.mock.calls.length;

    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByText("src").closest("div.tnode") as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [file],
        getData: () => "",
        setData: () => {},
        dropEffect: "",
        effectAllowed: "",
      },
    });
    expect(upload).toHaveBeenCalledWith(worktree, "/src", [file]);
    expect(screen.getByRole("status")).toHaveTextContent("Uploading 1 file…");
    expect(readdir.mock.calls.length).toBe(callsBefore); // no refetch before settle

    TREE["/mnt/abc/src"] = [...SRC_ENTRIES, { name: "note.txt", isDir: false }];
    await act(async () => resolveUpload());
    expect(screen.getByRole("status")).toHaveTextContent("Uploaded 1 file.");
    await act(async () => {});
    expect(readdir.mock.calls.length).toBe(callsBefore + 1);
    expect(readdir.mock.calls.at(-1)).toEqual(["/mnt/abc/src"]);
    expect(callsBefore > callsBeforeBase).toBe(true); // the reads above were real
  });

  it("a failed upload names the reason in banner + announcement, no refetch", async () => {
    let rejectUpload!: (e: unknown) => void;
    const upload = vi.fn(
      () =>
        new Promise<void>((_, rej) => (rejectUpload = rej)),
    );
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ upload }} />);
    await screen.findByText("src");
    const callsBefore = readdir.mock.calls.length;

    fireEvent.drop(screen.getByText("src").closest("div.tnode") as HTMLElement, {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["hello"], "big.bin", { type: "text/plain" })],
        getData: () => "",
        setData: () => {},
        dropEffect: "",
        effectAllowed: "",
      },
    });
    await act(async () =>
      rejectUpload(Object.assign(new Error("too large"), { code: "too-large" })),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("That file is too large to upload.");
    expect(screen.getByRole("status")).toHaveTextContent(/Couldn’t upload/);
    expect(readdir.mock.calls.length).toBe(callsBefore);
  });
});

// --- §5 upload button: the native-picker path and its destination rules ---------
describe("FileExplorerView upload button (FILE_EXPLORER_SPEC §5)", () => {
  const picker = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[type="file"]')!;

  it("uploads to the repo root when nothing is selected", async () => {
    const upload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ upload }} />,
    );
    await screen.findByText("README.md");

    fireEvent.click(screen.getByRole("button", { name: "Upload files to the repo root" }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(picker(container), { target: { files: [file] } });

    expect(upload).toHaveBeenCalledWith(worktree, "/", [file]);
  });

  it("uploads into the selected directory (and the row exposes its selection)", async () => {
    const user = userEvent.setup();
    const upload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ upload }} />,
    );
    await screen.findByText("src");
    await user.click(screen.getByText("src"));

    // The clicked folder is selected, and the button's label names it as the
    // destination — the rule is discoverable on the affordance itself.
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload files to /src" }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(picker(container), { target: { files: [file] } });

    expect(upload).toHaveBeenCalledWith(worktree, "/src", [file]);
  });

  it("uploads into the selected file's parent, so it becomes a sibling", async () => {
    const user = userEvent.setup();
    const upload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ upload }} />,
    );
    await user.click(await screen.findByText("src"));
    await screen.findByText("index.ts");
    await user.click(screen.getByText("index.ts"));

    fireEvent.click(screen.getByRole("button", { name: "Upload files to /src" }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(picker(container), { target: { files: [file] } });

    expect(upload).toHaveBeenCalledWith(worktree, "/src", [file]);
  });

  it("a selection inside a read-only scope falls back to the repo root", async () => {
    const user = userEvent.setup();
    const upload = vi.fn(() => Promise.resolve());
    const { container } = render(
      <FileExplorerView
        roots={[worktree, roSpace]}
        fs={fakeFs}
        actions={{ upload }}
      />,
    );
    await user.click(await screen.findByText("note.md"));

    fireEvent.click(screen.getByRole("button", { name: "Upload files to the repo root" }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    fireEvent.change(picker(container), { target: { files: [file] } });

    expect(upload).toHaveBeenCalledWith(worktree, "/", [file]);
  });

  it("hides the button when there is no writable root (no shown-then-EROFS)", async () => {
    render(
      <FileExplorerView roots={[roSpace]} fs={fakeFs} actions={{ upload: vi.fn() }} />,
    );
    await screen.findByText("note.md");
    expect(screen.queryByRole("button", { name: /^Upload files to/ })).not.toBeInTheDocument();
  });
});

// --- every layout's rows expose the menu by keyboard (ContextMenu / Shift+F10) ---
describe("row menu key (ContextMenu / Shift+F10) reaches every layout's rows", () => {
  it("list layout: the menu key on an option opens the row's context menu", async () => {
    const del = vi.fn(() => Promise.resolve("/README.md"));
    const user = userEvent.setup();
    render(
      <FileExplorerView
        roots={[worktree]}
        fs={fakeFs}
        layout="list"
        actions={{ delete: del }}
      />,
    );
    // The uncontrolled list starts at the roots-root; enter the single mount.
    await user.click(await screen.findByRole("option", { name: /^repo/ }));
    const readme = await screen.findByRole("option", { name: /README\.md/ });
    readme.focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Delete/ })).toBeInTheDocument();
  });

  it("tree layout: the ContextMenu key opens the row's menu at the row", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ open: vi.fn() }} />);
    const readme = await screen.findByRole("treeitem", { name: "README.md" });
    readme.focus();
    await user.keyboard("{ContextMenu}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /Open/ })).toBeInTheDocument();
  });
});

// --- the picker is keyboard-operable end to end (the 2.5.7 path itself) --------
describe("MoveDialog keyboard", () => {
  it("Tab reaches the footer buttons (Move here / Cancel) from the tree", async () => {
    const rename = vi.fn(() => Promise.resolve({ name: "README.md", isDir: false }));
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} actions={{ rename }} />);
    await screen.findByText("src");
    fireEvent.contextMenu(screen.getByText("README.md"));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: /Move to/ }));
    const dialog = await screen.findByRole("dialog", { name: "Move README.md to a folder" });

    // Choose a destination first — "Move here" is disabled (outside the trap)
    // until something is chosen.
    await user.click(within(dialog).getByRole("treeitem", { name: "src" }));

    // Focus starts in the tree (the dialog's first focusable). Tab walks the
    // tree's stop, then reaches the footer buttons — the trap bounds the PANEL.
    const lastTreeStop = [
      ...dialog.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]'),
    ].pop()!;
    lastTreeStop.focus();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await user.keyboard("{Tab}");
      reached = document.activeElement?.textContent === "Move here";
    }
    expect(reached).toBe(true);
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Move here" }),
    );
  });
});

// --- ArrowRight steps into an open folder's first child (APG Tree View) --------
describe("tree ArrowRight step-in", () => {
  it("ArrowRight on an OPEN folder focuses its first child row", async () => {
    const user = userEvent.setup();
    render(<FileExplorerView roots={[worktree]} fs={fakeFs} />);
    await screen.findByText("src");
    await user.click(screen.getByText("src"));
    await screen.findByText("index.ts");

    screen.getByRole("treeitem", { name: "src" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: "index.ts" })).toHaveFocus();
  });
});
