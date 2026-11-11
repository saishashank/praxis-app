// Batch 2a "close the books" CLI (M3 T10, ARN-060, design 4.1/4.2). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/arena-close.yml.
//   node scripts/arena/close-books.mjs [--date YYYY-MM-DD] [--wait-minutes N] [--max-sessions N] [--now <ISO instant>]
// --now is the simulated clock of the CI recorded day (M18 D-965); refused unless PRAXIS_ENV=recorded.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional)
// All logic lives in src/lib/arena/cli.ts (bundled by ./engine.mjs). In production with
// `market.mode != 'full'` it only records a skipped run record and writes nothing to the arena
// tables (D-066, BLD-024). Exit 0 success or expected skip, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";
import { parseNow } from "../e2e-day/now.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const sim = parseNow(argv, env);
  if (sim.error) {
    (deps.out ?? console.log)(`arena-2a: refused (${sim.error})`);
    return 2;
  }
  const { closeBooksMain } = await loadEngine();
  return closeBooksMain(sim.argv, env, sim.nowMs ? { ...deps, nowMs: sim.nowMs } : deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
