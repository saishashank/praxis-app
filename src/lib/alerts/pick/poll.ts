// M17 WP3: the quote-poll tick (ARN-112..114, NFR-042; docs/M17_design.md "Alert delivery", D-397).
// Order of work, fail-closed at every step (the same refusal, cool-down and claim-first rules as the
// intraday scan, reusing its helpers):
//   1. source accepted? refused -> skipped, NOTHING written;
//   2. market on, trading day, window 10:00-16:00, early close (`sessionTimes`);
//   3. ARM (step 1 of the tick, idempotent, no request), then the held-mail digest hook;
//   4. pause cool-down, budget band (stop at 95 %, armed picks only above 80 %);
//   5. plan: armed picks first, then watch-listed, then held codes, cut at `intraday_codes_max`;
//   6. CLAIM `quote_run` (purpose 'poll') before any request (D-442);
//   7. fetch, evaluate every active alert, write one `pick_alert` row per transition (state first),
//      then hand the mailable ones to the mailer hook (mail second; WP4).
// Writes: `pick_alert` and `quote_run` only (the mail tables are WP4's, through its hook). Orders,
// books and ledgers are never touched (ARN-111, SEC-114).
import type { Client } from "@libsql/client";
import type { Exec } from "@/lib/cortex/store/common";
import { getConfig } from "@/lib/config/store";
import { enabledMarkets, loadProfile } from "@/lib/market/profile";
import { HOME_SLOTS } from "@/lib/market/homeMarket.mjs";
import { HOME_MARKET } from "@/lib/market/profileCore.mjs";
import { localToUtc, marketDate, sessionsBetween, sessionTimes } from "@/lib/data/calendar";
import { readQuoteSourceState } from "@/lib/data/controls";
import {
  DONE_SUFFIX,
  QUOTE_REQUESTS_PER_DAY,
  budgetBand,
  quoteRequestsToday,
  requestsAllowed,
} from "@/lib/data/quotes/budget";
import {
  QUOTE_RUN_DEADLINE_MS,
  fetchDelayedQuotes,
  refusalFor,
  type QuoteFetchDeps,
} from "@/lib/data/quotes/fetch";
import type { DelayedQuote, QuoteRefusal } from "@/lib/data/quotes/types";
import { LATEST_READ_MAX, storeLatestQuotesSoft } from "@/lib/data/quotes/latest";
import { MARKET_INDEX_CODE } from "@/lib/data/quotes/parse";
import { heldCodes } from "@/lib/intraday/universe";
import {
  SESSION_TZ,
  minutesSincePause,
  readCalendar,
  recurringRunHealth,
} from "@/lib/intraday/run";
import { signed, type MachineDeps } from "@/lib/alerts/machine";
import type { AlertCtx } from "@/lib/alerts/deliver";
import { notifyIncident, type NotifyCtx } from "@/lib/incidents/notify";
import { armForSession } from "./arm";
import { extrasCadence, remainingPollTicks } from "./reserve";
import { evaluateAlert } from "./evaluate";
import { STARVATION_MINUTES, starved, type StarvationWindow } from "./starvation";
import {
  activeAlerts,
  alertRecipients,
  haltedCodes,
  insertTransition,
  pickFilled,
  watchCodes,
} from "./store";
import {
  MAILED_CLEAR_REASONS,
  NO_MAILER,
  type AlertParams,
  type MailableTransition,
  type PickAlertMailer,
} from "./types";

/** The market a poll or a health line is about when the caller names none: the first enabled one (D-997). */
async function pollMarket(db: Exec): Promise<string> {
  const [first] = await enabledMarkets(db);
  if (first === undefined) throw new Error("no market is enabled");
  return first;
}
export const PICK_ALERTS_PURPOSE = "pick-alerts";
/** The slot grid of `quote-poll` (worker/src/schedule.ts); early close is enforced below. */
export const POLL_START = HOME_SLOTS.quote_from; // threshold-ok: slot window, D-397
export const POLL_END = HOME_SLOTS.quote_until; // threshold-ok: slot window, D-397
const MS_PER_MIN = 60_000; // threshold-ok: unit

