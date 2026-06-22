# CODE_SPEC_REFERENCES — file-explorer

Durable index of **non-trivial** code↔spec mappings a reader wouldn't rediscover
quickly. Trivial mappings live as inline `// <SPEC> §X` comments. Seeded by the
2026-06 code-verification pass (R3-124; plan `08-system-apps.md`).

## The write-intent indirection (the load-bearing one)

**Spec:** `FILE_EXPLORER_SPEC §4` (write actions) + `UI_AS_APPS_SPEC §4` (one app,
two slots / host-gated intents) + the host's copy-on-write layer.

**Mapping:** the app holds **no write port**. Create / rename / delete / upload /
move are *not* direct filesystem writes — the app **names a path** and the **host**
performs the copy-on-write write behind the `editor:write` intent. The COW/journal
lives in the host (core_concepts §2), never in this app. This is why the affordances
appear only on a **writable** mount (v1: the worktree) and never surface `EROFS` as
UX — the host adjudicates writability, the app reflects it.

- `src/components/FileExplorer.tsx` (module docstring) — the §4 `editor:open` /
  `editor:write` intent indirection.
- SDK calls `deleteEntry` / `renameEntry` / `uploadFile` / `createFile` are
  host-gated intents, not local writes.

## The `llm.chat@1` "Summarize" fork feature

**Spec:** `SERVICE_PROVIDERS_SPEC` (`llm:chat` capability) + the `llm.chat@1` service
slot. `ui:overlay` self-overlay is the richer follow-up (`SERVICE_PROVIDERS_SPEC §6.3`,
proposed) — today the modal is drawn in-iframe.

**Mapping:** `src/components/SummaryModal.tsx` calls `chat()` (needs only the
`llm:chat` capability the fork consented), streams the summary, and can save it next
to the source file (gated on a writable mount). The "provider-agnostic LLM" wording
means the **LLM service provider** (Anthropic/OpenAI), core_concepts §6 sense — not
the app-identity source host.

## Multi-root tree store

**Spec:** `FILE_EXPLORER_SPEC §2` (multiple mounts) — `src/components/treeStore.ts`
keeps one scope-headed tree per mount (worktree + spaces + granted subtrees).

---

## Recorded findings (code-verification pass, 2026-06)

- **DONE-BUT-DIVERGENT (CRIT, pre-existing on origin/main) — `chat` not exported
  by the pinned SDK.** The shipped "Summarize" feature (`src/components/SummaryModal.tsx:2`
  `import { chat } from "@immediately-run/sdk"`, added in PR #9) does **not**
  type-check against the repo's own pinned `@immediately-run/sdk@0.11.0`, which has
  no `chat` export → `npm run build` fails with `TS2305` **on a clean origin/main
  checkout** (verified by stashing this pass's comment-only edits and rebuilding).
  This is a real Done-but-divergent gap: the feature shipped against a `chat`/
  `llm.chat@1` SDK surface newer than the pinned version (an instance of the
  SDK-version skew below). **Not introduced by this pass** — this pass made only
  comment-level edits (`kernel`→`host`, `PR #84 §6.3`→`SERVICE_PROVIDERS_SPEC §6.3`)
  and seeded this file; `npm run lint` and `npm test` (36 tests) are green. Fix is a
  coordinated SDK bump to a version exporting `chat` (out of scope for this
  verify/record pass — filed as a roadmap child of R3-124).
- **SDK-version skew (record only, do NOT bump):** file-explorer pins
  `@immediately-run/sdk` at **`0.11.0`** — the newest among the bound apps (others on
  `0.2.8` / `0.8.1`; agent-demo `^0.12.0`). Recorded as fleet maintenance debt; a
  coordinated bump is its own gated change.
- **Comment vocab fixes applied:** `kernel` → `host` (FileExplorer.tsx docstring);
  `PR #84 §6.3` → `SERVICE_PROVIDERS_SPEC §6.3` (SummaryModal.tsx — the unstable PR
  pointer cited the right § but the wrong source).
