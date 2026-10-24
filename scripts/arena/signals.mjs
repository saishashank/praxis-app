// Batch 2b "signals and orders" CLI (M4 T8, ARN-060, ARN-020, design 4.1). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/arena-signals.yml.
//   node scripts/arena/signals.mjs [--date YYYY-MM-DD] [--wait-minutes N] [--phase 2b|3|learn|words|all]
// The default phase `all` runs batch 2b and then, when 2b succeeded, batch 3 (the deterministic review
// numbers: forward signal ledger, scorecards, ARN-101 re-check, kill switch, evidence timeline; M4 T15)
// in the same job; `--phase 3` re-runs batch 3 alone for a session whose 2b has succeeded. Then come
// the A6 phases (M6 T11): `learn` (attribution, comparisons, Critic gate, Lane A, challenger steps,
// plan; no model call) and `words` (Critic wording and the R5 narrative through the router, rules-only
// until the bake-off). `all` = 2b -> 3 -> learn -> words; `learn` and `words` run on a non-trading
// day too (a reduced run), and on a missing predecessor they run partial (status degraded).
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional)
// All logic lives in src/lib/arena/cli.ts (bundled by ./engine.mjs). In production with
// `market.mode != 'full'` it only records a skipped run record and writes nothing to the arena or
// agent tables (D-066, BLD-024). It waits for batch 2a of the same session and never decides a past
// session. Exit 0 success or expected skip, 1 failed, 2 usage.
// D-181: after a night that includes batch 3, the published picks (AGT-113, ARN-095) follow from their
// own bundle (src/lib/picks/cli.ts): this script passes the same arguments and nothing comes back but
// an exit code, so no arena module reads picks (tests/picks/isolation.test.ts).
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

const PICKS_ENTRY = "src/lib/picks/cli.ts";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { signalsMain } = await loadEngine();
  const code = await signalsMain(argv, env, deps);
  if (code === 2) return code;
  const { picksMain } = await loadEngine(PICKS_ENTRY);
  return Math.max(code, await picksMain(argv, env, deps));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
