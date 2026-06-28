// Column (Miller/Finder) layout (R3-84, brief 13 §4) — the most novel view.
// Horizontal columns: column 0 lists the mounts; choosing a folder in column n
// reveals its children in column n+1 (the focus path); a file in the rightmost
// column is selected/opened. Each content column carries its mount's scope chip so
// the grant stays visible. Non-focused columns recede; the focused one wears an
// accent rail. Keyboard: up/down move within a column, left/right move the focus
// column, Enter opens a file or extends the path. Narrow/mobile projection is the
// CSS scroll-snap one-column-at-a-time (brief 13 §"Narrow-panel + mobile").
import { memo, useEffect, useMemo, useRef } from "react";
import { Trash2, Lock } from "lucide-react";
import { TreeStore, useSelected } from "./treeStore";
import FileGlyph from "./FileGlyph";
import { useBrowse, type BrowseRow } from "./hooks/useBrowse";
import { useLongPress } from "./hooks/useLongPress";
import { useRowInteractions, type NodeHandlers } from "./hooks/useRowInteractions";
import { mountLabel, subtreeLabel, isWritableMount, toMountRel, isProtected } from "./explorer";
import type { ExplorerRoot } from "./types";

const ColRow = memo(function ColRow({
  row,
  inPath,
  selected,
  active,
  onChoose,
  handlers,
}: {
  row: BrowseRow;
  inPath: boolean;
  selected: boolean;
  active: boolean;
  onChoose: (row: BrowseRow) => void;
  handlers: NodeHandlers;
}) {
  const { ctx, name } = row;
  const longPress = useLongPress((x, y) => handlers.onMenu({ clientX: x, clientY: y }, ctx));
  const { dropTarget, rowProps } = useRowInteractions(ctx, handlers, longPress);
  const mountRel = toMountRel(ctx.rootPath, ctx.absPath);
  const deletable = ctx.writable && ctx.absPath !== ctx.rootPath && !isProtected(mountRel);

  return (
    <div
      role="option"
      aria-selected={selected || inPath}
      aria-current={active ? "true" : undefined}
      tabIndex={0}
      className={
        "crow" +
        (inPath ? " crow--path" : "") +
        (selected ? " crow--selected" : "") +
        (active ? " crow--active" : "") +
        (dropTarget ? " crow--droptarget" : "")
      }
      onClick={() => onChoose(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose(row);
        }
      }}
      {...rowProps}
    >
      <span className="crow__icon">
        <FileGlyph name={name} isDir={ctx.isDir} />
      </span>
      <span className="crow__label">{name}</span>
      {ctx.isDir && <span className="crow__chev" aria-hidden="true">›</span>}
      {deletable && (
        <button
          type="button"
          className="tnode__del crow__del"
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

const Column = memo(function Column({
  store,
  ordered,
  dir,
  level,
  pathAtLevel,
  selectedPath,
  activeFile,
  focused,
  onChoose,
  handlers,
}: {
  store: TreeStore;
  ordered: ExplorerRoot[];
  dir: string | null;
  level: number;
  pathAtLevel: string | null;
  selectedPath: string | null;
  activeFile: string | null;
  focused: boolean;
  onChoose: (level: number, row: BrowseRow) => void;
  handlers: NodeHandlers;
}) {
  const { mount, rows, loading, errored, empty } = useBrowse(store, dir, ordered);

  return (
    <div className={"col" + (focused ? " col--focus" : "")} data-col={level}>
      <div className="col__head">
        {dir === null ? (
          <span className="col__title">Spaces</span>
        ) : (
          mount && (
            <span className="scope__chip col__chip">
              {!isWritableMount(mount) && <Lock size={11} aria-hidden="true" />}
              {mountLabel(mount)} · {subtreeLabel(mount)} ·{" "}
              {isWritableMount(mount) ? "read-write" : "read-only"}
            </span>
          )
        )}
      </div>
      <div role="listbox" aria-label={dir === null ? "Mounts" : (mount ? mountLabel(mount) : "Files")} className="col__list">
        {loading && <div className="layout__muted">Loading…</div>}
        {errored && <div className="layout__muted">Couldn’t read this folder.</div>}
        {empty && <div className="layout__muted">Empty</div>}
        {rows.map((row) => {
          const mountRel = toMountRel(row.ctx.rootPath, row.ctx.absPath);
          return (
            <ColRow
              key={row.ctx.absPath}
              row={row}
              inPath={row.ctx.absPath === pathAtLevel}
              selected={selectedPath === row.ctx.absPath}
              active={!row.ctx.isDir && mountRel === activeFile}
              onChoose={(r) => onChoose(level, r)}
              handlers={handlers}
            />
          );
        })}
      </div>
    </div>
  );
});

function ColumnView({
  store,
  ordered,
  colPath,
  setColPath,
  activeFile,
  handlers,
}: {
  store: TreeStore;
  ordered: ExplorerRoot[];
  colPath: string[];
  setColPath: (next: string[]) => void;
  activeFile: string | null;
  handlers: NodeHandlers;
}) {
  const selectedPath = useSelected(store);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Column 0 is the mounts list; column k>=1 shows the children of colPath[k-1].
  const levels = useMemo(() => {
    const out: { dir: string | null; level: number }[] = [{ dir: null, level: 0 }];
    colPath.forEach((d, i) => out.push({ dir: d, level: i + 1 }));
    return out;
  }, [colPath]);

  // Reveal the newest column when the path grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [colPath.length]);

  const onChoose = (level: number, row: BrowseRow) => {
    if (row.ctx.isDir) {
      setColPath([...colPath.slice(0, level), row.ctx.absPath]);
    } else {
      setColPath(colPath.slice(0, level));
      handlers.onActivate(row.ctx.absPath, false);
    }
  };

  // Focus-path keyboard model: up/down within a column, left/right across columns.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!keys.includes(e.key)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const active = document.activeElement as HTMLElement | null;
    const colEl = active?.closest<HTMLElement>("[data-col]");
    if (!colEl) return;
    const cols = Array.from(scroller.querySelectorAll<HTMLElement>("[data-col]"));
    const ci = cols.indexOf(colEl);
    const opts = Array.from(colEl.querySelectorAll<HTMLElement>('[role="option"]'));
    const ri = opts.indexOf(active as HTMLElement);
    e.preventDefault();
    if (e.key === "ArrowDown") opts[Math.min(opts.length - 1, ri + 1)]?.focus();
    else if (e.key === "ArrowUp") opts[Math.max(0, ri - 1)]?.focus();
    else if (e.key === "ArrowRight") {
      const next = cols[ci + 1];
      if (next) {
        const nopts = Array.from(next.querySelectorAll<HTMLElement>('[role="option"]'));
        (nopts.find((o) => o.getAttribute("aria-selected") === "true") ?? nopts[0])?.focus();
      }
    } else if (e.key === "ArrowLeft") {
      const prev = cols[ci - 1];
      if (prev) {
        const popts = Array.from(prev.querySelectorAll<HTMLElement>('[role="option"]'));
        (popts.find((o) => o.getAttribute("aria-selected") === "true") ?? popts[0])?.focus();
      }
    }
  };

  return (
    <div
      ref={scrollRef}
      className="layout layout--columns"
      onKeyDown={onKeyDown}
    >
      {levels.map(({ dir, level }) => (
        <Column
          key={level === 0 ? "__mounts" : (dir as string)}
          store={store}
          ordered={ordered}
          dir={dir}
          level={level}
          pathAtLevel={colPath[level] ?? null}
          selectedPath={selectedPath}
          activeFile={activeFile}
          focused={level === colPath.length}
          onChoose={onChoose}
          handlers={handlers}
        />
      ))}
    </div>
  );
}

export default ColumnView;