export type PollSkipReason =
  | QuoteRefusal
  | "market_off"
  | "non_trading_day"
  | "before_window"
  | "after_window"
  | "after_close"
  | "cooldown"
  | "budget_stop"
  | "already_done";

export type PollRunDeps = {
  db: Exec;
  now: () => Date;
  fetch: QuoteFetchDeps["fetch"];
  sleep: (ms: number) => Promise<void>;
  /** Wall clock (ms) for the whole-run deadline; defaults to Date.now (V2-S7). */
  clock?: () => number;
  /** Users whose pick alerts are on (ARN-112); the route reads the auth DB. */
  recipients: () => Promise<string[]>;
  /** WP4 hook; defaults to none (no mail leaves). */
  mailer?: PickAlertMailer;
  market?: string;
  /**
   * OPS-109 c (D-971): with this set the tick checks quote starvation and raises the S2
   * `quote_starvation` incident once a day (the env is the incident email's; `{}` records only).
   */
  notify?: Omit<NotifyCtx, "db" | "now">;
};

export type PollRunResult =
  | { status: "skipped"; reason: PollSkipReason; armed?: number }
  | {
      status: "ok";
      sessionD: string;
      slot: string;
      armed: number;
      requests: number;
      codes: number;
      quotes: number;
      hits: number;
      cleared: number;
      narrowed: boolean;
      paused: string | false;
    };

const skip = (reason: PollSkipReason, armed?: number): PollRunResult =>
  armed === undefined ? { status: "skipped", reason } : { status: "skipped", reason, armed };
const num = async (db: Exec, key: Parameters<typeof getConfig>[1]): Promise<number> =>
  Number(await getConfig(db, key));
const hm = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; // threshold-ok: time format

/** Newest stored quote time per code (`quote_latest.fetched_at`), for the starvation check. */
async function latestFetched(
  db: Exec,
  market: string,
  codes: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(codes)].slice(0, LATEST_READ_MAX);
  if (uniq.length === 0) return out;
  // rows-ok: at most the held codes (a few dozen), one primary-key lookup each
  const r = await db.execute({
    sql:
      "SELECT code, fetched_at FROM quote_latest " +
      `WHERE market = ? AND code IN (${uniq.map(() => "?").join(",")})`,
    args: [market, ...uniq],
  });
  for (const row of r.rows) out.set(String(row.code), String(row.fetched_at));
  return out;
}

/**
 * OPS-109 c (D-971): raise S2 `quote_starvation` (at most once a day) when a held position has had no
 * fresh quote for STARVATION_MINUTES inside the poll window of a trading day. The incident carries
 * counts only, never a code. Never fails the tick: an error here leaves the poll's result alone.
 */
async function checkStarvation(
  deps: PollRunDeps,
  market: string,
  sessionD: string,
  window: StarvationWindow,
  now: Date,
): Promise<void> {
  if (deps.notify === undefined) return;
  try {
    const held = await heldCodes(deps.db, market);
    if (held.size === 0) return;
    const latest = await latestFetched(deps.db, market, [...held]);
    const codes = starved(held, latest, now, { minutes: STARVATION_MINUTES, window });
    if (codes.length === 0) return;
    const today = await deps.db.execute({
      sql: "SELECT 1 FROM incident WHERE kind = 'quote_starvation' AND at >= ? LIMIT 1",
      args: [window.start.toISOString()],
    });
    if (today.rows.length > 0) return; // once per day, also after the first one was resolved
    await notifyIncident({ ...deps.notify, db: deps.db, now: deps.now }, "quote_starvation", "S2", {
      summary: `Held positions have had no fresh price for ${STARVATION_MINUTES} minutes during market hours`,
      detail: { sessionD, held: held.size, starved: codes.length },
    });
  } catch {
    // the starvation check never changes what the tick did
  }
}

