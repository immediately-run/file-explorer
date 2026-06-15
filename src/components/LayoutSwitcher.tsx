// The view switcher (R3-84, design brief 13 §1): a compact segmented control in
// the panel header that swaps the explorer between tree / list / columns / icons.
// App-local view state only. Lucide icons (no emoji); sentence-case tooltips; the
// label sits beside the icon when the header is wide and collapses to icon-only
// under a width threshold (CSS). ARIA radiogroup so it announces as one control
// with four mutually-exclusive options.
import { FolderTree, List as ListIcon, Columns3, LayoutGrid, type LucideIcon } from "lucide-react";
import type { Layout } from "../hooks/useLayout";

const OPTIONS: { value: Layout; label: string; tip: string; Icon: LucideIcon }[] = [
  { value: "tree", label: "Tree", tip: "Tree view", Icon: FolderTree },
  { value: "list", label: "List", tip: "List view", Icon: ListIcon },
  { value: "columns", label: "Columns", tip: "Column view", Icon: Columns3 },
  { value: "icons", label: "Icons", tip: "Icon view", Icon: LayoutGrid },
];

function LayoutSwitcher({
  value,
  onChange,
}: {
  value: Layout;
  onChange: (next: Layout) => void;
}) {
  return (
    <div className="viewswitch" role="radiogroup" aria-label="Layout">
      {OPTIONS.map(({ value: v, label, tip, Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={active}
            className={"viewswitch__btn" + (active ? " viewswitch__btn--active" : "")}
            title={tip}
            aria-label={tip}
            onClick={() => onChange(v)}
          >
            <Icon size={15} aria-hidden="true" />
            <span className="viewswitch__label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

export default LayoutSwitcher;
