// The shared row gesture bundle (R3-84). Every layout — tree, list, icons,
// columns — must support the SAME shipped affordances (FILE_EXPLORER_SPEC §3/§4):
// the context menu (right-click + 3s long-press), the internal move (R3-81) and
// upload (R3-82) drops onto a directory, and the cross-app drag-out (R3-83). The
// tree (`TreeNode`) grew these inline first; this hook lifts that logic out so
// list rows, icon tiles and column rows reuse ONE implementation instead of four
// drifting copies. It returns the spreadable DOM props + the live drop-target
// flag; the layout supplies its own onClick/onKeyDown (selection/navigation
// differ per layout) and renders the per-row delete affordance.
import { useState } from "react";
import { cancelItemDrag } from "@immediately-run/sdk";
import { MOVE_MIME } from "../lib/explorer";

/** Everything a row needs to identify itself to the shared handlers. */
export interface RowCtx {
  absPath: string;
  isDir: boolean;
  rootPath: string;
  mountId: string;
  writable: boolean;
}

/** The stable per-explorer callback bundle handed to every row. Each callback
 *  takes explicit args so one instance serves every scope/layout. */
export interface NodeHandlers {
  onOpenFile: (mountRel: string) => void;
  onActivate: (absPath: string, isDir: boolean) => void;
  onMenu: (e: { clientX: number; clientY: number }, ctx: RowCtx) => void;
  onMoveDrop: (fromAbs: string, fromRoot: string, targetDir: string, targetRoot: string) => void;
  onUploadDrop: (files: File[], targetDir: string, writable: boolean) => void;
  beginDragOut: (absPath: string, isDir: boolean, mountId: string, rootPath: string) => void;
  onDelete: (absPath: string, isDir: boolean, rootPath: string) => void;
}

export interface RowProps {
  draggable: true;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * Build the gesture props for one row. `longPress` is the pointer bundle from
 * `useLongPress` (the layout creates it so the menu opens at the row, mirroring
 * the tree). Returns `{ dropTarget, rowProps }`.
 */
export function useRowInteractions(
  ctx: RowCtx,
  handlers: NodeHandlers,
  longPress: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  },
): { dropTarget: boolean; rowProps: RowProps } {
  const [dropTarget, setDropTarget] = useState(false);
  const { absPath, isDir, rootPath, mountId, writable } = ctx;

  // Drag-out (R3-83) + internal move (R3-81) both start here: set the private move
  // payload (used only for an in-explorer drop) AND ask the host to begin a
  // cross-app drag-out; whichever drop fires wins (the other is cancelled).
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(MOVE_MIME, JSON.stringify({ from: absPath, rootPath }));
    e.dataTransfer.effectAllowed = "copyMove";
    handlers.beginDragOut(absPath, isDir, mountId, rootPath);
  };
  const onDragEnd = () => cancelItemDrag();

  // A directory row is a drop target for internal moves and OS-file uploads.
  const onDragOver = (e: React.DragEvent) => {
    if (!isDir) return;
    const isMove = e.dataTransfer.types.includes(MOVE_MIME);
    const isUpload = e.dataTransfer.types.includes("Files");
    if (!isMove && !isUpload) return;
    if (isUpload && !writable) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = isMove ? "move" : "copy";
    setDropTarget(true);
  };
  const onDragLeave = () => setDropTarget(false);
  const onDrop = (e: React.DragEvent) => {
    if (!isDir) return;
    const move = e.dataTransfer.getData(MOVE_MIME);
    const files = Array.from(e.dataTransfer.files);
    if (!move && !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);
    cancelItemDrag(); // the drop landed inside the explorer → not a drag-out
    if (move) {
      const { from, rootPath: fromRoot } = JSON.parse(move) as { from: string; rootPath: string };
      handlers.onMoveDrop(from, fromRoot, absPath, rootPath);
    } else if (files.length) {
      handlers.onUploadDrop(files, absPath, writable);
    }
  };

  const rowProps: RowProps = {
    draggable: true,
    onContextMenu: (e) => {
      e.preventDefault();
      handlers.onMenu(e, ctx);
    },
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
    onPointerDown: longPress.onPointerDown,
    onPointerMove: longPress.onPointerMove,
    onPointerUp: longPress.onPointerUp,
    onPointerCancel: longPress.onPointerCancel,
  };

  return { dropTarget, rowProps };
}
