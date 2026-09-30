// R3-827 — follow the host's theme polarity by driving the `data-theme`
// attribute the palette is keyed on (index.css: `html[data-theme="light"]`).
// The palette shipped with a light block nothing ever switched on: no file in
// src/ set the attribute, so a light host left the panel dark.
//
// The attribute is SET in light and REMOVED in dark — dark is the
// attribute-less default the stylesheet's root block already carries, so
// removing (never writing `data-theme="dark"`) keeps the default's precedence
// story exactly as it shipped. A frame that never receives a host push stays
// dark: that is the SDK's documented `initial`, not a fallback to guess from
// `prefers-color-scheme` — the host's selection, not the OS, is the truth
// (HOST_THEMING_SPEC §2).
//
// This hook lives in the APP SHELL ONLY. `src/lib-ui/` (the `.` export) stays
// SDK-free: a library consumer owns its own `<html>`.

import { useEffect } from "react";
import { useHostTheme } from "@immediately-run/sdk/theme";

export function useHostThemeAttribute(): void {
  const theme = useHostTheme();
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
  }, [theme]);
}
