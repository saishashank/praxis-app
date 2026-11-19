// M23 M4 (D-1760...D-1769): the research half of the Cortex page, every figure in plain words. Read only, bounded, by key.
// Four sections: tests and their one look, waiting for data, risk monitors, sector series. A lineage is always shown through
// `lineageName`, a family through `familyBadge`; no key, code or run time is ever put in a row. The registry rows come from
// `view.ts` (task A2); this module adds the meters, the monitors, the sector series and the Owner-only proposal counts.
import type { Client } from "@libsql/client";
import { industryLabel } from "@/lib/cortex/survivorship";
import { dataLimitsOf } from "@/lib/market/seed/dataLimits.mjs";
import { fillExclusionText } from "@/lib/cortex/monitors/fillExclusion";
import { REVISIT_TEXT, LENS_OPTION, LENS_REASON } from "@/lib/cortex/monitors/lens";
import { PROMOTION_ALARM_TEXT } from "@/lib/cortex/monitors/promotion";
import { stallText } from "@/lib/cortex/monitors/stall";
import { familyBadge } from "@/lib/ui/familyBadge";
import { lineageName } from "./names";
import type { Verdict } from "./verdict";
import { proposalCounts } from "./proposals/counts";
import { registryRows } from "./view";

export type DateText = (d: string) => string;

export type TestRowView = {
  readonly name: string;
  readonly market: string;
  readonly when: string;
  /** Plain result word. */
  readonly result: string;
  /** The first 12 characters of the fingerprint of the plan that was written down first. */
  readonly fingerprint: string;
  readonly refusals: number;
};

export type WaitRowView = {
  readonly name: string;
  /** "14 of 252 sessions collected". */
  readonly progress: string;
  readonly status: string;
  /** "Expected about Fri 6 Nov", or null. */
  readonly expected: string | null;
};

export type MonitorRowView = {
  readonly monitor: number;
  readonly title: string;
  /** "Q1 2030", "At calibration, Fri 6 Nov" or null when nothing is stored. */
  readonly period: string | null;
  readonly lines: readonly string[];
  readonly alarm: boolean;
  readonly alarmLines: readonly string[];
};

export type SectorView = {
  readonly asOf: string;
  /** "static industry" while the grouping reads today's map for past days, else null. */
  readonly label: string | null;
  readonly rows: readonly {
    readonly group: string;
    readonly returnText: string;
    readonly members: number;
  }[];
};

export type ResearchView = {
  readonly tests: readonly TestRowView[];
  readonly inconclusive: readonly string[];
  readonly waiting: readonly WaitRowView[];
  readonly monitors: readonly MonitorRowView[];
  readonly sector: SectorView | null;
  /** Owner only; null for everyone else. */
  readonly proposals: { readonly kept: number; readonly refused: number } | null;
};

export const EMPTY_RESEARCH: ResearchView = {
  tests: [],
  inconclusive: [],
  waiting: [],
  monitors: [],
  sector: null,
  proposals: null,
};

export const RESULT_WORD: Readonly<Record<Verdict, string>> = {
  PASS: "Pass",
  NULL: "Null (no edge found)",
  INCONCLUSIVE: "Inconclusive",
};
export const INCONCLUSIVE_REASON =
  "There was not enough data to say either way. The one look is spent and is not repeated; the report says what is missing.";
export const NO_FORWARD_RECORD = "Waiting for a forward record";
export const WAITING_COMPLETE = "Sample reached; the look is waiting for complete events";
const OLDER_RESULT = "Older result";

