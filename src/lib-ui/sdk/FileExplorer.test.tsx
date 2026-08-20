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
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../types";

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
  // Raw host->app message listeners (the mocked sandboxUtils.addListener registry).
  rawListeners: new Map<string, Set<(m: unknown) => void>>(),
  emit(type: string, msg: unknown) {
    for (const fn of h.rawListeners.get(type) ?? []) fn(msg);
  },
  mounts: [] as Array<{ type: string; path: string; id?: string }>,
  // The first-party Session-lens list (R3-95). Default none: a non-first-party frame
  // (a fork) receives `[]`, so the "App | Session" toggle never renders.
  sessionMounts: [] as Array<{ type: string; path: string; id?: string; name?: string; mode?: "ro" | "rw"; forwardedToApp: boolean }>,
  // The editor-context active file (FX-4b). Mutable so a test can move it and
  // re-render, mirroring a host push.
  activeFile: null as string | null,
  // The stage's viewed-document hint (R3-268), pushed on the same channel.
  viewedFile: null as string | null,
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
  // R3-269 D5: the host powerbox request. Never resolves by default — the flow is
  // host-owned; these tests only assert the app ASKS.
  requestMount: vi.fn((): Promise<unknown> => new Promise(() => {})),
  // The app's RegionId (R3-96): `page.commander` makes the app default to the broad
  // registry lens. Default null (a `panel.files` projection behaves App-first as before).
  region: null as string | null,
}));

// The subpath module the reveal listener rides. The REAL sandboxUtils cannot load
// under vitest (tsup extensionless specifiers), and mocking it here also gives the
// suite a controllable host->app channel: push with h.emit('viewed-reveal', msg).
vi.mock("@immediately-run/sdk/sandboxUtils", () => ({
  addListener: (type: string, handler: (m: unknown) => void) => {
    const set = h.rawListeners.get(type) ?? new Set<(m: unknown) => void>();
    set.add(handler);
    h.rawListeners.set(type, set);
    return () => set.delete(handler);
  },
  sendMessage: vi.fn(),
}));

vi.mock("@immediately-run/sdk", () => ({
  useMounts: () => h.mounts,
  useSessionMounts: () => h.sessionMounts,
  useEditorContext: () => ({
    dirtyPaths: [],
    openFiles: [],
    activeFile: h.activeFile,
    viewedFile: h.viewedFile,
  }),
  openInEditor: (path: string) => h.openInEditor(path),
  createFile: vi.fn(() => Promise.resolve()),
  createFolder: vi.fn(() => Promise.resolve()),
  deleteEntry: (path: string) => h.deleteEntry(path),
  renameEntry: (from: string, to: string) => h.renameEntry(from, to),
  uploadFile: (path: string, bytes: Uint8Array) => h.uploadFile(path, bytes),
  startItemDrag: (item: unknown) => h.startItemDrag(item),
  cancelItemDrag: () => h.cancelItemDrag(),
  unmountSpace: vi.fn(() => Promise.resolve()),
  // settings:all enumeration — default to none so the base file tree is unaffected.
  listSettingsApps: () => h.listSettingsApps(),
  openSettingsOf: vi.fn(() => Promise.resolve({ type: "firestore", path: "/mnt/set", id: "settings:x" })),
  requestMount: () => h.requestMount(),
  useRegion: () => h.region,
}));

vi.mock("./mountFs", () => ({
  readdir: (path: string) => h.readdir(path),
  readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  sdkFsSource: {
    readdir: (path: string) => h.readdir(path),
    readFile: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  },
}));

import FileExplorer from "./SdkFileExplorer";

const worktree = (id = "repo") => ({ type: "worktree", path: "/mnt/abc", id });

