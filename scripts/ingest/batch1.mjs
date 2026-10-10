// Batch 1 end-of-day ingest CLI (M2 T6, PLT-016, PLT-076, DAT-003, DAT-020, BLD-024). Runs in the
// `production` GitHub environment on the approved commit (SEC-108 c), right after the Python
// fetch step. No TS build: it imports the shared plain-ESM core.
//   node scripts/ingest/batch1.mjs prepare --request request.json   (read-only)
//   node scripts/ingest/batch1.mjs run --bars bars.json
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN, COMMIT_SHA (optional), GITHUB_OUTPUT (prepare, optional)
// `prepare` reads the database only: it decides whether to fetch, writes request.json for the
// Python step (codes from the DB universe, one session back for the D-1 re-fetch) and reports
// `fetch`, `chunk_size` and `min_gap_s` as step outputs (none of them is a secret).
// `run` validates bars.json and writes market data only (price_bar, universe_snapshot, bar_refetch,
// completion_marker, a refetch hash and its own run record). Exit 0 ok/skipped/degraded, 1 failed.
// Output: statuses and counts only. Never a row, a code, a URL or a token.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { prepareBatch1, runBatch1 } from "../../src/lib/data/pipeline/batch1-core.mjs";

const has = (v) => typeof v === "string" && v.trim() !== "";

/** @param {string[]} args @param {string} name */
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
}

/**
 * @param {string[]} argv  command line after `node batch1.mjs`
 * @param {Record<string, string | undefined>} env
 * @param {{
 *   openDb?: (url: string, token: string | undefined) => import("@libsql/client").Client,
 *   nowMs?: () => number,
 *   out?: (s: string) => void,
 *   runOptions?: Record<string, unknown>,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const [cmd, ...rest] = argv;
  if (cmd !== "prepare" && cmd !== "run") {
    out("ingest-batch1: failed (usage: prepare --request <file> | run --bars <file>)");
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out(`ingest-batch1 ${cmd}: failed (database not configured)`);
    return 1;
  }

  let db;
  try {
    db = openDb(url, has(token) ? token : undefined);
  } catch {
    out(`ingest-batch1 ${cmd}: failed (cannot open database)`);
    return 1;
  }
  try {
    if (cmd === "prepare") return await prepare(db, rest, env, nowMs, out);
    return await ingest(db, rest, env, nowMs, out, deps.runOptions ?? {});
  } catch {
    // Never print a driver error: it can carry the database URL.
    out(`ingest-batch1 ${cmd}: failed (unexpected error)`);
    return 1;
  } finally {
    db.close();
  }
}

async function prepare(db, args, env, nowMs, out) {
  const requestPath = flag(args, "--request");
  if (requestPath === null) {
    out("ingest-batch1 prepare: failed (--request <file> is required)");
    return 1;
  }
  const r = await prepareBatch1(db, { nowMs: nowMs() });
  const lines = [];
  if (r.action === "fetch") {
    writeFileSync(requestPath, JSON.stringify(r.request));
    lines.push(
      "fetch=true",
      `chunk_size=${r.throttle.chunkSize}`,
      `min_gap_s=${r.throttle.minGapS}`,
    );
    out(`ingest-batch1 prepare: fetch dates=${r.dates} codes=${r.codes} excluded=${r.excluded}`);
  } else {
    lines.push("fetch=false");
    out(
      r.action === "skip"
        ? `ingest-batch1 prepare: no fetch (${r.reason})`
        : `ingest-batch1 prepare: no fetch (nothing to fetch, dates=${r.dates})`,
    );
  }
  if (has(env.GITHUB_OUTPUT)) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  return 0;
}

async function ingest(db, args, env, nowMs, out, runOptions) {
  const barsPath = flag(args, "--bars");
  let barsText = null;
  if (barsPath !== null) {
    try {
      barsText = readFileSync(barsPath, "utf8");
    } catch {
      barsText = null; // the pipeline records a visible failure if it needed the file
    }
  }
  const res = await runBatch1(db, {
    nowMs,
    barsText,
    commitSha: has(env.COMMIT_SHA) ? env.COMMIT_SHA : undefined,
    ...runOptions,
  });
  const sum = (k) => res.dates.reduce((a, d) => a + d[k], 0);
  const why = res.reason ? ` (${res.reason})` : "";
  out(
    `ingest-batch1: ${res.status}${why} target=${res.target} dates=${res.dates.length} read=${sum("rowsRead")} written=${sum("rowsWritten")} bars=${sum("bars")} rejected=${sum("rejected")} refetch=${sum("refetchRows")}`,
  );
  for (const d of res.dates) {
    out(
      `ingest-batch1: ${d.d} ${d.status}${d.outcome ? ` ${d.outcome}` : ""} bars=${d.bars} written=${d.rowsWritten}${d.error ? ` error="${d.error}"` : ""}`,
    );
  }
  if (res.capStopped) out("ingest-batch1: backfill write cap reached, remaining catch-up deferred");
  if (res.remaining) out(`ingest-batch1: ${res.remaining} older date(s) left for later runs`);
  return res.exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
