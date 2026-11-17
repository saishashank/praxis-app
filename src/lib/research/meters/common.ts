// Shared helpers of the forward meters (M23 M3; D-1623, D-1720): one append-only `research_meter` row per lineage and market per
// night, a projected date at the trailing 60-session rate of the meter itself on the trading calendar, and the calendar helpers
// that let a counter work from dates alone (an event counts once its whole horizon has elapsed, before any outcome is read).
// Reads the calendar and its own table only; the one write is the meter row. Nothing here takes a look.
import type { Client } from "@libsql/client";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { projectDate } from "../lineages/annAngles";

export type MeterStatus = "collecting" | "met" | "looked" | "blocked";

const RATE_SESSIONS = 60; // threshold-ok: D-1623 the trailing 60-session rate
const CLOSED_AHEAD = 400; // threshold-ok: a bound on the holiday rows read for the projection
const MAX_INDEX = 4000; // threshold-ok: a bound on the index closes read (about sixteen years of sessions)
const MAX_BACK = 400; // threshold-ok: a bound on the sessions read to find a maturity cutoff

export const str = (v: unknown): string => String(v);
export const num = (v: unknown): number => Number(v);

/** The date of the k-th latest session at or before `d` (k = 1 is `d` itself when it is a session); null when the calendar is shorter. */
export async function sessionBack(
  db: Client,
  market: string,
  d: string,
  k: number,
): Promise<string | null> {
  if (!Number.isInteger(k) || k < 1 || k > MAX_BACK) throw new RangeError("k is out of range");
  // rows-ok: the market's last k sessions up to the night by primary key range, LIMIT k (at most 400)
  const r = await db.execute({
    sql:
      "SELECT d FROM trading_calendar WHERE market = ? AND kind IN ('session','early_close') AND d <= ? " +
      "ORDER BY d DESC LIMIT ?",
    args: [market, d, k],
  });
  return r.rows.length < k ? null : str(r.rows[k - 1]!.d);
}

/** Sessions with a date in [from, to], inclusive (a bounded count of calendar rows). */
export async function sessionsBetween(
  db: Client,
  market: string,
  from: string,
  to: string,
): Promise<number> {
  // rows-ok: calendar rows of one window by primary key range; a quarter or a few, at most about 400
  const r = await db.execute({
    sql:
      "SELECT COUNT(*) AS n FROM trading_calendar WHERE market = ? AND kind IN ('session','early_close') " +
      "AND d >= ? AND d <= ?",
    args: [market, from, to],
  });
  return num(r.rows[0]?.n ?? 0);
}

/** The market's holiday dates after the night, for the projection walk. */
export async function closedAfter(db: Client, market: string, d: string): Promise<Set<string>> {
  // rows-ok: holiday rows after the night, LIMIT 400 (a year ahead)
  const hol = await db.execute({
    sql: "SELECT d FROM trading_calendar WHERE market = ? AND kind = 'holiday' AND d > ? ORDER BY d LIMIT ?",
    args: [market, d, CLOSED_AHEAD],
  });
  return new Set(hol.rows.map((r) => str(r.d)));
}

/** The meter row before tonight: (date, n, status), or null. */
export async function previousMeter(
  db: Client,
  market: string,
  lineage: string,
  d: string,
): Promise<{ d: string; n: number; status: string } | null> {
  // rows-ok: primary key range (market, lineage, d) descending, LIMIT 1
  const r = await db.execute({
    sql: "SELECT d, n, status FROM research_meter WHERE market = ? AND lineage = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [market, lineage, d],
  });
  const x = r.rows[0];
  return x === undefined ? null : { d: str(x.d), n: num(x.n), status: str(x.status) };
}

