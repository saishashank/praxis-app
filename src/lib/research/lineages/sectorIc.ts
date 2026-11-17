// CXA-009 sector IC look on the history extract (M23 R3; D-1633, D-1634, D-1710 to D-1715). Pure: the runner
// (`scripts/research/run-lineage.mjs --lineage sector_ic`) owns every file read. The frozen plan is
// `docs/research/prereg/CXA-009.json`; the window sizes below are the ones that file states in words, and every other
// parameter is read from the plan by the runner (nothing is tuned here).
//
// Path: the U1 codes of each session, grouped by the extract's current industry map (static industry), feed S1's pure
// `sectorSeries`; the monthly panel reads that series; R1's `sectorIcLook` counts the months from member counts, then reads
// signals and outcomes, and takes the one look.
import { levelReturnPpm, monthStarts, seriesSessions, sectorSeries } from "../sectorSeries";
import type { Member, SeriesRow, SessionInput } from "../sectorSeries";
import { qualifyingMonths, sectorIcLook } from "../sectorIc";
import type { MonthEntry, ReadGroup, SectorIcParams, SectorIcResult } from "../sectorIc";
import type { Universe, World } from "./cxa003";

/** Window sizes of the signal, the gap and the outcome, in sessions (D-1634, D-1710). */
export const SECTOR_IC_WINDOWS = {
  signal: 126, // threshold-ok: frozen in CXA-009.json (D-1634), the half year of the signal
  gap: 21, // threshold-ok: frozen in CXA-009.json (D-1634), the sessions between signal end and month start
  outcome: 21, // threshold-ok: frozen in CXA-009.json (D-1634), the month after the start
} as const;

/** Groups that carry no sector (funds and trusts) are not a group (D-1711). */
const NO_GROUP = "not applic";

/** Code to industry group from the extract's listed-company file; an empty group or "Not Applic" is left out. */
export function parseIndustryFile(file: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const rows = (file as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) throw new Error("the listed-company file has no rows");
  for (const r of rows as { code?: unknown; industry?: unknown }[]) {
    if (typeof r?.code !== "string" || typeof r.industry !== "string") continue;
    const g = r.industry.trim();
    if (g === "" || g.toLowerCase().startsWith(NO_GROUP)) continue;
    out.set(r.code, g);
  }
  return out;
}

/**
 * The days that feed `sectorSeries`: for each session of the calendar, the U1 codes of that session that have a group
 * (all in their one static group, dated `asOf`) and the closes of the codes that are members of that session or of the
 * next one (the next session's return needs this session's close).
 */
export function buildDays(
  world: World,
  universe: Pick<Universe, "at">,
  groupOf: ReadonlyMap<string, string>,
  asOf: string,
): SessionInput[] {
  const memberOf = new Map<string, Member>();
  for (const [code, group] of groupOf) memberOf.set(code, { group, asOf });
  const mapped = (session: number): string[] =>
    session >= world.dates.length
      ? []
      : universe
          .at(session)
          .map((r) => r.code)
          .filter((c) => memberOf.has(c));
  const days: SessionInput[] = [];
  let here = mapped(0);
  for (let s = 0; s < world.dates.length; s += 1) {
    const next = mapped(s + 1);
    const members = new Map<string, Member>();
    for (const c of here) members.set(c, memberOf.get(c)!);
    const close = new Map<string, number>();
    for (const c of [...here, ...next]) {
      const ser = world.series.get(c);
      const b = ser === undefined ? -1 : ser.pos[s]!;
      if (b >= 0) close.set(c, ser!.close[b]!);
    }
    days.push({ d: world.dates[s]!, close, members });
    here = next;
  }
  return days;
}

export type Panel = {
  /** Month entries for the engine, counted from member counts and dates alone. */
  readonly entries: MonthEntry[];
  /** The series' own session list. */
  readonly sessions: readonly string[];
  /** Index into `sessions` of each entry month's first session. */
  readonly startOf: ReadonlyMap<number, number>;
  readonly dateOf: ReadonlyMap<number, string>;
};

/**
 * The monthly panel over a series (D-1710): months with 126 + 21 sessions before and 21 after their first session, groups
 * that have a row on the month start and on or before the first signal session, each with its member count on the start.
 */
