// Pick validity by information, not by a number of sessions (D-187, Owner 2026-10-25: "check the
// performance, sentiment and other parameters and decide"). Every night a pick that has not been
// bought yet is checked against that night's information; the verdict is stored in `pick_check`
// that night and never changed (no hindsight). A pick may be bought at the next open only after a
// passing check; the first failing check withdraws it. The luck-check twin follows its pick.
//
// Checks, in order (the first that fails is the reason):
//   data          a data fault (not a market fact) or a trading halt on the code tonight
//   below_stop    tonight's close is at or below the stop: the thesis is broken
//   aim_reached   tonight's close is at or above the aim: the move happened without us
//   negative_news a negative announcement event since publication (AGT-011a polarity; the LLM
//                 reading when present)
//   regime        tonight's market regime is one the family makes no new entry in (spec 7.4)
//   evidence      the family's validation label fell to FAILED or NOT-DEMONSTRATED
//   edge_eroded   reward-to-risk at tonight's close is below half of the published one
//   horizon       it has waited longer than the typical holding time of past similar trades
// A check without its information tonight (no bar, no regime row) does not fail: only information
// withdraws a pick.
import type { Client } from "@libsql/client";
import { REGIME_BLOCKS } from "@/lib/agents/families/constants";
import type { Family } from "@/lib/agents/schema";
import { isTradingDay, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { priceMicro } from "@/lib/arena/marketData";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import type { Micro } from "@/lib/money/micro";
import { levelsAfter, pickActions } from "./track";

export type CheckReason =
  | "data"
  | "below_stop"
  | "aim_reached"
  | "negative_news"
  | "regime"
  | "evidence"
  | "edge_eroded"
  | "horizon";

/** Labels that withdraw the evidence behind a family (ARN-086). */
export const FAILING_LABELS: readonly string[] = ["FAILED", "NOT-DEMONSTRATED"];
/** edge_eroded: tonight's reward-to-risk below 1/EDGE_KEEP_DIVISOR of the published one. */
const EDGE_KEEP_DIVISOR = 2n; // threshold-ok: D-187 rule text ("half of the published edge")
/** Flags that say "no information tonight", not "bad information": they never withdraw a pick. */
const NOT_A_FAULT = ["DAT-210:missing_bar", "DAT-210:u1_gate"];

export type PickNight = {
  /** Tonight's close in the levels' terms, null without a bar tonight. */
  readonly closeMicro: Micro | null;
  readonly buyMaxMicro: Micro;
  readonly stopMicro: Micro;
  readonly aimMicro: Micro;
  readonly family: Family;
  /** Tonight's regime state, null without a regime row. */
  readonly regime: string | null;
  readonly negativeNews: boolean;
  readonly label: string;
  readonly dataFault: boolean;
  readonly halted: boolean;
  readonly sessionsWaited: number;
  readonly timeFrameSessions: number;
};

/** The first failing check, or null when the pick still stands tonight. Pure. */
export function checkPickNight(n: PickNight): CheckReason | null {
  if (n.dataFault || n.halted) return "data";
  const close = n.closeMicro;
  if (close !== null && close <= n.stopMicro) return "below_stop";
  if (close !== null && close >= n.aimMicro) return "aim_reached";
  if (n.negativeNews) return "negative_news";
  if (n.regime !== null && (REGIME_BLOCKS[n.family] as readonly string[]).includes(n.regime)) {
    return "regime";
  }
  if (FAILING_LABELS.includes(n.label)) return "evidence";
  if (close !== null && n.aimMicro > n.buyMaxMicro && n.buyMaxMicro > n.stopMicro) {
    // (aim - close) / (close - stop) < (aim - buyMax) / (buyMax - stop) / divisor, cross-multiplied
    const now = (n.aimMicro - close) * (n.buyMaxMicro - n.stopMicro) * EDGE_KEEP_DIVISOR;
    const published = (n.aimMicro - n.buyMaxMicro) * (close - n.stopMicro);
    if (now < published) return "edge_eroded";
  }
  if (n.sessionsWaited > n.timeFrameSessions) return "horizon";
  return null;
}

const text = (v: unknown): string => String(v);

export type CheckSummary = { readonly checked: number; readonly withdrawn: number };

/**
 * The nightly step: one `pick_check` row per published pick still waiting (not bought, no failing
 * check yet) for the night `d`. Runs after the tracking of the night, so tonight's purchases are
 * known. Idempotent: a night already checked is not checked again.
 */
export async function checkWaitingPicks(
  db: Client,
  o: { market: string; d: string; calendar: readonly CalendarRow[]; now: string },
): Promise<CheckSummary> {
  if (!isTradingDay(o.d, o.calendar)) return { checked: 0, withdrawn: 0 };
  const rows = await db.execute({
    sql: `SELECT p.d, p.profile, p.rank, p.code, p.family, p.rule_version, p.buy_max_micro,
                 p.stop_micro, p.aim_micro, p.time_frame_sessions
          FROM pick p JOIN pick_outcome o
            ON o.market = p.market AND o.d = p.d AND o.profile = p.profile AND o.rank = p.rank
           AND o.kind = 'pick'
          WHERE p.market = ? AND p.d < ? AND o.state = 'waiting'
            AND NOT EXISTS (SELECT 1 FROM pick_check c WHERE c.market = p.market AND c.d = p.d
              AND c.profile = p.profile AND c.rank = p.rank AND (c.valid = 0 OR c.night_d = ?))
          ORDER BY p.d, p.profile, p.rank`,
    args: [o.market, o.d, o.d],
  });
  if (rows.rows.length === 0) return { checked: 0, withdrawn: 0 };
  const regimeRow = await db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d = ? ORDER BY version DESC LIMIT 1",
    args: [o.market, o.d],
  });
  const regime = regimeRow.rows.length === 0 ? null : text(regimeRow.rows[0]!.state);
  const confirmed = await loadConfirmedActions(db, o.market, o.d);
  let withdrawn = 0;
  const stmts = [];
  for (const r of rows.rows) {
    const pubD = text(r.d);
    const code = text(r.code);
    const family = text(r.family) as Family;
    const levels = levelsAfter(
      {
        buyMaxMicro: BigInt(text(r.buy_max_micro)),
        stopMicro: BigInt(text(r.stop_micro)),
        aimMicro: BigInt(text(r.aim_micro)),
      },
      pickActions(confirmed, code, pubD),
      o.d,
    );
    const bar = await db.execute({
      sql: "SELECT c FROM price_bar WHERE market = ? AND code = ? AND d = ?",
      args: [o.market, code, o.d],
    });
    const news = await db.execute({
      sql: `SELECT 1 FROM event WHERE market = ? AND code = ? AND day0_d > ? AND day0_d <= ?
              AND COALESCE(polarity_llm, polarity) = -1 LIMIT 1`,
      args: [o.market, code, pubD, o.d],
    });
    const label = await db.execute({
      sql: `SELECT l.label FROM label l JOIN execution e ON e.id = l.execution_id
            WHERE e.family = ? AND l.rule_version = ? AND l.d <= ?
            ORDER BY l.d DESC, l.id DESC LIMIT 1`,
      args: [family, text(r.rule_version), o.d],
    });
    const fault = await db.execute({
      sql: `SELECT 1 FROM data_quality_flag WHERE market = ? AND code = ? AND d = ?
              AND cleared_at IS NULL AND blocks_entries = 1 AND severity <> 'info'
              AND check_id NOT IN (${NOT_A_FAULT.map(() => "?").join(",")}) LIMIT 1`,
      args: [o.market, code, o.d, ...NOT_A_FAULT],
    });
    const halt = await db.execute({
      sql: "SELECT halted FROM universe_snapshot WHERE market = ? AND d = ? AND code = ?",
      args: [o.market, o.d, code],
    });
    const reason = checkPickNight({
      closeMicro: bar.rows.length === 0 ? null : priceMicro(bar.rows[0]!.c),
      ...levels,
      family,
      regime,
      negativeNews: news.rows.length > 0,
      label: label.rows.length === 0 ? "UNVALIDATED" : text(label.rows[0]!.label),
      dataFault: fault.rows.length > 0,
      halted: halt.rows.length > 0 && Number(halt.rows[0]!.halted) === 1,
      sessionsWaited: sessionsBetween(pubD, o.d, o.calendar).filter((s) => s > pubD).length,
      timeFrameSessions: Number(r.time_frame_sessions), // money-float-ok: SQL integer column
    });
    if (reason !== null) withdrawn += 1;
    stmts.push({
      sql: `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [
        o.market,
        pubD,
        text(r.profile),
        Number(r.rank), // money-float-ok: SQL integer column
        o.d,
        reason === null ? 1 : 0,
        reason,
        o.now,
      ],
    });
  }
  await db.batch(stmts, "write");
  return { checked: rows.rows.length, withdrawn };
}
