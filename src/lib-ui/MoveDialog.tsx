// "Move to…" — the non-drag move path (WCAG 2.5.7: dragging movements have a
// single-pointer alternative). A dialog holding a tree of the WRITABLE
// directories, read from the SAME TreeStore the explorer's tree reads (real
// cached listings, lazily expanded through the same store), and committing
// through the same move path a drag-drop takes — one action, two triggers.
//
// The dialog contract (focus in, Tab trapped, Escape, focus return) is the
// shared useOverlayFocusDismiss hook; the row keyboard (Up/Down/Home/End,
// Right/Left expand/collapse, roving tab stop) is the tree contract the main
// tree uses.
import { useEffect, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { TreeStore, useRowFocused, useNode, useTreeUnfocused } from "./treeStore";
import { useOverlayFocusDismiss } from "./hooks/useOverlayFocusDismiss";
import { firstTreeChildFocus, rovingTreeFocus } from "./hooks/rovingTreeFocus";
import { joinPath, moveRefusalLabel } from "./explorer";
import type { DirEntry, ExplorerRoot } from "./types";

/** What is being moved (the context-menu row). */
export interface MoveTarget {
  absPath: string;
  rootPath: string;
  name: string;
  isDir: boolean;
}

/** One directory row: choose-on-click/Enter, expand via arrows or the same
 *  click. Directories only — the picker's tree is files-free by construction. */
function DirRow({
  path,
  name,
  depth,
  rootPath,
  store,
  chosen,
  onChoose,
}: {
  path: string;
  name: string;
  depth: number;
  rootPath: string;
  store: TreeStore;
  chosen: string | null;
  onChoose: (path: string) => void;
}) {
  const { expanded, errored, entries } = useNode(store, path);
  const open = expanded;
  const treeUnfocused = useTreeUnfocused(store, rootPath);
  const rowFocused = useRowFocused(store, path);
  const tabStop = rowFocused || (treeUnfocused && depth === 0);
  const dirs = (entries ?? []).filter((e) => e.isDir);

  useEffect(() => {
    if (open && entries === undefined && !errored) store.ensureLoaded(path);
  }, [open, entries, errored, path, store]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onChoose(path);
      if (!open) store.open(path);
    } else if (e.key === "ArrowRight") {
      if (!open) {
        store.open(path);
      } else {
        firstTreeChildFocus(e.currentTarget as HTMLElement);
      }
    } else if (e.key === "ArrowLeft" && open) {
      store.toggle(path);
    }
  };

  const Icon = open ? FolderOpen : Folder;
  return (
    <li role="none">
      <div
        role="treeitem"
        aria-expanded={open}
        aria-selected={chosen === path || undefined}
        tabIndex={tabStop ? 0 : -1}
        className={"mv-row" + (chosen === path ? " mv-row--chosen" : "")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onFocus={() => store.setFocus(path)}
        onClick={() => {
          onChoose(path);
          if (!open) store.open(path);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="mv-row__icon">
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="mv-row__name">{name}</span>
      </div>
      {open && (
        <ul role="group" className="mv-group">
          {errored && (
            <li className="mv-row mv-row--muted" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              Couldn’t read this folder.
            </li>
          )}
          {dirs.length === 0 && !errored && entries !== undefined && (
            <li className="mv-row mv-row--muted" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              No folders
            </li>
          )}
          {dirs.map((entry: DirEntry) => (
            <DirRow
              key={entry.name}
              path={joinPath(path, entry.name)}
              name={entry.name}
              depth={depth + 1}
              rootPath={rootPath}
              store={store}
              chosen={chosen}
              onChoose={onChoose}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function MoveDialog({
  target,
  roots,
  store,
  onMove,
  onClose,
}: {
  target: MoveTarget;
  /** Writable roots only — the picker lists destinations the move can land in. */
  roots: ExplorerRoot[];
  store: TreeStore;
  /** Commit: hand the chosen directory to the SAME move path a drag-drop
   *  takes (the view's onMoveDrop). */
  onMove: (dirAbs: string, dirRootPath: string) => void;
  onClose: () => void;
}) {
  const ref = useOverlayFocusDismiss<HTMLDivElement>(true, onClose);
  const [chosen, setChosen] = useState<string | null>(null);

  const writable = roots.filter((r) => r.writable);
  const chosenRoot = writable.find(
    (r) => chosen === r.path || (chosen !== null && chosen.startsWith(r.path + "/")),
  );
  const rejection =
    chosen && chosenRoot ? moveRefusalLabel(target, chosen, chosenRoot.path) : null;

  return (
    <div className="mv-overlay" onClick={onClose}>
      {/* The hook's ref bounds the PANEL — the Tab trap must include the
          footer buttons, or "Move here"/Cancel are keyboard-unreachable. */}
      <div
        className="mv-panel"
        role="dialog"
        aria-modal="true"
        aria-label={`Move ${target.name} to a folder`}
        onClick={(e) => e.stopPropagation()}
        ref={ref}
        tabIndex={-1}
      >
        <header className="mv-head">
          <span className="mv-title">Move {target.name}</span>
          <span className="mv-sub">Choose a folder</span>
        </header>
        <div className="mv-body">
          <div
            className="mv-trees"
            onKeyDown={(e) => {
              if (rovingTreeFocus(e.currentTarget, e.key)) e.preventDefault();
            }}
          >
            {writable.map((root) => (
              <ul key={root.path} role="tree" aria-label={root.label} className="mv-tree">
                <DirRow
                  path={root.path}
                  name={root.label}
                  depth={0}
                  rootPath={root.path}
                  store={store}
                  chosen={chosen}
                  onChoose={setChosen}
                />
              </ul>
            ))}
          </div>
        </div>
        <footer className="mv-foot">
          <span className="mv-reason">{rejection ?? ""}</span>
          <div className="mv-actions">
            <button type="button" className="mv-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="mv-btn mv-primary"
              disabled={!chosen || !!rejection}
              onClick={() => {
                if (!chosen || !chosenRoot || rejection) return;
                onMove(chosen, chosenRoot.path);
              }}
            >
              Move here
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
