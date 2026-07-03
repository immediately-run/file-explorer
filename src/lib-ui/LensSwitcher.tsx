// The "App | Session" lens switcher (R3-95; PRINCIPALS_SPEC §9 B2). A compact
// segmented control in the panel header that swaps the explorer between the App
// lens (this app's own mounts, `useMounts()`) and the Session lens (the session's
// mounts beyond the app's own, `useSessionMounts()` — first-party only). Rendered
// ONLY when the host delivers a session signal, so a URL-loaded fork never shows it.
// Same ARIA radiogroup + `.viewswitch` styling as LayoutSwitcher (announces as one
// control with two mutually-exclusive options).
import { AppWindow, Users, type LucideIcon } from "lucide-react";

export type Lens = "app" | "session";

const OPTIONS: { value: Lens; label: string; tip: string; Icon: LucideIcon }[] = [
  { value: "app", label: "App", tip: "This app's mounts", Icon: AppWindow },
  { value: "session", label: "Session", tip: "The session's mounts", Icon: Users },
];

function LensSwitcher({
  value,
  onChange,
}: {
  value: Lens;
  onChange: (next: Lens) => void;
}) {
  return (
    <div className="viewswitch" role="radiogroup" aria-label="Mount lens">
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

export default LensSwitcher;
