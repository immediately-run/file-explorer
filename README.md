# file-explorer

A read-only **file explorer** system app for [immediately.run](https://immediately.run)
— the Phase 03 read-only pilot for the §3.2 app-as-chrome loader
(`UI_AS_APPS_SPEC` §4 / §8.7, design brief 10).

It shows a tree of a **mount**'s contents — a space or a granted subtree the user
has shared with this app — with each mount's grant scope made visible. It reads
the active mounts through the SDK (`useMounts`) and file entries from the sandbox
filesystem at the mount path. It explores only granted mounts, never the project
you're editing: a sandboxed app can only see what its mounts expose.

Loaded into a chrome region by the host; not meant to be run standalone.

## Library structure (file-explorer-library extraction)

The filesystem-browsing UI is a **headless library** under `src/lib-ui/` with the
SDK wiring isolated in `src/lib-ui/sdk/`:

- **`src/lib-ui/`** — the headless core: `FileExplorerView` (the view), the
  `TreeStore`, the four layouts, the path/metadata helpers, and the injected
  interfaces (`ExplorerRoot`, `FsSource`, `ExplorerActions`) in `types.ts`. It
  imports **no** `@immediately-run/sdk`. Public surface: `src/lib-ui/index.ts`.
- **`src/lib-ui/sdk/`** — the SDK adapter: `useSdkRoots()` (maps `useMounts()` →
  `ExplorerRoot[]`), `sdkFsSource` (the ZenFS accessor), `makeSdkActions()` (the
  `editor:open`/`editor:write` + drag-out + eject wiring), the "Summarize" feature,
  and `SdkFileExplorer` — the fully-assembled shipped app. Barrel:
  `src/lib-ui/sdk/index.ts`. `src/App.tsx` renders `<SdkFileExplorer/>`.

**Purity guard:** `npm run check:core` (`scripts/check-core-pure.mjs`) fails if any
file under `src/lib-ui/` **except** `src/lib-ui/sdk/` imports `@immediately-run/sdk`.
Run it alongside `npm run lint` / `npm run build` / `npm test` in CI.
