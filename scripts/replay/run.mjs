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
//   node scripts/replay/run.mjs --mode seed-recent
//      D-199: no replay. Copies the recent price window from the same history files into the
//      database (src/lib/data/backfill/seedRecent.mjs), so the nightly has the sessions it needs.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { createHistoryStore } from "../../src/lib/data/backfill/dataRepo.mjs";
import { JOB_YAHOO } from "../../src/lib/data/backfill/priceHistory.mjs";
import { seedRecentBars } from "../../src/lib/data/backfill/seedRecent.mjs";
import { loadReplay } from "./engine.mjs";
import { downloadHistory } from "./history.mjs";
import { run as snapshotRun } from "./snapshot.mjs";

/** @param {string[]} argv @param {Record<string, string | undefined>} env */
export async function run(argv, env, deps = {}) {
  if (argv.join(" ") === "--mode seed-recent") return seedRecent(env, deps);
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

/** D-199: seed the database's recent price window; one status line with counts only. */
async function seedRecent(env, deps) {
  const out = deps.out ?? ((s) => console.log(s));
  const has = (v) => typeof v === "string" && v !== "";
  if (!has(env.TURSO_MAIN_URL) || !has(env.DATA_REPO) || !has(env.DATA_REPO_TOKEN)) {
    out("seed-recent: failed (not configured)");
    return 1;
  }
  const work = mkdtempSync(path.join(env.RUNNER_TEMP || tmpdir(), "praxis-seed-"));
  const db = (deps.openDb ?? ((url, authToken) => createClient({ url, authToken })))(
    env.TURSO_MAIN_URL,
    env.TURSO_MAIN_TOKEN || undefined,
  );
  try {
    const hist = path.join(work, "history");
    await (deps.downloadHistory ?? downloadHistory)({
      repo: env.DATA_REPO,
      token: env.DATA_REPO_TOKEN,
      dir: hist,
    });
    const r = await seedRecentBars(db, {
      nowMs: (deps.nowMs ?? Date.now)(),
      commitSha: env.COMMIT_SHA,
      readMonth: (month) => {
        const p = path.join(hist, `${JOB_YAHOO}-${month}.jsonl.gz`);
        return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
      },
    });
    const range = r.from ? ` from=${r.from} to=${r.to}` : "";
    out(
      `seed-recent: ${r.status} sessions=${r.sessions} rows=${r.rows} written=${r.written}${range}`,
    );
    return r.status === "ok" || r.status === "nothing" ? 0 : 1;
  } catch (e) {
    // never the message: a driver or store error can carry the database URL or the repository
    out(`seed-recent: failed (${e instanceof Error ? e.name : "Error"})`);
    return 1;
  } finally {
    db.close();
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await run(process.argv.slice(2), process.env));
}
