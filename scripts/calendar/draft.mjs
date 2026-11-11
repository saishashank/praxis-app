// Yearly trading-calendar draft job (OPS-103, DAT-160; D-961). Runs in the `production` GitHub
// environment on the approved commit from .github/workflows/calendar-draft.yml (the Worker dispatches
// it once a year, 1 November 09:00 Melbourne).
//   node scripts/calendar/draft.mjs [--market CODE[,CODE]] [--year 2028] [--now ISO]
// For each market (default: every ENABLED market in the `market` table that has a rule module; a named market must be
// enabled too: M19 C2, MKT-110 a, the trading_calendar guard refuses a row of any other, so it exits 2 with
// "refused: market not enabled" and writes nothing) it generates
// next year's rows from the market's rule module (src/lib/data/calendarRules.mjs, the same rules as the
// seed generator) and inserts them as PROVISIONAL rows (`confirmed = 0`, source `draft:<rule set>`), but
// ONLY when the market has no rows for that year at all: a year that already exists (seeded, drafted,
// confirmed) is never touched, so the append-only guards of trading_calendar stay as they are. A drafted
// year writes one run record `calendar-draft:<market>:<year>`. The Owner then sees the item
// "Next year's trading calendar is drafted..." on System Health until they confirm the year there (the
// item is derived from the rows, src/lib/data/calendarEscalation.ts), and the heartbeat escalates it from
// 1 December and 1 January. The holiday rules are computed, not fetched: the Owner checks the drafted
// days against the ASX's published calendar before confirming (DAT-160 [VERIFY]). No network access.
// env: TURSO_MAIN_URL, TURSO_MAIN_TOKEN. Output: counts only. Exit 0 done, 1 failed, 2 usage.
import { fileURLToPath } from "node:url";
import { CALENDAR_RULE_MODULES, DRAFT_SOURCE_PREFIX } from "../../src/lib/data/calendarRules.mjs";
import { OWNER_TZ } from "../../src/lib/market/profileCore.mjs";
import { REFUSED_EXIT, REFUSED_LINE, enabledCodes } from "../../src/lib/market/scriptMarket.mjs";

export const JOB = "calendar-draft";
const MARKET_RE = /^[A-Z]{2,5}$/;

/** The Melbourne calendar year of an instant (the Owner's clock, not a market's). */
export function melbourneYear(now) {
  return Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: OWNER_TZ, year: "numeric" }).format(now),
  );
}

/**
 * Draft one market-year. Idempotent: returns `exists` and writes nothing when the year has any row.
 * @param {{ execute: Function, batch: Function }} db
 * @param {{ market: string, year: number, now: Date }} p
 * @returns {Promise<{ status: "drafted" | "exists" | "no_rules" | "unknown_market" | "bad_year", rows: number }>}
 */
export async function draftYear(db, { market, year, now }) {
  const rules = Object.hasOwn(CALENDAR_RULE_MODULES, market) ? CALENDAR_RULE_MODULES[market] : null;
  if (!MARKET_RE.test(market) || rules === null) return { status: "no_rules", rows: 0 };
  const nowYear = melbourneYear(now);
  if (!Number.isInteger(year) || year < nowYear || year > nowYear + 2) {
    return { status: "bad_year", rows: 0 }; // past years are facts, far years are guesses
  }
  const known = await db.execute({ sql: "SELECT 1 FROM market WHERE code = ?", args: [market] });
  if (known.rows.length === 0) return { status: "unknown_market", rows: 0 };
  // rows-ok: one key-range count over a year of trading_calendar (about 260 rows)
  const have = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
    args: [market, `${year}-01-01`, `${year}-12-31`],
  });
  if (Number(have.rows[0].n) > 0) return { status: "exists", rows: 0 };
  const rows = rules.yearRows(year);
  const source = `${DRAFT_SOURCE_PREFIX}${rules.source}`;
  const stamp = now.toISOString();
  await db.batch(
    [
      ...rows.map(([d, kind, closeTime]) => ({
        sql: `INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source)
              VALUES (?, ?, ?, ?, 0, ?)`,
        args: [market, d, kind, closeTime, source],
      })),
      {
        sql: `INSERT OR IGNORE INTO run_record (job, market, concurrency_key, scheduled_for, started_at,
              ended_at, status, items_processed, rows_written, details_json)
              VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
        args: [
          JOB,
          market,
          `${JOB}:${market}:${year}`,
          String(year),
          stamp,
          stamp,
          rows.length,
          rows.length + 1,
          JSON.stringify({ year, source, rows: rows.length }),
        ],
      },
    ],
    "write",
  );
  return { status: "drafted", rows: rows.length };
}

/** @param {string[]} argv @param {string} flag */
const arg = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} out
 * @param {{ connect?: (env: Record<string, string | undefined>) => Promise<any> }} [deps]
 */
export async function run(argv, env, out = console.log, deps = {}) {
  const nowArg = arg(argv, "--now");
  const now = nowArg === undefined ? new Date() : new Date(nowArg);
  if (Number.isNaN(now.getTime())) {
    out("calendar-draft: usage: --now must be an ISO time");
    return 2;
  }
  const yearArg = arg(argv, "--year");
  const year = yearArg === undefined || yearArg === "" ? melbourneYear(now) + 1 : Number(yearArg);
  if (!Number.isInteger(year)) {
    out("calendar-draft: usage: --year must be a whole year");
    return 2;
  }
  const marketArg = arg(argv, "--market");
  if ((env.TURSO_MAIN_URL ?? "").trim() === "") {
    out("calendar-draft: failed (TURSO_MAIN_URL not set)");
    return 1;
  }
  let db;
  try {
    const connect =
      deps.connect ??
      (async (e) => {
        const { createClient } = await import("@libsql/client");
        return createClient({ url: e.TURSO_MAIN_URL, authToken: e.TURSO_MAIN_TOKEN });
      });
    db = await connect(env);
    // MKT-110 a: only an enabled market is drafted (and a named one must be enabled before anything is written)
    const enabled = await enabledCodes(db);
    let markets;
    if (marketArg !== undefined && marketArg !== "") {
      markets = marketArg.split(",").map((m) => m.trim());
      if (markets.some((m) => !enabled.includes(m))) {
        out(`calendar-draft: ${REFUSED_LINE}`);
        return REFUSED_EXIT;
      }
    } else {
      markets = enabled.filter((m) => Object.hasOwn(CALENDAR_RULE_MODULES, m));
    }
    let failed = false;
    for (const market of markets) {
      const r = await draftYear(db, { market, year, now });
      out(`calendar-draft: ${market} ${year} ${r.status} rows=${r.rows}`);
      if (r.status === "no_rules" || r.status === "unknown_market" || r.status === "bad_year") {
        failed = true;
      }
    }
    return failed ? 1 : 0;
  } catch {
    out("calendar-draft: failed (database)");
    return 1;
  } finally {
    db?.close?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
