// Icon (grid) layout (R3-84, brief 13 §3): a responsive grid of large type icons
// with labels beneath. Folders open into the same grid; a breadcrumb steps back
// up. Shares the tree's selection + active-file model and the §3/§4 gestures via
// `useRowInteractions`. ARIA: a `grid` with roving tabindex — arrow keys move in
// two dimensions, Enter/Space opens.
import { memo, useMemo, useRef } from "react";
import { Trash2 } from "lucide-react";
import type { SandboxMount } from "@immediately-run/sdk";
import { TreeStore, useSelected } from "./treeStore";
import FileGlyph from "./FileGlyph";
import Breadcrumb from "./Breadcrumb";
import { useBrowse, type BrowseRow } from "../hooks/useBrowse";
import { useLongPress } from "../hooks/useLongPress";
import { useRowInteractions, type NodeHandlers } from "../hooks/useRowInteractions";
import { breadcrumbFor, toMountRel, isProtected } from "../lib/explorer";
import { fileTypeLabel } from "../lib/entryMeta";

const IconTile = memo(function IconTile({
  row,
  selected,
  active,
  onOpen,
  handlers,
}: {
  row: BrowseRow;
  selected: boolean;
  active: boolean;
  onOpen: (row: BrowseRow) => void;
  handlers: NodeHandlers;
}) {
  const { ctx, name } = row;
  const longPress = useLongPress((x, y) => handlers.onMenu({ clientX: x, clientY: y }, ctx));
  const { dropTarget, rowProps } = useRowInteractions(ctx, handlers, longPress);
  const mountRel = toMountRel(ctx.rootPath, ctx.absPath);
  const deletable = ctx.writable && ctx.absPath !== ctx.rootPath && !isProtected(mountRel);

  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-current={active ? "true" : undefined}
      aria-label={`${name}, ${fileTypeLabel(name, ctx.isDir)}`}
      tabIndex={0}
      className={
        "tile" +
        (selected ? " tile--selected" : "") +
        (active ? " tile--active" : "") +
        (dropTarget ? " tile--droptarget" : "")
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
      <span className="tile__icon">
        <FileGlyph name={name} isDir={ctx.isDir} size={30} />
      </span>
      <span className="tile__label">{name}</span>
      {deletable && (
        <button
          type="button"
          className="tnode__del tile__del"
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

function IconGrid({
  store,
  ordered,
  cwd,
  setCwd,
  activeFile,
  handlers,
}: {
  store: TreeStore;
  ordered: SandboxMount[];
  cwd: string | null;
  setCwd: (path: string | null) => void;
  activeFile: string | null;
  handlers: NodeHandlers;
}) {
  const selectedPath = useSelected(store);
  const { mount, rows, loading, errored, empty } = useBrowse(store, cwd, ordered);
  const { crumbs } = useMemo(() => breadcrumbFor(cwd, ordered), [cwd, ordered]);
  const gridRef = useRef<HTMLDivElement>(null);

  const onOpen = (row: BrowseRow) => {
    if (row.ctx.isDir) setCwd(row.ctx.absPath);
    else handlers.onActivate(row.ctx.absPath, false);
  };

  // 2-D roving: Left/Right step one tile; Up/Down jump to the geometrically
  // nearest tile on the adjacent row (rows inferred from tile offsetTop).
  const onKeyDownGrid = (e: React.KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []);
    if (!tiles.length) return;
    e.preventDefault();
    const cur = document.activeElement as HTMLElement;
    const i = tiles.indexOf(cur);
    if (e.key === "Home") return void tiles[0].focus();
    if (e.key === "End") return void tiles[tiles.length - 1].focus();
    if (e.key === "ArrowLeft") return void tiles[Math.max(0, i - 1)]?.focus();
    if (e.key === "ArrowRight") return void tiles[Math.min(tiles.length - 1, i + 1)]?.focus();
    // Vertical: pick the closest tile by center-x on the row above/below.
    const rect = cur.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    let best: HTMLElement | null = null;
    let bestDx = Infinity;
    let bestRowDy = Infinity;
    for (const t of tiles) {
      const r = t.getBoundingClientRect();
      const ty = r.top + r.height / 2;
      if (dir === 1 ? ty <= cy + 1 : ty >= cy - 1) continue; // must be on a further row
      const rowDy = Math.abs(ty - cy);
      const dx = Math.abs(r.left + r.width / 2 - cx);
      if (rowDy < bestRowDy - 1 || (Math.abs(rowDy - bestRowDy) <= 1 && dx < bestDx)) {
        best = t;
        bestDx = dx;
        bestRowDy = rowDy;
      }
    }
    best?.focus();
  };

  return (
    <div className="layout layout--icons">
      <Breadcrumb crumbs={crumbs} mount={mount} onNavigate={setCwd} />
      <div ref={gridRef} role="grid" aria-label="Files" className="igrid" onKeyDown={onKeyDownGrid}>
        {loading && <div className="layout__muted">Loading…</div>}
        {errored && <div className="layout__muted">Couldn’t read this folder.</div>}
        {empty && <div className="layout__muted">Empty</div>}
        {rows.map((row) => {
          const mountRel = toMountRel(row.ctx.rootPath, row.ctx.absPath);
          return (
            <IconTile
              key={row.ctx.absPath}
              row={row}
              selected={selectedPath === row.ctx.absPath}
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

export default IconGrid;
