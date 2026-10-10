// The checks behind the two heartbeat routes (PLT-074). Read-only: no write happens here.
//
// Spec text (verbatim; file:line in the private spec v1):
//  - 02_platform_hosting_auth.md:104 PLT-074 (s9): "the morning check tests the Worker's last
//    successful poll; the evening check tests the Worker's last poll, today's completion marker
//    and email record (email checks skipped for markets in data-only mode), local-date aware"
//  - 02_platform_hosting_auth.md:29 PLT-018: "a "Sentinel blind" alert (email via Chapter 04) when
//    no successful poll occurs for 15 minutes during MAP hours." (ch.15 `sentinel_blind_alert`,
//    15 min; the registry key is `sentinel_blind_alert_min`)
//  - 10_nfr_testing.md:17: "Market in production data-only mode (BLD-024) | heartbeat and
//    watchdog skip email/review checks for that market; data-pipeline and Worker checks still
//    apply"
//  - docs/M2_design.md section 3: "19:50 | Marker check | Worker | in-app incident if missing";
//    ASX announcement poll "07:00..19:30, every 4 min".
//
// What counts as evidence (the Worker writes no per-minute record, decision 10):
//  - The Worker is alive when its daily rollup run record `worker-clock:AU:<Sydney date>` exists
//    (the first tick of the Sydney day writes it).
//  - The Sentinel (ASX poll) is fresh when `asx_rate_token.last_request_at` is recent. Only
//    judged on a trading day, with the market on, `asx_enabled` on and the ASX source `on`
//    (otherwise the Worker is not supposed to poll and silence is not an incident).
//  - Batch 1 finished when `completion_marker` has `data` or `non-trading` for the Sydney date.
//    Only judged on a trading day, with the market on and dispatch enabled (otherwise nothing was
//    dispatched and a missing marker is expected).
// A weekday the calendar has no row for counts as a trading day (alert rather than stay silent).
import type { Client } from "@libsql/client";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { getConfig } from "@/lib/config/store";
import { isWeekend, localToUtc, marketDate } from "@/lib/data/calendar";
import { ASX_ENABLED_KEY, ASX_SOURCE_ID, DISPATCH_ENABLED_KEY, parseOn } from "@/lib/data/controls";
import {
  KIND_MARKER_MISSING,
  KIND_SENTINEL_BLIND,
  KIND_WORKER_BLIND,
  WORKER_CLOCK_JOB,
  type HeartbeatKind,
} from "./state";

export const MARKET = "AU";
export const TZ = "Australia/Sydney";
export const POLL_START = "07:00";
export const POLL_END = "19:30";

export type Problem = { kind: string; text: string; detail: Record<string, unknown> };
export type CheckResult = {
  /** Sydney trading date the check judged. */
  date: string;
  problems: Problem[];
  notes: string[];
};

const MIN_MS = 60_000;

async function blindMinutes(db: Client): Promise<number> {
  const v = await getConfig(db, "sentinel_blind_alert_min");
  return typeof v === "number" && Number.isInteger(v) && v >= 1
    ? v
    : CONFIG_KEYS.sentinel_blind_alert_min.default;
}

async function stateOn(db: Client, key: string): Promise<boolean> {
  const r = await db.execute({
    sql: "SELECT value_json FROM worker_state WHERE key = ?",
    args: [key],
  });
  return r.rows.length === 1 && parseOn(r.rows[0].value_json);
}

/** Throws on a database error (the handler records "unknown" and stays retryable). */
export async function runChecks(kind: HeartbeatKind, db: Client, now: Date): Promise<CheckResult> {
  const date = marketDate(now, TZ);
  const problems: Problem[] = [];
  const notes: string[] = [];

  const mode = await db.execute({ sql: "SELECT mode FROM market WHERE code = ?", args: [MARKET] });
  const marketMode = mode.rows.length === 1 ? String(mode.rows[0].mode) : null;
  const marketOn = marketMode !== null && marketMode !== "off";
  const cal = await db.execute({
    sql: "SELECT kind FROM trading_calendar WHERE market = ? AND d = ?",
    args: [MARKET, date],
  });
  const tradingDay = !isWeekend(date) && cal.rows[0]?.kind !== "holiday";
  if (!tradingDay) notes.push("not a trading day: poll and marker checks skipped");
  if (!marketOn) notes.push("market is off: poll and marker checks skipped");

  // 1. The Worker is alive (both checks).
  const rollup = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'success' LIMIT 1",
    args: [`${WORKER_CLOCK_JOB}:${MARKET}:${date}`],
  });
  if (rollup.rows.length === 0) {
    problems.push({
      kind: KIND_WORKER_BLIND,
      text: "The Worker has not reported any activity today.",
      detail: { check: kind, date },
    });
  }

  // 2. The Sentinel (ASX poll) is fresh.
  if (tradingDay && marketOn) {
    const asxOn = await stateOn(db, ASX_ENABLED_KEY);
    const src = await db.execute({
      sql: "SELECT mode FROM source_status WHERE source = ?",
      args: [ASX_SOURCE_ID],
    });
    const sourceOn = src.rows[0]?.mode === "on";
    if (!asxOn || !sourceOn) {
      notes.push("ASX contact is off: poll check skipped");
    } else {
      const tok = await db.execute("SELECT last_request_at FROM asx_rate_token WHERE id = 1");
      const raw = tok.rows[0]?.last_request_at;
      const last = typeof raw === "string" ? Date.parse(raw) : NaN;
      const blind = await blindMinutes(db);
      const start = localToUtc(date, POLL_START, TZ).getTime();
      const end = localToUtc(date, POLL_END, TZ).getTime();
      const nowMs = now.getTime();
      if (kind === "morning") {
        if (nowMs < start || nowMs > end) {
          notes.push("outside announcement hours: poll check skipped");
        } else if (Number.isNaN(last) || nowMs - last > blind * MIN_MS) {
          problems.push({
            kind: KIND_SENTINEL_BLIND,
            text: `No ASX poll for more than ${blind} minutes in announcement hours.`,
            detail: { check: kind, date, blindMinutes: blind, lastPollAt: raw ?? null },
          });
        }
      } else if (Number.isNaN(last) || last < end - blind * MIN_MS) {
        // After the poll window closes, the last poll must be within `blind` minutes of its end.
        problems.push({
          kind: KIND_SENTINEL_BLIND,
          text: `The last ASX poll was more than ${blind} minutes before the end of announcement hours.`,
          detail: { check: kind, date, blindMinutes: blind, lastPollAt: raw ?? null },
        });
      }
    }
  }

  // 3. Evening only: today's completion marker; the email record is skipped (data-only mode).
  if (kind === "evening") {
    notes.push("email checks skipped (data-only mode, BLD-024)");
    if (tradingDay && marketOn) {
      if (!(await stateOn(db, DISPATCH_ENABLED_KEY))) {
        notes.push("dispatch is off: marker check skipped");
      } else {
        const m = await db.execute({
          sql: `SELECT 1 FROM completion_marker
                WHERE market = ? AND d = ? AND kind IN ('data', 'non-trading') LIMIT 1`,
          args: [MARKET, date],
        });
        if (m.rows.length === 0) {
          problems.push({
            kind: KIND_MARKER_MISSING,
            text: "Batch 1 left no completion marker for today.",
            detail: { check: kind, date },
          });
        }
      }
    }
  }
  return { date, problems, notes };
}
