// Batch 1 pipeline core (M2 T6): the database side of the end-of-day ingest. Plain ESM + JSDoc so
// the Actions CLI runs it without a build. Pure rules live in ./rules.mjs. The typed facade, the
// spec quotes and the stage list are in ./batch1.ts.
//
// What it writes (BLD-024 data-only mode): `universe_snapshot`, `price_bar`, `bar_refetch`,
// `completion_marker`, `ingest_cursor` (refetch hash only) and its own `run_record`. Nothing else.
// Every data write is `INSERT ... ON CONFLICT DO NOTHING` (DAT-003, D-058): a re-run never
// duplicates and never overwrites; price_bar is first-seen immutable (DAT-002).
// Errors surface only as a stage name plus a fixed short text: never a driver message, URL, token
// or data row (SEC-110 b). Row counts only.
import {
  BACKFILL_WRITE_CAP_MONTH,
  BarsFormatError,
  compareBar,
  isRealDate,
  isValidCode,
  LOOKBACK_DAYS,
  MARKET,
  MAX_DATES_PER_RUN,
  monthBoundsUtc,
  parseBarsText,
  planDates,
  previousTradingDay,
  REFETCH_DIFF_PCT,
  refetchHash,
  rejectSummary,
  SOURCE,
  sydneyDate,
  throttleFrom,
  addDays,
} from "./rules.mjs";

export const JOB = "ingest-batch1";
export const STAGE_NAMES = [
  "calendar",
  "universe",
  "bars",
  "corporate_actions",
  "announcements",
  "macro_and_other",
  "fundamentals",
  "quality",
  "marker",
];
/** Stages 4..7 are not built in M2 T6 (design section 1); they are recorded as stubs. */
const STUB_STAGES = ["corporate_actions", "announcements", "macro_and_other", "fundamentals"];
const CALENDAR_BACK_DAYS = 90;
const ROWS_PER_STATEMENT = 100;

export class StageError extends Error {
  /** @param {string} stage @param {string} [detail] */
  constructor(stage, detail) {
    super(detail ? `${stage}: ${detail}` : stage);
    this.name = "StageError";
    this.stage = stage;
  }
}

/** The T7 quality engine plugs in here. The default does nothing. */
export const noopQualityHook = async () => ({ flags: 0 });

const keyFor = (market, d) => `batch1:${market}:${d}`;

/**
 * @typedef {import("@libsql/client").Client} Client
 * @typedef {{ read: number, written: number }} Io
 */

/** @param {Client} db @param {Io} io */
async function sel(db, io, sql, args = []) {
  const r = await db.execute({ sql, args });
  io.read += r.rows.length;
  return r.rows;
}

