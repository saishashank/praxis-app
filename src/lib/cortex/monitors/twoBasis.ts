// CXA-010 monitor 4 (M23 task M1; D-1618): two-basis stop conflicts per quarter. While a corporate action is unconfirmed the
// stop is compared on two price bases (`twoBasisStop`). The monitor counts the live positions held through such a window in
// the quarter, and how many of them closed on a stop inside it. The alarm: the count is above 0 and at least one closed on
// the stop. Source: `cortex_state` corporate-action rows (a "candidate" row opens the window, the next row of that code
// closes it) and the scored live-arm outcomes. A stop exit is a fill by the `level` or `gap_open` rule. Reads only.
import type { Client } from "@libsql/client";
import {
  addDays,
  quarterRange,
  quarterlyPeriod,
  type MonitorDef,
  type MonitorResult,
} from "./store";

/** The fill rules that are a stop exit (arena fill rules `level` and `gap_open`). */
export const STOP_EXIT_RULES: readonly string[] = ["level", "gap_open"];

export type StateRow = { readonly code: string; readonly fromD: string; readonly state: string };
export type Window = { readonly code: string; readonly from: string; readonly to: string };
export type HeldPosition = {
  readonly code: string;
  readonly fillD: string;
  /** null while the position is still open. */
  readonly exitD: string | null;
  readonly exitRule: string | null;
};

const OPEN_END = "9999-12-31";

/** The unconfirmed windows: from a "candidate" row to the next row of the same code (open windows end at OPEN_END). */
export function candidateWindows(rows: readonly StateRow[]): Window[] {
  const byCode = new Map<string, StateRow[]>();
  for (const r of rows) (byCode.get(r.code) ?? byCode.set(r.code, []).get(r.code)!).push(r);
  const out: Window[] = [];
  for (const [code, list] of [...byCode].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    list.sort((a, b) => (a.fromD < b.fromD ? -1 : 1));
    let start: string | null = null;
    for (const r of list) {
      const candidate = r.state.startsWith("candidate");
      if (candidate && start === null) start = r.fromD;
      else if (!candidate && start !== null) {
        out.push({ code, from: start, to: r.fromD });
        start = null;
      }
    }
    if (start !== null) out.push({ code, from: start, to: OPEN_END });
  }
  return out;
}

/** Monitor 4 from plain rows, for the quarter `[from, to]`. */
export function twoBasisMonitor(
  windows: readonly Window[],
  positions: readonly HeldPosition[],
  q: { from: string; to: string },
): MonitorResult {
  let held = 0;
  let closed = 0;
  for (const p of positions) {
    const end = p.exitD ?? OPEN_END;
    const inQuarter = p.fillD <= q.to && end >= q.from;
    if (!inQuarter) continue;
    const hit = windows.filter((w) => w.code === p.code && p.fillD <= w.to && end >= w.from);
    if (hit.length === 0) continue;
    held += 1;
    const stopped =
      p.exitD !== null &&
      p.exitRule !== null &&
      STOP_EXIT_RULES.includes(p.exitRule) &&
      hit.some((w) => p.exitD! >= w.from && p.exitD! <= w.to);
    if (stopped) closed += 1;
  }
  const alarm = held > 0 && closed >= 1;
  return {
    value: { held_through_unconfirmed: held, closed_on_stop: closed },
    alarm,
    ownerItems: alarm
      ? [
          `${closed} ${closed === 1 ? "position" : "positions"} closed on a stop while a company's share change was still unconfirmed: check the exit price was fair`,
        ]
      : [],
  };
}

const LOOK_BACK_DAYS = 120; // threshold-ok: how far back an unconfirmed window may have begun

/** Reads the windows and the live-arm positions of the quarter. Read only. */
export async function loadTwoBasis(
  db: Client,
  market: string,
  period: string,
): Promise<{ windows: Window[]; positions: HeldPosition[] }> {
  const { from, to } = quarterRange(period);
  // rows-ok: corporate-action state rows of the quarter and its look-back; capped at 2000
  const st = await db.execute({
    sql: `SELECT code, from_d, state FROM cortex_state WHERE market = ? AND kind = 'corp_action'
          AND from_d >= ? AND from_d <= ? ORDER BY code, from_d LIMIT 2000`,
    args: [market, addDays(from, -LOOK_BACK_DAYS), addDays(to, LOOK_BACK_DAYS)],
  });
  const windows = candidateWindows(
    st.rows.map((r) => ({ code: String(r.code), fromD: String(r.from_d), state: String(r.state) })),
  );
  // rows-ok: filled live-arm positions whose hold touches the quarter; capped at 2000
  const po = await db.execute({
    sql: `SELECT code, fill_d, exit_d, exit_rule FROM cortex_outcome
          WHERE market = ? AND arm = 'live' AND fill_status = 'filled' AND fill_d <= ?
            AND (exit_d IS NULL OR exit_d >= ?) ORDER BY fill_d, code LIMIT 2000`,
    args: [market, to, from],
  });
  const positions: HeldPosition[] = po.rows.map((r) => ({
    code: String(r.code),
    fillD: String(r.fill_d),
    exitD: r.exit_d === null ? null : String(r.exit_d),
    exitRule: r.exit_rule === null ? null : String(r.exit_rule),
  }));
  return { windows, positions };
}

export const twoBasisDef: MonitorDef = {
  monitor: 4,
  period: quarterlyPeriod,
  async compute(db, market, period) {
    const { windows, positions } = await loadTwoBasis(db, market, period);
    return twoBasisMonitor(windows, positions, quarterRange(period));
  },
};
