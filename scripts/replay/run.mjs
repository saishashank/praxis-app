// Replay workflow CLI (M4 T16; D-095 draft). Runs in the `production` GitHub environment on the
// approved commit (SEC-108 c) from the dispatch-only workflow replay.yml.
//   node scripts/replay/run.mjs --mode light|full|null|injected|evidence|learning [--date D] [--since D]
//        [--runs N] [--synthetic] [--budget-minutes N]
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, DATA_REPO (`<owner>/<repo>-data`), DATA_REPO_TOKEN,
//      COMMIT_SHA (optional). The history files are downloaded from the data repo, the snapshot is
//      built (scripts/replay/snapshot.mjs, recent window read from the database), the replay runs in
//      memory and writes summaries to the database and bulky outputs as write-once data-repo assets
//      (D-065). Everything stays on the runner: nothing is uploaded as an artifact. Output: statuses,
//      counts and minutes only. The logic lives in src/lib/replay/cli.ts (bundled by ./engine.mjs).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHistoryStore } from "../../src/lib/data/backfill/dataRepo.mjs";
import { loadReplay } from "./engine.mjs";
import { downloadHistory } from "./history.mjs";
import { run as snapshotRun } from "./snapshot.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  const { replayMain } = await loadReplay();
  const work = mkdtempSync(path.join(env.RUNNER_TEMP || tmpdir(), "praxis-replay-"));
  try {
    return await replayMain(argv, env, {
      makeStore: (repo, token) => createHistoryStore({ repo, token }),
      prepareSnapshot: async ({ from, to }) => {
        const hist = path.join(work, "history");
        await (deps.downloadHistory ?? downloadHistory)({
          repo: env.DATA_REPO ?? "",
          token: env.DATA_REPO_TOKEN ?? "",
          dir: hist,
        });
        const outDir = path.join(work, "snapshot");
        const code = await (deps.snapshotRun ?? snapshotRun)(
          ["--from", from, "--to", to, "--history-dir", hist, "--out", outDir],
          env,
        );
        if (code !== 0) throw new Error("snapshot failed");
        return new Uint8Array(readFileSync(path.join(outDir, "snapshot.jsonl.gz")));
      },
      ...deps.cli,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await run(process.argv.slice(2), process.env));
}
