// R3-267 — the SDK half: the manifest↔code parity that keeps the declared contract
// list honest, the marker probe, and the invoke's delegation + refusal handling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplorerRoot, FsSource } from "../types";

const invokeTask = vi.fn();
const capDir = vi.fn((ref: unknown, opts: unknown) => ({ $cap: "dir", ...(ref as object), ...(opts as object) }));

vi.mock("@immediately-run/sdk", () => ({
  invokeTask: (...a: unknown[]) => invokeTask(...a),
  capDir: (...a: unknown[]) => capDir(...(a as [unknown, unknown])),
}));

const { DECLARED_TASKS, MAX_MARKER_BYTES, openWith, probeOffer, readMarker } = await import("./openWith");

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
  capDir.mockClear();
  invokeTask.mockResolvedValue({ opened: true });
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
