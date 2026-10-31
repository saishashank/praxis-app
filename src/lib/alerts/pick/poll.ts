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
import { localToUtc, marketDate, sessionsBetween, sessionTimes } from "@/lib/data/calendar";
import { readQuoteSourceState } from "@/lib/data/controls";
import {
  QUOTE_REQUESTS_PER_DAY,
  budgetBand,
  quoteRequestsToday,
  requestsAllowed,
} from "@/lib/data/quotes/budget";
import { fetchDelayedQuotes, refusalFor, type QuoteFetchDeps } from "@/lib/data/quotes/fetch";
import type { DelayedQuote, QuoteRefusal } from "@/lib/data/quotes/types";
import { heldCodes } from "@/lib/intraday/universe";
import { SESSION_TZ, minutesSincePause, readCalendar } from "@/lib/intraday/run";
import { signed, type MachineDeps } from "@/lib/alerts/machine";
import type { AlertCtx } from "@/lib/alerts/deliver";
import { armForSession } from "./arm";
import { evaluateAlert } from "./evaluate";
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

export const POLL_MARKET = "AU";
export const PICK_ALERTS_PURPOSE = "pick-alerts";
/** The slot grid of `quote-poll` (worker/src/schedule.ts); early close is enforced below. */
export const POLL_START = "10:00"; // threshold-ok: slot window, D-397
export const POLL_END = "16:00"; // threshold-ok: slot window, D-397
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
  /** Users whose pick alerts are on (ARN-112); the route reads the auth DB. */
  recipients: () => Promise<string[]>;
  /** WP4 hook; defaults to none (no mail leaves). */
  mailer?: PickAlertMailer;
  market?: string;
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

export async function runPickAlertPoll(deps: PollRunDeps): Promise<PollRunResult> {
  const { db } = deps;
  const market = deps.market ?? POLL_MARKET;
  const mailer = deps.mailer ?? NO_MAILER;
  const now = deps.now();
  const sessionD = marketDate(now, SESSION_TZ);

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

  // 4. Cool-down and budget.
  const cooldown = await num(db, "quote_pause_cooldown_min");
  const since = await minutesSincePause(db, market, sessionD, now);
  if (since !== null && since < cooldown) return skip("cooldown", arm.armed);
  const usedToday = await quoteRequestsToday(db, market, sessionD);
  const dayBudget = { dayMax: QUOTE_REQUESTS_PER_DAY, usedToday };
  const band = budgetBand(dayBudget);
  if (band === "stop") return skip("budget_stop", arm.armed);
  const allowed = requestsAllowed({ perRunMax: await num(db, "intraday_codes_max"), ...dayBudget });

  // 5. Plan: armed picks first, then watch-listed, then held codes (armed only above 80 %).
  const active = await activeAlerts(db, market);
  const codes: string[] = [];
  const seen = new Set<string>();
  const add = (c: string): void => {
    if (!seen.has(c)) {
      seen.add(c);
      codes.push(c);
    }
  };
  for (const a of active) add(a.latest.code);
  const armedOnly = band === "narrow";
  if (!armedOnly) {
    for (const c of await watchCodes(db, market, sessionD)) add(c);
    for (const c of [...(await heldCodes(db, market))].sort()) add(c);
  }
  const planned = codes.slice(0, allowed);
  const narrowed = armedOnly || codes.length > planned.length;

  // 6. Claim first: the row exists before any request (D-442). The reserved count is what this run may
  // request (never more than it plans), so 73 ticks stay inside the daily budget.
  const claim = await db.execute({
    sql:
      "INSERT INTO quote_run (market, session_d, slot_minute, purpose, started_at, requests, narrowed, codes) " +
      "VALUES (?, ?, ?, 'poll', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [
      market,
      sessionD,
      slot,
      now.toISOString(),
      planned.length,
      narrowed ? 1 : 0,
      planned.length,
    ],
  });
  if (claim.rowsAffected === 0) return skip("already_done", arm.armed);

  // 7. Fetch.
  let quotes: DelayedQuote[] = [];
  let paused: string | false = false;
  if (planned.length > 0) {
    const fetched = await fetchDelayedQuotes(
      {
        fetch: deps.fetch,
        now: deps.now,
        sleep: deps.sleep,
        sourceState: () => readQuoteSourceState(db),
      },
      planned,
      { perRunMax: planned.length, dayMax: QUOTE_REQUESTS_PER_DAY, usedToday },
    );
    quotes = fetched.quotes;
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

  return {
    status: "ok",
    sessionD,
    slot,
    armed: arm.armed,
    requests: planned.length,
    codes: planned.length,
    quotes: quotes.length,
    hits,
    cleared,
    narrowed,
    paused,
  };
}

/** System Health lines of the "pick alerts" series, derived on read. */
export async function pickAlertsHealth(
  db: Exec,
  now: Date,
  market: string = POLL_MARKET,
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
  if ((await minutesSincePause(db, market, d, now)) !== null) lines.push("Prices paused");
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
