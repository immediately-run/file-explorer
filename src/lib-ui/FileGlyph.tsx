// The type icon for one entry, shared by every layout (R3-84). Lucide only,
// `currentColor`, sizable — folders read as folders (open/closed), files map to a
// small set of category glyphs by extension, unknowns fall back to a plain file.
// One component per file, default-exported (file-explorer CLAUDE.md rule 4); the
// extension→icon map is a private const so the Fast Refresh rule holds.
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  FileCode,
  FileJson,
  FileText,
  FileImage,
  FileType,
  type LucideIcon,
} from "lucide-react";
import { extOf } from "./entryMeta";

const BY_EXT: Record<string, LucideIcon> = {
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  css: FileCode,
  scss: FileCode,
  html: FileCode,
  sh: FileCode,
  json: FileJson,
  md: FileText,
  mdx: FileText,
  txt: FileText,
  yml: FileText,
  yaml: FileText,
  toml: FileText,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  woff: FileType,
  woff2: FileType,
  ttf: FileType,
  otf: FileType,
};

function FileGlyph({
  name,
  isDir,
  open = false,
  size = 15,
}: {
  name: string;
  isDir: boolean;
  open?: boolean;
  size?: number;
}) {
  const Icon: LucideIcon = isDir ? (open ? FolderOpen : Folder) : (BY_EXT[extOf(name)] ?? FileIcon);
  return <Icon size={size} aria-hidden="true" />;
}

export default FileGlyph;
