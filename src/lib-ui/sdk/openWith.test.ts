// R3-267 — the SDK half: the manifest↔code parity that keeps the declared contract
// list honest, the marker probe, and the invoke's delegation + refusal handling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerRoot, FsSource } from "../types";

const invokeTask = vi.fn();
const launch = vi.fn();
const capDir = vi.fn((ref: unknown, opts: unknown) => ({ $cap: "dir", ...(ref as object), ...(opts as object) }));

vi.mock("@immediately-run/sdk", () => ({
  invokeTask: (...a: unknown[]) => invokeTask(...a),
  launch: (...a: unknown[]) => launch(...a),
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
  capDir.mockClear();
  invokeTask.mockResolvedValue({ opened: true });
  launch.mockResolvedValue({ launchId: "launch-1", onDismiss: () => () => {} });
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

  it("offers nothing for a marker naming a contract this app does not invoke", async () => {
    const fs = fsWith({ "/spaces/abc/x/immediately.run.json": '{"opensWith":{"task":"open-hologram"}}' });
    await expect(probeOffer(fs, "/spaces/abc/x", { offerable: DECLARED_TASKS })).resolves.toBeNull();
  });
});

describe("openWith — delegates the folder, and only the folder", () => {
  const offer = { task: "open-wiki", version: "1.0", label: "Open as wiki" };

  it("invokes the marker's contract with a capDir for that directory", async () => {
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "opened" });
    expect(invokeTask).toHaveBeenCalledTimes(1);
    expect(invokeTask.mock.calls[0][0]).toBe("open-wiki");
    expect(capDir).toHaveBeenCalledWith({ mountId: "space:abc", relPath: "/wiki" }, { mode: "rw" });
  });

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

  it("treats a user-closed viewer as ordinary — the affordance stays", async () => {
    invokeTask.mockRejectedValue(Object.assign(new Error("no"), { code: "cancelled" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
  });

  it("withdraws a contract nothing is bound to, instead of surfacing no-such-task", async () => {
    invokeTask.mockRejectedValue(Object.assign(new Error("no"), { code: "no-such-task" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({
      status: "withdraw",
      task: "open-wiki",
    });
  });

  it("never rethrows a protocol error at the caller, whatever the code", async () => {
    invokeTask.mockRejectedValue(Object.assign(new Error("boom"), { code: "forbidden" }));
    await expect(openWith(root(), "/spaces/abc/wiki", offer)).resolves.toEqual({ status: "declined" });
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

  it("treats a refusal-resolved launch as ordinary — the affordance stays", async () => {
    // A fork (no elevated principal) gets `forbidden`; a full stage gets `budget`.
    // Both are states, not verdicts on the contract.
    launch.mockResolvedValue({ ok: false, code: "forbidden" });
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "declined" });
    launch.mockResolvedValue({ ok: false, code: "budget" });
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "declined" });
  });

  it("withdraws a contract the launch path reports as unbound (unsupported)", async () => {
    launch.mockResolvedValue({ ok: false, code: "unsupported" });
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({
      status: "withdraw",
      task: "open-project",
    });
  });

  it("never throws — an off-host rejection is ordinary too", async () => {
    launch.mockRejectedValue(new Error("no host transport"));
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({ status: "declined" });
  });

  it("pins the whole LaunchErrorCode union — only `unsupported` withdraws", async () => {
    for (const code of ["forbidden", "budget", "revoked", "cancelled", "invalid-params", "unknown"]) {
      launch.mockResolvedValue({ ok: false, code });
      await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({
        status: "declined",
      });
    }
    launch.mockResolvedValue({ ok: false, code: "unsupported" });
    await expect(openInPlace(root(), "/spaces/abc/proj", offer)).resolves.toEqual({
      status: "withdraw",
      task: "open-project",
    });
  });
});
