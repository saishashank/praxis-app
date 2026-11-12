// Batch 1 for the US (M20 US1; D-1127, D-1132, D-1180). `pipeline/batch1-core.mjs` dispatches every built market that is
// not the home market to `sources/<code>/day.mjs` by convention; this is the US one. It exports the two functions the
// dispatcher calls, with the shapes of the home pipeline's:
//   prepareDay(db, o)  read-only: should a fetch step run, and for which codes and dates
//   runDay(db, o)      writes the night: universe snapshot, bars, filings and their categories, insider and holder
//                      notices, short volume, halts, index bars, the quality verdict and the completion marker
// The network is NOT in this file. The fetch step (`scripts/ingest/us/fetch.mjs`, a workflow step with no database)
// writes `feeds.json`; this step reads it and the bars file and writes the database. Both steps refuse before any request
// or write while the market is off: `assertMarketEnabled` is the first statement of each (AT-70, MKT-110 b).
//
// Honesty rules kept from the home pipeline: nothing is invented (a missing bars file fails the date visibly, DAT-004),
// every write is `ON CONFLICT DO NOTHING` (a re-run adds nothing), a feed that fails never fails the bars (the stage is
// recorded as `failed` in the run record and the status is `degraded`), and errors are fixed words and counts, never a
// driver message, a URL, a code list or a row (SEC-110 b). Only the live target date is processed: the US keeps no
// catch-up window, a missed night is reported by the next run's `calendar` stage and the quality verdict.
import { assertMarketEnabled } from "../../../market/guard.mjs";
import { staticProfile } from "../../../market/staticProfile.mjs";
import { CATEGORY_MAP } from "../../../market/seed/us/categoryMap.mjs";
import { addDays, isWeekend, previousTradingDay } from "../../pipeline/rules.mjs";
import { assignTiers, tierRulesOf } from "../../universe/tiers.mjs";
import { qualityHook } from "../../quality/engine.mjs";
import { parseUsBarsText, UsBarsFormatError } from "./bars.mjs";
import { classifyItem } from "./classify.mjs";
import { announcementsFromSubmissions, writeAnnouncements } from "./filings8k.mjs";
import { noticeOfForm4, parseForm4, writeInsiderNotice } from "./form4.mjs";
import { parseDailyShortVolume, writeShortInterest } from "./finra.mjs";
import { parseNasdaqHalts, parseSecSuspensions, writeHalts } from "./halts.mjs";
import { parseIndexCsv, writeIndexBars } from "./index.mjs";
import {
  isSchedule13,
  noticeOfSchedule13,
  percentOfClass,
  writeHolderNotice,
} from "./schedule13.mjs";
import { parseSubmissions, writeSicGroup } from "./submissions.mjs";

export const JOB = "ingest-batch1";
export const STAGE_NAMES = [
  "calendar",
  "universe",
  "bars",
  "filings",
  "notices",
  "short",
  "halts",
  "index",
  "quality",
  "marker",
];
const CALENDAR_BACK_DAYS = 400;
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const CODES_PER_QUERY = 300;
const ROWS_PER_STATEMENT = 100;
const keyFor = (market, d) => `batch1:${market}:${d}`;

/** @typedef {import("@libsql/client").Client} Client */

