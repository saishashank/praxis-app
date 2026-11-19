// What the app already knows about each code the Owner holds (M21 B1, UXN-316, D-1220): read-only, nothing here writes.
// Per code: the thesis-breakers that are not green (the latest evaluation of each), the Owner's own pick alerts on the
// code, and, when a live paper book holds it, the stop in force, the plain-words exit rule of that strategy and the
// paper position's status. Every query is bounded and keyed (market, code, recent days); no OFFSET.
import { formatDay } from "@/lib/view/format";
import { strategyNames } from "@/lib/ui/loaders/common";
import { loadMyAlerts, type MyAlertRow } from "@/lib/ui/loaders/pickAlerts";
import type { LoaderEnv } from "@/lib/ui/loaders/shell";
import { tierLabel } from "./tiers";

const BREAKER_DAYS = 7; // threshold-ok: a breaker evaluation older than a week is not "active"
const MAX_BREAKER_ROWS = 2000; // threshold-ok: bound of the breaker read for up to 200 codes
const MAX_CODES = 200; // threshold-ok: the holdings write limit
const MAX_POSITION_ROWS = 500; // threshold-ok: bound of the paper-position read for up to 200 codes
const MS_PER_DAY = 86_400_000; // threshold-ok: ms in a day

export type BreakerFact = {
  status: "watch" | "triggered";
  day: string;
  value: string;
  trigger: string;
};
export type AlertFact = {
  alertId: string;
  tier: string;
  rank: number;
  pickDate: string;
  state: "armed" | "hit" | "cleared";
  limitMicro: string | null;
  currency: string | null;
};
export type PaperFact = {
  strategy: string;
  exitRule: string;
  since: string;
  qty: number;
  /** The higher of the first stop and the latest recomputed stop, in micro. */
  stopMicro: string;
};
export type HoldingFacts = {
  /** False when the code is not in the market's instrument list: the app has no facts for it. */
  known: boolean;
  breakers: BreakerFact[];
  alerts: AlertFact[];
  paper: PaperFact[];
};

const empty = (): HoldingFacts => ({ known: true, breakers: [], alerts: [], paper: [] });

const inList = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

/** The facts for each of `codes` (an empty list gives an empty map; a failed read gives that part empty). */
export async function loadHoldingFacts(
  env: LoaderEnv,
  codes: readonly string[],
): Promise<Map<string, HoldingFacts>> {
  const out = new Map<string, HoldingFacts>(codes.map((c) => [c, empty()]));
  if (codes.length === 0) return out;
  const list = [...codes].slice(0, MAX_CODES);

  try {
    // rows-ok: key probe of (market, code) for at most 200 codes (the unique index), LIMIT bounded
    const r = await env.main.execute({
      sql: `SELECT code FROM instrument WHERE market = ? AND code IN (${inList(list.length)}) LIMIT ?`,
      args: [env.market, ...list, MAX_CODES],
    });
    const found = new Set(r.rows.map((x) => String(x.code)));
    for (const c of list) if (!found.has(c)) out.get(c)!.known = false;
  } catch {
    // a failed probe leaves the codes "known": the page then says nothing about them
  }

  try {
    const since = new Date(env.now.getTime() - BREAKER_DAYS * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    // rows-ok: index (market, code, d) with a seven-day window for at most 200 codes, LIMIT bounded
    const r = await env.main.execute({
      sql: `SELECT code, breaker_id, status, d, value_text, trigger_text FROM thesis_breaker_eval
            WHERE market = ? AND code IN (${inList(list.length)}) AND d >= ?
            ORDER BY d DESC, seq DESC, breaker_id LIMIT ?`,
      args: [env.market, ...list, since, MAX_BREAKER_ROWS],
    });
    const seen = new Set<string>();
    for (const x of r.rows) {
      const code = String(x.code);
      const key = `${code}|${String(x.breaker_id)}`;
      if (seen.has(key)) continue; // the newest evaluation of each breaker decides
      seen.add(key);
      const status = String(x.status);
      if (status !== "amber" && status !== "red") continue;
      out.get(code)?.breakers.push({
        status: status === "red" ? "triggered" : "watch",
        day: formatDay(String(x.d)),
        value: String(x.value_text),
        trigger: String(x.trigger_text),
      });
    }
  } catch {
    // the page shows the holding without breaker lines
  }

  try {
    const mine = await loadMyAlerts(env);
    for (const a of mine.rows as MyAlertRow[]) {
      const f = out.get(a.stock); // the Owner is never masked: the label is the code
      if (f === undefined) continue;
      f.alerts.push({
        alertId: a.alertId,
        tier: tierLabel(a.profile) ?? a.profile,
        rank: a.rank,
        pickDate: a.pickDate,
        state: a.state,
        limitMicro: a.limit?.micro ?? null,
        currency: a.limit?.currency ?? null,
      });
    }
  } catch {
    // no alert lines
  }

  try {
    const names = await strategyNames(env.main);
    // rows-ok: live cohorts of one market (few), their open trades by the (cohort_id, code) index; LIMIT bounded
    const r = await env.main.execute({
      sql: `SELECT t.code, x.family, ef.d AS entry_d, ef.qty AS qty, t.stop_micro AS first_stop,
                   (SELECT MAX(s.level_micro) FROM stop_level s WHERE s.trade_id = t.id
                      AND s.d = (SELECT MAX(s2.d) FROM stop_level s2 WHERE s2.trade_id = t.id)) AS latest_stop
            FROM cohort c JOIN execution x ON x.id = c.execution_id
              JOIN trade t ON t.cohort_id = c.id AND t.exit_type IS NULL
              JOIN fill ef ON ef.id = t.entry_fill_id
            WHERE x.market = ? AND c.live = 1 AND c.terminal_kind IS NULL AND t.code IN (${inList(list.length)})
            ORDER BY t.code, ef.d DESC LIMIT ?`,
      args: [env.market, ...list, MAX_POSITION_ROWS],
    });
    for (const x of r.rows) {
      const family = String(x.family);
      const first = BigInt(String(x.first_stop));
      const latest = x.latest_stop === null ? null : BigInt(String(x.latest_stop));
      out.get(String(x.code))?.paper.push({
        strategy: names[family]?.name ?? family,
        exitRule: names[family]?.sells ?? "",
        since: formatDay(String(x.entry_d)),
        qty: Number(x.qty), // money-float-ok: a stored share count, integer
        stopMicro: (latest !== null && latest > first ? latest : first).toString(),
      });
    }
  } catch {
    // no paper lines
  }
  return out;
}
