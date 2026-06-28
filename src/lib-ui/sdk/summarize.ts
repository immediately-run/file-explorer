// The "Summarize…" fork feature as an `extraMenuItems` contribution (Phase 02
// §B.4). It is SDK-only (it streams `llm.chat@1` and can save via `uploadFile`),
// so it lives in the adapter and is wired into the headless view through the
// generic `extraMenuItems` slot — a non-SDK consumer simply never adds it.
//
// This is a plain helper (not a component) so the Fast-Refresh rule holds; the
// React surface is `SummaryModal.tsx`, rendered by `SdkFileExplorer`.
import { createElement } from "react";
import { Sparkles } from "lucide-react";
import { basename } from "../explorer";
import type { MenuItem, RowCtx } from "../types";
import type { SummaryTarget } from "./SummaryModal";

/** Build the "Summarize…" menu item for a file row (none for a directory). Calls
 *  `onSummarize` with the target the modal needs. */
export function summarizeMenuItems(
  ctx: RowCtx,
  onSummarize: (target: SummaryTarget) => void,
): MenuItem[] {
  if (ctx.isDir) return [];
  return [
    {
      key: "summarize",
      label: "Summarize…",
      icon: createElement(Sparkles, { size: 14 }),
      onSelect: () =>
        onSummarize({
          absPath: ctx.absPath,
          rootPath: ctx.rootPath,
          name: basename(ctx.absPath),
          writable: ctx.writable,
        }),
    },
  ];
}
