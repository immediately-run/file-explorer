// The explorer's ONE announcement channel (R-IX-7 / WCAG 4.1.3). The live
// region lives once — beside the view, in FileExplorerView — and anything
// that needs an outcome announced PUBLISHES here rather than mounting a
// second region. Sibling overlays (the summarize modal) have no prop path
// into the view, so the channel is a module-level emitter: publishers call
// `announce`, the region's subscription renders.
type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Announce a message through the live region (pending or settled). */
export function announce(message: string): void {
  for (const l of listeners) l(message);
}

/** The region's subscription. Returns the unsubscribe fn. */
export function subscribeToAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
