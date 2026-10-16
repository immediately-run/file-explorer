// R3-267 — the SDK half: the manifest↔code parity that keeps the declared contract
// list honest, the marker probe, and the invoke's delegation + refusal handling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerRoot, FsSource } from "../types";

const invokeTask = vi.fn();
const launch = vi.fn();
const openBundle = vi.fn();
const capDir = vi.fn((ref: unknown, opts: unknown) => ({ $cap: "dir", ...(ref as object), ...(opts as object) }));

vi.mock("@immediately-run/sdk", () => ({
  invokeTask: (...a: unknown[]) => invokeTask(...a),
  launch: (...a: unknown[]) => launch(...a),
  openBundle: (...a: unknown[]) => openBundle(...a),
  capDir: (...a: unknown[]) => capDir(...(a as [unknown, unknown])),
}));

const { DECLARED_TASKS, DECLARED_LAUNCHES, MAX_MARKER_BYTES, openInPlace, openWith, probeOffer, readMarker } =
  await import("./openWith");

const enc = (s: string) => new TextEncoder().encode(s);

const fsWith = (files: Record<string, string | Uint8Array>): FsSource => ({
  readdir: async () => [],
  readFile: async (p: string) => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return typeof v === "string" ? enc(v) : v;
  },
});

const root = (over: Partial<ExplorerRoot> = {}): ExplorerRoot => ({
  id: "space:abc",
  path: "/spaces/abc",
  label: "Notes",
  kind: "space",
  writable: false,
  grants: [{ subtree: "/", mode: "rw" }],
  ...over,
});

beforeEach(() => {
  invokeTask.mockReset();
  launch.mockReset();
  openBundle.mockReset();
  capDir.mockClear();
  invokeTask.mockResolvedValue({ opened: true });
  launch.mockResolvedValue({ launchId: "launch-1", onDismiss: () => () => {} });
  // R3-808: the tab open resolves by default — the overlay is the fallback, not the rule.
  openBundle.mockResolvedValue(undefined);
});

describe("DECLARED_TASKS mirrors the manifest — §5.8 least authority, pinned", () => {
  // Read from the repo root (vitest's cwd) rather than a module URL: the shipped app is
  // transpiled to CommonJS, where that token is a parse-time SyntaxError.
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const declared: { task: string }[] = manifest["immediately.run"]?.invokes ?? [];

  it("declares in package.json exactly the contracts the code will offer", () => {
    expect([...declared.map((d) => d.task)].sort()).toEqual([...DECLARED_TASKS].sort());
  });

  it("requests the capability those invocations need", () => {
    expect(manifest["immediately.run"]?.requests).toHaveProperty("task:invoke");
  });
});

describe("DECLARED_LAUNCHES mirrors the manifest (R3-159) — R-SAL-3, pinned", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));

  it("declares in package.json exactly the contracts the code will launch in place", () => {
    const declared: { task: string }[] = manifest["immediately.run"]?.launches ?? [];
    expect([...declared.map((d) => d.task)].sort()).toEqual([...DECLARED_LAUNCHES].sort());
  });

  it("launches a SUBSET of the invocable contracts — launch never exceeds invoke", () => {
    for (const task of DECLARED_LAUNCHES) expect(DECLARED_TASKS).toContain(task);
  });
});

describe("readMarker", () => {
  it("reads the marker file beside the directory", async () => {
    const fs = fsWith({ "/spaces/abc/wiki/immediately.run.json": '{"opensWith":{"task":"open-wiki"}}' });
    await expect(readMarker(fs, "/spaces/abc/wiki")).resolves.toContain("open-wiki");
  });

  it("returns null when the folder carries none (the common case)", async () => {
    await expect(readMarker(fsWith({}), "/spaces/abc/src")).resolves.toBeNull();
  });

  it("returns null when the fs cannot read bytes at all", async () => {
    await expect(readMarker({ readdir: async () => [] }, "/spaces/abc")).resolves.toBeNull();
  });

  it("refuses to decode an absurdly large 'marker' rather than doing that work", async () => {
    const fs = fsWith({ "/spaces/abc/x/immediately.run.json": new Uint8Array(MAX_MARKER_BYTES + 1) });
    await expect(readMarker(fs, "/spaces/abc/x")).resolves.toBeNull();
  });
});

