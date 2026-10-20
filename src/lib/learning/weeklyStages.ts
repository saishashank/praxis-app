// The stage functions of the weekly learning run (M6 T12; docs/M6_design.md 4.4-4.6, D-110 #23/#24/#41,
// D-124 draft). Each stage reads the in-memory replay (`WeeklyContext`: the snapshot world and the
// ledger of the live rule versions) and the learning tables, writes through the module that owns the
// table (idempotent writers) and returns the statistics rows of the run. Every threshold comes from
// AgentParams. Development rows are the only rows the lesson engine, the generator and the factor
// buckets see (module boundary: LessonObs carries `part: "development"`, `DevelopmentView` returns a
// development summary only); validation rows are read once, inside the evidence run, after the
// `validation_access` row is written.
import type { Client } from "@libsql/client";
import { FAMILY_ORDER, FAMILY_RULE_VERSION } from "@/lib/agents/families/constants";
import { paramsWithVersion, type AgentParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { canonicalJson } from "@/lib/arena/cohort";
import { loadCalendar } from "@/lib/arena/closeBooks";
import { previousTradingDay, type CalendarRow } from "@/lib/data/calendar";
import {
  dailySeries,
  replayLedger,
  type EntryFacts,
  type LedgerEntry,
  type LedgerResult,
} from "@/lib/replay/ledger";
import { periodReturns, costSetupFrom } from "@/lib/replay/returns";
import type { SnapshotWorld } from "@/lib/replay/snapshotWorld";
import type { ReplayStatInput } from "@/lib/replay/scorecards";
import {
  lineageId,
  splitOf,
  validationSessions,
  type LineageSplitRecord,
} from "@/lib/stats/splits";
import {
  signalRowFromEntry,
  type ChallengerRow as ExcessRow,
  type SignalRow,
} from "@/lib/stats/val110";
import { ppmOf } from "./attribution";
import {
  generateChallenger,
  type DevelopmentEvaluation,
  type DevelopmentView,
  type ParamHint,
} from "./challengerGenerator";
import { advanceProposed, runChallengerEvidence, type EvidenceSize } from "./challengerEvidence";
import { incumbentOf } from "./challengerLifecycle";
import {
  evaluateLook,
  lookReady,
  readFindings,
  weeklyComparisons,
  writeLook,
  writeWeekly,
} from "./comparisons";
import { computeFactorBuckets, writeFactorBuckets, type FactorObs } from "./factors";
import { advanceSessions } from "./learnFacts";
import { comparisonPairs } from "./learnStage";
import { weeklyLeaveOneClass } from "./leaveOneClass";
import { runLessons, type LineageInput } from "./lessons";
import {
  budgetTotalFor,
  loadPromotion,
  promotionsAwaitingRoll,
  rollAfterPromotion,
} from "./promotion";
import type { LessonObs } from "./templates";
import type { StageOutput } from "./weeklyRun";
import {
  freezeLessonWindow,
  lessonWindowRow,
  splitLessonWindows,
  type LessonWindows,
} from "./windows";

export type WeeklyContext = {
  readonly db: Client;
  readonly market: string;
  /** The run date (Saturday in production; any date on a dispatch). */
  readonly d: string;
  readonly params: AgentParams;
  readonly runId: string;
  readonly world: SnapshotWorld;
  /** The live rule versions' ledger over the whole snapshot. */
  readonly ledger: LedgerResult;
  readonly facts: ReadonlyMap<string, EntryFacts>;
  readonly calendar: readonly CalendarRow[];
};

const stat = (scope: string, metric: string, value: unknown): ReplayStatInput => ({
  scope,
  metric,
  value,
});
const text = (v: unknown): string => String(v);
const ratNumber = (r: { readonly num: bigint; readonly den: bigint }): number =>
  Number(r.num) / Number(r.den); // money-float-ok: descriptive and bootstrap inputs are float64

export const loadMarketCalendar = loadCalendar;

// ---- shared readers ------------------------------------------------------------------------------------------

/** The newest stored split of a lineage, or null. */
export async function loadSplit(db: Client, lineage: string): Promise<LineageSplitRecord | null> {
  const rs = await db.execute({
    sql: "SELECT * FROM lineage_split WHERE lineage_id = ? ORDER BY version DESC LIMIT 1",
    args: [lineage],
  });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0]!;
  const opt = (v: unknown): string | null => (v === null || v === undefined ? null : text(v));
  return {
    lineage_id: text(r.lineage_id),
    version: Number(r.version),
    block_sessions: Number(r.block_sessions),
    holdout_len: Number(r.holdout_len),
    validation_len: Number(r.validation_len),
    purge: Number(r.purge),
    data_end_d: text(r.data_end_d),
    holdout_start_d: opt(r.holdout_start_d),
    holdout_end_d: opt(r.holdout_end_d),
    validation_start_d: opt(r.validation_start_d),
    validation_end_d: opt(r.validation_end_d),
    dev_end_d: opt(r.dev_end_d),
    deferred_until_d: opt(r.deferred_until_d),
    reason: text(r.reason) as "create" | "roll",
    measured_on_run: opt(r.measured_on_run),
  };
}