beforeEach(() => {
  h.mounts = [worktree()];
  h.sessionMounts = [];
  h.activeFile = null;
  h.viewedFile = null;
  h.rawListeners.clear();
  h.region = null;
  h.openInEditor.mockClear();
  h.readdir.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Render, wait for the root to load, expand `src`, wait for its children.
 *  When `activeFile` points into `src`, the editor-active reveal has already
 *  opened it — clicking again would CLOSE it, so only click when still closed. */
async function renderWithSrcExpanded() {
  const user = userEvent.setup();
  const utils = render(<FileExplorer />);
  // Root is open by default → top-level entries appear.
  await screen.findByText("src");
  const src = screen.getByRole("treeitem", { name: "src" });
  if (src.getAttribute("aria-expanded") !== "true") {
    await user.click(screen.getByText("src"));
  }
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

// --- R3-94: App-scope per-mount header (PRINCIPALS §9 B1 / FILE_EXPLORER §2) ----
describe("R3-94 — app-scope per-mount header", () => {
  it("lists one mode chip per granted subtree, each read-only on a non-worktree mount", async () => {
    h.mounts = [
      {
        type: "firestore",
        path: "/spaces/s1",
        id: "space:s1",
        name: "Shared notes",
        mode: "ro",
        rules: [
          { subtree: "/notes", mode: "rw" },
          { subtree: "/drafts", mode: "ro" },
        ],
      } as never,
    ];
    render(<FileExplorer />);
    const scope = (await screen.findByRole("tree", { name: "Shared notes" })).closest(
      ".mount",
    ) as HTMLElement;
    const chips = within(scope).getAllByText(/read-only|read-write/);
    // One chip per subtree, and a granted `rw` subtree is still shown read-only (v1:
    // only the worktree is writable — never shown-then-EROFS).
    // Ordered root-first then A→Z (here: /drafts before /notes).
    expect(chips.map((c) => c.textContent)).toEqual([
      expect.stringContaining("/drafts · read-only"),
      expect.stringContaining("/notes · read-only"),
    ]);
  });

  it("the worktree header shows a single read-write whole-mount chip", async () => {
    h.mounts = [worktree()];
    render(<FileExplorer />);
    const scope = (await screen.findByRole("tree", { name: "repo" })).closest(
      ".mount",
    ) as HTMLElement;
    const chips = within(scope).getAllByText(/read-only|read-write/);
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain("/ · read-write");
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

// --- R3-269 D4/D5/D6 — the explorer as the spaces entry point ----------------
describe("R3-269 — add-a-space + manage-sharing entry points", () => {
  it("the header's 'Add a space…' asks the HOST powerbox (requestMount)", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("src");
    await user.click(screen.getByRole("button", { name: "Add a space…" }));
    expect(h.requestMount).toHaveBeenCalledTimes(1);
  });

  it("the empty state carries the first-timer sentence + an Add-a-space action", async () => {
    h.mounts = [];
    const user = userEvent.setup();
    render(<FileExplorer />);
    // D6 copy, R-SPACES-1 vocabulary (space/folder — never mount/filesystem).
    const copy = await screen.findByText(/A space is a folder that lives in your account/);
    const state = copy.closest(".state") as HTMLElement;
    await user.click(within(state).getByRole("button", { name: /Add a space…/ }));
    expect(h.requestMount).toHaveBeenCalled();
  });

  it("a space ROOT row's menu offers 'Manage sharing →' opening /spaces at that space", async () => {
    // getHostOrigin() reads the iframe's `?href=` boot param — simulate the sandbox URL.
    window.history.replaceState(
      {},
      "",
      "/?href=" + encodeURIComponent("https://immediately.run/edit/github/a/b/main/"),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      h.mounts = [{ type: "space", path: "/spaces/s1", id: "space:s1", name: "Shared notes" }];
      const user = userEvent.setup();
      render(<FileExplorer />);
      // The label appears in the scope header AND as the tree's root row — the row
      // (inside role=tree) is the one carrying the context menu.
      const tree = await screen.findByRole("tree", { name: "Shared notes" });
      fireEvent.contextMenu(within(tree).getByText("Shared notes"));
      const menu = await screen.findByRole("menu");
      await user.click(within(menu).getByRole("menuitem", { name: /Manage sharing/ }));
      expect(open).toHaveBeenCalledWith(
        "https://immediately.run/spaces?space=s1",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
      window.history.replaceState({}, "", "/");
    }
  });

  it("a non-root row inside a space does NOT offer 'Manage sharing →'", async () => {
    window.history.replaceState(
      {},
      "",
      "/?href=" + encodeURIComponent("https://immediately.run/edit/github/a/b/main/"),
    );
    try {
      h.mounts = [{ type: "space", path: "/spaces/s1", id: "space:s1", name: "Shared notes" }];
      render(<FileExplorer />);
      fireEvent.contextMenu(await screen.findByText("note.md"));
      const menu = await screen.findByRole("menu");
      expect(
        within(menu).queryByRole("menuitem", { name: /Manage sharing/ }),
      ).not.toBeInTheDocument();
    } finally {
      window.history.replaceState({}, "", "/");
    }
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
    expect(await screen.findByRole("alert")).toHaveTextContent(/spaces/);
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

describe("R3-95 — App | Session lens (PRINCIPALS §9 B2 / D-PRIN-4)", () => {
  const sessionSpace = () => ({
    type: "space",
    path: "/spaces/sess",
    id: "sess",
    name: "Session space",
    mode: "ro" as const,
    forwardedToApp: false,
  });

  it("(#5) hides the lens toggle when the host delivers no session signal (a fork)", async () => {
    h.mounts = [worktree()];
    h.sessionMounts = []; // fork: mounts:registry withheld → empty session list
    render(<FileExplorer />);
    expect(await screen.findByRole("tree", { name: "repo" })).toBeInTheDocument();
    // No Session lens: neither the toggle group nor the Session radio exists.
    expect(screen.queryByRole("radiogroup", { name: "Mount lens" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "The session's mounts" })).toBeNull();
  });

  it("shows the toggle for a first-party frame and switches roots to the session mounts", async () => {
    h.mounts = [worktree()]; // the App lens = this app's own mounts
    h.sessionMounts = [sessionSpace()]; // first-party: the session's mounts
    const user = userEvent.setup();
    render(<FileExplorer />);

    // App lens (default): the app's own worktree shows; the session-only space does NOT
    // (exit #1 — a session-only mount is never in the app's own view).
    expect(await screen.findByRole("tree", { name: "repo" })).toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "Session space" })).toBeNull();

    // The toggle is present (a session signal arrived). Switch to the Session lens.
    await user.click(screen.getByRole("radio", { name: "The session's mounts" }));

    // Session lens: the session mount shows; the App-lens worktree is replaced.
    expect(await screen.findByRole("tree", { name: "Session space" })).toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "repo" })).toBeNull();
  });

  it("(R3-96 step 4b) as the page.commander surface, DEFAULTS to the registry lens — no toggle", async () => {
    h.mounts = [worktree()]; // the app's own worktree (App lens)
    h.sessionMounts = [sessionSpace()]; // first-party registry lens available
    h.region = "page.commander"; // the standalone User-scope full manager
    render(<FileExplorer />);
    // WITHOUT clicking the toggle: the commander opens on the broad registry lens
    // (the "everything you've ever opened" navigator), so the session mount is the
    // default view and the app's own worktree is NOT.
    expect(await screen.findByRole("tree", { name: "Session space" })).toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "repo" })).toBeNull();
    // The toggle is still present so the user can narrow to the App lens.
    expect(screen.getByRole("radio", { name: "The session's mounts" })).toBeInTheDocument();
  });
});

describe("R3-238 — settings filesystems are hidden behind one advanced flag", () => {
  const settingsMount = () => ({
    type: "firestore",
    path: "/mnt/set/color-picker",
    id: "settings:color-picker",
    name: "color-picker settings",
    mode: "rw" as const,
  });

  beforeEach(() => {
    localStorage.clear(); // the flag persists; each case starts from the shipped default
  });

  it("a default session shows no settings root and no `settings · <app>` button", async () => {
    h.mounts = [worktree(), settingsMount()];
    h.listSettingsApps.mockResolvedValue(["agent-demo"]); // an app whose store isn't mounted
    render(<FileExplorer />);

    // The ordinary mount is untouched…
    expect(await screen.findByRole("tree", { name: "repo" })).toBeInTheDocument();
    // …and both settings affordances are absent.
    expect(screen.queryByRole("tree", { name: "color-picker settings" })).toBeNull();
    expect(screen.queryByTitle("Open agent-demo settings")).toBeNull();
    // The reveal control is offered, because this session HAS something hidden.
    expect(screen.getByRole("button", { name: "Show all filesystems" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("toggling the flag restores both the settings root and the header button, and persists", async () => {
    h.mounts = [worktree(), settingsMount()];
    h.listSettingsApps.mockResolvedValue(["agent-demo"]);
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByRole("tree", { name: "repo" });

    await user.click(screen.getByRole("button", { name: "Show all filesystems" }));

    expect(await screen.findByRole("tree", { name: "color-picker settings" })).toBeInTheDocument();
    expect(await screen.findByTitle("Open agent-demo settings")).toBeInTheDocument();
    // The ordinary mount is still there — this reveals, it does not replace.
    expect(screen.getByRole("tree", { name: "repo" })).toBeInTheDocument();
    expect(localStorage.getItem("ir.fileexplorer.showAllFilesystems")).toBe("1");
    // And the door swings back.
    expect(screen.getByRole("button", { name: "Hide advanced filesystems" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers no reveal control when the session has nothing hidden", async () => {
    h.mounts = [worktree()];
    h.listSettingsApps.mockResolvedValue([]);
    render(<FileExplorer />);
    await screen.findByRole("tree", { name: "repo" });
    expect(screen.queryByRole("button", { name: "Show all filesystems" })).toBeNull();
  });

  it("keeps the reveal control reachable when EVERYTHING is hidden (no dead end)", async () => {
    // The pathological commander case: every mount is a settings store, so the root
    // list is empty. The header's action cluster used to be gated on having roots —
    // which would hide the one control that brings them back.
    h.mounts = [settingsMount()];
    h.listSettingsApps.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<FileExplorer />);

    const toggle = await screen.findByRole("button", { name: "Show all filesystems" });
    expect(screen.queryByRole("tree")).toBeNull();
    await user.click(toggle);
    expect(await screen.findByRole("tree", { name: "color-picker settings" })).toBeInTheDocument();
  });

  it("hides settings stores in the Session lens too (the commander's default view)", async () => {
    h.mounts = [worktree()];
    h.sessionMounts = [
      { type: "space", path: "/spaces/s", id: "space:s", name: "Session space", mode: "ro", forwardedToApp: false },
      { ...settingsMount(), forwardedToApp: false },
    ];
    h.region = "page.commander"; // defaults to the Session lens
    h.listSettingsApps.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<FileExplorer />);

    expect(await screen.findByRole("tree", { name: "Session space" })).toBeInTheDocument();
    expect(screen.queryByRole("tree", { name: "color-picker settings" })).toBeNull();
    // The lens toggle still renders — `available` reads the raw session signal, not
    // the filtered roots, so filtering can never strand the user in one lens.
    expect(screen.getByRole("radio", { name: "The session's mounts" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all filesystems" }));
    expect(await screen.findByRole("tree", { name: "color-picker settings" })).toBeInTheDocument();
  });
});

describe("R3-239 — the header's size must not follow the mount-label length", () => {
  // The fix is CSS, which jsdom cannot lay out. What jsdom CAN pin is the MARKUP
  // CONTRACT the CSS depends on — the two seams that would silently un-fix it:
  // an ellipsis needs its own block box (a bare text node in a flex button can only
  // overflow), and the compact-view-switcher rule keys off the `--extra` modifier.
  // Geometry itself is verified in a headless-Chrome harness; numbers in the PR.
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("ir.fileexplorer.showAllFilesystems", "1");
  });

  it("renders the settings-app label in its own truncatable element", async () => {
    h.mounts = [worktree()];
    h.listSettingsApps.mockResolvedValue(["a-really-long-application-key"]);
    render(<FileExplorer />);

    const btn = await screen.findByTitle("Open a-really-long-application-key settings");
    const label = btn.querySelector(".settings-app__label");
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent("settings · a-really-long-application-key");
    // The label must be the ONLY text — an icon sibling, not a text sibling, or the
    // anonymous text node reappears and defeats `text-overflow`.
    expect(btn.textContent).toBe(label!.textContent);
  });

  it("marks the action cluster `--extra` when a consumer supplies header controls", async () => {
    h.mounts = [worktree()];
    h.listSettingsApps.mockResolvedValue(["cp"]);
    render(<FileExplorer />);
    await screen.findByTitle("Open cp settings");
    expect(document.querySelector(".panel__actions")).toHaveClass("panel__actions--extra");
  });
});

// --- R3-268 follow-up: gesture-gated reveal + collapsed-ancestor dot ----------
describe("viewed-document reveal + ancestor dot", () => {
  it("a collapsed folder containing the viewed file carries the dimmed ancestor dot", async () => {
    h.viewedFile = "/src/index.ts";
    render(<FileExplorer />);
    await screen.findByText("src"); // root listed; `src` starts COLLAPSED
    // The dot names its meaning; the folder itself never opens on its own.
    expect(
      await screen.findByRole("img", { name: "Contains the file shown in the running app" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
  });

  it("a host `viewed-reveal` expands the ancestors and scrolls the row into view — without focus", async () => {
    const scrolls: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this);
    };
    try {
      h.viewedFile = "/src/index.ts";
      render(<FileExplorer />);
      await screen.findByText("src");
      const before = document.activeElement;

      act(() => h.emit("viewed-reveal", { type: "viewed-reveal", path: "/src/index.ts" }));

      // Ancestors expanded → the row renders, carrying the on-stage marker…
      const row = await screen.findByText("index.ts");
      expect(row).toBeInTheDocument();
      expect(
        await screen.findByRole("img", { name: "Shown in the running app" }),
      ).toBeInTheDocument();
      // …the row is scrolled into view (bounded poll inside the view)…
      await waitFor(() => expect(scrolls.length).toBeGreaterThan(0));
      // …and focus NEVER moved (the activation-free half that still holds).
      expect(document.activeElement).toBe(before);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("without a reveal message the tree never moves on its own (highlight-only)", async () => {
    h.viewedFile = "/src/index.ts";
    render(<FileExplorer />);
    await screen.findByText("src");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument(); // still collapsed
  });
});

// --- The editor-active counterpart: reveal + glyph + ancestor dot -------------
// The bug this covers: switching a `/present/...` session to edit mode seeds the
// editor with the app's ENTRYPOINT, which lives under a collapsed folder — so the
// tree showed nothing at all about the file being edited.
describe("editor-active reveal + marker", () => {
  it("the editor's active file is revealed: ancestors expand and the row scrolls into view", async () => {
    const scrolls: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () {
      scrolls.push(this);
    };
    try {
      h.activeFile = "/src/index.ts";
      render(<FileExplorer />);
      await screen.findByText("src");
      const before = document.activeElement;

      // No gesture, no message: the host's editor-context push is enough.
      expect(await screen.findByText("index.ts")).toBeInTheDocument();
      expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await waitFor(() => expect(scrolls.length).toBeGreaterThan(0));
      // Reveal is scroll-only — focus never moves.
      expect(document.activeElement).toBe(before);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });

  it("the revealed row carries the 'Open in the editor' glyph, and siblings do not", async () => {
    h.activeFile = "/src/index.ts";
    render(<FileExplorer />);
    await screen.findByText("util.ts"); // the whole open directory rendered
    const marks = screen.getAllByRole("img", { name: "Open in the editor" });
    expect(marks).toHaveLength(1);
    expect(marks[0].closest("div.tnode")).toHaveClass("tnode--active");
    expect(marks[0].closest("div.tnode")).toContainElement(screen.getByText("index.ts"));
  });

  it("collapsing the folder leaves the dimmed ancestor dot — and never re-opens it", async () => {
    h.activeFile = "/src/index.ts";
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("index.ts"); // revealed

    await user.click(screen.getByText("src")); // the user closes it again

    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Contains the file open in the editor" }),
    ).toBeInTheDocument();
    // Expand-only: a folder the user closed stays closed.
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
  });

  it("the mounts arriving AFTER the active file still reveal it (the load race)", async () => {
    // The real ordering on a cold edit-mode boot: the editor-context push can beat
    // the mount list, and a reveal against an empty root set expands nothing.
    h.mounts = [];
    h.activeFile = "/src/index.ts";
    const { rerender } = render(<FileExplorer />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("src")).not.toBeInTheDocument(); // no roots yet

    h.mounts = [worktree()];
    rerender(<FileExplorer />);

    expect(await screen.findByText("index.ts")).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("no active file → no marker and no reveal", async () => {
    h.activeFile = null;
    render(<FileExplorer />);
    await screen.findByText("src");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Open in the editor" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Contains the file open in the editor" }),
    ).not.toBeInTheDocument();
  });
});