/** Multi-row INSERT ... ON CONFLICT DO NOTHING in one atomic batch. Returns rows inserted. */
async function insertRows(db, table, cols, rows) {
  if (rows.length === 0) return 0;
  const ph = `(${cols.map(() => "?").join(",")})`;
  const stmts = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const slice = rows.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push({
      sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES ${slice.map(() => ph).join(",")} ON CONFLICT DO NOTHING`,
      args: slice.flat(),
    });
  }
  const res = await db.batch(stmts, "write");
  return res.reduce((a, r) => a + r.rowsAffected, 0);
}

async function hasSuccess(db, key) {
  const r = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    args: [key],
  });
  return r.rows.length > 0;
}

async function startRun(db, key, date, nowIso, commitSha) {
  const r = await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, status, commit_sha)
          VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    args: [JOB, MARKET, key, date, nowIso, commitSha ?? null],
  });
  return Number(r.lastInsertRowid);
}

async function finishRun(db, id, nowIso, r) {
  const cur = await db.execute({
    sql: "SELECT started_at FROM run_record WHERE id = ?",
    args: [id],
  });
  const duration = Math.max(0, Date.parse(nowIso) - Date.parse(String(cur.rows[0].started_at)));
  await db.execute({
    sql: `UPDATE run_record SET status = ?, ended_at = ?, duration_ms = ?, items_processed = ?,
          rows_read = ?, rows_written = ?, llm_tokens = 0, error_summary = ?, details_json = ?
          WHERE id = ?`,
    args: [
      r.status,
      nowIso,
      duration,
      r.items ?? 0,
      r.rowsRead ?? 0,
      r.rowsWritten ?? 0,
      r.error === undefined ? null : r.error.slice(0, 500),
      r.details === undefined ? null : JSON.stringify(r.details),
      id,
    ],
  });
}

/** Active codes on date `d` from `instrument` (the only universe source in T6). */
async function loadUniverse(db, io, market, d) {
  const rows = await sel(
    db,
    io,
    `SELECT code FROM instrument WHERE market = ? AND (listed_on IS NULL OR listed_on <= ?)
     AND (delisted_on IS NULL OR delisted_on > ?) ORDER BY code`,
    [market, d, d],
  );
  const all = rows.map((r) => String(r.code));
  const codes = all.filter(isValidCode);
  return { codes, excluded: all.length - codes.length };
}

/**
 * Throttle for the Python fetch step from the Owner-editable config (decision 8), validated
 * against the bounds; absent or invalid values fall back to the defaults.
 * @param {Client} db
 */
export async function readThrottle(db) {
  const get = async (key) => {
    const r = await db.execute({
      sql: "SELECT value_json FROM config_version WHERE key = ? AND scope = 'global' ORDER BY id DESC LIMIT 1",
      args: [key],
    });
    if (!r.rows.length) return undefined;
    try {
      return JSON.parse(String(r.rows[0].value_json));
    } catch {
      return undefined;
    }
  };
  return throttleFrom(await get("yahoo_chunk_size"), await get("yahoo_min_gap_s"));
}

/**
 * Steps 1..5 of a run, read-only: market mode, PLT-076 early exit, catch-up plan, source gate and
 * universe. Shared by `prepareBatch1` (decides whether to fetch) and `runBatch1` (decides what to
 * write), so the two can never disagree about the plan.
 * @param {Client} db
 * @param {{ nowMs: number, market?: string, maxDates?: number, lookbackDays?: number }} o
 */
export async function assess(db, o) {
  const market = o.market ?? MARKET;
  const target = sydneyDate(o.nowMs);
  /** @type {Io} */
  const io = { read: 0, written: 0 };
  const base = { target, market, io };

  const mode = await sel(db, io, "SELECT mode FROM market WHERE code = ?", [market]);
  if (!mode.length) return { ...base, kind: "failed", stage: "config", reason: "market_missing" };
  if (String(mode[0].mode) === "off") return { ...base, kind: "skip", reason: "market_off" };

  // PLT-076: first step. A success record for today's key means there is nothing to do.
  if (await hasSuccess(db, keyFor(market, target))) {
    return { ...base, kind: "done", reason: "already_done" };
  }

  const lookback = o.lookbackDays ?? LOOKBACK_DAYS;
  const calRows = (
    await sel(
      db,
      io,
      "SELECT d, kind, confirmed FROM trading_calendar WHERE market = ? AND d >= ? AND d <= ?",
      [market, addDays(target, -(CALENDAR_BACK_DAYS + lookback)), target],
    )
  ).map((r) => ({ d: String(r.d), kind: String(r.kind), confirmed: Number(r.confirmed) }));
  const markerRows = await sel(
    db,
    io,
    `SELECT d FROM completion_marker WHERE market = ? AND kind IN ('data','non-trading')
     AND d >= ? AND d <= ?`,
    [market, addDays(target, -lookback), target],
  );
  const first = await sel(
    db,
    io,
    "SELECT MIN(d) AS d FROM completion_marker WHERE market = ? AND kind IN ('data','non-trading')",
    [market],
  );
  const firstMarker = first[0]?.d == null ? null : String(first[0].d);
  const plan = planDates({
    target,
    markers: new Set(markerRows.map((r) => String(r.d))),
    firstMarker,
    rows: calRows,
    maxDates: o.maxDates ?? MAX_DATES_PER_RUN,
    lookbackDays: lookback,
  });
  if (plan.dates.length === 0) return { ...base, kind: "done", reason: "complete" };

  const trading = plan.dates.filter((x) => x.trading);
  if (trading.length === 0) return { ...base, kind: "go", plan, calRows, codes: [], request: null };

  // DAT-120 / DAT-123 / DAT-127: fetch only from a source the Owner has accepted and that is on.
  const reg = await sel(db, io, "SELECT status FROM source_register WHERE source = ?", [SOURCE]);
  const regStatus = reg.length ? String(reg[0].status) : "missing";
  if (regStatus === "disabled") return { ...base, kind: "skip", reason: "source_disabled" };
  if (regStatus !== "enabled") return { ...base, kind: "skip", reason: "source_not_accepted" };
  const st = await sel(db, io, "SELECT mode FROM source_status WHERE source = ?", [SOURCE]);
  if (!st.length || String(st[0].mode) !== "on")
    return { ...base, kind: "skip", reason: "source_off" };

  const uni = await loadUniverse(db, io, market, target);
  if (uni.codes.length === 0) return { ...base, kind: "skip", reason: "no_universe" };

  const oldest = trading[0].d;
  const newest = trading[trading.length - 1].d;
  const request = {
    codes: uni.codes,
    start: previousTradingDay(oldest, calRows), // one session back: the D-1 re-fetch (DAT-002)
    end: newest,
  };
  return { ...base, kind: "go", plan, calRows, codes: uni.codes, excluded: uni.excluded, request };
}

/**
 * The read-only "what should the fetch step ask for" call (workflow step 1). Writes nothing.
 * @param {Client} db @param {Parameters<typeof assess>[1]} o
 */
export async function prepareBatch1(db, o) {
  const a = await assess(db, o);
  if (a.kind === "go" && a.request) {
    return {
      action: "fetch",
      target: a.target,
      dates: a.plan.dates.length,
      codes: a.request.codes.length,
      excluded: a.excluded ?? 0,
      request: a.request,
      throttle: await readThrottle(db),
    };
  }
  if (a.kind === "go")
    return { action: "nothing_to_fetch", target: a.target, dates: a.plan.dates.length };
  return { action: "skip", target: a.target, reason: a.kind === "failed" ? a.reason : a.reason };
}

/**
 * @typedef {object} RunOptions
 * @property {() => number} nowMs
 * @property {string | null} [barsText]  contents of bars.json, null when no file exists
 * @property {string} [commitSha]
 * @property {string} [market]
 * @property {number} [maxDates]
 * @property {number} [lookbackDays]
 * @property {number} [writeCap]  decision 13 cap on catch-up writes per UTC month
 * @property {number} [refetchPct]
 * @property {(ctx: any) => Promise<{ flags?: number } | void>} [qualityHook]
 */

/**
 * Run the pipeline. Never throws for pipeline problems: it records them and returns an exit code.
 * @param {Client} db @param {RunOptions} o
 */
export async function runBatch1(db, o) {
  const market = o.market ?? MARKET;
  const a = await assess(db, {
    nowMs: o.nowMs(),
    market,
    maxDates: o.maxDates,
    lookbackDays: o.lookbackDays,
  });
  const iso = () => new Date(o.nowMs()).toISOString();

  if (a.kind === "done")
    return { exit: 0, status: "skipped", reason: a.reason, target: a.target, dates: [] };

  if (a.kind === "skip" || a.kind === "failed") {
    const failed = a.kind === "failed";
    const id = await startRun(db, keyFor(market, a.target), a.target, iso(), o.commitSha);
    await finishRun(db, id, iso(), {
      status: failed ? "failed" : "skipped",
      rowsRead: a.io.read,
      error: failed ? `${a.stage}: ${a.reason}` : undefined,
      details: { reason: a.reason },
    });
    return {
      exit: failed ? 1 : 0,
      status: failed ? "failed" : "skipped",
      reason: a.reason,
      target: a.target,
      dates: [],
    };
  }

  const { plan, calRows, codes } = a;
  const firstTrading = plan.dates.find((x) => x.trading);

  // Parse the fetched file once. A missing or malformed file fails the first trading date visibly
  // (DAT-004: nothing is invented), the other dates are not touched.
  let parsed = null;
  if (firstTrading) {
    let problem = null;
    if (o.barsText == null) problem = "bars file missing";
    else {
      try {
        parsed = parseBarsText(o.barsText, {
          from: a.request ? a.request.start : undefined,
          to: a.request ? a.request.end : undefined,
        });
      } catch (e) {
        problem = e instanceof BarsFormatError ? e.message : "bars file unreadable";
      }
    }
    if (problem !== null) {
      const id = await startRun(
        db,
        keyFor(market, firstTrading.d),
        firstTrading.d,
        iso(),
        o.commitSha,
      );
      await finishRun(db, id, iso(), {
        status: "failed",
        rowsRead: a.io.read,
        error: `validate: ${problem}`,
        details: { stage: "validate" },
      });
      return { exit: 1, status: "failed", reason: "validate", target: a.target, dates: [] };
    }
  }

  const ctx = {
    db,
    o,
    market,
    target: a.target,
    calRows,
    codes,
    parsed,
    rejByDate: new Map(),
    rejUndated: rejectSummary([]),
    processed: new Set(),
    preReads: a.io.read,
    writeCap: o.writeCap ?? BACKFILL_WRITE_CAP_MONTH,
    monthUsed: 0,
    capStopped: false,
    firstTradingDate: firstTrading ? firstTrading.d : null,
  };
  if (parsed) {
    const byDate = new Map();
    const undated = [];
    for (const r of parsed.rejected) {
      if (isRealDate(r.date)) {
        byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
      } else undated.push(r);
    }
    ctx.rejByDate = new Map([...byDate].map(([k, v]) => [k, rejectSummary(v)]));
    ctx.rejUndated = rejectSummary(undated);
    ctx.rejRows = parsed.rejected;
    const inPlan = new Set(plan.dates.map((x) => x.d));
    for (const x of plan.dates) if (x.trading) inPlan.add(previousTradingDay(x.d, calRows));
    ctx.fileStats = {
      total: parsed.total,
      valid: parsed.rows.length,
      rejected: rejectSummary(parsed.rejected),
      out_of_plan: parsed.rows.filter((r) => !inPlan.has(r.date)).length,
    };
  }
  const { start, end } = monthBoundsUtc(o.nowMs());
  const used = await db.execute({
    sql: `SELECT COALESCE(SUM(rows_written), 0) AS w FROM run_record
          WHERE job = ? AND started_at >= ? AND started_at < ?`,
    args: [JOB, start, end],
  });
  ctx.monthUsed = Number(used.rows[0].w);

  const results = [];
  for (const item of plan.dates) {
    const isTarget = item.d === a.target;
    if (ctx.capStopped && !isTarget) continue;
    const r = await processDate(ctx, item, isTarget);
    results.push(r);
  }

  const failed = results.some((r) => r.status === "failed");
  const degraded = ctx.capStopped || plan.remaining > 0;
  return {
    exit: failed ? 1 : 0,
    status: failed ? "failed" : degraded ? "degraded" : "ok",
    target: a.target,
    remaining: plan.remaining,
    capStopped: ctx.capStopped,
    dates: results,
  };
}

/** Process one trading or non-trading date: stages 1..9 with one run record (DAT-020). */
async function processDate(ctx, item, isTarget) {
  const { db, o, market } = ctx;
  const d = item.d;
  const key = keyFor(market, d);
  const iso = () => new Date(o.nowMs()).toISOString();
  /** @type {Io} */
  const io = { read: 0, written: 0 };
  const out = {
    d,
    status: "ok",
    rowsRead: 0,
    rowsWritten: 0,
    bars: 0,
    rejected: 0,
    refetchRows: 0,
  };

  // PLT-076: a date that already succeeded is left alone.
  if (await hasSuccess(db, key)) return { ...out, status: "already_done" };

  const stages = Object.fromEntries(STAGE_NAMES.map((s) => [s, "pending"]));
  let stage = "calendar";

  // Per-date inputs that need no database.
  const todays = ctx.parsed ? ctx.parsed.rows.filter((r) => r.date === d) : [];

  // Decision 13: catch-up writes (every date but the live target) stop at the monthly cap.
  if (item.trading && !isTarget) {
    const estimate = todays.length + 2; // bars, the marker and the refetch hash
    if (ctx.monthUsed + io.written + estimate > ctx.writeCap) {
      ctx.capStopped = true;
      const id = await startRun(db, key, d, iso(), o.commitSha);
      await finishRun(db, id, iso(), {
        status: "skipped",
        error: "backfill write cap reached",
        details: { reason: "write_cap", cap: ctx.writeCap, used: ctx.monthUsed, estimate },
      });
      return { ...out, status: "cap", capStop: true };
    }
  }

  // The workflow's concurrency group allows one run at a time, so a record still 'running' for
  // this key belongs to a run that died. Close it, or the clock would wait for it forever.
  await db.execute({
    sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
          WHERE concurrency_key = ? AND status = 'running'`,
    args: [iso(), "superseded: the previous run did not finish", key],
  });
  const runId = await startRun(db, key, d, iso(), o.commitSha);
  io.read += ctx.preReads; // the shared plan reads are charged to the first run record
  ctx.preReads = 0;
  try {
    // Stage 1: calendar check.
    if (!item.trading) {
      stage = "marker";
      const n = await insertRows(
        db,
        "completion_marker",
        ["market", "d", "kind", "at", "run_id", "outcome"],
        [[market, d, "non-trading", iso(), runId, "non-trading"]],
      );
      io.written += n;
      stages.calendar = "non-trading";
      stages.marker = n ? "written" : "exists";
      await finishRun(db, runId, iso(), {
        status: "skipped",
        rowsRead: io.read,
        rowsWritten: io.written,
        details: { reason: "non_trading_day", stages },
      });
      return { ...out, status: "non_trading", rowsWritten: io.written };
    }
    // DAT-160: say so when the day rests on a provisional or unconfirmed calendar row.
    const calRow = ctx.calRows.find((r) => r.d === d);
    stages.calendar = {
      trading_day: true,
      covered: calRow !== undefined,
      confirmed: calRow?.confirmed === 1,
    };

    // Stage 2: universe snapshot (live target only: a past day's snapshot cannot be recovered).
    stage = "universe";
    let universe = ctx.codes;
    if (isTarget) {
      const snap = await writeSnapshot(ctx, io, d, universe);
      stages.universe = { rows: snap };
    } else {
      const u = await loadUniverse(db, io, market, d);
      universe = u.codes;
      stages.universe = "snapshot_not_recoverable";
    }
    if (universe.length === 0) {
      await finishRun(db, runId, iso(), {
        status: "skipped",
        rowsRead: io.read,
        rowsWritten: io.written,
        error: "no universe for date",
        details: { reason: "no_universe", stages },
      });
      return { ...out, status: "no_universe", rowsWritten: io.written };
    }

    // Stage 3: EOD bars, first-seen immutable.
    stage = "bars";
    const set = new Set(universe);
    const valid = todays.filter((r) => set.has(r.code));
    const notInUniverse = todays.length - valid.length;
    const rejSummary = { ...(ctx.rejByDate.get(d) ?? {}) };
    if (d === ctx.firstTradingDate) {
      for (const [k, v] of Object.entries(ctx.rejUndated)) rejSummary[k] = (rejSummary[k] ?? 0) + v;
    }
    const rejectedCount = Object.values(rejSummary).reduce((a, b) => a + b, 0);
    if (valid.length === 0) throw new StageError("bars", "no valid bars for the date");
    const ingestedAt = iso();
    const barRows = valid.map((r) => [
      market,
      r.code,
      d,
      r.open,
      r.high,
      r.low,
      r.close,
      r.volume,
      SOURCE,
      ingestedAt, // DAT-001: no publication time is known, so published_at = ingested_at
      ingestedAt,
    ]);
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
      barRows,
    );
    io.written += inserted;
    stages.bars = {
      valid: valid.length,
      inserted,
      already_stored: valid.length - inserted,
      rejected: rejSummary,
      not_in_universe: notInUniverse,
    };

    // Re-fetch compare of the previous session (DAT-002, decision 4): only differences are stored.
    stage = "refetch";
    const refetch = await refetchCompare(ctx, io, d);
    io.written += refetch.written;
    stages.refetch = refetch.summary;

    for (const s of STUB_STAGES) stages[s] = "stub";

    // Stage 8: quality hook (T7). The default is a no-op.
    stage = "quality";
    const hook = ctx.o.qualityHook ?? noopQualityHook;
    const q = await hook({
      db,
      market,
      d,
      io,
      universe: universe.length,
      barsValid: valid.length,
      rejected: (ctx.rejRows ?? []).filter((r) => r.date === d),
      refetchDiffs: refetch.diffs,
    });
    stages.quality =
      hook === noopQualityHook
        ? "noop"
        : q && typeof q.flags === "number"
          ? { flags: q.flags }
          : "done";

    // Stage 9: completion marker (insert once).
    stage = "marker";
    const covered = valid.length;
    const outcome =
      covered === universe.length && rejectedCount === 0
        ? "complete"
        : `partial:${covered}/${universe.length}`;
    const m = await insertRows(
      db,
      "completion_marker",
      ["market", "d", "kind", "at", "run_id", "outcome"],
      [[market, d, "data", iso(), runId, outcome]],
    );
    io.written += m;
    stages.marker = m ? "written" : "exists";
    ctx.processed.add(d);

    const details = {
      outcome,
      universe: universe.length,
      bars: stages.bars,
      refetch: stages.refetch,
      ...(d === ctx.firstTradingDate ? { file: ctx.fileStats } : {}),
      stages,
    };
    try {
      await finishRun(db, runId, iso(), {
        status: "success",
        items: valid.length,
        rowsRead: io.read,
        rowsWritten: io.written,
        details,
      });
    } catch {
      // The unique-success index refused a second success for this key (a racing run won).
      await finishRun(db, runId, iso(), {
        status: "skipped",
        rowsRead: io.read,
        rowsWritten: io.written,
        error: "success already recorded",
        details,
      });
    }
    return {
      ...out,
      rowsRead: io.read,
      rowsWritten: io.written,
      bars: inserted,
      rejected: rejectedCount,
      refetchRows: refetch.diffs.length,
      outcome,
    };
  } catch (e) {
    const summary = e instanceof StageError ? e.message : `${stage}: unexpected error`;
    try {
      await finishRun(db, runId, iso(), {
        status: "failed",
        rowsRead: io.read,
        rowsWritten: io.written,
        error: summary,
        details: { stage, stages },
      });
    } catch {
      // best effort: the exit code still fails the workflow
    }
    return { ...out, status: "failed", error: summary, rowsRead: io.read, rowsWritten: io.written };
  } finally {
    ctx.monthUsed += io.written;
  }
}

