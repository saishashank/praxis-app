// M17 WP5: the intraday scan run (AGT-140, DAT-239, NFR-042; docs/M17_design.md "Slots and budget").
// Order of work, fail-closed at every step:
//   1. source accepted? `readQuoteSourceState` + `refusalFor`; refused -> skipped, NOTHING written
//      (the System Health line is derived from the same state by `intradayScanHealth`);
//   2. pause cool-down (`quote_pause_cooldown_min`) from the latest `quote_run.paused` row;
//   3. market on, trading day, session window, early close (`sessionTimes`);
//   4. budget band (stop at 95 %) and the run's allowance;
//   5. plan: universe ∩ today's catalysts, tier 1 first, cut at the allowance;
//   6. CLAIM `quote_run` (requests = allowed, session_d = Melbourne market date, D-442) before any request;
//   7. fetch delayed quotes, evaluate, write shadow candidates; a pause is recorded as its own row.
// Writes: `quote_run` and `intraday_candidate` only. Orders, books and ledgers are never touched.
import type { Exec } from "@/lib/cortex/store/common";
import { getConfig } from "@/lib/config/store";
import {
  type CalendarKind,
  type CalendarRow,
  localToUtc,
  marketDate,
  sessionTimes,
} from "@/lib/data/calendar";
import {
  QUOTE_RUN_DEADLINE_MS,
  refusalFor,
  fetchDelayedQuotes,
  type QuoteFetchDeps,
} from "@/lib/data/quotes/fetch";
import { armedReserve, remainingPollTicks } from "@/lib/alerts/pick/reserve";
import { activeAlerts } from "@/lib/alerts/pick/store";
import { readQuoteSourceState } from "@/lib/data/controls";
import {
  DONE_SUFFIX,
  QUOTE_REQUESTS_PER_DAY,
  budgetBand,
  quoteRequestsToday,
  requestsAllowed,
} from "@/lib/data/quotes/budget";
import type { QuoteRefusal } from "@/lib/data/quotes/types";
import { armedCatalysts, armHaltResumes, loadMoversParams } from "@/lib/cortex/store/movers";
import { todayCatalysts } from "@/lib/sentinel/todayItems";
import { evaluateQuotes } from "./scan";
import { scanUniverse, type ScanCode } from "./universe";

export const SCAN_MARKET = "AU";
/** Session dates are Melbourne market dates (D-442). */
const SCAN_POLL_END = "16:00"; // threshold-ok: end of the quote-poll window (poll.ts POLL_END)
export const SESSION_TZ = "Australia/Melbourne";
const MS_PER_MIN = 60_000; // threshold-ok: unit

export type ScanSkipReason =
  | QuoteRefusal
  | "scan_off"
  | "cooldown"
  | "market_off"
  | "non_trading_day"
  | "before_window"
  | "after_window"
  | "after_close"
  | "budget_stop"
  | "already_done";

export type ScanRunDeps = {
  db: Exec;
  now: () => Date;
  fetch: QuoteFetchDeps["fetch"];
  sleep: (ms: number) => Promise<void>;
  /** Wall clock (ms) for the whole-run deadline; defaults to Date.now (V2-S7). */
  clock?: () => number;
  market?: string;
  /** WP4 hook (EML-040): mails the new candidates after they are written; default none. */
  mailCandidates?: (c: {
    db: Exec;
    now: Date;
    market: string;
    sessionD: string;
    slot: string;
  }) => Promise<void>;
};

export type ScanRunResult =
  | { status: "skipped"; reason: ScanSkipReason }
  | {
      status: "ok";
      sessionD: string;
      slot: string;
      requests: number;
      codes: number;
      quotes: number;
      written: number;
      gateFailed: number;
      narrowed: boolean;
      paused: string | false;
      volumeUnavailable: number;
    };

const skip = (reason: ScanSkipReason): ScanRunResult => ({ status: "skipped", reason });
const num = async (db: Exec, key: Parameters<typeof getConfig>[1]): Promise<number> =>
  Number(await getConfig(db, key));
const hm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; // threshold-ok: time format

export async function readCalendar(db: Exec, market: string): Promise<CalendarRow[]> {
  const r = await db.execute({
    sql: "SELECT d, kind, close_time, confirmed FROM trading_calendar WHERE market = ? ORDER BY d",
    args: [market],
  });
  return r.rows.map((x) => ({
    d: String(x.d),
    kind: String(x.kind) as CalendarKind,
    close_time: x.close_time === null ? null : String(x.close_time),
    confirmed: Number(x.confirmed) === 1 ? 1 : 0, // money-float-ok: a flag
  }));
}

