// R3-267 — the probe that makes the `opensWith` affordance available at menu time.
//
// The context menu is built SYNCHRONOUSLY from a snapshot (`extraMenuItems`), but the
// marker lives in a file. Rather than teach the view to await, this wraps the injected
// {@link FsSource}: every `readdir` the explorer already performs also probes the
// directories it just listed for their marker, and the answers land in state before the
// user can right-click a row. The probe is one small read per directory, cached
// (negatives included — most folders are just folders) and never repeated.
//
// Wrapping `readdir` rather than probing eagerly from the root is what keeps the cost
// proportional to what the user actually looks at: an unopened subtree is never probed.
import { useCallback, useMemo, useRef, useState } from "react";
import { probeOffer, DECLARED_TASKS } from "./openWith";
import type { OpensWithOffer } from "../opensWith";
import { joinPath } from "../explorer";
import type { DirEntry, FsSource } from "../types";

/** Hard cap on directories probed per listing, so a folder with thousands of
 *  subdirectories cannot turn one `readdir` into thousands of reads. Beyond it the
 *  affordance is simply absent for the overflow — never a stall. */
export const MAX_PROBES_PER_LISTING = 128;

export interface OpensWithState {
  /** The fs to hand the view: identical behaviour, plus the marker probe. */
  fs: FsSource;
  /** The offer for a directory, or null (unprobed, unmarked, or withdrawn). */
  offerFor: (dirAbsPath: string) => OpensWithOffer | null;
  /** Stop offering a contract the host refused — the affordance withdraws itself. */
  withdraw: (task: string) => void;
}

/** Wrap `fs` so listing a directory also learns which of its children are content. */
export function useOpensWith(fs: FsSource): OpensWithState {
  const [offers, setOffers] = useState<ReadonlyMap<string, OpensWithOffer | null>>(new Map());
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(new Set());
  // Probed paths are tracked in a ref, not state: this is "have we asked", which must
  // be correct across concurrent listings and must not itself trigger a render.
  const probed = useRef(new Set<string>());
  const probeDir = useCallback(
    async (source: FsSource, dirAbsPath: string) => {
      if (probed.current.has(dirAbsPath)) return;
      probed.current.add(dirAbsPath);
      const offer = await probeOffer(source, dirAbsPath, { offerable: DECLARED_TASKS });
      // Cache negatives too — that is the common answer, and re-reading it on every
      // menu open would be the expensive version of "this folder is just a folder".
      setOffers((prev) => new Map(prev).set(dirAbsPath, offer));
    },
    [],
  );

  const wrapped = useMemo<FsSource>(
    () => ({
      readFile: fs.readFile ? (p: string) => fs.readFile!(p) : undefined,
      readdir: async (path: string): Promise<DirEntry[]> => {
        const entries = await fs.readdir(path);
        // The listed directory itself is a candidate too: a user who navigated INTO a
        // marked folder should be offered it, not only one who sees it from outside.
        const targets = [path, ...entries.filter((e) => e.isDir).map((e) => joinPath(path, e.name))];
        void Promise.all(
          targets.slice(0, MAX_PROBES_PER_LISTING).map((t) => probeDir(fs, t).catch(() => undefined)),
        );
        return entries;
      },
    }),
    [fs, probeDir],
  );

  const offerFor = useCallback(
    (dirAbsPath: string): OpensWithOffer | null => {
      const offer = offers.get(dirAbsPath) ?? null;
      if (!offer) return null;
      return unavailable.has(offer.task) ? null : offer;
    },
    [offers, unavailable],
  );

  const withdraw = useCallback((task: string) => {
    setUnavailable((prev) => (prev.has(task) ? prev : new Set(prev).add(task)));
  }, []);

  return { fs: wrapped, offerFor, withdraw };
}
