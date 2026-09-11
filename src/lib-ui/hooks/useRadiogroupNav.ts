// APG Radio Group keyboard contract, shared by the two `.viewswitch` segmented
// controls (LayoutSwitcher, LensSwitcher). ArrowLeft/Right/Up/Down move
// selection AND check it (wrapping), Home/End jump to the ends, and focus
// follows the newly checked radio. The roving-tabindex half — the checked radio
// is the group's one tab stop, the others are -1 — is applied by the caller on
// each button; role="radio" buttons without both halves are not a radio group.
import { useRef, type KeyboardEvent, type RefObject } from "react";

export function useRadiogroupNav<T>(
  values: readonly T[],
  value: T,
  onChange: (next: T) => void,
): {
  ref: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const radios = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    const last = values.length - 1;
    const i = values.indexOf(value);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? last
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? i <= 0
              ? last
              : i - 1
            : i >= last
              ? 0
              : i + 1;
    if (next === i) return;
    onChange(values[next]);
    radios[next]?.focus();
  };
  return { ref, onKeyDown };
}