export function buildPanel(rows: readonly SeriesRow[], w = SECTOR_IC_WINDOWS): Panel {
  const sessions = seriesSessions(rows);
  const first = new Map<string, string>();
  const onStart = new Map<string, SeriesRow[]>();
  for (const r of rows) {
    if (!first.has(r.group)) first.set(r.group, r.d);
    const l = onStart.get(r.d);
    if (l) l.push(r);
    else onStart.set(r.d, [r]);
  }
  const back = w.signal + w.gap;
  const entries: MonthEntry[] = [];
  const startOf = new Map<number, number>();
  const dateOf = new Map<number, string>();
  for (const m of monthStarts(sessions)) {
    if (m.index < back || m.index + w.outcome >= sessions.length) continue;
    const from = sessions[m.index - back]!;
    const groups = (onStart.get(m.d) ?? [])
      .filter((r) => first.get(r.group)! <= from)
      .map((r) => ({ group: r.group, members: r.n }));
    entries.push({ month: m.month, groups });
    startOf.set(m.month, m.index);
    dateOf.set(m.month, m.d);
  }
  return { entries, sessions, startOf, dateOf };
}

/** Signal and outcome reader: called by the engine only after the month floor is met. */
export function panelReader(
  rows: readonly SeriesRow[],
  panel: Panel,
  minMembers: number,
  w = SECTOR_IC_WINDOWS,
): ReadGroup {
  const back = w.signal + w.gap;
  const outcomeOf = (month: number, group: string): number => {
    const i = panel.startOf.get(month)!;
    const v = levelReturnPpm(rows, group, panel.sessions[i]!, panel.sessions[i + w.outcome]!);
    if (v === null) throw new Error("a group in the panel has no level");
    return v;
  };
  const meanCache = new Map<number, number>();
  const monthMean = (month: number): number => {
    const hit = meanCache.get(month);
    if (hit !== undefined) return hit;
    const e = panel.entries.find((x) => x.month === month)!;
    const gs = e.groups.filter((g) => g.members >= minMembers);
    const mean = gs.reduce((a, g) => a + outcomeOf(month, g.group), 0) / gs.length;
    meanCache.set(month, mean);
    return mean;
  };
  return (month, group) => {
    const i = panel.startOf.get(month)!;
    const sig = levelReturnPpm(rows, group, panel.sessions[i - back]!, panel.sessions[i - w.gap]!);
    if (sig === null) throw new Error("a group in the panel has no level");
    return { signal: sig, outcome: outcomeOf(month, group) - monthMean(month) };
  };
}

/** What the plan freezes and the runner passes in (read from `CXA-009.json`). */
export type SectorIcPlanParams = Omit<SectorIcParams, "holdoutFromMonth">;

export type SectorIcRun = {
  readonly result: SectorIcResult;
  readonly sessions: number;
  readonly panelMonths: number;
  readonly firstMonth: string | null;
  readonly lastMonth: string | null;
  readonly groups: number;
  /** The mean for the months before the holdout start, from the mean of all and of the holdout (report only). */
  readonly developmentMeanIc: number | null;
  readonly developmentMonths: number;
};

/** The months that qualify, counted from member counts and dates alone (no signal or outcome is read). */
export function countMonths(rows: readonly SeriesRow[], p: SectorIcPlanParams): number {
  return qualifyingMonths(buildPanel(rows).entries, p.minMembers, p.minGroupsPerMonth).length;
}

/** The one look over a series: the engine counts, then reads, then decides. `holdoutFrom` is a date (report only). */
export function sectorIcRun(
  rows: readonly SeriesRow[],
  p: SectorIcPlanParams,
  holdoutFrom: string,
  w = SECTOR_IC_WINDOWS,
): SectorIcRun {
  const panel = buildPanel(rows, w);
  const startMonth = [...panel.dateOf.entries()].find(([, d]) => d >= holdoutFrom);
  const result = sectorIcLook(panel.entries, panelReader(rows, panel, p.minMembers, w), {
    ...p,
    holdoutFromMonth: startMonth?.[0],
  });
  let development: number | null = null;
  let developmentMonths = 0;
  if (result.status === "looked" && result.meanIc !== null) {
    developmentMonths = result.usedMonths - result.holdoutMonths;
    if (developmentMonths > 0)
      development =
        (result.meanIc * result.usedMonths - (result.holdoutMeanIc ?? 0) * result.holdoutMonths) /
        developmentMonths;
  }
  const months = [...panel.dateOf.values()].sort();
  return {
    result,
    sessions: panel.sessions.length,
    panelMonths: panel.entries.length,
    firstMonth: months[0] ?? null,
    lastMonth: months[months.length - 1] ?? null,
    groups: new Set(rows.map((r) => r.group)).size,
    developmentMeanIc: development,
    developmentMonths,
  };
}

/** Convenience for tests and the runner: days to series. */
export const seriesOfDays = (days: readonly SessionInput[]): SeriesRow[] => sectorSeries(days);