/** The family's own variant, optionally of one rule version. */
const primary = (res: LedgerResult, family: Family, version?: string): LedgerEntry[] =>
  res.entries.filter(
    (e) =>
      e.family === family &&
      e.variant === family &&
      (version === undefined || e.ruleVersion === version),
  );

const indexOf = (sessions: readonly string[]): Map<string, number> =>
  new Map(sessions.map((d, i) => [d, i]));

const isDevelopment = (split: LineageSplitRecord, entryD: string): boolean =>
  split.deferred_until_d !== null ? true : splitOf(split, entryD) === "development";

// ---- comparisons -----------------------------------------------------------------------------------------------------

export async function comparisonsStage(c: WeeklyContext): Promise<StageOutput> {
  const { db, market, params } = c;
  const cal = [...c.calendar];
  const friday = previousTradingDay(c.d, cal);
  const advance = (d: string, n: number): string => advanceSessions(d, n, cal);
  let looks = 0;
  let confirmed = 0;
  let discarded = 0;
  // TST-109 (D-126): a finding detected after the run date does not exist for this run
  const known = (await readFindings(db)).filter((f) => f.detected_d <= c.d);
  const open = known.filter((f) => f.state === "candidate" && f.look_due_d <= friday);
  for (const f of open) {
    const pairs = await comparisonPairs(db, {
      market,
      d: friday,
      calendar: cal,
      params,
      since: f.detected_d,
    });
    const pair = pairs.find((p) => p.pairId === f.pair_id);
    if (pair === undefined) continue;
    if (!lookReady(params, pair.block, pair.a.length, pair.b.length, pair.sessionCount)) continue;
    const out = evaluateLook(params, f, pair, c.d, pair.sessionCount, advance);
    await writeLook(db, f.id, out);
    looks += 1;
    if (out.passed) confirmed += 1;
    else discarded += 1;
  }
  const pairs = await comparisonPairs(db, { market, d: friday, calendar: cal, params });
  const week = weeklyComparisons(params, pairs, c.d, known, advance);
  await writeWeekly(db, week);
  return {
    stats: [
      stat(market, "comparisons", {
        asOf: friday,
        pairs: pairs.length,
        tested: week.rows.filter((r) => r.p !== null).length,
        discoveries: week.rows.filter((r) => r.discovery === 1).length,
        candidates: week.candidates.length,
        looks,
        confirmed,
        discarded,
      }),
    ],
  };
}

// ---- lessons -----------------------------------------------------------------------------------------------------------

type FrozenRow = {
  l1_start_d: string;
  l1_end_d: string;
  l2_start_d: string;
  l2_end_d: string;
};

