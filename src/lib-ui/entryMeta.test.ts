import { describe, it, expect } from "vitest";
import { extOf, fileTypeLabel, compareEntries } from "./entryMeta";

describe("extOf", () => {
  it("returns the lowercased final extension", () => {
    expect(extOf("App.tsx")).toBe("tsx");
    expect(extOf("index.CSS")).toBe("css");
    expect(extOf("archive.tar.gz")).toBe("gz");
  });
  it("returns empty for dotfiles and no-extension names", () => {
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe(""); // leading dot is not an extension
    expect(extOf("Makefile")).toBe("");
  });
});

describe("fileTypeLabel", () => {
  it("labels directories as Folder", () => {
    expect(fileTypeLabel("src", true)).toBe("Folder");
  });
  it("maps known extensions to friendly names", () => {
    expect(fileTypeLabel("App.tsx", false)).toBe("React TS");
    expect(fileTypeLabel("data.json", false)).toBe("JSON");
    expect(fileTypeLabel("notes.md", false)).toBe("Markdown");
  });
  it("degrades unknown/extensionless files without mislabeling", () => {
    expect(fileTypeLabel("thing.xyz", false)).toBe("XYZ file");
    expect(fileTypeLabel("LICENSE", false)).toBe("File");
  });
});

describe("compareEntries", () => {
  const dir = (name: string) => ({ name, isDir: true });
  const file = (name: string) => ({ name, isDir: false });

  it("always orders directories before files", () => {
    expect(compareEntries(file("a"), dir("z"), "name")).toBeGreaterThan(0);
    expect(compareEntries(dir("z"), file("a"), "name")).toBeLessThan(0);
  });
  it("sorts by name case-insensitively", () => {
    expect(compareEntries(file("Apple"), file("banana"), "name")).toBeLessThan(0);
    expect(compareEntries(file("b"), file("a"), "name")).toBeGreaterThan(0);
  });
  it("sorts by type label then name when key is type", () => {
    // "JSON" < "React TS" alphabetically.
    expect(compareEntries(file("z.json"), file("a.tsx"), "type")).toBeLessThan(0);
    // Same type → tie-break on name.
    expect(compareEntries(file("b.ts"), file("a.ts"), "type")).toBeGreaterThan(0);
  });
});