const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const; // threshold-ok: the six families with a live n meter
const PERCENT = 100; // threshold-ok: percent
const PPM_PER_PERCENT = 10_000; // threshold-ok: ppm per percent
const METER_LIMIT = 60; // threshold-ok: bound on the meter lineages read (about 25 are asked for)
const SECTOR_LIMIT = 80; // threshold-ok: bound on the groups of one night
const MONITOR_LIMIT = 80; // threshold-ok: bound on the monitor rows read (8 monitors, a few periods each)
const MONITOR_COUNT = 8; // threshold-ok: the eight residual-risk monitors
const DATE_CHARS = 10; // threshold-ok: the date part of an ISO stamp
const SHA_CHARS = 12; // threshold-ok: the first 12 characters of the fingerprint

const MOVER_IDS = ["a1", "a2", "a3", "a4", "a5", "a8"] as const;
const LABEL_KINDS = ["guidance", "event_confirm", "tone"] as const;

type PlanItem = { key: string; name: string; unit: string; look: boolean; mover: boolean };

/** The lineages the meter list asks for, with the plain name, the unit and whether the sample ends in a look. */
function meterPlan(streamKey: string | null): PlanItem[] {
  const plan: PlanItem[] = [
    {
      key: "ann_angles",
      name: "Announcement history",
      unit: "sessions collected",
      look: true,
      mover: false,
    },
  ];
  for (const k of LABEL_KINDS)
    plan.push({
      key: `text_label_${k}`,
      name: lineageName(`text_label_${k}`),
      unit: "items you labelled",
      look: true,
      mover: false,
    });
  for (const m of MOVER_IDS)
    plan.push({
      key: `movers_${m}`,
      name: lineageName(`movers_${m}`),
      unit: "events counted",
      look: true,
      mover: true,
    });
  if (streamKey !== null)
    plan.push({
      key: streamKey,
      name: lineageName(streamKey),
      unit: "candidates measured",
      look: true,
      mover: false,
    });
  for (const f of FAMILIES)
    plan.push({
      key: `neff_live_${f}`,
      name: `Live-tested setups, ${familyBadge(f).label}`,
      unit: "independent setups",
      look: false,
      mover: false,
    });
  for (const f of FAMILIES)
    plan.push({
      key: `neff_trade_${f}`,
      name: `Independent trade setups, ${familyBadge(f).label}`,
      unit: "independent setups",
      look: false,
      mover: false,
    });
  return plan;
}

/** The newest stream cell's lineage key (one index read), or null before the first cell. */
async function streamLineageKey(db: Client, market: string): Promise<string | null> {
  // rows-ok: the stream's cells of one market by the (market, family, kind) index, newest first, LIMIT 1
  const r = await db.execute({
    sql:
      "SELECT cell_id FROM cortex_ledger_cell WHERE market = ? AND family = 'all' AND kind = 'intraday_stream' " +
      "ORDER BY logged_at DESC, cell_id DESC LIMIT 1",
    args: [market],
  });
  const id = r.rows[0] === undefined ? null : String(r.rows[0].cell_id);
  const head = `intraday_stream:${market}:`;
  if (id === null || !id.startsWith(head) || id.length === head.length) return null;
  return `intraday_stream_${id.slice(head.length).replace(/:/g, "_")}`;
}

