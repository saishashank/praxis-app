// LLM bake-off CLI (M6 T15; D-112 draft). Runs from the dispatch-only workflow llm-bakeoff.yml in the
// `production` GitHub environment on the approved commit (SEC-108 c), or locally as a self-check.
//   node scripts/llm/bakeoff.mjs [--golden DIR] [--date D] [--candidate KIND:MODEL]...
//        [--trains KIND=yes|no]... [--checked KIND=D]... [--report-out FILE] [--pause-ms N]
// With no --candidate it is a self-check (oracle provider, no network, nothing stored). Live calls need
// the provider key in env and --candidate; rows are written to `bakeoff_result` only when
// TURSO_MAIN_URL is set. All logic lives in src/lib/llm/bakeoffCli.ts (bundled by ./engine.mjs).
// Exit 0 report produced, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadBakeoff } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { bakeoffMain } = await loadBakeoff();
  return bakeoffMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