describe("probeOffer", () => {
  it("offers a declared contract, labelled from the marker's kind", async () => {
    const fs = fsWith({
      "/spaces/abc/wiki/immediately.run.json": '{"opensWith":{"task":"open-wiki"},"kind":"wiki"}',
    });
    await expect(probeOffer(fs, "/spaces/abc/wiki", { offerable: DECLARED_TASKS })).resolves.toEqual({
      task: "open-wiki",
      version: "1.0",
      label: "Open as wiki",
    });
  });

  it("offers open-workbook — the workbook corpus's door (R3-754)", async () => {
    const fs = fsWith({
      "/content/wb/immediately.run.json": '{"opensWith":{"task":"open-workbook"},"kind":"workbook"}',
    });
    await expect(probeOffer(fs, "/content/wb", { offerable: DECLARED_TASKS })).resolves.toEqual({
      task: "open-workbook",
      version: "1.0",
      label: "Open as workbook",
    });
  });

  it("offers the roadmap board's app-form marker through open-declared, and invokes it with the folder alone (R3-547)", async () => {
    // The marker docs/content/roadmap/board/ actually carries.
    const fs = fsWith({
      "/docs/content/roadmap/board/immediately.run.json": JSON.stringify({
        opensWith: { app: "github:immediately-run/kanban-board", version: "1.0" },
        kind: "board",
      }),
    });
    const offer = await probeOffer(fs, "/docs/content/roadmap/board", { offerable: DECLARED_TASKS });
    expect(offer).toEqual({ task: "open-declared", version: "1.0", label: "Open as board" });
    await openWith(root({ id: "space:docs", path: "/docs" }), "/docs/content/roadmap/board", offer!);
    // R3-808: the tab open carries the delegated directory and nothing else — no
    // `app` key (the retired open-with shape the host refuses), no app identity.
    expect(Object.keys(openBundle.mock.calls[0][0])).toEqual(["dir"]);
    expect(invokeTask).not.toHaveBeenCalled();
    expect(JSON.stringify(openBundle.mock.calls[0])).not.toContain("kanban-board");
  });

  it("a declared view is invoked through open-declared with dir AND the view's name — never its app (R3-789)", async () => {
    const offer = { task: "open-declared", version: "1.0", label: "Open as Roadmap board", view: "Roadmap board" };
    await openWith(root({ id: "space:docs", path: "/docs" }), "/docs/content", offer);
    // The tab open carries the view's NAME beside the directory — the host resolves
    // which app shows it.
    expect(Object.keys(openBundle.mock.calls[0][0]).sort()).toEqual(["dir", "view"]);
    expect(openBundle.mock.calls[0][0].view).toBe("Roadmap board");
  });

  it("offers nothing for a marker naming a contract this app does not invoke", async () => {
    const fs = fsWith({ "/spaces/abc/x/immediately.run.json": '{"opensWith":{"task":"open-hologram"}}' });
    await expect(probeOffer(fs, "/spaces/abc/x", { offerable: DECLARED_TASKS })).resolves.toBeNull();
  });
});

