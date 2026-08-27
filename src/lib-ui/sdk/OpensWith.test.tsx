// R3-267 — the directory-as-content trigger, end to end through the shipped app.
//
// The defect this closes was not a missing mechanism: the contracts, bindings,
// delegation minting and overlay all existed and were tested. What was missing was
// the CALLER. So these tests assert exactly that — a folder that declares what opens
// it gets an affordance in the file manager, and using it invokes the contract the
// marker names with a delegation for that folder.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../types";

const TREE: Record<string, DirEntry[]> = {
  "/spaces/s1": [
    { name: "handbook", isDir: true },
    { name: "board", isDir: true },
    { name: "sketches", isDir: true },
    { name: "shed", isDir: true },
    { name: "note.md", isDir: false },
  ],
  "/spaces/s1/handbook": [{ name: "home.mdx", isDir: false }],
  "/spaces/s1/board": [{ name: "objects.json", isDir: false }],
  "/spaces/s1/sketches": [],
  "/spaces/s1/shed": [],
};

// Marker files, keyed by their absolute path. `handbook` is a wiki, `board` a
// project, `sketches` names a contract this app does not invoke, `shed` has none.
const MARKERS: Record<string, string> = {
  "/spaces/s1/handbook/immediately.run.json": JSON.stringify({
    opensWith: { task: "open-wiki", version: "1.0" },
    kind: "wiki",
  }),
  "/spaces/s1/board/immediately.run.json": JSON.stringify({
    opensWith: { task: "open-project" },
    kind: "board",
  }),
  "/spaces/s1/sketches/immediately.run.json": JSON.stringify({
    opensWith: { task: "open-hologram" },
    kind: "hologram",
  }),
};

const h = vi.hoisted(() => ({
  mounts: [] as Array<Record<string, unknown>>,
  readdir: vi.fn<(path: string) => Promise<DirEntry[]>>(() => Promise.resolve([])),
  readFile: vi.fn<(path: string) => Promise<Uint8Array>>(() => Promise.reject(new Error("ENOENT"))),
  invokeTask: vi.fn((): Promise<unknown> => Promise.resolve({ opened: true })),
}));

vi.mock("@immediately-run/sdk/sandboxUtils", () => ({
  addListener: () => () => {},
  sendMessage: vi.fn(),
}));

vi.mock("@immediately-run/sdk", () => ({
  useMounts: () => h.mounts,
  useSessionMounts: () => [],
  useEditorContext: () => ({ dirtyPaths: [], openFiles: [], activeFile: null, viewedFile: null }),
  openInEditor: vi.fn(() => Promise.resolve()),
  createFile: vi.fn(() => Promise.resolve()),
  createFolder: vi.fn(() => Promise.resolve()),
  deleteEntry: vi.fn(() => Promise.resolve()),
  renameEntry: vi.fn(() => Promise.resolve()),
  uploadFile: vi.fn(() => Promise.resolve()),
  startItemDrag: vi.fn(() => Promise.resolve()),
  cancelItemDrag: vi.fn(),
  unmountSpace: vi.fn(() => Promise.resolve()),
  listSettingsApps: vi.fn(() => Promise.resolve([])),
  openSettingsOf: vi.fn(() => Promise.resolve({})),
  requestMount: vi.fn(() => new Promise(() => {})),
  useRegion: () => null,
  invokeTask: (task: string, params: Record<string, unknown>) => h.invokeTask(task, params),
  capDir: (ref: { mountId: string; relPath: string }, opts: { mode: "ro" | "rw" }) => ({
    $cap: "dir",
    ...ref,
    ...opts,
  }),
}));

vi.mock("./mountFs", () => ({
  readdir: (p: string) => h.readdir(p),
  readFile: (p: string) => h.readFile(p),
  sdkFsSource: { readdir: (p: string) => h.readdir(p), readFile: (p: string) => h.readFile(p) },
}));

import FileExplorer from "./SdkFileExplorer";

const space = (over: Record<string, unknown> = {}) => ({
  type: "firestore",
  path: "/spaces/s1",
  id: "space:s1",
  name: "Team",
  mode: "rw",
  rules: [{ subtree: "/", mode: "rw" }],
  ...over,
});

/** Right-click a row and return its open menu. */
async function menuFor(label: string) {
  fireEvent.contextMenu(screen.getByText(label));
  return screen.findByRole("menu");
}

/** The labels a row's context menu offers. Empty when the row has no menu at all —
 *  the view opens none when nothing is offerable, which is the strongest form of
 *  "no affordance". */
function menuLabelsFor(label: string): string[] {
  fireEvent.contextMenu(screen.getByText(label));
  const menu = screen.queryByRole("menu");
  return menu
    ? within(menu)
        .queryAllByRole("menuitem")
        .map((el) => el.textContent ?? "")
    : [];
}