export async function runPickAlertPoll(deps: PollRunDeps): Promise<PollRunResult> {
  const { db } = deps;
  const market = deps.market ?? (await pollMarket(db));
  const mailer = deps.mailer ?? NO_MAILER;
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

  // 2. Market, calendar, window, early close.
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
  const calendar = await readCalendar(db, market);
  const session = sessionTimes(sessionD, hours, calendar);
  if (session === null) return skip("non_trading_day");
  const start = localToUtc(sessionD, POLL_START, hours.tz);
  const end = localToUtc(sessionD, POLL_END, hours.tz);
  if (now.getTime() > session.close.getTime()) return skip("after_close");
  if (now.getTime() < start.getTime()) return skip("before_window");
  if (now.getTime() > end.getTime() + MS_PER_MIN) return skip("after_window");
  const stepMin = await num(db, "intraday_refresh_min");
  const sinceStartMin = Math.floor((now.getTime() - start.getTime()) / MS_PER_MIN);
  const startMinutes = Number(POLL_START.slice(0, 2)) * 60 + Number(POLL_START.slice(3, 5)); // threshold-ok: HH:MM
  const slot = hm(startMinutes + Math.floor(sinceStartMin / stepMin) * stepMin);

  // 3. Arm first (D-397), then the digest hook of quiet hours (WP4).
  const recipients = await deps.recipients();
  const arm = await armForSession(db, market, sessionD, recipients, now);
  const mailCtx = { db, now, market, sessionD, slot: slot.replace(":", "") };
  await mailer.digest(mailCtx);
  // OPS-109 c: the starvation window is the poll window, cut at the session close.
  const starveWindow: StarvationWindow = {
    start,
    end: end.getTime() < session.close.getTime() ? end : session.close,
  };
  const skipChecked = async (reason: PollSkipReason): Promise<PollRunResult> => {
    await checkStarvation(deps, market, sessionD, starveWindow, now);
    return skip(reason, arm.armed);
  };

  // 4. Cool-down and budget.
  const cooldown = await num(db, "quote_pause_cooldown_min");
  const since = await minutesSincePause(db, market, sessionD, now);
  if (since !== null && since < cooldown) return skipChecked("cooldown");
  const usedToday = await quoteRequestsToday(db, market, sessionD);
  const dayBudget = { dayMax: QUOTE_REQUESTS_PER_DAY, usedToday };
  const band = budgetBand(dayBudget);
  const active = await activeAlerts(db, market);
  // D-502 re-budget (V2-S5, D-694): armed picks keep their requests to 16:00. The 95 % stop only
  // ends the watch/held polling; an armed pick is polled until the day's budget itself is spent.
  const armedCodes = [...new Set(active.map((a) => a.latest.code))];
  if (band === "stop" && armedCodes.length === 0) return skipChecked("budget_stop");
  const allowed = requestsAllowed({ perRunMax: await num(db, "intraday_codes_max"), ...dayBudget });
  if (allowed <= 0) return skipChecked("budget_stop");

  // 5. Plan: armed picks first (every tick), then watch-listed and held codes at the cadence the
  // remaining budget sustains (every tick, or every k-th tick instead of stopping, D-695).
  const codes: string[] = [];
  const seen = new Set<string>();
  const add = (c: string): void => {
    if (!seen.has(c)) {
      seen.add(c);
      codes.push(c);
    }
  };
  for (const c of armedCodes) add(c);
  const extraCodes = new Set<string>();
  const heldKind = new Set<string>(); // OPS-109 c: held codes that are not watch-listed (plan counts)
  // D-907: the ASX 200 first among the extras, one request a tick, for the live line on Home.
  if ((await loadProfile(db, market)).benchmarkIndex === MARKET_INDEX_CODE) {
    extraCodes.add(MARKET_INDEX_CODE);
  }
  for (const c of await watchCodes(db, market, sessionD)) if (!seen.has(c)) extraCodes.add(c);
  for (const c of [...(await heldCodes(db, market))].sort()) {
    if (seen.has(c)) continue;
    if (!extraCodes.has(c)) heldKind.add(c);
    extraCodes.add(c);
  }
  const ticksLeft = remainingPollTicks(now, end, stepMin);
  const cadence = extrasCadence({
    ...dayBudget,
    armed: armedCodes.length,
    ticksLeft,
    extras: extraCodes.size,
  });
  const tickIndex = Math.floor(sinceStartMin / stepMin);
  const extrasDue = cadence > 0 && tickIndex % cadence === 0;
  if (extrasDue) for (const c of extraCodes) add(c);
  const planned = codes.slice(0, allowed);
  const narrowed = (extraCodes.size > 0 && !extrasDue) || codes.length > planned.length;
  // OPS-109 c (D-971): what the budget left out, and the plan's make-up (counts only).
  const skippedCodes = armedCodes.length + extraCodes.size - planned.length;
  const armedSet = new Set(armedCodes);
  const plan = {
    armed: planned.filter((c) => armedSet.has(c)).length,
    watch: planned.filter((c) => !armedSet.has(c) && !heldKind.has(c)).length,
    held: planned.filter((c) => !armedSet.has(c) && heldKind.has(c)).length,
  };

  // 6. Claim first: the row exists before any request (D-442). The reserved count is what this run may
  // request (never more than it plans), so 73 ticks stay inside the daily budget.
  const claim = await db.execute({
    sql:
      "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, narrowed, codes, skipped, plan) " +
      "VALUES (?, ?, ?, 'poll', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [
      market,
      sessionD,
      slot,
      now.toISOString(),
      planned.length,
      narrowed ? 1 : 0,
      planned.length,
      skippedCodes,
      JSON.stringify(plan),
    ],
  });
  if (claim.rowsAffected === 0) return skip("already_done", arm.armed);

  // 7. Fetch.
  let quotes: DelayedQuote[] = [];
  let paused: string | false = false;
  let requestsMade = 0;
  if (planned.length > 0) {
    const fetched = await fetchDelayedQuotes(
      {
        fetch: deps.fetch,
        now: deps.now,
        clock,
        sleep: deps.sleep,
        sourceState: () => readQuoteSourceState(db),
      },
      planned,
      { perRunMax: planned.length, dayMax: QUOTE_REQUESTS_PER_DAY, usedToday },
      { deadlineAt },
    );
    quotes = fetched.quotes;
    requestsMade = fetched.requests;
    // D-900: keep the newest quote per code for the site's delayed live price (display only).
    await storeLatestQuotesSoft(db, market, quotes);
    // V2-S7 (D-697): reconcile the reservation to the requests actually made.
    if (fetched.requests < planned.length) {
      await db.execute({
        sql:
          "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests) " +
          "VALUES (?, ?, ?, 'poll', ?, ?) ON CONFLICT DO NOTHING",
        args: [
          market,
          sessionD,
          `${slot}${DONE_SUFFIX}`,
          deps.now().toISOString(),
          fetched.requests,
        ],
      });
    }
    paused = fetched.paused;
    if (fetched.paused !== false) {
      // The claim row is append-only: a pause is its own row, read by the cool-down.
      await db.execute({
        sql:
          "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, paused) " +
          "VALUES (?, ?, ?, 'poll', ?, 0, ?) ON CONFLICT DO NOTHING",
        args: [market, sessionD, `${slot}+paused`, deps.now().toISOString(), fetched.paused],
      });
    }
  }
  const byCode = new Map(quotes.map((q) => [q.code, q]));

  // Evaluate every active alert; state first.
  const refresh = await num(db, "intraday_refresh_min");
  const params: AlertParams = {
    chaseCapPct: await num(db, "chase_cap_pct"),
    maxSessions: await num(db, "pick_alert_max_sessions"),
    maxAgeMin: 2 * refresh, // threshold-ok: D-441 freshness = delay + 2 x refresh
    delayMin: await num(db, "intraday_quote_delay_min"),
  };
  const halted = await haltedCodes(db, market, sessionD);
  const listed = new Set(
    arm.orders.map((o) => `${o.pickKey.d}|${o.pickKey.profile}|${o.pickKey.rank}`),
  );
  const users = new Set(recipients);
  const mailable: MailableTransition[] = [];
  let hits = 0;
  let cleared = 0;
  for (const a of active) {
    const row = a.latest;
    const q = byCode.get(row.code) ?? null;
    const t = evaluateAlert(
      {
        state: row.state,
        limitMicro: row.limitMicro,
        stopMicro: row.stopMicro,
        armedSession: a.armedSession,
        sessionsArmed: sessionsBetween(a.armedSession, sessionD, calendar).length,
        hitThisSession: row.state === "hit" && row.sessionD === sessionD,
      },
      q,
      {
        session: sessionD,
        now,
        halted: halted.has(row.code) || q?.halted === true,
        inList: listed.has(`${row.pickD}|${row.profile}|${row.rank}`),
        filled: await pickFilled(db, row),
        muted: !users.has(row.userId),
        params,
      },
    );
    if (t === null) continue;
    const next: MailableTransition = {
      ...row,
      seq: row.seq + 1,
      sessionD,
      state: t.state,
      at: now.toISOString(),
      hitMicro: t.state === "hit" ? t.hitMicro : null,
      quoteAt: t.quoteAt ?? null,
      clearReason: t.state === "cleared" ? t.reason : null,
    };
    if (!(await insertTransition(db, next))) continue; // another tick wrote it: no second mail
    if (t.state === "hit") {
      hits += 1;
      mailable.push(next);
    } else {
      cleared += 1;
      if (MAILED_CLEAR_REASONS.includes(t.reason)) mailable.push(next);
    }
  }

  // Mail second (WP4 hook).
  if (mailable.length > 0) await mailer.notify(mailCtx, mailable);

  // OPS-109 c: after the fetch, so this tick's fresh quotes count.
  await checkStarvation(deps, market, sessionD, starveWindow, deps.now());

  return {
    status: "ok",
    sessionD,
    slot,
    armed: arm.armed,
    requests: requestsMade,
    codes: planned.length,
    quotes: quotes.length,
    hits,
    cleared,
    narrowed,
    paused,
  };
}

