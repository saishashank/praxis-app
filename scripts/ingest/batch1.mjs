// Batch 1 end-of-day ingest CLI (M2 T6, PLT-016, PLT-076, DAT-003, DAT-020, BLD-024). Runs in the
// `production` GitHub environment on the approved commit (SEC-108 c), right after the Python
// fetch step. No TS build: it imports the shared plain-ESM core.
//   node scripts/ingest/batch1.mjs prepare [--market CODE] --request request.json   (read-only)
//   node scripts/ingest/batch1.mjs run [--market CODE] --bars bars.json [--index index.json] [--short short.json] [--actions actions.json]
// --market CODE: the market (M19 C2, MKT-110 a); omitted = the single enabled market, else exit 2 ("market required");
//   a market that is not enabled exits 2 with "refused: market not enabled" and writes nothing, not even a run record.
// --now <ISO instant>: the simulated clock of the CI recorded day (M18 D-965); refused unless PRAXIS_ENV=recorded.
// (M4 T3: index.json = the python step's benchmark-index bars, short.json = the no-secrets ASIC step)
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
import { resolveScriptMarket, takeMarketFlag } from "../../src/lib/market/scriptMarket.mjs";
import { parseNow } from "../e2e-day/now.mjs";

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
  const sim = parseNow(argv, env);
  if (sim.error) {
    out(`ingest-batch1: failed (${sim.error})`);
    return 2;
  }
  const nowMs = sim.nowMs ?? deps.nowMs ?? (() => Date.now());
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const mk = takeMarketFlag(sim.argv);
  if (mk.error) {
    out(`ingest-batch1: failed (${mk.error})`);
    return 2;
  }
  const [cmd, ...rest] = mk.argv;
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
    // MKT-110 a: the market must be enabled before anything is written (no run record for a refused market)
    const m = await resolveScriptMarket(db, mk.market);
    if (!m.ok) {
      out(`ingest-batch1 ${cmd}: ${m.line}`);
      return m.exit;
    }
    if (cmd === "prepare") return await prepare(db, rest, env, nowMs, out, m.market);
    return await ingest(db, rest, env, nowMs, out, deps.runOptions ?? {}, m.market);
  } catch {
    // Never print a driver error: it can carry the database URL.
    out(`ingest-batch1 ${cmd}: failed (unexpected error)`);
    return 1;
  } finally {
    db.close();
  }
}

async function prepare(db, args, env, nowMs, out, market) {
  const requestPath = flag(args, "--request");
  if (requestPath === null) {
    out("ingest-batch1 prepare: failed (--request <file> is required)");
    return 1;
  }
  const r = await prepareBatch1(db, { nowMs: nowMs(), market });
  const lines = [];
  if (r.action === "fetch") {
    writeFileSync(requestPath, JSON.stringify(r.request));
    lines.push(
      "fetch=true",
      `chunk_size=${r.throttle.chunkSize}`,
      `min_gap_s=${r.throttle.minGapS}`,
    );
    out(
      `ingest-batch1 prepare: fetch dates=${r.dates} codes=${r.codes} excluded=${r.excluded} short_dates=${r.request.short_dates?.length ?? 0}`,
    );
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

function readOptional(path) {
  if (path === null) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // the pipeline records a visible failure if it needed the file
  }
}

async function ingest(db, args, env, nowMs, out, runOptions, market) {
  const barsText = readOptional(flag(args, "--bars"));
  const indexText = readOptional(flag(args, "--index"));
  const shortText = readOptional(flag(args, "--short"));
  const actionsText = readOptional(flag(args, "--actions"));
  const res = await runBatch1(db, {
    nowMs,
    market,
    barsText,
    indexText,
    shortText,
    actionsText,
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
