// Pure, framework-free metadata helpers for the alternative layouts (R3-84):
// a human file-type label and entry ordering. No React, no SDK, no I/O — unit
// tested directly (ways_of_working §5; file-explorer CLAUDE.md: utilities live in
// src/lib/). The list/columns layouts show the type as the row's secondary meta
// and let the user sort by name or type; the icon grid uses the same label as the
// tile's accessible description.

/** Lowercased final extension of a name (no dot), or "" when there is none. */
export const extOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

// A small, deliberately-curated map from extension to a friendly type label. It
// is NOT exhaustive — unknown extensions fall back to "<EXT> file" / "File", so
// adding a language never silently mislabels. Kept here (data) rather than in a
// component file so the Fast Refresh rule holds.
const TYPE_LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "React TS",
  js: "JavaScript",
  jsx: "React JS",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  css: "Stylesheet",
  scss: "Stylesheet",
  html: "HTML",
  md: "Markdown",
  mdx: "MDX",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  gif: "Image",
  svg: "Image",
  webp: "Image",
  ico: "Image",
  woff: "Font",
  woff2: "Font",
  ttf: "Font",
  otf: "Font",
  lock: "Lockfile",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  txt: "Text",
  sh: "Shell",
};

/** A human-readable type label for a row's secondary meta column. Directories
 *  read "Folder"; known files map to a friendly name; unknown files degrade to
 *  "<EXT> file" or plain "File". */
export const fileTypeLabel = (name: string, isDir: boolean): string => {
  if (isDir) return "Folder";
  const ext = extOf(name);
  if (!ext) return "File";
  return TYPE_LABELS[ext] ?? `${ext.toUpperCase()} file`;
};

export type SortKey = "name" | "type";

export interface SortableEntry {
  name: string;
  isDir: boolean;
}

/**
 * Compare two entries for the list view's sort. Directories always sort before
 * files (Finder/desktop convention, matching `readdir`'s own ordering), then by
 * the chosen key. `name` is a locale-aware case-insensitive compare; `type`
 * orders by the type label, breaking ties by name. Pure + stable so it unit-tests
 * directly and never depends on render order.
 */
export const compareEntries = (
  a: SortableEntry,
  b: SortableEntry,
  key: SortKey,
): number => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  if (key === "type" && !a.isDir && !b.isDir) {
    const ta = fileTypeLabel(a.name, false);
    const tb = fileTypeLabel(b.name, false);
    const t = ta.localeCompare(tb);
    if (t !== 0) return t;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
};