describe("openWith — the bundle opens in its own tab; the overlay is the fallback (R3-808)", () => {
  const offer = { task: "open-wiki", version: "1.0", label: "Open as wiki" };

  it("opens addressable directories with the host's openBundle verb — no overlay invoke", async () => {
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "opened" });
    expect(openBundle).toHaveBeenCalledTimes(1);
    expect(openBundle.mock.calls[0][0]).toEqual({
      dir: { $cap: "dir", mountId: "space:abc", relPath: "/wiki", mode: "rw" },
    });
    expect(invokeTask).not.toHaveBeenCalled();
  });

  it("forwards a declared view by NAME — the host resolves which app shows it", async () => {
    await openWith(root(), "/spaces/abc/wiki", { ...offer, view: "board" });
    expect(openBundle.mock.calls[0][0]).toEqual({
      dir: { $cap: "dir", mountId: "space:abc", relPath: "/wiki", mode: "rw" },
      view: "board",
    });
  });

  it.each(["unaddressable", "unsupported", "timeout"] as const)(
    "falls back to the overlay invoke on %s — the open that ran before the verb existed",
    async (code) => {
      openBundle.mockRejectedValue(Object.assign(new Error("no tab"), { code }));
      await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "opened" });
      expect(invokeTask).toHaveBeenCalledTimes(1);
      expect(invokeTask.mock.calls[0][0]).toBe("open-wiki");
      expect(invokeTask.mock.calls[0][1]).toEqual({
        dir: { $cap: "dir", mountId: "space:abc", relPath: "/wiki", mode: "rw" },
      });
    },
  );

  it("delegates at the mount's OWN mode — a ro grant opens a ro corpus (R3-266)", async () => {
    await openWith(root({ grants: [{ subtree: "/", mode: "ro" }] }), "/spaces/abc/wiki", offer);
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/wiki" }, { mode: "ro" });
  });

  it("honours the longest matching grant rule, not the mount-wide one", async () => {
    const r = root({
      grants: [
        { subtree: "/", mode: "ro" },
        { subtree: "/wiki", mode: "rw" },
      ],
    });
    await openWith(r, "/spaces/abc/wiki", offer);
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/wiki" }, { mode: "rw" });
  });

  it("asks for ro when the grant rule-set is unknown (never over-asks)", async () => {
    await openWith(root({ grants: undefined }), "/spaces/abc/wiki", offer);
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/wiki" }, { mode: "ro" });
  });

  it("a real refusal of the TAB open never pays the overlay round trip — no-activation declines", async () => {
    openBundle.mockRejectedValue(Object.assign(new Error("no gesture"), { code: "no-activation" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
    expect(invokeTask).not.toHaveBeenCalled();
  });

  it("treats a user-closed viewer as ordinary — the affordance stays", async () => {
    openBundle.mockRejectedValue(Object.assign(new Error("no tab"), { code: "unaddressable" }));
    invokeTask.mockRejectedValue(Object.assign(new Error("no"), { code: "cancelled" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
  });

  it("withdraws a contract nothing is bound to, instead of surfacing no-such-task", async () => {
    openBundle.mockRejectedValue(Object.assign(new Error("no tab"), { code: "unaddressable" }));
    invokeTask.mockRejectedValue(Object.assign(new Error("no"), { code: "no-such-task" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({
      status: "withdraw",
      task: "open-wiki",
    });
  });

  it("never rethrows a protocol error at the caller, whatever the code and whichever path", async () => {
    openBundle.mockRejectedValue(Object.assign(new Error("boom"), { code: "forbidden" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
    openBundle.mockRejectedValue(new Error("no code at all"));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
    openBundle.mockRejectedValue(Object.assign(new Error("no tab"), { code: "timeout" }));
    invokeTask.mockRejectedValue(new Error("no code at all"));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
  });
});

describe("openInPlace — run the folder's project TO-RUN in the stage (R3-159)", () => {
  const offer = { task: "open-project", version: "1.0", label: "Open in place" };

  it("launches the marker's contract into the stage with a capDir for that directory", async () => {
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "opened" });
    expect(launch).toHaveBeenCalledTimes(1);
    const [target, opts] = launch.mock.calls[0] as [
      { task: string },
      { region: string; input: { dir: unknown } },
    ];
    expect(target).toEqual({ task: "open-project" });
    expect(opts.region).toBe("stage");
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/proj" }, { mode: "ro" });
  });

  it("delegates ro even on an rw mount — the R-SAL-6 default, unlike openWith", async () => {
    // The rw-into-stage host confirm is a follow-on; the into-stage capDir ships ro.
    await openInPlace(root({ grants: [{ subtree: "/", mode: "rw" }] }), "/spaces/abc/proj", offer);
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/proj" }, { mode: "ro" });
  });

  it("pins the whole LaunchErrorCode union — EVERY refusal declines, none withdraws", async () => {
    // The host resolves `unsupported` for transient states too (launch host not yet
    // mounted, absent launch context, create failing before bind), so no launch code
    // is a safe session-permanent verdict — a fork's `forbidden` and a full stage's
    // `budget` included, the affordance always stays.
    for (const code of [
      "forbidden",
      "unsupported",
      "budget",
      "revoked",
      "cancelled",
      "invalid-params",
      "unknown",
    ]) {
      launch.mockResolvedValue({ ok: false, code });
      await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({
        status: "declined",
      });
    }
  });

  it("never throws — an off-host rejection is ordinary too", async () => {
    launch.mockRejectedValue(new Error("no host transport"));
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "declined" });
    launch.mockRejectedValue(Object.assign(new Error("nope"), { code: "unsupported" }));
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "declined" });
  });
});
