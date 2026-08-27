import {
  CONTENT_MARKER_FILE,
  openWithLabel,
  opensWithOffer,
  parseOpensWith,
  withdrawsOffer,
} from "./opensWith";

const policy = { offerable: ["open-wiki", "open-project"] };
const marker = (o: unknown) => JSON.stringify(o);

describe("parseOpensWith — an untrusted marker never throws", () => {
  it("names the marker file the specs name", () => {
    expect(CONTENT_MARKER_FILE).toBe("immediately.run.json");
  });

  it("reads the task and defaults the version to the v1 shape", () => {
    expect(parseOpensWith(marker({ opensWith: { task: "open-wiki" }, kind: "wiki" }))).toEqual({
      task: "open-wiki",
      version: "1.0",
      kind: "wiki",
    });
  });

  it("keeps an explicit version", () => {
    expect(
      parseOpensWith(marker({ opensWith: { task: "open-wiki", version: "1.2" } })),
    ).toMatchObject({ version: "1.2" });
  });

  it.each<[string, unknown]>([
    ["empty text", ""],
    ["whitespace", "   "],
    ["invalid JSON", "{ not json"],
    ["a JSON scalar", '"wiki"'],
    ["a JSON array", "[1,2]"],
    ["no opensWith key", marker({ kind: "wiki" })],
    ["opensWith not an object", marker({ opensWith: "open-wiki" })],
    ["opensWith an array", marker({ opensWith: ["open-wiki"] })],
    ["a non-string task", marker({ opensWith: { task: 7 } })],
    ["an empty task", marker({ opensWith: { task: "  " } })],
  ])("returns null for %s", (_why, text) => {
    expect(parseOpensWith(text as string)).toBeNull();
  });

  it("returns null for absent bytes (an unreadable / missing marker)", () => {
    expect(parseOpensWith(null)).toBeNull();
    expect(parseOpensWith(undefined)).toBeNull();
  });
});

describe("openWithLabel — the label comes from the marker's kind, never a task name", () => {
  it("uses the author's kind", () => {
    expect(openWithLabel("wiki")).toBe("Open as wiki");
    expect(openWithLabel("board")).toBe("Open as board");
    expect(openWithLabel("Design System")).toBe("Open as design system");
  });

  it("falls back to a generic label when there is no kind", () => {
    expect(openWithLabel(undefined)).toBe("Open with its app");
    expect(openWithLabel("")).toBe("Open with its app");
  });

  it.each([
    ["markup", "<img src=x onerror=alert(1)>"],
    ["a newline", "wiki\nSign in to continue"],
    ["a control character", "wiki"],
    ["a right-to-left override", "wiki‮gnp.exe"],
    ["an essay", "w".repeat(200)],
    ["a leading joiner", "-wiki"],
  ])(
    "refuses %s and shows the generic label instead of sanitizing it into shape",
    (_why, kind) => {
      expect(openWithLabel(kind)).toBe("Open with its app");
    },
  );
});

describe("opensWithOffer — absent affordance is the answer to every refusal", () => {
  it("offers a declared contract, labelled by the marker's kind", () => {
    const o = opensWithOffer(marker({ opensWith: { task: "open-wiki" }, kind: "wiki" }), policy);
    expect(o).toEqual({ task: "open-wiki", version: "1.0", label: "Open as wiki" });
  });

  it("offers a SECOND contract from the same code path, with no task name in it", () => {
    const o = opensWithOffer(
      marker({ opensWith: { task: "open-project" }, kind: "project" }),
      policy,
    );
    expect(o).toEqual({ task: "open-project", version: "1.0", label: "Open as project" });
  });

  it("offers a declared contract even when the marker names no usable kind", () => {
    const o = opensWithOffer(marker({ opensWith: { task: "open-wiki" } }), policy);
    expect(o).toMatchObject({ task: "open-wiki", label: "Open with its app" });
  });

  it("a marker naming a contract this app does not invoke → no affordance, not an error", () => {
    expect(
      opensWithOffer(marker({ opensWith: { task: "open-hologram" }, kind: "hologram" }), policy),
    ).toBeNull();
  });

  it("a folder with no marker → no affordance", () => {
    expect(opensWithOffer(null, policy)).toBeNull();
  });

  it("withdraws a contract the host has already refused this session", () => {
    const text = marker({ opensWith: { task: "open-wiki" }, kind: "wiki" });
    expect(opensWithOffer(text, policy)).not.toBeNull();
    expect(opensWithOffer(text, { ...policy, unavailable: new Set(["open-wiki"]) })).toBeNull();
  });

  it("cannot be talked into offering anything when the app declares nothing", () => {
    expect(opensWithOffer(marker({ opensWith: { task: "open-wiki" } }), { offerable: [] })).toBeNull();
  });
});

describe("withdrawsOffer — a cancel is not a refusal", () => {
  it("keeps offering after the user closes the viewer", () => {
    expect(withdrawsOffer("cancelled")).toBe(false);
  });

  it("stops offering a contract that is structurally dead", () => {
    expect(withdrawsOffer("no-such-task")).toBe(true);
    expect(withdrawsOffer("not-declared")).toBe(true);
    expect(withdrawsOffer("task-version-mismatch")).toBe(true);
  });

  it("keeps offering after a one-off failure (transient, unknown, or a bad delegation)", () => {
    expect(withdrawsOffer("forbidden")).toBe(false);
    expect(withdrawsOffer("timeout")).toBe(false);
    expect(withdrawsOffer(undefined)).toBe(false);
  });
});
