// Industry-group index series (M23 S1; CXA-009, D-1632, D-1633, D-1670...D-1674). Pure, integer parts per million.
// An equal-weight daily return per group: the mean of its members' close-to-close returns, a member that moved by
// more than 60 % in one session left out as a corporate action (the D-750 rule). The level chains from 1,000,000
// (the base before the first return): level = round(previous level x (1,000,000 + return) / 1,000,000).
// No market literal, no database, no clock here: the night step and the offline panel feed it.

const PPM = 1_000_000; // threshold-ok: unit
const SPLIT_GUARD_PPM = 600_000; // threshold-ok: D-750, a move above 60 % is a corporate action, not a return

/** The base level of every series (before its first return). */
export const SECTOR_BASE_LEVEL_PPM = PPM;

export type Member = { readonly group: string; readonly asOf: string };

export type GroupReturn = {
  readonly retPpm: number;
  /** Members that carried a return (a split-guarded or priceless member is not counted). */
  readonly n: number;
  /** The newest classification date among the counted members. */
  readonly mapAsOf: string;
};

/** Division rounded half away from zero. */
function roundDiv(num: number, den: number): number {
  const r = Math.floor(Math.abs(num) / den + 0.5);
  return num < 0 ? -r : r;
}

/** The return of one member in ppm, or null when it is not usable (no price, or a move above the guard). */
export function memberReturnPpm(
  close: number | undefined,
  prev: number | undefined,
): number | null {
  if (close === undefined || prev === undefined) return null;
  if (!(close > 0) || !(prev > 0)) return null;
  const ppm = roundDiv((close - prev) * PPM, prev);
  if (Math.abs(ppm) > SPLIT_GUARD_PPM) return null;
  return ppm;
}

/**
 * Equal-weight return per group for one session. `members` is the group map of that session (a code that moved group
 * counts in the group it belonged to on that date). Groups with no usable member are absent.
 */
export function groupReturns(
  bars: ReadonlyMap<string, number>,
  members: ReadonlyMap<string, Member>,
  prevClose: ReadonlyMap<string, number>,
): Map<string, GroupReturn> {
  const acc = new Map<string, { sum: number; n: number; asOf: string }>();
  for (const [code, m] of members) {
    const r = memberReturnPpm(bars.get(code), prevClose.get(code));
    if (r === null) continue;
    const g = acc.get(m.group) ?? { sum: 0, n: 0, asOf: m.asOf };
    g.sum += r;
    g.n += 1;
    if (m.asOf > g.asOf) g.asOf = m.asOf;
    acc.set(m.group, g);
  }
  const out = new Map<string, GroupReturn>();
  for (const g of [...acc.keys()].sort()) {
    const a = acc.get(g)!;
    out.set(g, { retPpm: roundDiv(a.sum, a.n), n: a.n, mapAsOf: a.asOf });
  }
  return out;
}

/** The next level of a chained series. */
export function chainLevel(prevLevelPpm: number, retPpm: number): number {
  const next = roundDiv(prevLevelPpm * (PPM + retPpm), PPM);
  if (!Number.isSafeInteger(next)) throw new Error("level out of range");
  return next;
}

export type SessionInput = {
  readonly d: string;
  readonly close: ReadonlyMap<string, number>;
  readonly members: ReadonlyMap<string, Member>;
};

export type SeriesRow = {
  readonly d: string;
  readonly group: string;
  readonly retPpm: number;
  readonly levelPpm: number;
  readonly n: number;
  readonly mapAsOf: string;
};

/**
 * The series over consecutive sessions (oldest first). The first session is the base and has no row; each later session
 * gives one row per group with a usable member, the level chained from the base (a group with no row on a session keeps
 * its level). Rows are ordered by date, then group.
 */
export function sectorSeries(days: readonly SessionInput[]): SeriesRow[] {
  const level = new Map<string, number>();
  const rows: SeriesRow[] = [];
  for (let i = 1; i < days.length; i++) {
    const day = days[i]!;
    const gr = groupReturns(day.close, day.members, days[i - 1]!.close);
    for (const [group, g] of gr) {
      const lv = chainLevel(level.get(group) ?? SECTOR_BASE_LEVEL_PPM, g.retPpm);
      level.set(group, lv);
      rows.push({ d: day.d, group, retPpm: g.retPpm, levelPpm: lv, n: g.n, mapAsOf: g.mapAsOf });
    }
  }
  return rows;
}

/** The sessions of a series in time order (distinct dates of its rows). */
export function seriesSessions(rows: readonly SeriesRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (out[out.length - 1] !== r.d) out.push(r.d);
  return out;
}

export type MonthStart = {
  /** 0-based, in time order, over the calendar months present. */
  readonly month: number;
  /** The first session of the month (index into `sessions`). */
  readonly index: number;
  readonly d: string;
};

/** The first session of each calendar month present in `sessions` (oldest first, YYYY-MM-DD). */
export function monthStarts(sessions: readonly string[]): MonthStart[] {
  const out: MonthStart[] = [];
  let last = "";
  sessions.forEach((d, index) => {
    const ym = d.slice(0, 7);
    if (ym === last) return;
    last = ym;
    out.push({ month: out.length, index, d });
  });
  return out;
}

/**
 * Month entries for `sectorIcLook` (R1): per month start, the groups with their member count on that session. The caller
 * reads signals and outcomes only after the floor is met (D-1605), through `levelReturnPpm`.
 */
export function monthEntries(
  rows: readonly SeriesRow[],
): { month: number; groups: { group: string; members: number }[] }[] {
  const byDate = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    const l = byDate.get(r.d);
    if (l) l.push(r);
    else byDate.set(r.d, [r]);
  }
  return monthStarts(seriesSessions(rows)).map((m) => ({
    month: m.month,
    groups: (byDate.get(m.d) ?? []).map((r) => ({ group: r.group, members: r.n })),
  }));
}

/** The group's level on a session, carried forward from its latest row at or before it, or null before its first row. */
export function levelAt(rows: readonly SeriesRow[], group: string, d: string): number | null {
  let lv: number | null = null;
  for (const r of rows) {
    if (r.d > d) break;
    if (r.group === group) lv = r.levelPpm;
  }
  return lv;
}

/** The return in ppm of a group's level from session `d0` to session `d1`, or null when either level is absent. */
export function levelReturnPpm(
  rows: readonly SeriesRow[],
  group: string,
  d0: string,
  d1: string,
): number | null {
  const a = levelAt(rows, group, d0);
  const b = levelAt(rows, group, d1);
  if (a === null || b === null || a <= 0) return null;
  return roundDiv((b - a) * PPM, a);
}