async function readFrozen(db: Client, lineage: string, version: number): Promise<FrozenRow | null> {
  const rs = await db.execute({
    sql: "SELECT l1_start_d, l1_end_d, l2_start_d, l2_end_d FROM lesson_window WHERE lineage_id = ? AND split_version = ?",
    args: [lineage, version],
  });
  if (rs.rows.length === 0) return null;
  const r = rs.rows[0]!;
  return {
    l1_start_d: text(r.l1_start_d),
    l1_end_d: text(r.l1_end_d),
    l2_start_d: text(r.l2_start_d),
    l2_end_d: text(r.l2_end_d),
  };
}

/** A frozen window as session lists of the current calendar (the snapshot's start may move between weeks). */
function windowsFromFrozen(f: FrozenRow, sessions: readonly string[]): LessonWindows {
  return {
    l1: sessions.filter((d) => d >= f.l1_start_d && d <= f.l1_end_d),
    purge: sessions.filter((d) => d > f.l1_end_d && d < f.l2_start_d),
    l2: sessions.filter((d) => d >= f.l2_start_d && d <= f.l2_end_d),
  };
}

async function retiredVersions(db: Client, market: string): Promise<Set<string>> {
  const rs = await db.execute({
    sql: `SELECT r.id FROM rule_version r WHERE r.market = ?
          AND (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
               ORDER BY s.seq DESC LIMIT 1) = 'retired'`,
    args: [market],
  });
  return new Set(rs.rows.map((r) => text(r.id)));
}

/** A closed development ledger row as the lesson engine reads it (executed kind; stress excess not computed). */
export function toLessonObs(
  e: LedgerEntry,
  f: EntryFacts | undefined,
  index: ReadonlyMap<string, number>,
): LessonObs {
  const entryIdx = index.get(e.row.entry_d);
  const exitIdx = e.row.exit_d === null ? undefined : index.get(e.row.exit_d);
  return {
    part: "development",
    entryD: e.row.entry_d,
    observedD: e.row.exit_d ?? e.row.entry_d,
    id: e.row.id,
    family: e.family,
    kind: "executed",
    excess: e.excess === null ? null : ratNumber(e.excess),
    net: e.net === null ? 0 : ratNumber(e.net),
    stressExcess: null,
    regime: f?.regime ?? null,
    tier: f?.tier ?? null,
    exitKind: e.row.exit_tag,
    holdSessions: entryIdx === undefined || exitIdx === undefined ? null : exitIdx - entryIdx,
    blockedBy: null,
    evidenceClasses: f?.classes ?? [],
  };
}

export async function lessonsStage(c: WeeklyContext): Promise<StageOutput> {
  const { db, market, world } = c;
  const index = indexOf(world.sessions);
  const lineages: LineageInput[] = [];
  const rows: LessonObs[] = [];
  const skipped: { family: string; reason: string }[] = [];
  for (const family of FAMILY_ORDER) {
    const lineage = lineageId(market, family);
    const split = await loadSplit(db, lineage);
    if (split === null) {
      skipped.push({ family, reason: "no_split" });
      continue;
    }
    const incumbent = (await incumbentOf(db, market, family)) ?? FAMILY_RULE_VERSION[family];
    const deferred = split.deferred_until_d !== null;
    const devSessions = world.sessions.filter((d) => deferred || d <= split.dev_end_d!);
    let windows: LessonWindows | null = null;
    if (!deferred) {
      const frozen = await readFrozen(db, lineage, split.version);
      if (frozen !== null) windows = windowsFromFrozen(frozen, world.sessions);
      else {
        windows = splitLessonWindows(devSessions, split.purge);
        if (windows !== null) {
          await freezeLessonWindow(
            db,
            lessonWindowRow(lineage, split.version, windows, split.block_sessions, c.runId),
          );
        }
      }
    }
    lineages.push({
      family,
      lineageId: lineage,
      ruleVersion: incumbent,
      splitVersion: deferred ? 0 : split.version,
      windows,
      devSessions,
      block: split.block_sessions,
    });
    for (const e of primary(c.ledger, family, incumbent)) {
      if (e.net === null || !isDevelopment(split, e.row.entry_d)) continue;
      rows.push(toLessonObs(e, c.facts.get(e.row.id), index));
    }
  }
  const report = await runLessons(db, {
    market,
    runId: c.runId,
    d: c.d,
    asOfD: c.d,
    params: c.params,
    rows,
    lineages,
    retiredRuleVersions: await retiredVersions(db, market),
  });
  return { stats: [stat(market, "lessons", { ...report, lineages: lineages.length, skipped })] };
}

