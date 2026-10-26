// ASX store step (D-194): bundles src/lib/data/asxIngest.ts (the "@/" alias needs the bundle, as
// scripts/arena/engine.mjs explains) and runs it. The only step of asx-fetch.yml with secrets.
//   node scripts/asx/ingest.mjs --dir <dir>
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: counts only.
import { fileURLToPath } from "node:url";
import { loadEngine } from "../arena/engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { asxIngestMain } = await loadEngine("src/lib/data/asxIngest.ts");
  return asxIngestMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