/** System Health lines of the "pick alerts" series, derived on read. */
/** The health lines read the home market unless a market is named (no extra query: DAT-141 budget). */
export async function pickAlertsHealth(
  db: Exec,
  now: Date,
  market: string = HOME_MARKET,
): Promise<string[]> {
  let refusal: QuoteRefusal | null;
  try {
    refusal = refusalFor(await readQuoteSourceState(db));
  } catch {
    refusal = "gate_error";
  }
  if (refusal !== null) return [`Pick alerts off: ${refusal.replaceAll("_", " ")}`];
  const lines: string[] = [];
  const d = marketDate(now, SESSION_TZ);
  const used = await quoteRequestsToday(db, market, d);
  if (budgetBand({ dayMax: QUOTE_REQUESTS_PER_DAY, usedToday: used }) === "stop") {
    lines.push("Pick alerts stopped for the day (request budget)");
  }
  const paused = (await minutesSincePause(db, market, d, now)) !== null;
  if (paused) lines.push("Prices paused");
  if (!paused && lines.length === 0) {
    lines.push(
      ...(await recurringRunHealth(db, now, {
        market,
        purpose: "poll",
        label: "Pick-alert poll",
        startText: POLL_START,
        endText: POLL_END,
        stepMin: await num(db, "intraday_refresh_min"),
      })),
    );
  }
  return lines;
}

