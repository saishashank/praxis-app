// KB archive CLI (M6 T13; D-116 draft). Runs from the dispatch-only workflow kb-archive.yml in the
// `production` GitHub environment on the approved commit (SEC-108 c).
//   node scripts/kb/archive.mjs [--no-sync]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, DATA_REPO_TOKEN, DATA_REPO (`<owner>/<name>-data`)
// Regenerates the `document` versions, then commits only the changed files under `knowledge/` in the
// private data repo (Git Data API, token only to api.github.com, fast-forward only, no deletes).
// All logic lives in src/lib/kb/archiveCli.ts (bundled by ./engine.mjs).
// Exit 0 ok / partial / skipped, 1 failed, 2 usage or configuration.
import { fileURLToPath } from "node:url";
import { loadArchive } from "./engine.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { archiveMain } = await loadArchive();
  return archiveMain(argv, env, deps);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