/** Minutes since the latest pause row of today, or null when none (shared by the poll and the scan). */
export async function minutesSincePause(
  db: Exec,
  market: string,
  sessionD: string,
  now: Date,
): Promise<number | null> {
  const r = await db.execute({
    sql:
      "SELECT started_at FROM quote_run WHERE market = ? AND session_d = ? AND paused IS NOT NULL " +
      "ORDER BY started_at DESC LIMIT 1",
    args: [market, sessionD],
  });
  if (r.rows.length === 0) return null;
  return (now.getTime() - Date.parse(String(r.rows[0].started_at))) / MS_PER_MIN;
}

export async function runIntradayScan(deps: ScanRunDeps): Promise<ScanRunResult> {
  const { db } = deps;
  const market = deps.market ?? SCAN_MARKET;
  const now = deps.now();
  const sessionD = marketDate(now, SESSION_TZ);
  const clock = deps.clock ?? Date.now;
  const deadlineAt = clock() + QUOTE_RUN_DEADLINE_MS;

  // 1. Source acceptance, before anything else.
  let refusal: QuoteRefusal | null;
  try {
    refusal = refusalFor(await readQuoteSourceState(db));
  } catch {
    refusal = "gate_error";
  }
  if (refusal !== null) return skip(refusal);

  // 2. Cool-down after a paused run.
  const cooldown = await num(db, "quote_pause_cooldown_min");
  const since = await minutesSincePause(db, market, sessionD, now);
  if (since !== null && since < cooldown) return skip("cooldown");

  // 3. Market, calendar, window, early close.
  const codesMax = await num(db, "intraday_scan_codes_max");
  if (codesMax <= 0) return skip("scan_off");
  const mk = await db.execute({
    sql: "SELECT tz, open_time, close_time, mode FROM market WHERE code = ?",
    args: [market],
  });
  if (mk.rows.length === 0 || String(mk.rows[0].mode) === "off") return skip("market_off");
  const hours = {
    tz: String(mk.rows[0].tz),
    open_time: String(mk.rows[0].open_time),
    close_time: String(mk.rows[0].close_time),
  };
  const session = sessionTimes(sessionD, hours, await readCalendar(db, market));
  if (session === null) return skip("non_trading_day");
  const startText = String(await getConfig(db, "intraday_scan_start"));
  const endText = String(await getConfig(db, "intraday_scan_end"));
  const start = localToUtc(sessionD, startText, hours.tz);
  const end = localToUtc(sessionD, endText, hours.tz);
  if (now.getTime() > session.close.getTime()) return skip("after_close");
  if (now.getTime() < start.getTime()) return skip("before_window");
  if (now.getTime() > end.getTime() + MS_PER_MIN) return skip("after_window");

  // Slot key: the scan grid from the window start, so a late retry of the same slot dedupes.
  const stepMin = await num(db, "intraday_scan_min");
  const sinceStartMin = Math.floor((now.getTime() - start.getTime()) / MS_PER_MIN);
  const startMinutes = Number(startText.slice(0, 2)) * 60 + Number(startText.slice(3, 5)); // threshold-ok: HH:MM
  const slot = hm(startMinutes + Math.floor(sinceStartMin / stepMin) * stepMin);

  // 4. Budget.
  const usedToday = await quoteRequestsToday(db, market, sessionD);
  const dayBudget = { dayMax: QUOTE_REQUESTS_PER_DAY, usedToday };
  const band = budgetBand(dayBudget);
  if (band === "stop") return skip("budget_stop");
  // V2-S5 (D-694): the armed picks' requests to the end of the poll window are not the scan's to spend.
  const armedCount = new Set((await activeAlerts(db, market)).map((a) => a.latest.code)).size;
  const reserve =
    armedCount === 0
      ? 0
      : armedReserve(
          armedCount,
          remainingPollTicks(
            now,
            localToUtc(sessionD, SCAN_POLL_END, hours.tz),
            await num(db, "intraday_refresh_min"),
          ),
        );
  const allowed = requestsAllowed({
    perRunMax: await num(db, "intraday_scan_requests_max"),
    dayMax: dayBudget.dayMax - reserve,
    usedToday,
  });
  if (reserve > 0 && allowed <= 0) return skip("budget_stop");

  // 5. Plan: universe ∩ today's catalysts, tier 1 first, cut at the allowance.
  const universe = await scanUniverse(db, market, sessionD, codesMax);
  const catalysts = await todayCatalysts(db, market, sessionD, now.toISOString());
  // A1/A3 (D-744): halt resumes and volume-creep names are quoted although no catalyst of the day exists;
  // they enter as synthetic catalysts from their arm time (10:00 by default). A real catalyst wins.
  const movers = await loadMoversParams(db);
  try {
    await armHaltResumes(db, {
      market,
      sessionD,
      now: now.toISOString(),
      params: movers,
      calendar: await readCalendar(db, market),
      hours,
    });
  } catch {
    // the scan does not depend on the arms
  }
  const nowMinute = Math.floor(
    (now.getTime() - localToUtc(sessionD, "00:00", hours.tz).getTime()) / MS_PER_MIN,
  );
  const armed = await armedCatalysts(db, {
    market,
    sessionD,
    nowLocalHhmm: hm(nowMinute),
    cap: movers.intradayArmCodesMax,
  });
  for (const [code, c] of armed) if (!catalysts.has(code)) catalysts.set(code, c);
  const ordered = universe.filter((c) => catalysts.has(c.code));
  const narrowedBand = band === "narrow";
  const eligible = narrowedBand ? ordered.filter((c) => c.kind === "U1") : ordered;
  const planned = eligible.slice(0, allowed);
  const droppedTier2 = eligible.slice(allowed).some((c) => c.kind !== "U1");
  const narrowed = narrowedBand || droppedTier2;

  // 6. Claim first: the row exists before any request (D-442).
  const claim = await db.execute({
    sql:
      "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, narrowed, codes) " +
      "VALUES (?, ?, ?, 'scan', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [market, sessionD, slot, now.toISOString(), allowed, narrowed ? 1 : 0, planned.length],
  });
  if (claim.rowsAffected === 0) return skip("already_done");

  const base = {
    status: "ok" as const,
    sessionD,
    slot,
    requests: allowed,
    codes: planned.length,
    narrowed,
  };
  if (planned.length === 0) {
    // Nothing to fetch: the reservation is refunded (V2-S5, D-697).
    await db.execute({
      sql:
        "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) " +
        "VALUES (?, ?, ?, 'scan', ?, 0) ON CONFLICT DO NOTHING",
      args: [market, sessionD, `${slot}${DONE_SUFFIX}`, now.toISOString()],
    });
    return { ...base, quotes: 0, written: 0, gateFailed: 0, paused: false, volumeUnavailable: 0 };
  }

  // 7. Fetch and evaluate.
  const fetched = await fetchDelayedQuotes(
    {
      fetch: deps.fetch,
      now: deps.now,
      clock,
      sleep: deps.sleep,
      sourceState: () => readQuoteSourceState(db),
    },
    planned.map((c) => c.code),
    { perRunMax: allowed, dayMax: QUOTE_REQUESTS_PER_DAY, usedToday },
    { deadlineAt },
  );
  // V2-S5/S7 (D-697): the claim reserved `allowed`; reconcile it to the requests actually made.
  if (fetched.requests < allowed) {
    await db.execute({
      sql:
        "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) " +
        "VALUES (?, ?, ?, 'scan', ?, ?) ON CONFLICT DO NOTHING",
      args: [market, sessionD, `${slot}${DONE_SUFFIX}`, deps.now().toISOString(), fetched.requests],
    });
  }
  if (fetched.paused !== false) {
    // The claim row is append-only: a pause is its own row, read by the cool-down.
    await db.execute({
      sql:
        "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, paused) " +
        "VALUES (?, ?, ?, 'scan', ?, 0, ?) ON CONFLICT DO NOTHING",
      args: [market, sessionD, `${slot}+paused`, deps.now().toISOString(), fetched.paused],
    });
  }
  const delay = await num(db, "intraday_quote_delay_min");
  const refresh = await num(db, "intraday_refresh_min");
  const evaluated = await evaluateQuotes(db, {
    market,
    sessionD,
    slot,
    now: deps.now(),
    open: session.open,
    close: session.close,
    quotes: fetched.quotes,
    codes: new Map<string, ScanCode>(planned.map((c) => [c.code, c])),
    catalysts,
    params: {
      moveMinPct: await num(db, "intraday_move_min_pct"),
      relVolumeMin: await num(db, "intraday_rel_volume_min"),
      maxAgeMin: delay + 2 * refresh, // threshold-ok: D-441 freshness = delay + 2 x refresh
      indexChangeWindowSessions: await num(db, "index_change_window_sessions"),
      maxBooksSameCode: await num(db, "max_books_same_code"),
      maxCodeNavShare: await num(db, "max_code_nav_share"),
      maxIndustryNavShare: await num(db, "max_industry_nav_share"),
      stopAtr: await num(db, "f1_initial_stop_atr"),
      streamState: String(await getConfig(db, "intraday_stream_state")),
      sectorMinMembers: movers.sectorCompositeMinMembers,
    },
  });
  if (deps.mailCandidates && evaluated.written > 0) {
    await deps.mailCandidates({ db, now: deps.now(), market, sessionD, slot });
  }
  return {
    ...base,
    quotes: fetched.quotes.length,
    written: evaluated.written,
    gateFailed: evaluated.gateFailed,
    paused: fetched.paused,
    volumeUnavailable: evaluated.volumeUnavailable,
  };
}