/** Stage 2 write: carry tier, market cap and ADV forward from the last snapshot (T7/T9 refine). */
async function writeSnapshot(ctx, io, d, universe) {
  const { db, market } = ctx;
  const prev = await sel(
    db,
    io,
    `SELECT code, tier, mcap_est, adv FROM universe_snapshot
     WHERE market = ? AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d < ?)`,
    [market, market, d],
  );
  const by = new Map(prev.map((r) => [String(r.code), r]));
  const rows = universe.map((code) => {
    const p = by.get(code);
    return [
      market,
      d,
      code,
      "active",
      p ? String(p.tier) : "U3",
      p?.mcap_est ?? null,
      p?.adv ?? null,
      0,
    ];
  });
  const n = await insertRows(
    db,
    "universe_snapshot",
    ["market", "d", "code", "status", "tier", "mcap_est", "adv", "halted"],
    rows,
  );
  io.written += n;
  return n;
}

/** DAT-002: compare the fetched bars of the previous session with the stored ones. */
async function refetchCompare(ctx, io, d) {
  const { db, market, parsed } = ctx;
  const none = { written: 0, diffs: [], summary: { compared: 0, differing: 0 } };
  if (!parsed) return none;
  let prev;
  try {
    prev = previousTradingDay(d, ctx.calRows);
  } catch {
    return none;
  }
  // Bars stored by this very run are not a re-fetch; the true re-fetch comes with tomorrow's run.
  if (ctx.processed.has(prev))
    return { ...none, summary: { compared: 0, differing: 0, skipped: "same_run" } };
  const fetched = parsed.rows.filter((r) => r.date === prev);
  if (fetched.length === 0) return none;
  const stored = await sel(
    db,
    io,
    "SELECT code, o, h, l, c, volume FROM price_bar WHERE market = ? AND d = ?",
    [market, prev],
  );
  const by = new Map(stored.map((r) => [String(r.code), r]));
  const threshold = ctx.o.refetchPct ?? REFETCH_DIFF_PCT;
  const compared = [];
  const diffs = [];
  const rows = [];
  for (const f of fetched) {
    const s = by.get(f.code);
    if (!s) continue;
    compared.push(f);
    const cmp = compareBar(
      { o: Number(s.o), h: Number(s.h), l: Number(s.l), c: Number(s.c), volume: Number(s.volume) },
      f,
      threshold,
    );
    if (!cmp.differs) continue;
    diffs.push({ code: f.code, d: prev, maxDiffPct: cmp.maxDiffPct });
    rows.push([
      market,
      f.code,
      prev,
      f.fetched_at,
      JSON.stringify({ o: f.open, h: f.high, l: f.low, c: f.close, volume: f.volume }),
      cmp.maxDiffPct,
    ]);
  }
  let written = await insertRows(
    db,
    "bar_refetch",
    ["market", "code", "d", "fetched_at", "ohlcv_json", "max_diff_pct"],
    rows,
  );
  if (compared.length > 0) {
    // The nightly hash per session (decision 4), kept once per session.
    const hash = refetchHash(compared);
    written += await insertRows(
      db,
      "ingest_cursor",
      ["job", "market", "source", "cursor_json", "updated_at"],
      [
        [
          "refetch_hash",
          market,
          `${SOURCE}:${prev}`,
          JSON.stringify({ d: prev, hash, n: compared.length }),
          new Date(ctx.o.nowMs()).toISOString(),
        ],
      ],
    );
  }
  return {
    written,
    diffs,
    summary: { compared: compared.length, differing: diffs.length, fetched: fetched.length },
  };
}