/** The "waiting for data" rows: the newest meter row of each lineage, by key. */
export async function waitingRows(
  db: Client,
  market: string,
  when: DateText,
  looked: (lineage: string) => boolean,
): Promise<WaitRowView[]> {
  const plan = meterPlan(await streamLineageKey(db, market));
  // rows-ok: the newest research_meter row of each asked lineage, primary key (market, lineage, d) probes, LIMIT 60
  const r = await db.execute({
    sql: `SELECT m.lineage, m.n, m.target, m.projected_d, m.status FROM research_meter m
           WHERE m.market = ? AND m.lineage IN (SELECT value FROM json_each(?))
             AND m.d = (SELECT MAX(x.d) FROM research_meter x WHERE x.market = m.market AND x.lineage = m.lineage)
           LIMIT ?`,
    args: [market, JSON.stringify(plan.map((p) => p.key)), METER_LIMIT],
  });
  const byKey = new Map(r.rows.map((x) => [String(x.lineage), x]));
  const out: WaitRowView[] = [];
  for (const p of plan) {
    const x = byKey.get(p.key);
    if (x === undefined) continue;
    const status = String(x.status);
    let word: string;
    if (status === "blocked") word = p.mover ? NO_FORWARD_RECORD : "Not running yet";
    else if (status === "looked" || (status === "met" && looked(p.key))) word = "One look taken";
    else if (status === "met") word = p.look ? WAITING_COMPLETE : "Target reached";
    else word = "Collecting";
    out.push({
      name: p.name,
      progress: `${Number(x.n)} of ${Number(x.target)} ${p.unit}`,
      status: word,
      expected:
        status === "collecting" && x.projected_d !== null && x.projected_d !== undefined
          ? `Expected about ${when(String(x.projected_d))}`
          : null,
    });
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : [];
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rate = (v: unknown): string => {
  const x = fin(v);
  return x === null ? "not measured" : `${(x * PERCENT).toFixed(1)}%`;
};
const ppm = (v: unknown): string => {
  const x = fin(v);
  return x === null ? "not measured" : `${(x / PPM_PER_PERCENT).toFixed(2)}%`;
};
const fam = (v: Record<string, unknown>): string => familyBadge(String(v.family)).label;

const TITLES: Readonly<Record<number, string>> = {
  1: "Promotion flags and smaller-company entries",
  2: "What the permission rule would let through",
  3: "Confidence figures",
  4: "Share changes while a position is open",
  5: "One market state only",
  6: "Disagreement rule record",
  7: "Trades that stall",
  8: "Setups the fill model leaves out",
};

/** The plain lines and alarm lines of one stored monitor value (pure; a shape that does not read gives no lines). */
export function monitorLines(
  monitor: number,
  value: unknown,
  alarm: boolean,
): { lines: string[]; alarmLines: string[] } {
  const v = obj(value) ?? {};
  const lines: string[] = [];
  const alarmLines: string[] = [];
  const fams = arr(v.families);
  switch (monitor) {
    case 1: {
      const f = obj(v.flags);
      const e = obj(v.entries);
      const matured = fin(f?.matured) ?? 0;
      lines.push(
        matured === 0
          ? "No promotion flag has matured yet."
          : `${fin(f?.hits) ?? 0} of ${matured} promotion flags were followed by a fall (${rate(f?.hit_rate)}).`,
      );
      lines.push(
        `Event entries after costs: smaller companies ${ppm(e?.smaller_mean_ppm)} on average over ${fin(e?.smaller_n) ?? 0}, larger companies ${ppm(e?.large_mean_ppm)} over ${fin(e?.large_n) ?? 0}.`,
      );
      lines.push(
        fin(e?.lower90_ppm) === null
          ? "The gap between the two is not measured yet."
          : `The gap is at least ${ppm(e?.lower90_ppm)} with 90 % confidence.`,
      );
      if (alarm) alarmLines.push(PROMOTION_ALARM_TEXT);
      break;
    }
    case 2:
      for (const f of fams)
        lines.push(
          `${fam(f)}: ${rate(f.false_pass)} of look-alikes with no edge would pass; ${rate(f.true_pass)} of real edges at the smallest size we can detect would pass.`,
        );
      break;
    case 3:
      for (const f of fams) {
        const ub = fin(f.slope_ub90);
        lines.push(
          `${fam(f)}: ${f.hidden === true ? "the confidence figure is hidden" : "the confidence figure is shown"}${ub === null ? "" : `, slope bound ${ub.toFixed(2)}`}.`,
        );
        if (f.alarm === true) alarmLines.push(`Confidence figures are over-stated for ${fam(f)}`);
      }
      break;
    case 4: {
      const held = fin(v.held_through_unconfirmed) ?? 0;
      const closed = fin(v.closed_on_stop) ?? 0;
      lines.push(
        `${held} ${held === 1 ? "position was" : "positions were"} held while a company's share change was still unconfirmed; ${closed} closed on a stop.`,
      );
      if (alarm)
        alarmLines.push(
          `${closed} ${closed === 1 ? "position" : "positions"} closed on a stop while a company's share change was still unconfirmed: check the exit price was fair`,
        );
      break;
    }
    case 5:
      for (const f of fams)
        lines.push(
          `${fam(f)}: ${fin(f.setups) ?? 0} setups, ${rate(f.top_share)} in the most common market state${f.one_regime_only === true ? " (one regime only)" : ""}.`,
        );
      break;
    case 6:
      lines.push(`Rule: ${LENS_OPTION}.`, `Why: ${LENS_REASON}.`);
      lines.push(
        `Candidates stopped by it: ${fin(v.g10_vetoed) ?? 0}; nights a book stood aside: ${fin(v.g10_abstain_nights) ?? 0}; set share ${rate(v.disagreement_max)}.`,
      );
      break;
    case 7:
      for (const f of fams) {
        const src =
          f.expected_source === "calibration" ? "from calibration" : "from earlier quarters";
        lines.push(
          `${fam(f)}: ${rate(f.realised_rate)} stalled against ${rate(f.expected_rate)} expected (${src}).`,
        );
        if (f.alarm === true) alarmLines.push(stallText(String(f.family)));
      }
      break;
    case 8:
      for (const f of fams) {
        lines.push(
          `${fam(f)}: ${rate(f.unfilled_share)} of setups went unfilled (${rate(f.previous_share)} the quarter before).`,
        );
        if (f.alarm === true) alarmLines.push(fillExclusionText(String(f.family)));
      }
      break;
    default:
      break;
  }
  return { lines, alarmLines };
}

const periodWord = (p: string, when: DateText): string => {
  const q = /^(\d{4})-Q([1-4])$/.exec(p);
  if (q !== null) return `Q${q[2]} ${q[1]}`;
  const c = /^cal-(\d{4}-\d{2}-\d{2})$/.exec(p);
  return c === null ? "Revisit note" : `At calibration, ${when(c[1]!)}`;
};

type MonitorStored = {
  monitor: number;
  period: string;
  value: unknown;
  alarm: boolean;
  at: string;
};

/** The newest stored row of each monitor: the newest quarterly one, and the one-off calibration rows (monitors 2 and 6). */
export async function monitorRows(
  db: Client,
  market: string,
  when: DateText,
): Promise<MonitorRowView[]> {
  // rows-ok: residual_monitor primary key (market, monitor, period): the newest quarterly row of each of the eight, LIMIT 80
  const q = await db.execute({
    sql: `SELECT r.monitor, r.period, r.value_json, r.alarm, r.created_at FROM residual_monitor r
           WHERE r.market = ? AND r.period GLOB '[0-9]*'
             AND r.period = (SELECT MAX(x.period) FROM residual_monitor x
                              WHERE x.market = r.market AND x.monitor = r.monitor AND x.period GLOB '[0-9]*')
           LIMIT ?`,
    args: [market, MONITOR_LIMIT],
  });
  // rows-ok: residual_monitor primary key prefix (market), the one-off 'cal-' rows (one a market at calibration, one revisit), LIMIT 80
  const c = await db.execute({
    sql: "SELECT monitor, period, value_json, alarm, created_at FROM residual_monitor WHERE market = ? AND period GLOB 'cal-*' LIMIT ?",
    args: [market, MONITOR_LIMIT],
  });
  const parse = (x: Record<string, unknown>): MonitorStored => {
    let value: unknown = null;
    try {
      value = JSON.parse(String(x.value_json));
    } catch {
      value = null;
    }
    return {
      monitor: Number(x.monitor),
      period: String(x.period),
      value,
      alarm: Number(x.alarm) === 1,
      at: String(x.created_at),
    };
  };
  const quarterly = new Map(q.rows.map((x) => [Number(x.monitor), parse(x)]));
  const calibration = new Map<number, MonitorStored>();
  for (const x of c.rows.map(parse)) {
    const cur = calibration.get(x.monitor);
    if (cur === undefined || x.at > cur.at) calibration.set(x.monitor, x);
  }
  const out: MonitorRowView[] = [];
  for (let m = 1; m <= MONITOR_COUNT; m++) {
    const main = quarterly.get(m) ?? calibration.get(m) ?? null;
    if (main === null) {
      out.push({
        monitor: m,
        title: TITLES[m]!,
        period: null,
        lines: [],
        alarm: false,
        alarmLines: [],
      });
      continue;
    }
    const { lines, alarmLines } = monitorLines(m, main.value, main.alarm);
    const revisit = m === 6 ? calibration.get(6) : undefined;
    if (revisit !== undefined && revisit.alarm) alarmLines.push(REVISIT_TEXT);
    out.push({
      monitor: m,
      title: TITLES[m]!,
      period: periodWord(main.period, when),
      lines,
      alarm: main.alarm || alarmLines.length > 0,
      alarmLines,
    });
  }
  return out;
}

/** The latest night's equal-weight return of each industry group (one key seek for the night, then its rows). */
export async function sectorView(
  db: Client,
  market: string,
  when: DateText,
): Promise<SectorView | null> {
  // rows-ok: sector_index primary key (market, d, group_code, weighting): the newest night, then its groups, LIMIT 80
  const r = await db.execute({
    sql: `SELECT d, group_code, ret_ppm, n_members FROM sector_index
           WHERE market = ? AND weighting = 'equal'
             AND d = (SELECT MAX(x.d) FROM sector_index x WHERE x.market = ? AND x.weighting = 'equal')
           ORDER BY group_code LIMIT ?`,
    args: [market, market, SECTOR_LIMIT],
  });
  if (r.rows.length === 0) return null;
  const d = String(r.rows[0]!.d);
  const limit = dataLimitsOf(market)?.survivorship;
  // No own point-in-time industry snapshot is read here (the map is loaded from the extract), so the label applies while the
  // market's limit says it lapses only with its own snapshots (D-1763).
  const label = limit?.until_own_snapshots === true ? industryLabel(d, null) : null;
  return {
    asOf: when(d),
    label,
    rows: r.rows.map((x) => ({
      group: String(x.group_code),
      returnText: `${(Number(x.ret_ppm) / PPM_PER_PERCENT).toFixed(2)}%`,
      members: Number(x.n_members),
    })),
  };
}

/** Everything the research half of the page shows for one market. */
export async function loadResearchView(
  db: Client,
  o: { market: string; when: DateText; owner: boolean },
): Promise<ResearchView> {
  const reg = await registryRows(db, o.market);
  const lookedSet = new Set(reg.map((x) => x.lineage));
  const looked = (lineage: string): boolean =>
    lookedSet.has(lineage) ||
    (lineage === "ann_angles" && [...lookedSet].some((x) => x.startsWith("ann_angle_")));
  const tests: TestRowView[] = reg.map((x) => ({
    name: x.name,
    market: x.market,
    when: o.when(x.lookedAt.slice(0, DATE_CHARS)),
    result: x.verdict === null ? OLDER_RESULT : RESULT_WORD[x.verdict],
    fingerprint: x.sha.slice(0, SHA_CHARS),
    refusals: x.refusals,
  }));
  return {
    tests,
    inconclusive: reg.filter((x) => x.verdict === "INCONCLUSIVE").map((x) => x.name),
    waiting: await waitingRows(db, o.market, o.when, looked),
    monitors: await monitorRows(db, o.market, o.when),
    sector: await sectorView(db, o.market, o.when),
    proposals: o.owner ? await proposalCounts(db, o.market) : null,
  };
}