/** Poll slots shown on System Health (the newest ones that carry a plan). */
export const QUOTE_LINES_MAX = 3; // threshold-ok: display cap

/**
 * OPS-109 c (D-971): one fixed-word line per recent poll slot of the day,
 * "Quotes HH:MM: used n, skipped m (armed a, watch w, held h)". Counts only: no code is named (D-580).
 * `used` is the reservation, replaced by the `+done` row's actual count when one exists (D-697).
 */
export async function quoteBudgetLines(
  db: Exec,
  now: Date,
  market: string = HOME_MARKET,
): Promise<string[]> {
  const d = marketDate(now, SESSION_TZ);
  // rows-ok: one session's poll slots, at most 73 claim rows
  const r = await db.execute({
    sql:
      "SELECT q.slot_minute AS slot, q.skipped AS skipped, q.plan AS plan, " +
      "COALESCE((SELECT x.requests FROM quote_run x WHERE x.market = q.market AND x.session_d = q.session_d " +
      "AND x.purpose = q.purpose AND x.slot_minute = q.slot_minute || ?), q.requests) AS used " +
      "FROM quote_run q WHERE q.market = ? AND q.session_d = ? AND q.purpose = 'poll' " +
      "AND q.plan IS NOT NULL AND q.slot_minute NOT LIKE '%+%' ORDER BY q.slot_minute DESC LIMIT ?",
    args: [DONE_SUFFIX, market, d, QUOTE_LINES_MAX],
  });
  const lines: string[] = [];
  for (const row of [...r.rows].reverse()) {
    let p: { armed?: unknown; watch?: unknown; held?: unknown } = {};
    try {
      p = JSON.parse(String(row.plan)) as typeof p;
    } catch {
      continue;
    }
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    lines.push(
      `Quotes ${String(row.slot)}: used ${Number(row.used)}, skipped ${Number(row.skipped)} ` +
        `(armed ${n(p.armed)}, watch ${n(p.watch)}, held ${n(p.held)})`,
    );
  }
  return lines;
}

