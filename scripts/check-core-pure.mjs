// Purity guard (00-overview §5; Phase 01 step 6): the headless core under
// `src/lib-ui/` must NOT depend on `@immediately-run/sdk`. Only the SDK adapter
// under `src/lib-ui/sdk/` may import it. Run via `npm run check:core`; wire into
// CI alongside lint/build.
//
// Fails (exit 1) if any file under src/lib-ui EXCEPT src/lib-ui/sdk imports
// `@immediately-run/sdk`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// npm runs scripts from the package root, so cwd is the repo root. (Uses cwd
// rather than a module-URL token, which the immediately.run CommonJS transpile
// parse-errors on — that token is kept out of the repo entirely.)
const ROOT = process.cwd();
const CORE_DIR = join(ROOT, "src", "lib-ui");
const ADAPTER_DIR = join(CORE_DIR, "sdk");
const NEEDLE = "@immediately-run/sdk";
// Match a real module reference (import/from/require/vi.mock), not a comment
// that merely names the package.
//
// The optional `/…` tail matters and was missing until R3-653: the package's exports map
// is `{".": …, "./*": …}`, and this repo's own adapter reaches for a SUBPATH —
// `src/lib-ui/sdk/SdkFileExplorer.tsx:20` imports `@immediately-run/sdk/sandboxUtils`. A
// pattern anchored on a closing quote right after `sdk` therefore refused only the bare
// specifier, so a core file importing `@immediately-run/sdk/fs` passed this check green.
// Nothing under `src/lib-ui/` outside `sdk/` used the subpath form when this was widened,
// so the widening changed no verdict — it closed a door nobody had walked through yet.
const IMPORT_RE = /(?:from|import|require|vi\.mock)\s*\(?\s*["']@immediately-run\/sdk(?:\/[^"']*)?["']/;

/** All .ts/.tsx files under a dir, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(CORE_DIR)) {
  // The SDK adapter is allowed to import the SDK.
  if (file === ADAPTER_DIR || file.startsWith(ADAPTER_DIR + sep)) continue;
  const src = readFileSync(file, "utf8");
  if (IMPORT_RE.test(src)) offenders.push(relative(ROOT, file));
}

if (offenders.length) {
  console.error(
    `check:core FAILED — the headless core must not import ${NEEDLE}.\n` +
      `Move the SDK-coupled code into src/lib-ui/sdk/. Offenders:\n` +
      offenders.map((f) => `  - ${f}`).join("\n"),
  );
  process.exit(1);
}

console.log(`check:core OK — no ${NEEDLE} imports outside src/lib-ui/sdk/.`);
