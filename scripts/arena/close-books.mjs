// Batch 2a "close the books" CLI (M3 T10, ARN-060, design 4.1/4.2). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/arena-close.yml.
//   node scripts/arena/close-books.mjs [--date YYYY-MM-DD] [--wait-minutes N] [--max-sessions N]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (optional)
// All logic lives in src/lib/arena/cli.ts (bundled by ./engine.mjs). In production with
// `market.mode != 'full'` it only records a skipped run record and writes nothing to the arena
// tables (D-066, BLD-024). Exit 0 success or expected skip, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { closeBooksMain } = await loadEngine();
  return closeBooksMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
