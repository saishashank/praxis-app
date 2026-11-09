// D-905 (Owner 2026-11-09, O-81): the post-deploy full replay runs only when the deploy changed
// code the replay's results depend on. A replay re-runs every strategy over the whole history with
// the new code; a deploy that only changes the website, docs, workflows or tests leaves its
// results the same, and each run reads the whole recent price window from the database.
// Compares the deploy being replayed (CURRENT_SHA) with the approved deploy before it through
// GitHub's compare API (github.token: contents/deployments read; no environment secret).
// Writes `run=true|false` to $GITHUB_OUTPUT. Anything unknown (no earlier deploy, a cut file list,
// an API error) gives run=true: when in doubt the replay runs, as before.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Fail, SHA, changedFiles, listApprovedShas } from "./approved-commit-core.mjs";

/** Paths whose change can move a replay result (strategy, data shaping, statistics, schema). */
export const REPLAY_PATHS = Object.freeze([
  "src/lib/agents/",
  "src/lib/arena/",
  "src/lib/cortex/",
  "src/lib/replay/",
  "src/lib/stats/",
  "src/lib/learning/",
  "src/lib/money/",
  "src/lib/config/",
  "src/lib/data/backfill/",
  "src/lib/data/calendar.ts",
  "scripts/replay/",
  "db/migrations/main/",
]);

/** Pure: does this list of changed files need a replay? null (unknown) means yes. */
export function needsReplay(files) {
  if (files === null) return true;
  return files.some((f) => REPLAY_PATHS.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
}

/** Returns the process exit code (0 in every handled case; the answer is in the output). */
export async function run(env, fetchImpl, out = console.log) {
  const write = (v, why) => {
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${v}\n`);
    out(`replay-needed: run=${v} (${why})`);
    return 0;
  };
  const current = (env.CURRENT_SHA ?? "").trim();
  if (!SHA.test(current)) return write(true, "no current commit");
  try {
    const shas = await listApprovedShas(fetchImpl, env.GITHUB_TOKEN, env.GITHUB_REPOSITORY, 2);
    const prev = shas.find((s) => s !== current);
    if (prev === undefined) return write(true, "no earlier approved deploy");
    const files = await changedFiles(
      fetchImpl,
      env.GITHUB_TOKEN,
      env.GITHUB_REPOSITORY,
      prev,
      current,
    );
    if (files === null) return write(true, "change list unknown");
    return needsReplay(files)
      ? write(true, "replay inputs changed")
      : write(false, `no replay input changed in ${files.length} files`);
  } catch (e) {
    return write(true, e instanceof Fail ? e.message : "request failed");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run(process.env, fetch));
}
