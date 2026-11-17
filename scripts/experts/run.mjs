// The experts job entry (M22 E2; KB-082, KB-083, D-1429). Runs in the `production` environment on the approved commit from the
// `experts` job of .github/workflows/maintenance.yml:
//   node scripts/experts/run.mjs [--date YYYY-MM-DD] [--phase all|licence|poll|discovery|extract]
// All logic lives in src/lib/experts/poll/cli.ts, bundled by scripts/arena/engine.mjs (it imports with the "@/" alias).
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN (and the model keys of the experts job when a model is switched on). Output:
// counts and statuses only. Exit 0 done or nothing to do, 1 a phase failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadEngine } from "../arena/engine.mjs";

const ENTRY = "src/lib/experts/poll/cli.ts";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const load = deps.loadEngine ?? loadEngine;
  const { expertsMain } = await load(ENTRY);
  return expertsMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