/** The local date (YYYY-MM-DD) of an instant in a zone. @param {number} ms @param {string} tz */
function localDate(ms, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
/** @param {{ nowMs: number | (() => number) }} o */
const nowOf = (o) => (typeof o.nowMs === "function" ? o.nowMs() : o.nowMs);

/** @param {Client} db @param {{ read: number }} io */
async function sel(db, io, sql, args = []) {
  const r = await db.execute({ sql, args });
  io.read += r.rows.length;
  return r.rows;
}

async function insertRows(db, table, cols, rows) {
  if (rows.length === 0) return 0;
  const ph = `(${cols.map(() => "?").join(",")})`;
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      // rows-ok: at most 100 rows per statement; one row per covered code of the night, ignored when present
      sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flat(),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

/** Steps shared by prepare and run: market mode, done check, the calendar. Read-only. */
async function assess(db, o) {
  const market = o.market;
  const profile = staticProfile(market);
  const target = localDate(nowOf(o), profile.tz);
  const io = { read: 0 };
  const base = { target, market, profile, io };
  const mode = await sel(db, io, "SELECT mode FROM market WHERE code = ?", [market]);
  if (!mode.length) return { ...base, kind: "failed", reason: "market_missing" };
  if (String(mode[0].mode) === "off") return { ...base, kind: "skip", reason: "market_off" };
  const done = await sel(
    db,
    io,
    "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    [keyFor(market, target)],
  );
  if (done.length > 0) return { ...base, kind: "done", reason: "already_done" };
  const calRows = (
    await sel(
      db,
      io,
      "SELECT d, kind, confirmed FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      [market, addDays(target, -CALENDAR_BACK_DAYS), target],
    )
  ).map((r) => ({ d: String(r.d), kind: String(r.kind), confirmed: Number(r.confirmed) }));
  const today = calRows.find((r) => r.d === target);
  /** @type {"trading" | "non_trading" | "missing"} */
  let day;
  if (isWeekend(target) || today?.kind === "holiday") day = "non_trading";
  else if (today === undefined) day = "missing";
  else day = "trading";
  return { ...base, kind: "go", calRows, day, calRow: today };
}

/** The codes of the market's universe on `d`: the `instrument` rows (the capped list, D-1098), plain tickers only. */
async function loadUniverse(db, io, market, d) {
  const rows = await sel(
    db,
    io,
    // rows-ok: the market's instrument rows (at most universe_max, 2,500)
    `SELECT code, listed_on FROM instrument WHERE market = ? AND (listed_on IS NULL OR listed_on <= ?)
     AND (delisted_on IS NULL OR delisted_on > ?) ORDER BY code`,
    [market, d, d],
  );
  const codes = [];
  const listed = new Map();
  for (const r of rows) {
    const c = String(r.code);
    if (!TICKER_RE.test(c)) continue;
    codes.push(c);
    listed.set(c, r.listed_on === null ? null : String(r.listed_on));
  }
  return { codes, listed, excluded: rows.length - codes.length };
}

/** `prepareDay`: the read-only "what should the fetch step ask for" call. @param {Client} db */
export async function prepareDay(db, o) {
  await assertMarketEnabled(db, o.market);
  const a = await assess(db, o);
  if (a.kind === "failed" || a.kind === "skip" || a.kind === "done")
    return { action: "skip", target: a.target, reason: a.reason };
  if (a.day === "missing") return { action: "skip", target: a.target, reason: "calendar_missing" };
  if (a.day === "non_trading") return { action: "nothing_to_fetch", target: a.target, dates: 0 };
  const uni = await loadUniverse(db, a.io, o.market, a.target);
  if (uni.codes.length === 0) return { action: "skip", target: a.target, reason: "no_universe" };
  return {
    action: "fetch",
    target: a.target,
    dates: 1,
    codes: uni.codes.length,
    excluded: uni.excluded,
    // the fetch step reads this: the codes, the date, the profile's own values (no market default, D-1034)
    request: {
      codes: uni.codes,
      start: previousTradingDay(a.target, a.calRows),
      end: a.target,
      suffix: a.profile.yahooSuffix ?? "",
      currency: a.profile.currency,
    },
  };
}

/** The 60-session traded values of the universe up to (not including) `d`, and the last raw close. */
async function computeTiers(db, io, profile, calRows, d, codes, listed) {
  const rules = tierRulesOf(profile);
  let from = d;
  for (let i = 0; i < rules.windowSessions; i += 1) {
    try {
      from = previousTradingDay(from, calRows);
    } catch {
      break;
    }
  }
  const traded = new Map();
  const last = new Map();
  const first = new Map();
  for (let i = 0; i < codes.length; i += CODES_PER_QUERY) {
    const chunk = codes.slice(i, i + CODES_PER_QUERY);
    const bars = await sel(
      db,
      io,
      // rows-ok: one chunk of at most 300 codes x the 60-session window, the same shape as the home tier read
      `SELECT code, d, c, volume FROM price_bar WHERE market = ? AND d >= ? AND d < ?
       AND code IN (SELECT value FROM json_each(?)) ORDER BY code, d`,
      [profile.code, from, d, JSON.stringify(chunk)],
    );
    for (const b of bars) {
      const code = String(b.code);
      const price = BigInt(Math.round(Number(b.c) * 1e6)); // money-float-ok: vendor price to micro
      let list = traded.get(code);
      if (list === undefined) traded.set(code, (list = []));
      list.push(price * BigInt(Number(b.volume))); // money-float-ok: SQL integer column
      last.set(code, price);
      if (!first.has(code)) first.set(code, String(b.d));
    }
  }
  const tiers = assignTiers(
    codes.map((code) => ({
      code,
      priceMicro: last.get(code) ?? 0n,
      tradedMicro: traded.get(code) ?? [],
      listedSince: listed.get(code) ?? first.get(code) ?? null,
      mcapMicro: null,
    })),
    d,
    rules,
  );
  const out = new Map();
  for (const [code, t] of tiers) {
    out.set(code, {
      tier: t.tier,
      status: t.status,
      adv: t.advMicro === null ? null : Number(t.advMicro / 1_000_000n), // money-float-ok: currency units in a REAL column
    });
  }
  return out;
}

/** @param {string | null | undefined} text */
function parseFeeds(text) {
  if (text === null || text === undefined) return {};
  try {
    const j = JSON.parse(text);
    return j !== null && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return { _unreadable: true };
  }
}

/**
 * `runDay`: never throws for pipeline problems; returns `{ exit, status, reason?, target, dates }`.
 * @param {Client} db
 * @param {{ nowMs: number | (() => number), market: string, barsText?: string | null, feedsText?: string | null,
 *           feeds?: Record<string, any>, commitSha?: string, qualityHook?: Function }} o
 */
export async function runDay(db, o) {
  await assertMarketEnabled(db, o.market);
  const market = o.market;
  const iso = () => new Date(nowOf(o)).toISOString();
  const a = await assess(db, o);
  const result = (exit, status, reason, d) => ({
    exit,
    status,
    reason,
    target: a.target,
    dates: d ?? [],
  });

  if (a.kind === "done") return result(0, "skipped", a.reason);
  if (a.kind === "failed") return result(1, "failed", a.reason);
  const key = keyFor(market, a.target);
  const startRun = async () => {
    const r = await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, commit_sha)
            VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      args: [JOB, market, key, a.target, iso(), o.commitSha ?? null],
    });
    return Number(r.lastInsertRowid);
  };
  const finish = async (id, f) => {
    const cur = await db.execute({
      sql: "SELECT started_at FROM run_record WHERE id = ?",
      args: [id],
    });
    await db.execute({
      sql: `UPDATE run_record SET status = ?, ended_at = ?, duration_ms = ?, items_processed = ?, rows_read = ?,
            rows_written = ?, llm_tokens = 0, error_summary = ?, details_json = ? WHERE id = ?`,
      args: [
        f.status,
        iso(),
        Math.max(0, nowOf(o) - Date.parse(String(cur.rows[0].started_at))),
        f.items ?? 0,
        f.read ?? 0,
        f.written ?? 0,
        f.error === undefined ? null : String(f.error).slice(0, 500),
        f.details === undefined ? null : JSON.stringify(f.details),
        id,
      ],
    });
  };

  if (a.kind === "skip") {
    const id = await startRun();
    await finish(id, { status: "skipped", read: a.io.read, details: { reason: a.reason } });
    return result(0, "skipped", a.reason);
  }
  if (a.day === "missing") {
    const id = await startRun();
    await finish(id, {
      status: "skipped",
      read: a.io.read,
      details: { reason: "calendar_missing" },
    });
    return result(0, "skipped", "calendar_missing");
  }

  const io = { read: a.io.read, written: 0 };
  const stages = Object.fromEntries(STAGE_NAMES.map((s) => [s, "pending"]));
  // a run still 'running' for this key died: close it so the clock does not wait for it forever
  await db.execute({
    sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
          WHERE concurrency_key = ? AND status = 'running'`,
    args: [iso(), "superseded: the previous run did not finish", key],
  });
  const runId = await startRun();
  const d = a.target;
  let stage = "calendar";
  const out = { d, status: "ok", rowsRead: 0, rowsWritten: 0, bars: 0, rejected: 0 };
  try {
    if (a.day === "non_trading") {
      stage = "marker";
      const n = await insertRows(
        db,
        "completion_marker",
        ["market", "d", "kind", "at", "run_id", "outcome"],
        [[market, d, "non-trading", iso(), runId, "non-trading"]],
      );
      io.written += n;
      stages.calendar = "non-trading";
      await finish(runId, {
        status: "skipped",
        read: io.read,
        written: io.written,
        details: { reason: "non_trading_day", stages },
      });
      return result(0, "ok", undefined, [
        { ...out, status: "non_trading", rowsRead: io.read, rowsWritten: io.written },
      ]);
    }
    stages.calendar = { trading_day: true, confirmed: a.calRow?.confirmed === 1 };

    // ---- universe snapshot ------------------------------------------------------------------------------------
    stage = "universe";
    const uni = await loadUniverse(db, io, market, d);
    if (uni.codes.length === 0) {
      await finish(runId, {
        status: "skipped",
        read: io.read,
        written: io.written,
        error: "no universe for date",
        details: { reason: "no_universe", stages },
      });
      return result(0, "ok", undefined, [{ ...out, status: "no_universe" }]);
    }
    const tiers = await computeTiers(db, io, a.profile, a.calRows, d, uni.codes, uni.listed);
    const snapRows = uni.codes.map((code) => {
      const t = tiers.get(code);
      return [market, d, code, t.status, t.tier, null, t.adv, 0];
    });
    io.written += await insertRows(
      db,
      "universe_snapshot",
      ["market", "d", "code", "status", "tier", "mcap_est", "adv", "halted"],
      snapRows,
    );
    stages.universe = { rows: snapRows.length };

    // ---- bars ---------------------------------------------------------------------------------------------------
    stage = "bars";
    if (o.barsText === null || o.barsText === undefined)
      throw new StageError("bars", "bars file missing");
    let parsed;
    try {
      parsed = parseUsBarsText(o.barsText, { from: addDays(d, -10), to: d });
    } catch (e) {
      throw new StageError(
        "bars",
        e instanceof UsBarsFormatError ? e.message : "bars file unreadable",
      );
    }
    const set = new Set(uni.codes);
    const todays = parsed.rows.filter((r) => r.date === d && set.has(r.code));
    if (todays.length === 0) throw new StageError("bars", "no valid bars for the date");
    const ingestedAt = iso();
    const inserted = await insertRows(
      db,
      "price_bar",
      [
        "market",
        "code",
        "d",
        "o",
        "h",
        "l",
        "c",
        "volume",
        "source",
        "published_at",
        "ingested_at",
      ],
      todays.map((r) => [
        market,
        r.code,
        d,
        r.open,
        r.high,
        r.low,
        r.close,
        r.volume,
        r.source,
        ingestedAt,
        ingestedAt,
      ]),
    );
    io.written += inserted;
    out.bars = todays.length;
    out.rejected = parsed.rejected.length;
    stages.bars = {
      valid: todays.length,
      inserted,
      rejected: parsed.rejected.length,
      not_in_universe: parsed.rows.filter((r) => r.date === d).length - todays.length,
    };

    // ---- the feeds: each stage is isolated, a failure degrades the night, never the bars ----------------------
    const feeds = o.feeds ?? parseFeeds(o.feedsText);
    let feedFailed = feeds._unreadable === true;
    const guarded = async (name, fn) => {
      stage = name;
      try {
        stages[name] = await fn();
      } catch (e) {
        // fixed words only: the typed refusal of the guard is rethrown (a market that went off mid-run stops the run)
        if (e instanceof Error && e.name === "MarketNotEnabled") throw e;
        feedFailed = true;
        stages[name] = { failed: e instanceof Error ? e.name : "error" };
      }
    };
    const now = iso();
    const covered = new Set(uni.codes);

    await guarded("filings", async () => {
      let ann = 0;
      let cats = 0;
      let sic = 0;
      let skipped = 0;
      const classify = (item) => classifyItem(CATEGORY_MAP, item);
      for (const s of feeds.submissions ?? []) {
        if (!covered.has(s?.code)) continue;
        const subs = parseSubmissions(s.json);
        if (await writeSicGroup(db, market, s.code, subs.sic)) sic += 1;
        const c = announcementsFromSubmissions(subs, s.code, { since: addDays(d, -3) });
        skipped += c.skippedNoTime;
        const w = await writeAnnouncements(db, market, c.rows, { classify, now });
        ann += w.inserted;
        cats += w.categories;
      }
      return { announcements: ann, categories: cats, sic_updates: sic, skipped_no_time: skipped };
    });

    await guarded("notices", async () => {
      let insiders = 0;
      let holders = 0;
      let skipped = 0;
      for (const f of feeds.form4 ?? []) {
        if (!covered.has(f?.code) || typeof f.xml !== "string") continue;
        const n = noticeOfForm4(parseForm4(f.xml));
        if (n === null) {
          skipped += 1;
          continue;
        }
        if (
          await writeInsiderNotice(db, market, {
            annId: f.accession,
            code: f.code,
            kind: n.kind,
            valueMicro: n.valueMicro,
            publishedAt: f.acceptedAt,
          })
        )
          insiders += 1;
      }
      for (const f of feeds.schedule13 ?? []) {
        if (!covered.has(f?.code) || typeof f.form !== "string" || !isSchedule13(f.form)) continue;
        const n = noticeOfSchedule13(f.form, {
          percent: percentOfClass(f.xml),
          previousPercent: f.previousPercent ?? null,
        });
        if (!("kind" in n)) {
          skipped += 1;
          continue;
        }
        if (
          await writeHolderNotice(db, market, {
            annId: f.accession,
            code: f.code,
            kind: n.kind,
            publishedAt: f.acceptedAt,
          })
        )
          holders += 1;
      }
      return { insider: insiders, holder: holders, skipped };
    });

    await guarded("short", async () => {
      if (typeof feeds.finraDaily !== "string") return "no_feed";
      const p = parseDailyShortVolume(feeds.finraDaily);
      const w = await writeShortInterest(db, market, p.rows, covered, now);
      return {
        parsed: p.rows.length,
        inserted: w.inserted,
        not_covered: w.notCovered,
        rejected: p.rejected,
      };
    });

    await guarded("halts", async () => {
      const rows = [];
      let skipped = 0;
      if (typeof feeds.halts === "string") {
        const p = parseNasdaqHalts(feeds.halts, a.profile.tz);
        rows.push(...p.rows);
        skipped += p.skipped;
      }
      if (typeof feeds.suspensions === "string") {
        const p = parseSecSuspensions(feeds.suspensions);
        rows.push(...p.rows);
        skipped += p.skipped;
      }
      const w = await writeHalts(
        db,
        market,
        rows.filter((r) => covered.has(r.code)),
      );
      return { inserted: w.inserted, resumed: w.resumed, skipped };
    });

    await guarded("index", async () => {
      let n = 0;
      for (const [indexCode, text] of Object.entries(feeds.indexCsv ?? {})) {
        if (typeof text !== "string") continue;
        n += await writeIndexBars(db, market, parseIndexCsv(text, indexCode).rows, now);
      }
      return { inserted: n };
    });

    // ---- quality, then the marker ------------------------------------------------------------------------------
    stage = "quality";
    const hook = o.qualityHook ?? qualityHook;
    const q = await hook({
      db,
      market,
      d,
      io,
      now,
      universe: uni.codes.length,
      barsValid: todays.length,
      rejected: parsed.rejected.filter((r) => r.date === d),
      refetchDiffs: [],
    });
    stages.quality =
      q && typeof q.flags === "number" ? { flags: q.flags, ...(q.summary ?? {}) } : "done";

    stage = "marker";
    const outcome =
      todays.length === uni.codes.length && parsed.rejected.length === 0
        ? "complete"
        : `partial:${todays.length}/${uni.codes.length}`;
    io.written += await insertRows(
      db,
      "completion_marker",
      ["market", "d", "kind", "at", "run_id", "outcome"],
      [[market, d, "data", iso(), runId, outcome]],
    );
    stages.marker = outcome;

    await finish(runId, {
      status: feedFailed ? "degraded" : "success",
      items: todays.length,
      read: io.read,
      written: io.written,
      details: { stages },
    });
    return result(0, feedFailed ? "degraded" : "ok", undefined, [
      {
        ...out,
        status: feedFailed ? "degraded" : "ok",
        rowsRead: io.read,
        rowsWritten: io.written,
      },
    ]);
  } catch (e) {
    if (e instanceof Error && e.name === "MarketNotEnabled") throw e;
    const why =
      e instanceof StageError ? e.message : `${stage}: ${e instanceof Error ? e.name : "error"}`;
    await finish(runId, {
      status: "failed",
      read: io.read,
      written: io.written,
      error: why,
      details: { stage, stages },
    });
    return result(1, "failed", stage, [{ ...out, status: "failed", error: why }]);
  }
}

export class StageError extends Error {
  /** @param {string} stage @param {string} [detail] */
  constructor(stage, detail) {
    super(detail ? `${stage}: ${detail}` : stage);
    this.name = "StageError";
    this.stage = stage;
  }
}