beforeEach(() => {
  h.mounts = [space()];
  h.readdir.mockReset();
  h.readdir.mockImplementation((path: string) => Promise.resolve(TREE[path] ?? []));
  h.readFile.mockReset();
  h.readFile.mockImplementation((path: string) =>
    MARKERS[path] !== undefined
      ? Promise.resolve(new TextEncoder().encode(MARKERS[path]))
      : Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  );
  h.invokeTask.mockReset();
  h.invokeTask.mockResolvedValue({ opened: true });
});

afterEach(() => vi.clearAllMocks());

describe("R3-267 — a folder's opensWith marker finally has a caller", () => {
  it("offers a marked folder by its KIND, and opens it with the contract the marker names", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("handbook");
    // The probe rides the listing the explorer already did.
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/handbook/immediately.run.json"));

    const menu = await menuFor("handbook");
    const item = within(menu).getByRole("menuitem", { name: /Open as wiki/ });
    await user.click(item);

    expect(h.invokeTask).toHaveBeenCalledTimes(1);
    const [task, params] = h.invokeTask.mock.calls[0] as [string, Record<string, unknown>];
    expect(task).toBe("open-wiki");
    expect(params.dir).toEqual({ $cap: "dir", mountId: "space:s1", relPath: "/handbook", mode: "rw" });
  });

  it("opens a DIFFERENT contract from the same code path — no task name in the caller", async () => {
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("board");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/board/immediately.run.json"));

    const menu = await menuFor("board");
    await user.click(within(menu).getByRole("menuitem", { name: /Open as board/ }));

    expect(h.invokeTask.mock.calls[0][0]).toBe("open-project");
  });

  it("a marker naming a contract nothing is bound to degrades to NO affordance", async () => {
    render(<FileExplorer />);
    await screen.findByText("sketches");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/sketches/immediately.run.json"));

    expect(menuLabelsFor("sketches")).toEqual([]);
    expect(h.invokeTask).not.toHaveBeenCalled();
  });

  it("an ordinary folder gets no affordance", async () => {
    render(<FileExplorer />);
    await screen.findByText("shed");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/shed/immediately.run.json"));

    expect(menuLabelsFor("shed")).toEqual([]);
  });

  it("delegates at the mount's own mode — a ro space opens a ro corpus, never EROFS-later", async () => {
    h.mounts = [space({ mode: "ro", rules: [{ subtree: "/", mode: "ro" }] })];
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("handbook");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/handbook/immediately.run.json"));

    await user.click(within(await menuFor("handbook")).getByRole("menuitem", { name: /Open as wiki/ }));
    expect((h.invokeTask.mock.calls[0][1] as { dir: { mode: string } }).dir.mode).toBe("ro");
  });

  it("a user closing the viewer (cancelled) leaves the affordance in place", async () => {
    h.invokeTask.mockRejectedValue(Object.assign(new Error("dismissed"), { code: "cancelled" }));
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("handbook");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/handbook/immediately.run.json"));

    await user.click(within(await menuFor("handbook")).getByRole("menuitem", { name: /Open as wiki/ }));
    await waitFor(() => expect(h.invokeTask).toHaveBeenCalledTimes(1));

    const again = await menuFor("handbook");
    expect(within(again).getByRole("menuitem", { name: /Open as wiki/ })).toBeInTheDocument();
  });

  it("a host refusal WITHDRAWS the affordance instead of showing a protocol code", async () => {
    h.invokeTask.mockRejectedValue(Object.assign(new Error("nope"), { code: "no-such-task" }));
    const user = userEvent.setup();
    render(<FileExplorer />);
    await screen.findByText("handbook");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/handbook/immediately.run.json"));

    await user.click(within(await menuFor("handbook")).getByRole("menuitem", { name: /Open as wiki/ }));
    await waitFor(() => expect(h.invokeTask).toHaveBeenCalledTimes(1));

    // No error text anywhere, and the dead affordance is gone.
    expect(screen.queryByText(/no-such-task/)).not.toBeInTheDocument();
    await waitFor(() => expect(menuLabelsFor("handbook")).toEqual([]));
  });

  it("probes each listed directory once, not on every menu open", async () => {
    render(<FileExplorer />);
    await screen.findByText("handbook");
    await waitFor(() => expect(h.readFile).toHaveBeenCalledWith("/spaces/s1/handbook/immediately.run.json"));
    const after = h.readFile.mock.calls.filter(
      (c) => c[0] === "/spaces/s1/handbook/immediately.run.json",
    ).length;

    await menuFor("handbook");
    fireEvent.keyDown(document, { key: "Escape" });
    await menuFor("handbook");

    expect(
      h.readFile.mock.calls.filter((c) => c[0] === "/spaces/s1/handbook/immediately.run.json").length,
    ).toBe(after);
  });
});
