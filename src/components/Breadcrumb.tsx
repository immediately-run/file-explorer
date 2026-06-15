// The breadcrumb + scope chip shown above the list and icon layouts (R3-84). It
// keeps the grant scope VISIBLE in every layout (brief 13 trust constraints): the
// owning mount's name and its `subtree · mode` chip travel with the current
// directory, and read-only vs writable reads the same as the tree's scope header.
// Segments are buttons that navigate up; the last (current) segment is inert.
import { ChevronLeft, ChevronRight, Lock } from "lucide-react";
import type { SandboxMount } from "@immediately-run/sdk";
import { subtreeLabel, isWritableMount, type Crumb } from "../lib/explorer";

function Breadcrumb({
  crumbs,
  mount,
  onNavigate,
}: {
  crumbs: Crumb[];
  mount: SandboxMount | null;
  onNavigate: (path: string | null) => void;
}) {
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const ro = mount ? !isWritableMount(mount) : false;

  return (
    <div className="crumbs">
      <button
        type="button"
        className="crumbs__back"
        title="Go up one level"
        aria-label="Go up one level"
        disabled={!parent}
        onClick={() => parent && onNavigate(parent.path)}
      >
        <ChevronLeft size={15} aria-hidden="true" />
      </button>
      <nav className="crumbs__trail" aria-label="Location">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={c.path ?? "__root"} className="crumbs__seg">
              {i > 0 && <ChevronRight size={12} className="crumbs__sep" aria-hidden="true" />}
              {last ? (
                <span className="crumbs__cur" aria-current="page">
                  {c.label}
                </span>
              ) : (
                <button type="button" className="crumbs__link" onClick={() => onNavigate(c.path)}>
                  {c.label}
                </button>
              )}
            </span>
          );
        })}
      </nav>
      {mount && (
        <span className="scope__chip crumbs__chip">
          {ro && <Lock size={11} aria-hidden="true" />}
          {subtreeLabel(mount)} · {ro ? "read-only" : "read-write"}
        </span>
      )}
    </div>
  );
}

export default Breadcrumb;
