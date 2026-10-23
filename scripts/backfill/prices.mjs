// Price-history backfill CLI (M4 T16a, D-092 draft; D-086, DAT-125, DAT-126). Runs in the
// `production` GitHub environment on the approved commit (SEC-108 c) from the dispatch-only
// workflow backfill-prices.yml.
//   node scripts/backfill/prices.mjs plan   --out plan.json      (database secrets only)
//   node scripts/backfill/prices.mjs commit --prices prices.json (database + data-repo secrets)
// `plan` asks planPrices for the next month; when the Yahoo source is not accepted (O-26) or off it
// records `source_off` (inside planPrices) and reports fetch=false. Otherwise it writes plan.json
// {month, start, end, codes} for the secret-free Python fetch step and reports fetch=true.
// `commit` reads prices.json {month, vendor, bars, splits} and calls commitPriceMonth, which
// reconstructs raw prices, uploads the write-once month file and moves the cursor.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN; commit also DATA_REPO, DATA_REPO_TOKEN, COMMIT_SHA
// (optional); plan: GITHUB_OUTPUT (optional). Output: statuses and counts only.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { createHistoryStore } from "../../src/lib/data/backfill/dataRepo.mjs";
import { commitPriceMonth, planPrices } from "../../src/lib/data/backfill/priceHistory.mjs";
import {
  MARKET,
  isMonth,
  isValidCode,
  monthFirstDay,
  monthLastDay,
} from "../../src/lib/data/backfill/rules.mjs";

const has = (v) => typeof v === "string" && v.trim() !== "";
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};

/** Codes listed on or before the month end (delisted names included: history needs them). */
export async function loadCodes(db, month) {
  const r = await db.execute({
    sql: `SELECT code FROM instrument WHERE market = ?
          AND (listed_on IS NULL OR listed_on <= ?)
          AND (delisted_on IS NULL OR delisted_on >= ?) ORDER BY code`,
    args: [MARKET, monthLastDay(month), monthFirstDay(month)],
  });
  return r.rows.map((x) => String(x.code)).filter(isValidCode);
}

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ openDb?: Function, nowMs?: () => number, out?: (s: string) => void,
 *   fetchImpl?: typeof fetch, options?: Record<string, unknown> }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const nowMs = deps.nowMs ?? (() => Date.now());
  const openDb = deps.openDb ?? ((url, authToken) => createClient({ url, authToken }));
  const [cmd, ...rest] = argv;
  if (cmd !== "plan" && cmd !== "commit") {
    out("prices: failed (usage: plan --out <file> | commit --prices <file>)");
    return 1;
  }
  const url = env.TURSO_MAIN_URL;
  const token = env.TURSO_MAIN_TOKEN;
  if (!has(url) || (!has(token) && !String(url).startsWith("file:"))) {
    out(`prices ${cmd}: failed (database not configured)`);
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
      out("prices commit: failed (data repository not configured)");
      return 1;
    }
  }
  let db;
  try {
    db = openDb(url, has(token) ? token : undefined);
  } catch {
    out(`prices ${cmd}: failed (cannot open database)`);
    return 1;
  }
  try {
    if (cmd === "plan") return await plan(db, rest, env, nowMs, out, deps.options ?? {});
    return await commit(db, store, rest, env, nowMs, out, deps.options ?? {});
  } catch {
    out(`prices ${cmd}: failed (unexpected error)`); // never a driver message (it can carry the URL)
    return 1;
  } finally {
    db.close();
  }
}

async function plan(db, args, env, nowMs, out, options) {
  const outPath = flag(args, "--out");
  if (outPath === null) {
    out("prices plan: failed (--out <file> is required)");
    return 1;
  }
  const p = await planPrices(db, { nowMs: nowMs(), ...options });
  let fetch = false;
  if (p.action === "fetch") {
    const codes = await loadCodes(db, p.month);
    if (codes.length === 0) {
      out(`prices plan: no fetch (no_codes) month=${p.month}`);
    } else {
      writeFileSync(
        outPath,
        JSON.stringify({
          month: p.month,
          start: monthFirstDay(p.month),
          end: monthLastDay(p.month),
          codes,
        }),
      );
      fetch = true;
      out(`prices plan: fetch month=${p.month} codes=${codes.length}`);
    }
  } else {
    out(`prices plan: no fetch (${p.reason})`);
  }
  if (has(env.GITHUB_OUTPUT)) appendFileSync(env.GITHUB_OUTPUT, `fetch=${fetch}\n`);
  return 0;
}

async function commit(db, store, args, env, nowMs, out, options) {
  const path = flag(args, "--prices");
  let doc = null;
  if (path !== null) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      doc = null;
    }
  }
  if (doc === null || !isMonth(doc.month) || !Array.isArray(doc.bars)) {
    out("prices commit: failed (prices file missing or malformed)");
    return 1;
  }
  const r = await commitPriceMonth(db, {
    month: doc.month,
    bars: doc.bars,
    vendorSplits: Array.isArray(doc.splits) ? doc.splits : [],
    vendor: doc.vendor === "raw" ? "raw" : "adjusted",
    store,
    nowMs: nowMs(),
    commitSha: has(env.COMMIT_SHA) ? env.COMMIT_SHA : undefined,
    ...options,
  });
  out(
    `prices commit: ${doc.month} ${r.status}${r.reason ? ` reason=${String(r.reason).replace(/[^a-z_]/g, "")}` : ""}${r.file ? ` file=${r.file}` : ""}${r.rows !== undefined ? ` rows=${r.rows}` : ""}${r.excluded ? ` excluded=${r.excluded}` : ""}`,
  );
  return ["ok", "already_done", "done", "source_off", "paused_cap"].includes(r.status) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