// ---- challengers ----------------------------------------------------------------------------------------------------

async function versionParams(db: Client, id: string): Promise<Record<string, unknown>> {
  const rs = await db.execute({
    sql: "SELECT params_json FROM rule_version WHERE id = ?",
    args: [id],
  });
  return rs.rows.length === 0
    ? {}
    : (JSON.parse(text(rs.rows[0]!.params_json)) as Record<string, unknown>);
}

async function paramHints(db: Client, lineage: string): Promise<ParamHint[]> {
  const rs = await db.execute({
    sql: `SELECT l.id, l.param_hint FROM lesson l
          WHERE l.lineage_id = ? AND l.param_hint IS NOT NULL
            AND (SELECT g.grade FROM lesson_grade g WHERE g.lesson_id = l.id ORDER BY g.seq DESC LIMIT 1) IN ('L2', 'L3')
          ORDER BY l.id`,
    args: [lineage],
  });
  return rs.rows.map((r) => ({ lessonId: text(r.id), key: text(r.param_hint) }));
}

const entryKey = (e: LedgerEntry): string => `${e.code}|${e.row.entry_d}`;

export async function challengersStage(c: WeeklyContext): Promise<StageOutput> {
  const { db, market, world, params } = c;
  const index = indexOf(world.sessions);
  const cost = costSetupFrom(params);
  const perFamily: Record<string, unknown>[] = [];
  const holdoutDue: string[] = [];
  const lastSession = world.sessions[world.sessions.length - 1]!;
  const replays = new Map<string, LedgerResult>();
  const replayOf = (
    family: Family,
    versionId: string,
    p: Readonly<Record<string, unknown>>,
  ): LedgerResult => {
    const key = `${family}|${versionId}|${canonicalJson(p)}`;
    let r = replays.get(key);
    if (r === undefined) {
      r = replayLedger(world, {
        params: paramsWithVersion(params, family, p),
        familyOptions: { families: [family], ruleVersions: { [family]: versionId } },
      });
      replays.set(key, r);
    }
    return r;
  };
  const entriesOf = (
    family: Family,
    versionId: string,
    p: Readonly<Record<string, unknown>>,
  ): LedgerEntry[] => {
    const live = primary(c.ledger, family, versionId);
    return live.length > 0 ? live : primary(replayOf(family, versionId, p), family, versionId);
  };
  let activeLineages = 0;
  for (const family of FAMILY_ORDER) {
    if ((await loadSplit(db, lineageId(market, family))) !== null) activeLineages += 1;
  }
  for (const family of FAMILY_ORDER) {
    const lineage = lineageId(market, family);
    const split = await loadSplit(db, lineage);
    const row: Record<string, unknown> = { family };
    perFamily.push(row);
    if (split === null || split.deferred_until_d !== null) {
      row.skipped = split === null ? "no_split" : "split_deferred";
      continue;
    }
    const incumbentId = await incumbentOf(db, market, family);
    if (incumbentId === null) {
      row.skipped = "no_incumbent";
      continue;
    }
    const incumbentParams = await versionParams(db, incumbentId);
    const budgetTotal = await budgetTotalFor(
      db,
      market,
      family,
      split.version,
      params.stats.trialBudgetPerLineage,
    );

    // 1. the generator: development rows only, through a view that returns a development summary
    const devEval = new Map<string, DevelopmentEvaluation>();
    const view: DevelopmentView = {
      async evaluate(p) {
        const k = canonicalJson(p);
        let e = devEval.get(k);
        if (e === undefined) {
          const dev = primary(replayOf(family, `${family}.dev`, p), family).filter(
            (x) => x.net !== null && splitOf(split, x.row.entry_d) === "development",
          );
          const ex = dev.filter((x) => x.excess !== null).map((x) => ratNumber(x.excess!));
          const blocks = new Set(
            dev.map((x) => Math.floor((index.get(x.row.entry_d) ?? 0) / split.block_sessions)),
          );
          e = {
            split: "development",
            rows: dev.length,
            blocks: blocks.size,
            meanExcess: ex.length === 0 ? null : ex.reduce((a, b) => a + b, 0) / ex.length,
          };
          devEval.set(k, e);
        }
        return e;
      },
    };
    const gen = await generateChallenger(db, view, {
      market,
      family,
      d: c.d,
      hints: await paramHints(db, lineage),
      learning: params.learning,
      stats: params.stats,
      budgetTotal,
    });
    row.generator =
      gen.status === "blocked" || gen.status === "refused"
        ? `${gen.status}:${gen.reason}`
        : gen.status;

    // 2. proposed -> replay, then the VAL-110 evidence of those in replay
    const active = await db.execute({
      sql: `SELECT id, rule_version_id, state FROM challenger
            WHERE lineage_id = ? AND state IN ('proposed', 'replay') ORDER BY id`,
      args: [lineage],
    });
    const vSess = validationSessions(split, [...world.sessions]);
    const vStart = vSess[0] === undefined ? 0 : index.get(vSess[0])!;
    const inValidation = (e: LedgerEntry): boolean =>
      splitOf(split, e.row.entry_d) === "validation";
    const incEntries = entriesOf(family, incumbentId, incumbentParams);
    const evidence: Record<string, string> = {};
    row.evidence = evidence;
    for (const ch of active.rows) {
      const id = text(ch.id);
      const vid = text(ch.rule_version_id);
      const mine = entriesOf(family, vid, await versionParams(db, vid));
      const size: EvidenceSize = {
        challengerKeys: mine.filter(inValidation).map(entryKey),
        incumbentKeys: incEntries.filter(inValidation).map(entryKey),
        sessionCount: vSess.length,
        block: split.block_sessions,
        windowEndD: split.validation_end_d!,
      };
      if (text(ch.state) === "proposed") {
        const adv = await advanceProposed(db, {
          challengerId: id,
          d: c.d,
          size,
          stats: params.stats,
          learning: params.learning,
        });
        if (!adv.moved) {
          evidence[id] = "proposed:insufficient";
          continue;
        }
      }
      const report = await runChallengerEvidence(db, {
        challengerId: id,
        runId: c.runId,
        d: c.d,
        variant: family,
        split,
        stats: params.stats,
        learning: params.learning,
        activeLineages,
        budgetTotal,
        size,
        loadRows: async () => {
          const val = mine.filter(inValidation);
          const rows: SignalRow[] = [];
          for (const e of val) {
            const s = signalRowFromEntry(e, index.get(e.row.entry_d)! - vStart);
            if (s !== null) rows.push(s);
          }
          const excessRows = (es: readonly LedgerEntry[]): ExcessRow[] =>
            es.flatMap((e) =>
              e.excess === null
                ? []
                : [
                    {
                      key: entryKey(e),
                      entrySession: index.get(e.row.entry_d)! - vStart,
                      excess: ratNumber(e.excess),
                    },
                  ],
            );
          const daily = periodReturns(
            dailySeries({ ...c.ledger, entries: val } as LedgerResult),
            cost.notionalMicro,
            (d) => d,
          ).map((x) => ratNumber(x.ret));
          return {
            rows,
            challengerRows: excessRows(val),
            incumbentRows: excessRows(incEntries.filter(inValidation)),
            safety: null,
            costInfeasible: false,
            pboWeekly: null,
            dsr:
              daily.length > 2
                ? {
                    daily,
                    variantDailySr: [],
                    defaultSrVariance: params.stats.dsrDefaultSrVariance,
                  }
                : null,
          };
        },
      });
      evidence[id] = report.outcome === "skipped" ? `skipped:${report.reason}` : report.outcome;
    }
  }

  // 3. holdout confirmations that are due are listed (the holdout is opened by the evidence run only)
  const promoted = await db.execute({
    sql: `SELECT ch.id, ch.lineage_id, ch.rule_version_id FROM challenger ch
          WHERE ch.state = 'promoted' AND ch.lineage_id LIKE ? ORDER BY ch.id`,
    args: [`${market}:%`],
  });
  for (const ch of promoted.rows) {
    const split = await loadSplit(db, text(ch.lineage_id));
    if (split === null || split.holdout_end_d === null || split.holdout_end_d > lastSession)
      continue;
    const used = await db.execute({
      sql: `SELECT 1 FROM trial_ledger WHERE lineage_id = ? AND split_version = ? AND kind = 'holdout_access'
            AND rule_version = ? LIMIT 1`,
      args: [text(ch.lineage_id), split.version, text(ch.rule_version_id)],
    });
    if (used.rows.length === 0) holdoutDue.push(text(ch.id));
  }
  return { stats: [stat(market, "challengers", { families: perFamily, holdout_due: holdoutDue })] };
}

