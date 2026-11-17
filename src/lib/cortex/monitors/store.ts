// CXA-010 residual-risk monitors, shared plumbing (M23 task M1; D-1614). One row per monitor, market and period in
// `residual_monitor` (append-only, primary key market + monitor + period), and one plain-words line in `app_log` when an
// alarm fires. This is the ONLY place the monitors write: no monitor writes to a book, a rule, a ranking or a card, and
// nothing in a monitor changes anything the AU night reads (AT-74; a static test pins the two tables).
import type { Client } from "@libsql/client";
import type { ResearchNightOptions } from "@/lib/research/night";

/** What one monitor computes for one period: the figures, the alarm, and the Owner lines (plain words). */
export interface MonitorResult {
  readonly value: Record<string, unknown>;
  readonly alarm: boolean;
  /** One plain sentence per thing the Owner should look at; empty when no alarm. */
  readonly ownerItems: readonly string[];
}

/**
 * One monitor's definition. `period` says which period is due on this night (null when none is due); `compute` reads
 * stored rows only and returns the figures. Task M2 appends monitors 5 to 8 to the list in `steps/monitors.ts`.
 */
export interface MonitorDef {
  /** 1 to 8, as in `residual_monitor.monitor`. */
  readonly monitor: number;
  period(db: Client, market: string, d: string): Promise<string | null>;
  compute(db: Client, market: string, period: string): Promise<MonitorResult>;
}

export const QUARTER_RE = /^\d{4}-Q[1-4]$/;
/** The longest `value_json` the table accepts (CHECK in 0040). */
const VALUE_MAX = 4000; // threshold-ok: column CHECK of residual_monitor.value_json

/** "2030-02-14" -> "2030-Q1". */
export function quarterOf(d: string): string {
  const month = Number(d.slice(5, 7));
  return `${d.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`; // threshold-ok: months per quarter
}

/** The quarter before the one `d` falls in: the latest quarter that has fully ended on the night `d`. */
export function previousQuarter(d: string): string {
  const q = quarterOf(d);
  const year = Number(q.slice(0, 4));
  const n = Number(q.slice(6));
  return n === 1 ? `${year - 1}-Q4` : `${year}-Q${n - 1}`;
}

const QUARTER_BOUNDS: readonly (readonly [string, string])[] = [
  ["01-01", "03-31"],
  ["04-01", "06-30"],
  ["07-01", "09-30"],
  ["10-01", "12-31"],
];

/** First and last calendar day of a quarter label. */
export function quarterRange(q: string): { from: string; to: string } {
  if (!QUARTER_RE.test(q)) throw new RangeError("not a quarter label");
  const b = QUARTER_BOUNDS[Number(q.slice(6)) - 1]!;
  return { from: `${q.slice(0, 4)}-${b[0]}`, to: `${q.slice(0, 4)}-${b[1]}` };
}

/** `d` moved by `days` calendar days (UTC arithmetic on a date-only string). */
export function addDays(d: string, days: number): string {
  const t = Date.parse(`${d}T00:00:00Z`) + days * 86_400_000; // threshold-ok: ms per day
  return new Date(t).toISOString().slice(0, 10); // threshold-ok: date part of an ISO stamp
}

/** The quarterly monitors' `period`: the quarter that ended before the night, once. */
export const quarterlyPeriod = async (_db: Client, _market: string, d: string): Promise<string> =>
  previousQuarter(d);

/** Rounds to four decimals so a stored figure is short and reproducible. */
export const r4 = (x: number): number => Math.round(x * 10_000) / 10_000; // threshold-ok: 4 decimals

/** Does a monitor row already exist? (one primary-key read) */
async function rowExists(
  db: Client,
  market: string,
  monitor: number,
  period: string,
): Promise<boolean> {
  // rows-ok: one primary-key probe of residual_monitor (market, monitor, period); at most one row
  const r = await db.execute({
    sql: "SELECT 1 AS x FROM residual_monitor WHERE market = ? AND monitor = ? AND period = ?",
    args: [market, monitor, period],
  });
  return r.rows.length > 0;
}

/** Writes one monitor row; false when it was already there (the row is append-only and written once). */
export async function writeMonitorRow(
  db: Client,
  p: {
    market: string;
    monitor: number;
    period: string;
    result: MonitorResult;
    now: string;
  },
): Promise<boolean> {
  const json = JSON.stringify(p.result.value);
  if (json.length > VALUE_MAX) throw new RangeError("a monitor value is too long to store");
  // rows-ok: one insert per monitor, market and period (at most eight a quarter, D-1641)
  const r = await db.execute({
    sql: `INSERT OR IGNORE INTO residual_monitor (market, monitor, period, value_json, alarm, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [p.market, p.monitor, p.period, json, p.result.alarm ? 1 : 0, p.now],
  });
  return r.rowsAffected > 0;
}

/** One Owner item, through the existing path: an `app_log` warn line that starts "owner item:" (stage.ts pattern). */
export async function writeOwnerItem(db: Client, now: string, text: string): Promise<void> {
  // rows-ok: one warning line per alarm; a handful a quarter
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, 'warn', ?, ?, NULL)",
    args: [now, "research", `owner item: ${text}`.slice(0, 500)], // threshold-ok: log line length
  });
}

/**
 * Runs the monitors due on this night for one market: for each, the period (skipped when none or already stored),
 * the computation, one row, and one Owner line per alarm text. A monitor that fails does not stop the next one; the
 * first failure is raised at the end so the night seam logs it in plain words.
 */
export async function runMonitors(
  db: Client,
  o: ResearchNightOptions,
  defs: readonly MonitorDef[],
): Promise<void> {
  let failure: unknown = null;
  for (const def of defs) {
    try {
      const period = await def.period(db, o.market, o.d);
      if (period === null || (await rowExists(db, o.market, def.monitor, period))) continue;
      const result = await def.compute(db, o.market, period);
      const fresh = await writeMonitorRow(db, {
        market: o.market,
        monitor: def.monitor,
        period,
        result,
        now: o.now,
      });
      if (fresh && result.alarm) {
        for (const text of result.ownerItems) await writeOwnerItem(db, o.now, text);
      }
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure !== null) throw failure;
}