/** Latest slot (HH:MM) of `purpose` whose run was not paused (a claim without a `+paused` row), or null. */
export async function lastSuccessfulSlot(
  db: Exec,
  market: string,
  sessionD: string,
  purpose: "poll" | "scan",
): Promise<string | null> {
  const r = await db.execute({
    sql:
      "SELECT q.slot_minute AS s FROM quote_run q WHERE q.market = ? AND q.session_d = ? AND q.purpose = ? " +
      "AND q.slot_minute NOT LIKE '%+%' AND NOT EXISTS (SELECT 1 FROM quote_run p WHERE p.market = q.market " +
      "AND p.session_d = q.session_d AND p.purpose = q.purpose AND p.slot_minute = q.slot_minute || '+paused') " +
      "ORDER BY q.slot_minute DESC LIMIT 1",
    args: [market, sessionD, purpose],
  });
  return r.rows.length ? String(r.rows[0].s) : null;
}

const GRACE_STEPS = 2; // threshold-ok: ticks of grace before a missing run is reported
const LATE_STEPS = 3; // threshold-ok: ticks without a run before "last run" is reported

/**
 * V2-S3 (D-698): the recurring route slots (quote-poll, intraday-scan) have no worker_state row, so
 * their health is read from `quote_run`: on a trading day, after a grace of two ticks from the window
 * start, "no successful run today" when none exists, and "last successful run HH:MM" while the window
 * is open and the last one is more than three ticks old. Empty when the day or market is off.
 */
