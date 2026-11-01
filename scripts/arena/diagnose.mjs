// Read-only batch 2b diagnosis CLI (live defect: signals=0 every night). Runs in the `production`
// GitHub environment on the approved commit (SEC-108 c) from .github/workflows/diagnose-signals.yml.
//   node scripts/arena/diagnose.mjs --dates YYYY-MM-DD[,YYYY-MM-DD...]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. All logic lives in src/lib/arena/diagnose.ts (bundled by
// ./engine.mjs); its client refuses every statement but a plain SELECT. Counts only in the log.
// Exit 0 done, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { loadEngine } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, out) {
  const { diagnoseMain } = await loadEngine("src/lib/arena/diagnose.ts");
  return diagnoseMain(argv, env, out);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
