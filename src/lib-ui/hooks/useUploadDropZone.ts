// The container-level OS-file upload drop zone (R3-626 / FILE_EXPLORER_SPEC §5).
//
// The rows (`useRowInteractions`) answer a drop for THEMSELVES — but only a
// directory row does, and deliberately so: `if (!isDir) return` is what lets a
// file row's event bubble to a container that can resolve it, the same shape
// file-explorer#40 gave the tree's scope. This hook is that container for the
// three flat layouts, ONE implementation instead of three drifting copies: in
// list and icons the fallback is the browsed cwd; in columns the hook is called
// PER COLUMN, so the fallback is that column's directory (column 0 — the mounts
// list — has none, and accepts nothing).
//
// Only OS files are accepted at container level: an internal move (MOVE_MIME)
// needs a real directory row, and `moveRejection` is the rows' to apply — the
// same rule #40 set for the tree's scope. A read-only target accepts nothing
// and never lights the affordance (§5: the drop is rejected, no EROFS surfaced).
import { useState } from "react";
import { uploadRowFromEvent } from "../explorer";

export function useUploadDropZone({
  fallbackDir,
  writable,
  onUploadDrop,
}: {
  /** Where a drop that misses every row lands. `null` = this container has no
   *  directory to offer (the mounts root) — it accepts nothing at all. */
  fallbackDir: string | null;
  writable: boolean;
  onUploadDrop: (files: File[], targetDir: string, writable: boolean) => void;
}): {
  dropProps: {
    /** The affordance (§5): `[data-drag="1"]` on the owning container, styled
     *  beside `.mount[data-drag="1"]` — set HERE, so the attribute has the one
     *  writer (the shared hook; the tree's scope is the other). */
    "data-drag"?: "1";
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    /** Capture phase: a drop a DIRECTORY row takes stops propagation in the
     *  bubble phase, so this container's onDrop never runs and the lit
     *  affordance would stick. The capture handler runs before that. */
    onDropCapture: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  const [dragging, setDragging] = useState(false);
  const accepts = (e: React.DragEvent): boolean =>
    fallbackDir !== null && writable && e.dataTransfer.types.includes("Files");

  const onDragOver = (e: React.DragEvent) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    // `dragleave` fires when crossing between children too; only a pointer that
    // has actually left the container clears the affordance.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!accepts(e) || fallbackDir === null) return;
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) return;
    e.preventDefault();
    setDragging(false);
    // The row under the pointer, if any, answers for itself in the DOM: a
    // directory row stopped propagation long before this handler, so what
    // arrives here is a file row (→ its parent) or no row (→ the fallback).
    onUploadDrop(files, uploadRowFromEvent(e, fallbackDir), writable);
  };

  return {
    dropProps: {
      "data-drag": dragging ? "1" : undefined,
      onDragOver,
      onDragLeave,
      onDropCapture: () => setDragging(false),
      onDrop,
    },
  };
}