/** The projected date at the trailing 60-session rate of the meter itself; null while there is no rate (D-1623). */
export async function projectedFromMeter(
  db: Client,
  market: string,
  lineage: string,
  d: string,
  n: number,
  target: number,
): Promise<string | null> {
  // rows-ok: the market's last 60 sessions up to the night, LIMIT 60
  const cal = await db.execute({
    sql:
      "SELECT d FROM trading_calendar WHERE market = ? AND kind IN ('session','early_close') AND d <= ? " +
      "ORDER BY d DESC LIMIT ?",
    args: [market, d, RATE_SESSIONS],
  });
  const days = cal.rows.map((r) => str(r.d));
  if (days.length < 2) return null;
  const cutoff = days[days.length - 1]!;
  // rows-ok: primary key range (market, lineage, d) descending, LIMIT 1: the meter row at or before the cutoff
  let base = await db.execute({
    sql:
      "SELECT d, n FROM research_meter WHERE market = ? AND lineage = ? AND d <= ? AND d < ? " +
      "ORDER BY d DESC LIMIT 1",
    args: [market, lineage, cutoff, d],
  });
  if (base.rows.length === 0) {
    // rows-ok: primary key range (market, lineage, d) ascending, LIMIT 1: the first meter row
    base = await db.execute({
      sql: "SELECT d, n FROM research_meter WHERE market = ? AND lineage = ? AND d < ? ORDER BY d LIMIT 1",
      args: [market, lineage, d],
    });
  }
  const b = base.rows[0];
  if (b === undefined) return null;
  const elapsed = days.filter((x) => x > str(b.d)).length;
  if (elapsed < 1) return null;
  const rate = (n - num(b.n)) / elapsed;
  return projectDate(d, target - n, rate, await closedAfter(db, market, d));
}

export type MeterRow = {
  readonly market: string;
  readonly lineage: string;
  readonly d: string;
  readonly n: number;
  readonly target: number;
  readonly status: MeterStatus;
  /** Null: the date is projected from the meter's own trailing rate (only while collecting). */
  readonly projectedD?: string | null;
  readonly now: string;
};

/** Writes the night's meter row (a repeat for the same night is ignored). Returns the projected date written. */
export async function writeMeter(db: Client, m: MeterRow): Promise<string | null> {
  const projectedD =
    m.projectedD !== undefined
      ? m.projectedD
      : m.status === "collecting"
        ? await projectedFromMeter(db, m.market, m.lineage, m.d, m.n, m.target)
        : null;
  // rows-ok: one insert per lineage, market and night; a repeat is ignored
  await db.execute({
    sql:
      "INSERT INTO research_meter (market, lineage, d, n, target, projected_d, status, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    args: [
      m.market,
      m.lineage,
      m.d,
      Math.max(0, Math.trunc(m.n)),
      m.target,
      projectedD,
      m.status,
      m.now,
    ],
  });
  return projectedD;
}

/** Lineages of this market that already hold a look (one primary-key read per lineage, from a json_each list). */
export async function lookedLineages(
  db: Client,
  market: string,
  lineages: readonly string[],
): Promise<Set<string>> {
  // rows-ok: the lineages of one item by primary key (json_each list), at most a few dozen rows
  const r = await db.execute({
    sql: "SELECT lineage FROM holdout_look WHERE market = ? AND lineage IN (SELECT value FROM json_each(?))",
    args: [market, JSON.stringify(lineages)],
  });
  return new Set(r.rows.map((x) => str(x.lineage)));
}

export type Bar = { d: string; o: number; c: number };
export type Idx = Map<string, { o: number; c: number }>;

export async function barsFrom(
  db: Client,
  market: string,
  code: string,
  from: string,
  limit: number,
): Promise<Bar[]> {
  // rows-ok: one code's bars by primary key range from the event date, LIMIT of the rule's horizon plus one (at most 21)
  const r = await db.execute({
    sql: "SELECT d, o, c FROM price_bar WHERE market = ? AND code = ? AND d >= ? ORDER BY d LIMIT ?",
    args: [market, code, from, limit],
  });
  return r.rows.map((x): Bar => ({ d: str(x.d), o: num(x.o), c: num(x.c) }));
}

export async function indexFrom(
  db: Client,
  market: string,
  from: string,
  to: string,
): Promise<Idx> {
  const code = staticProfile(market).benchmarkIndex;
  // rows-ok: the benchmark index closes of the window by primary key range, LIMIT 4000
  const r = await db.execute({
    sql:
      "SELECT d, o_micro, c_micro FROM index_bar WHERE market = ? AND index_code = ? AND d >= ? AND d <= ? " +
      "ORDER BY d LIMIT ?",
    args: [market, code, from, to, MAX_INDEX],
  });
  return new Map(r.rows.map((x) => [str(x.d), { o: num(x.o_micro), c: num(x.c_micro) }]));
}
