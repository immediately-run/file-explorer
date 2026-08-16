// List layout (R3-84, brief 13 §2): single-column rows, no tree indentation,
// sortable by name or type. Navigates one directory at a time with a breadcrumb
// (the "Mounts" root lists the mounts; opening one drills in). Shares the tree's
// selection + active-file model and the §3/§4 gestures (context menu, move,
// upload, drag-out, delete) via `useRowInteractions`. ARIA: a `listbox` of
// `option` rows; arrow keys roam the rows.
import { memo, useMemo, useRef, useState } from "react";
import { Trash2, Play } from "lucide-react";
import { TreeStore, useSelected, useInSelection, useViewed } from "./treeStore";
import FileGlyph from "./FileGlyph";
import Breadcrumb from "./Breadcrumb";
import { useBrowse, type BrowseRow } from "./hooks/useBrowse";
import { useLongPress } from "./hooks/useLongPress";
import { useRowInteractions, type NodeHandlers } from "./hooks/useRowInteractions";
import { breadcrumbFor, toMountRel, isProtected } from "./explorer";
import { fileTypeLabel, compareEntries, type SortKey } from "./entryMeta";
import type { ExplorerRoot } from "./types";

const ListRow = memo(function ListRow({
  row,
  store,
  multi,
  cursorSelected,
  active,
  onOpen,
  handlers,
}: {
  row: BrowseRow;
  store: TreeStore;
  multi: boolean;
  cursorSelected: boolean;
  active: boolean;
  onOpen: (row: BrowseRow) => void;
  handlers: NodeHandlers;
}) {
  const { ctx, name } = row;
  // Under multi-select the highlight tracks membership in the store's selection
  // SET (via `useInSelection`); otherwise it tracks the single cursor. The hook
  // runs unconditionally (Rules of Hooks) — `multi` picks which drives the class.
  const inSelection = useInSelection(store, ctx.absPath);
  const selected = multi ? inSelection : cursorSelected;
  const longPress = useLongPress((x, y) => handlers.onMenu({ clientX: x, clientY: y }, ctx));
  const { dropTarget, rowProps } = useRowInteractions(ctx, handlers, longPress);
  const mountRel = toMountRel(ctx.rootPath, ctx.absPath);
  // The stage's "on stage" marker (R3-268) — store-subscribed per row like the
  // tree's, so a navigation re-renders only the affected rows.
  const viewedMatch = useViewed(store, mountRel);
  const viewed = !ctx.isDir && viewedMatch;
  const deletable = ctx.writable && ctx.absPath !== ctx.rootPath && !isProtected(mountRel);

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-current={active ? "true" : undefined}
      tabIndex={0}
      className={
        "lrow" +
        (selected ? " lrow--selected" : "") +
        (active ? " lrow--active" : "") +
        (viewed ? " lrow--viewed" : "") +
        (dropTarget ? " lrow--droptarget" : "")
      }
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row);
        }
      }}
      {...rowProps}
    >
      <span className="lrow__name">
        <span className="lrow__icon">
          <FileGlyph name={name} isDir={ctx.isDir} />
        </span>
        <span className="lrow__label">{name}</span>
        {viewed && (
          <span
            className="lrow__viewed"
            role="img"
            aria-label="Shown in the running app"
            title="Shown in the running app"
          >
            <Play size={11} aria-hidden="true" />
          </span>
        )}
      </span>
      <span className="lrow__type">{fileTypeLabel(name, ctx.isDir)}</span>
      {deletable && (
        <button
          type="button"
          className="tnode__del lrow__del"
          aria-label={`Delete ${name}`}
          title={`Delete ${name}`}
          onClick={(e) => {
            e.stopPropagation();
            handlers.onDelete(ctx.absPath, ctx.isDir, ctx.rootPath);
          }}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

function ListView({
  store,
  ordered,
  cwd,
  setCwd,
  activeFile,
  selectionMode = "single",
  handlers,
}: {
  store: TreeStore;
  ordered: ExplorerRoot[];
  cwd: string | null;
  setCwd: (path: string | null) => void;
  activeFile: string | null;
  selectionMode?: "single" | "multi" | "none";
  handlers: NodeHandlers;
}) {
  const multi = selectionMode === "multi";
  const selectedPath = useSelected(store);
  const { mount, rows, loading, errored, empty } = useBrowse(store, cwd, ordered);
  const { crumbs } = useMemo(() => breadcrumbFor(cwd, ordered), [cwd, ordered]);
  const [sort, setSort] = useState<SortKey>("name");
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (cwd === null) return rows; // mounts root keeps its given (ranked) order
    return [...rows].sort((a, b) =>
      compareEntries({ name: a.name, isDir: a.ctx.isDir }, { name: b.name, isDir: b.ctx.isDir }, sort),
    );
  }, [rows, sort, cwd]);

  const onOpen = (row: BrowseRow) => {
    if (row.ctx.isDir) setCwd(row.ctx.absPath);
    // Under multi-select a file-row click TOGGLES membership in the selection set
    // (mark/unmark) rather than moving the single cursor / opening. Directory
    // navigation and (single/none) activation are unchanged.
    else if (multi) store.toggleInSelection(row.ctx.absPath);
    else handlers.onActivate(row.ctx.absPath, false);
  };

  // Roving focus across the rows (the rows are tabbable; arrows move between them).
  const onKeyDownList = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const opts = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (!opts.length) return;
    e.preventDefault();
    const i = opts.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? opts.length - 1 : e.key === "ArrowDown" ? Math.min(opts.length - 1, i + 1) : Math.max(0, i - 1);
    opts[next < 0 ? 0 : next]?.focus();
  };

  return (
    <div className="layout layout--list">
      <Breadcrumb crumbs={crumbs} mount={mount} onNavigate={setCwd} />
      {cwd !== null && (
        <div className="lhead" role="presentation">
          <button
            type="button"
            className={"lhead__col lhead__name" + (sort === "name" ? " lhead__col--on" : "")}
            aria-pressed={sort === "name"}
            onClick={() => setSort("name")}
          >
            Name
          </button>
          <button
            type="button"
            className={"lhead__col lhead__type" + (sort === "type" ? " lhead__col--on" : "")}
            aria-pressed={sort === "type"}
            onClick={() => setSort("type")}
          >
            Type
          </button>
        </div>
      )}
      <div ref={listRef} role="listbox" aria-label="Files" className="llist" onKeyDown={onKeyDownList}>
        {loading && <div className="layout__muted">Loading…</div>}
        {errored && <div className="layout__muted">Couldn’t read this folder.</div>}
        {empty && <div className="layout__muted">Empty</div>}
        {sorted.map((row) => {
          const mountRel = toMountRel(row.ctx.rootPath, row.ctx.absPath);
          return (
            <ListRow
              key={row.ctx.absPath}
              row={row}
              store={store}
              multi={multi}
              cursorSelected={selectedPath === row.ctx.absPath}
              active={!row.ctx.isDir && mountRel === activeFile}
              onOpen={onOpen}
              handlers={handlers}
            />
          );
        })}
      </div>
    </div>
  );
}

export default ListView;