// ---- rolls -------------------------------------------------------------------------------------------------------------

/** D-121: `rollAfterPromotion` for every promotion applied since the last run (the marker makes it once). */
export async function rollsStage(c: WeeklyContext): Promise<StageOutput> {
  const ids = await promotionsAwaitingRoll(c.db, c.market);
  const results: { promotion: string; status: string }[] = [];
  for (const id of ids) {
    const p = await loadPromotion(c.db, id);
    if (p === null) continue;
    const r = await rollAfterPromotion(c.db, {
      promotionId: id,
      calendar: c.world.sessions,
      primaryRows: primary(c.ledger, p.family).map((e) => ({
        entryD: e.row.entry_d,
        exitD: e.row.exit_d,
      })),
      stats: c.params.stats,
      now: c.d,
    });
    results.push({ promotion: id, status: r.status });
  }
  return { stats: [stat(c.market, "rolls", { awaiting: ids.length, results })] };
}

// ---- ARN-076 ----------------------------------------------------------------------------------------------------------

export async function arn076Stage(c: WeeklyContext): Promise<StageOutput> {
  const report = weeklyLeaveOneClass(c.world, c.world.sessions, c.params, c.market);
  return {
    stats: [stat(c.market, "arn076", report)],
    file: { name: "arn076", text: `${canonicalJson(JSON.parse(JSON.stringify(report)))}\n` },
  };
}

// ---- AGT-112 -----------------------------------------------------------------------------------------------------------

export async function factorsStage(c: WeeklyContext): Promise<StageOutput> {
  const obs: FactorObs[] = [];
  for (const family of FAMILY_ORDER) {
    const split = await loadSplit(c.db, lineageId(c.market, family));
    if (split === null) continue;
    for (const e of primary(c.ledger, family)) {
      if (e.net === null || !isDevelopment(split, e.row.entry_d)) continue;
      const f = c.facts.get(e.row.id);
      if (f === undefined) continue;
      obs.push({
        family,
        ruleVersion: e.ruleVersion,
        splitVersion: split.version,
        netPpm: Number(ppmOf(e.net.num, e.net.den)),
        values: Object.fromEntries(f.rules.map((r) => [r.rule, r.value])),
      });
    }
  }
  const rows = computeFactorBuckets(c.market, obs, c.params);
  const w = await writeFactorBuckets(c.db, rows);
  return {
    stats: [stat(c.market, "factor_buckets", { rows: rows.length, ...w })],
    file: {
      name: "factors",
      text: `${rows.map((r) => canonicalJson(JSON.parse(JSON.stringify(r)))).join("\n")}\n`,
    },
  };
}
