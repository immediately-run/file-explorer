# file-explorer

A read-only **file explorer** system app for [immediately.run](https://immediately.run)
— the Phase 03 read-only pilot for the §3.2 app-as-chrome loader
(`UI_AS_APPS_SPEC` §4 / §8.7, design brief 10).

It shows a tree of a **mount**'s contents — a space or a granted subtree the user
has shared with this app — with each mount's grant scope made visible. It reads
the active mounts through the SDK (`useMounts`) and file entries from the sandbox
filesystem at the mount path. It explores only granted mounts, never the project
you're editing: a sandboxed app can only see what its mounts expose.

Read-only by design (no create / rename / delete). Loaded into a chrome region
by the host; not meant to be run standalone.
