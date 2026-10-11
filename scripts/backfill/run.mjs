// History backfill CLI (M2 T9; DAT-125, DAT-125a, DAT-140, decisions 7 and 13). Runs in the
// `production` GitHub environment on the approved commit (SEC-108 c), from the dispatch-only
// workflow backfill-history.yml.
//   node scripts/backfill/run.mjs plan   --out plan.json      (database secrets only)
//   node scripts/backfill/run.mjs commit --chunks chunks.json (database + data-repo secrets)
// `plan` decides what the secret-free ASIC fetch step should fetch (months of the ASIC job, newest
// first, under the cap and the source switch) and reports `fetch=true|false` as a step output.
// `commit` writes the fetched ASIC months as history files and moves the cursor, then exports any
// completed past month of announcement history from Turso to its history file.
// The ASX announcement fetch is NOT here: only the Worker may contact asx.com.au (DAT-122); it
// hands parsed days to `commitAsxDay` (src/lib/data/backfill/engine.mjs).
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN; commit also DATA_REPO (`<owner>/<repo>-data`),
//      DATA_REPO_TOKEN, COMMIT_SHA (optional); plan: GITHUB_OUTPUT (optional).
// Output: statuses and counts only. Never a row, a URL, a token or a driver message.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { createHistoryStore } from "../../src/lib/data/backfill/dataRepo.mjs";
import {
  commitHistoryMonth,
  exportAsxMonths,
  planAsic,
} from "../../src/lib/data/backfill/engine.mjs";
import { isMonth } from "../../src/lib/data/backfill/rules.mjs";

const has = (v) => typeof v === "string" && v.trim() !== "";
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: (url: string, token: string | undefined) => import("@libsql/client").Client,
 *   nowMs?: () => number, out?: (s: string) => void, fetchImpl?: typeof fetch,
 *   options?: Record<string, unknown> }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const [cmd, ...rest] = argv;
  if (cmd !== "plan" && cmd !== "commit") {
    out("backfill: failed (usage: plan --out <file> | commit --chunks <file>)");
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out(`backfill ${cmd}: failed (database not configured)`);
    return 1;
  }
  let store = null;
  if (cmd === "commit") {
    try {
      store = createHistoryStore({
        repo: String(env.DATA_REPO),
        token: String(env.DATA_REPO_TOKEN ?? ""),
        fetchImpl: deps.fetchImpl,
      });
    } catch {
      out("backfill commit: failed (data repository not configured)");
      return 1;
    }
  }
  let db;
  try {
    db = openDb(url, has(token) ? token : undefined);
  } catch {
    out(`backfill ${cmd}: failed (cannot open database)`);
    return 1;
  }
  try {
    if (cmd === "plan") return await plan(db, rest, env, nowMs, out, deps.options ?? {});
    return await commit(db, store, rest, env, nowMs, out, deps.options ?? {});
  } catch {
    // Never print a driver or network error: it can carry the database URL.
    out(`backfill ${cmd}: failed (unexpected error)`);
    return 1;
  } finally {
    db.close();
  }
}

async function plan(db, args, env, nowMs, out, options) {
  const outPath = flag(args, "--out");
  if (outPath === null) {
    out("backfill plan: failed (--out <file> is required)");
    return 1;
  }
  const p = await planAsic(db, { nowMs: nowMs(), ...options });
  const lines = [];
  if (p.action === "fetch") {
    writeFileSync(
      outPath,
      JSON.stringify({ months: p.months.map((m) => ({ month: m.month, dates: m.dates })) }),
    );
    lines.push("fetch=true");
    out(
      `backfill plan: fetch months=${p.months.length} dates=${p.months.reduce((a, m) => a + m.dates.length, 0)}`,
    );
  } else {
    lines.push("fetch=false");
    out(`backfill plan: no fetch (${p.reason})`);
  }
  if (has(env.GITHUB_OUTPUT)) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  return 0;
}

async function commit(db, store, args, env, nowMs, out, options) {
  const commitSha = has(env.COMMIT_SHA) ? env.COMMIT_SHA : undefined;
  let failed = false;
  let month = null;

  // (1) ASIC months fetched by the secret-free step (absent file = the fetch was not needed).
  const chunksPath = flag(args, "--chunks");
  let chunks = null;
  if (chunksPath !== null) {
    try {
      chunks = JSON.parse(readFileSync(chunksPath, "utf8"));
    } catch {
      chunks = null;
    }
  }
  if (chunks !== null && Array.isArray(chunks.months)) {
    const sorted = chunks.months
      .filter((m) => isMonth(m?.month) && m.complete === true && Array.isArray(m.rows))
      .sort((a, b) => (a.month < b.month ? 1 : -1)); // newest first, the cursor's order
    for (const m of sorted) {
      const r = await commitHistoryMonth(db, {
        month: m.month,
        rows: m.rows,
        store,
        nowMs: nowMs(),
        commitSha,
        ...options,
      });
      out(
        `backfill commit: asic ${m.month} ${r.status}${r.file ? ` file=${r.file}` : ""} rows=${r.rows ?? 0}`,
      );
      if (r.status === "ok") month = m.month;
      if (r.status === "conflict" || r.status === "out_of_order" || r.status === "rejected")
        failed = true;
      if (r.status !== "ok" && r.status !== "already_done") break;
    }
    if (chunks.stopped) {
      out(
        `backfill commit: asic fetch had stopped (${String(chunks.stopped).replace(/[^a-z_]/g, "")})`,
      );
      failed = true;
    }
  }

  // (2) Announcement history months that are complete in Turso.
  const ex = await exportAsxMonths(db, { store, nowMs: nowMs(), commitSha, ...options });
  out(
    `backfill commit: asx export uploaded=${ex.exported.length} skipped=${ex.skipped.length} conflicts=${ex.conflicts.length}${ex.stopped ? ` stopped=${ex.stopped}` : ""}`,
  );
  if (ex.conflicts.length > 0 || ex.stopped === "too_many_rows") failed = true;
  if (month !== null) out("backfill commit: asic cursor advanced");
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
