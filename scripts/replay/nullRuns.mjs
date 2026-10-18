// AT-17 null runs and injected edge, local check (M4 T16; design 4.9). No database, no data repo, no
// secret: synthetic rows by default, a local snapshot file with --snapshot (the real-data null run
// is the production workflow, decision 31). Prints aggregates only.
//   node scripts/replay/nullRuns.mjs --kind null|injected [--runs N] [--snapshot FILE]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadReplay } from "./engine.mjs";

/** @param {string[]} argv */
export async function run(argv, deps = {}) {
  const { nullRunsMain } = await loadReplay();
  return nullRunsMain(argv, { readFile: (p) => new Uint8Array(readFileSync(p)), ...deps });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await run(process.argv.slice(2)));
}