// ---- the signed handler of POST /api/internal/pick-alerts (D-067 pattern) ---------------------------

export type PickAlertsHandlerDeps = Omit<MachineDeps, "ctx"> & {
  db: () => Client;
  fetch: PollRunDeps["fetch"];
  sleep: PollRunDeps["sleep"];
  /** Reads the auth DB (injected so tests need none). */
  recipients: (db: Exec) => Promise<string[]>;
  mailer?: PickAlertMailer;
};

/** The default recipients reader: auth DB preference rows plus the Owner default (D-385). */
export async function defaultRecipients(main: Exec, auth: Exec): Promise<string[]> {
  return alertRecipients(auth, String(await getConfig(main, "pick_alerts_default_owner")) === "on");
}

export function createPickAlertsHandler(deps: PickAlertsHandlerDeps) {
  return signed(
    PICK_ALERTS_PURPOSE,
    { ...deps, ctx: () => ({ db: deps.db(), env: deps.env as AlertCtx["env"] }) },
    async (_b, nowSec) => {
      const db = deps.db();
      const r = await runPickAlertPoll({
        db,
        now: () => new Date(nowSec * 1000),
        fetch: deps.fetch,
        sleep: deps.sleep,
        recipients: () => deps.recipients(db),
        mailer: deps.mailer,
        notify: { env: deps.env as AlertCtx["env"] },
      });
      const body =
        r.status === "skipped"
          ? { status: r.reason === "already_done" ? "already_done" : "skipped", reason: r.reason }
          : {
              status: "ok",
              slot: r.slot,
              armed: r.armed,
              requests: r.requests,
              codes: r.codes,
              quotes: r.quotes,
              hits: r.hits,
              cleared: r.cleared,
              narrowed: r.narrowed,
              paused: r.paused,
            };
      return Response.json(body, { status: 200, headers: { "Cache-Control": "no-store" } });
    },
  );
}
