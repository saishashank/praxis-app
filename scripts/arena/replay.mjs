// Replay harness CLI (M3 T10, ARN-102, AT-12, AT-13): closes every session of a range against a
// LOCAL file database, as the nightly batch would. It refuses any database that is not a
// `file:` URL, so it can never touch production (D-066). Test strategies (the stand-in for
// batch 2b) are injected by the tests; this CLI replays the orders already stored in the file.
//   node scripts/arena/replay.mjs --db file:<path> --from YYYY-MM-DD --to YYYY-MM-DD [--market AU]
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { replayMain } = await loadEngine();
  return replayMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
