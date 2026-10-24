// Env-names check (M8 T15, decision 41, BLD-040). Zero dependencies.
// Fails when: a name the code or a workflow `env:` block reads is missing from .env.example,
// or .env.example holds any value (or a malformed line). Warns (never fails) when .env.example
// lists a name that nothing reads. Names only are printed; no value is ever read or shown.
// Usage: node scripts/ci/env-names.mjs [repoRoot]
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Names that are not Praxis configuration: platform/CI-provided, tool switches, or inputs that
// belong to a single script or workflow run (set by the workflow, never by the Owner's env file).
export const NOT_CONFIG = new Set([
  // Platform and runtime
  "NODE_ENV",
  "CI",
  "VITEST",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_SHA",
  "NEXT_RUNTIME",
  "PATH",
  "NEXT_TELEMETRY_DISABLED",
  "VERCEL_TELEMETRY_DISABLED",
  "WRANGLER_SEND_METRICS",
  // GitHub Actions provided
  "GITHUB_OUTPUT",
  "GITHUB_EVENT_NAME",
  "GITHUB_API_URL",
  "GITHUB_STEP_SUMMARY",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_SHA",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "RUNNER_TEMP",
  // Tool pins in workflows
  "GITLEAKS_SHA256",
  "GITLEAKS_VERSION",
  "ZAP_IMAGE", // ZAP container pinned by digest in zap-baseline.yml (M8 T12)
  // Per-run workflow or script inputs
  "MODE",
  "KEY_MODE",
  "CONFIRM",
  "STAGING_RESULT", // per-run result of the staging job inside nightly.yml (M8 T12)
  "DEADLINES_OUTCOME", // per-run step outcomes and date input of staging-e2e-day.yml (M8 T12)
  "E2E_OUTCOME",
  "E2E_DAY_DATE",
  "DIFF_COVERAGE_MIN", // CI thresholds of scripts/ci/diff-coverage.mjs (M8 T3)
  "DIFF_BRANCH_MIN",
  "HEAD_SHA", // per-run commit ids passed to scripts/ci in ci.yml (M8 T17), not configuration
  "PR_BASE_SHA",
  "PUSH_BEFORE_SHA",
  "PRAXIS_COVERAGE_RUN", // timing slack for two tests under coverage (M8 T17), set only by the coverage job
  "ZAP_OUT", // per-run report folder of scripts/ci/zap-run.mjs (M8 T12), not configuration
  "FROM", // backfill-index.yml: the first-date input of a one-off dispatch (D-175), not configuration
  "TARGET",
  "TARGETS",
  "TRAINS",
  "REF",
  "CANDIDATES",
  "CHECKED",
  "BACKUP_TAG",
  "BACKUP_ENV",
  "COMMIT_SHA",
  "REPLAY_MODE",
  "WATCHDOG_SLOT",
  "WATCHDOG_DELIBERATE_FAILURE",
  "ALLOW_BOOTSTRAP",
  "SMOKE_ENV",
  // Local test and audit tooling
  "E2E_SCENARIO",
  "E2E_SCREENS",
  "E2E_DIR",
  "LIGHTHOUSE",
  "LIGHTHOUSE_CHROME",
  "CONTRAST_VERBOSE",
]);

const CODE_EXT = /\.(ts|tsx|mts|mjs|js)$/;
const TEST_FILE = /(\.test\.|\.spec\.)|(^|\/)(tests?|__tests__|fixtures|node_modules|\.next)(\/|$)/;
const NAME = "[A-Z][A-Z0-9_]+";

/** Names read as `env.X`, `process.env.X` or `env["X"]` in one source text. */
export function codeNames(text) {
  const out = new Set();
  const dot = new RegExp(`\\benv\\??\\.(${NAME})\\b`, "g");
  const br = new RegExp(`\\benv\\[\\s*["'\`](${NAME})["'\`]\\s*\\]`, "g");
  for (const re of [dot, br]) for (const m of text.matchAll(re)) out.add(m[1]);
  return out;
}

/** Keys of every `env:` mapping in one workflow file (indentation based; no YAML parser). */
export function workflowEnvNames(text) {
  const out = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?env:\s*(#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const base = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "" || l.trim().startsWith("#")) continue;
      const indent = /^(\s*)/.exec(l)[1].length;
      if (indent <= base) break;
      const k = new RegExp(`^\\s*(${NAME}):`).exec(l);
      if (k) out.add(k[1]);
    }
  }
  return out;
}

/** Parse .env.example: names plus problems (any value, malformed line, duplicate). */
export function parseEnvExample(text) {
  const names = new Set();
  const problems = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = new RegExp(`^(${NAME})=(.*)$`).exec(line);
    if (!m) {
      problems.push(`.env.example line ${i + 1}: not NAME= (malformed)`);
      return;
    }
    if (m[2] !== "") problems.push(`.env.example line ${i + 1}: ${m[1]} has a value; names only`);
    if (names.has(m[1])) problems.push(`.env.example line ${i + 1}: ${m[1]} is listed twice`);
    names.add(m[1]);
  });
  return { names, problems };
}

/** Pure comparison. read: Set of names the code reads. Returns { errors, warnings }. */
export function compare({ read, exampleText, ignore = NOT_CONFIG }) {
  const { names, problems } = parseEnvExample(exampleText);
  const errors = [...problems];
  const warnings = [];
  for (const n of [...read].sort()) {
    if (ignore.has(n) || names.has(n)) continue;
    errors.push(`${n} is read by the code or a workflow but missing from .env.example`);
  }
  for (const n of [...names].sort()) {
    if (!read.has(n)) warnings.push(`${n} is listed in .env.example but nothing reads it`);
  }
  return { errors, warnings };
}

function walk(dir, root, acc) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, root, acc);
    else acc.push(relative(root, p).split(sep).join("/"));
  }
}

export function collectReadNames(root) {
  const read = new Set();
  for (const top of ["src", "scripts", "worker/src"]) {
    const dir = join(root, top);
    if (!existsSync(dir)) continue;
    const files = [];
    walk(dir, root, files);
    for (const f of files) {
      if (!CODE_EXT.test(f) || TEST_FILE.test(f)) continue;
      for (const n of codeNames(readFileSync(join(root, f), "utf8"))) read.add(n);
    }
  }
  const wf = join(root, ".github", "workflows");
  if (existsSync(wf)) {
    for (const f of readdirSync(wf)) {
      if (!/\.ya?ml$/.test(f)) continue;
      for (const n of workflowEnvNames(readFileSync(join(wf, f), "utf8"))) read.add(n);
    }
  }
  return read;
}

export function run(root) {
  const ex = join(root, ".env.example");
  if (!existsSync(ex)) return { errors: [".env.example is missing"], warnings: [] };
  return compare({ read: collectReadNames(root), exampleText: readFileSync(ex, "utf8") });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { errors, warnings } = run(process.argv[2] ?? process.cwd());
  for (const w of warnings) console.warn(`warn: ${w}`);
  for (const e of errors) console.error(`FAIL: ${e}`);
  if (errors.length > 0) process.exit(1);
  console.log(`env-names: ok (${warnings.length} warning(s))`);
}