export async function recurringRunHealth(
  db: Exec,
  now: Date,
  p: {
    market: string;
    purpose: "poll" | "scan";
    label: string;
    startText: string;
    endText: string;
    stepMin: number;
  },
): Promise<string[]> {
  const sessionD = marketDate(now, SESSION_TZ);
  const mk = await db.execute({
    sql: "SELECT tz, open_time, close_time, mode FROM market WHERE code = ?",
    args: [p.market],
  });
  if (mk.rows.length === 0 || String(mk.rows[0].mode) === "off") return [];
  const hours = {
    tz: String(mk.rows[0].tz),
    open_time: String(mk.rows[0].open_time),
    close_time: String(mk.rows[0].close_time),
  };
  const session = sessionTimes(sessionD, hours, await readCalendar(db, p.market));
  if (session === null) return [];
  const start = localToUtc(sessionD, p.startText, hours.tz).getTime();
  const end = localToUtc(sessionD, p.endText, hours.tz).getTime();
  const step = Math.max(1, p.stepMin) * MS_PER_MIN;
  if (now.getTime() < start + GRACE_STEPS * step) return [];
  const last = await lastSuccessfulSlot(db, p.market, sessionD, p.purpose);
  if (last === null) return [`${p.label}: no successful run today (since ${p.startText})`];
  const lastAt = localToUtc(sessionD, last, hours.tz).getTime();
  if (now.getTime() <= end && now.getTime() - lastAt > LATE_STEPS * step) {
    return [`${p.label}: last successful run ${last}`];
  }
  return [];
}

/** System Health lines of the "intraday scan" series, derived on read (nothing is stored for them). */
export async function intradayScanHealth(
  db: Exec,
  now: Date,
  market: string = SCAN_MARKET,
): Promise<string[]> {
  const lines: string[] = [];
  let refusal: QuoteRefusal | null;
  try {
    refusal = refusalFor(await readQuoteSourceState(db));
  } catch {
    refusal = "gate_error";
  }
  if (refusal !== null) return [`Intraday scan off: ${refusal.replaceAll("_", " ")}`];
  const d = marketDate(now, SESSION_TZ);
  const used = await quoteRequestsToday(db, market, d);
  const band = budgetBand({ dayMax: QUOTE_REQUESTS_PER_DAY, usedToday: used });
  if (band === "stop") lines.push("Intraday scan stopped for the day (request budget)");
  const r = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM quote_run WHERE market = ? AND session_d = ? AND purpose = 'scan' AND narrowed = 1",
    args: [market, d],
  });
  if (Number(r.rows[0]?.n ?? 0) > 0) lines.push("Intraday scan narrowed");
  const since = await minutesSincePause(db, market, d, now);
  if (since !== null) lines.push("Prices paused");
  if (band !== "stop" && since === null && (await num(db, "intraday_scan_codes_max")) > 0) {
    lines.push(
      ...(await recurringRunHealth(db, now, {
        market,
        purpose: "scan",
        label: "Intraday scan",
        startText: String(await getConfig(db, "intraday_scan_start")),
        endText: String(await getConfig(db, "intraday_scan_end")),
        stepMin: await num(db, "intraday_scan_min"),
      })),
    );
  }
  return lines;
}
