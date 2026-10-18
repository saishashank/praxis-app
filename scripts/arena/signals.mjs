// Batch 2b "signals and orders" CLI (M4 T8, ARN-060, ARN-020, design 4.1). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/arena-signals.yml.
//   node scripts/arena/signals.mjs [--date YYYY-MM-DD] [--wait-minutes N]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional)
// All logic lives in src/lib/arena/cli.ts (bundled by ./engine.mjs). In production with
// `market.mode != 'full'` it only records a skipped run record and writes nothing to the arena or
// agent tables (D-066, BLD-024). It waits for batch 2a of the same session and never decides a past
// session. Exit 0 success or expected skip, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { signalsMain } = await loadEngine();
  return signalsMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
