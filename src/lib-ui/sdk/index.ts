// Public surface of the SDK adapter (`@immediately-run/file-explorer-ui/sdk`).
// Wires the headless view to `@immediately-run/sdk`: roots from `useMounts`, the
// ZenFS `FsSource`, the action bundle, and the fully-assembled app.
export { default } from "./SdkFileExplorer"; // SdkFileExplorer — the whole app
export { default as SdkFileExplorer } from "./SdkFileExplorer";
export { useSdkRoots } from "./useSdkRoots";
export { useSessionRoots, type SessionRoot, type SessionRootsResult } from "./useSessionRoots";
export { sdkFsSource, readdir, readFile, fsAvailable } from "./mountFs";
export { makeSdkActions } from "./actions";
export { toExplorerRoot } from "./mounts";
// R3-267: the `opensWith` caller — the marker probe, the invoke, and the hook that
// wires both into an explorer's fs.
export { DECLARED_TASKS, MAX_MARKER_BYTES, openWith, probeOffer, readMarker } from "./openWith";
export type { OpenWithOutcome } from "./openWith";
export { useOpensWith, MAX_PROBES_PER_LISTING } from "./useOpensWith";
export type { OpensWithState } from "./useOpensWith";
