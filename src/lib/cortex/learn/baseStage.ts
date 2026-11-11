// The two stage functions of the candidate measures and the numbered base (Owner O-81):
//
//   probeNight   nightly, right after `cortexLearnNight` (the learn stage, picks/cli.ts): scores the
//                open probes from their cortex_feature_probe rows of D-1 and D-21 with the same
//                scorecard (cortex_angle_day rows), tallies the daily loop's mover causes of the last
//                four weeks and opens a probe (charged first) or escalates "a new measure is needed".
//   baseWeekly   weekly, in the learning run's "cortex" stage BEFORE the learner's reweight: writes base
//                version 1 of each family the first time, closes futile probes, runs the strict test
//                (learn/base.ts) and makes at most one base change per family per month: a new base
//                version, a new system cortex_map row (used from the next night), the event, and the
//                learner restart signal (`restartLearner`: the reweight then writes generation 0 on the
//                new base).
//
// Reads (Turso free plan): probeNight ≈ 2 × probes × universe feature rows + 2 regime rows + ~20
// daily_learning rows + the probe/base events (index); baseWeekly ≈ the scorecard rows of at most
// MAX_BLOCKS blocks (≤ 240 nights × ~100 rows) + maps + passports + charged cells. Nothing reads a bar
// of its own (the World's bars are reused), an outcome, or a night before a probe's open night or a
// base's first night: the sealed holdout is never touched. Insert-or-ignore everywhere.
import {
  addDays,
  isTradingDay,
  nextTradingDay,
  previousTradingDay,
  sessionsBetween,
  type CalendarRow,
} from "@/lib/data/calendar";
import type { Family } from "@/lib/agents/families/types";
import type { MoverExplanation } from "@/lib/learning/daily";
import type { World } from "@/lib/learning/dailyLoad";
import { ANGLES, scoredSet } from "../angles/registry";
import type { AngleDef, AngleStatus } from "../angles/types";
import { inResultsWindow } from "../gates/resultsSeason";
import { DEFAULT_MOVERS_PARAMS } from "../moversParams";
import { newestPerFamily } from "../stage";
import type { BatchExec, CortexFamily } from "../store/common";
import { insertMap, latestMaps, type MapRow } from "../store/maps";
import { latestPassports } from "../store/passports";
import {
  BASE_Q,
  BLOCK_SESSIONS,
  MAX_BLOCKS,
  blockEvidence,
  baseChangeWords,
  changeAllowed,
  chooseChange,
  isSystemRow,
  nextBase,
  probeFutility,
  strictVerdicts,
  type BaseChange,
  type BlockEvidence,
  type EvidenceNight,
} from "./base";
import {
  BASE_CELL_KIND,
  PROBE_CELL_KIND,
  baseEvents,
  baseVersions,
  chargeTrial,
  chargedCells,
  insertBaseVersion,
  latestBases,
  moverNights,
  probeFeatureNights,
  settleTrial,
  type BaseVersionRow,
} from "./baseStore";
import {
  CAUSE_WINDOW_SESSIONS,
  escalateWords,
  probeActions,
  probeCloseWords,
  probeOpenWords,
  probeStates,
  recurringCauses,
  type CauseTally,
  type ProbeCloseReason,
  type ProbeState,
} from "./probes";
import { familyWords } from "./learnWords";
import { scorecardNight } from "./scorecard";
import { angleDaysSince, insertAngleDays, logEvent, type LearnEvent } from "./store";

/** cortex_learn_event seq ranges of a night: probeNight 100–149, baseWeekly 150–199 (the scorecard
 *  is 0; the checkpoint and the reweight take their own seqs below 100). */
export const PROBE_SEQ0 = 100; // threshold-ok: reserved seq range of the night
export const BASE_SEQ0 = 150; // threshold-ok: reserved seq range of the night
const SEQ_SPAN = 50; // threshold-ok: width of each reserved range
const BACK20_SESSIONS = 21; // threshold-ok: design C.6 feature night of the 20-session leg
const CALENDAR_SPAN = 2; // threshold-ok: calendar days per session searched back
const V1_FAMILIES: readonly Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sessionsBack(d: string, n: number, calendar: readonly CalendarRow[]): string {
  let t = d;
  for (let i = 0; i < n; i += 1) t = previousTradingDay(t, calendar);
  return t;
}

async function regimeBefore(db: BatchExec, market: string, d: string): Promise<string> {
  const r = await db.execute({
    sql: "SELECT state FROM regime_daily WHERE market = ? AND d < ? ORDER BY d DESC LIMIT 1",
    args: [market, d],
  });
  return r.rows.length === 0 ? "unknown" : String(r.rows[0]!.state);
}

/** The next free seq of tonight in a reserved range (re-runs append after what is there). */
function seqFrom(events: readonly LearnEvent[], d: string, seq0: number): number {
  let next = seq0;
  for (const e of events) {
    if (e.d === d && e.seq >= seq0 && e.seq < seq0 + SEQ_SPAN) next = Math.max(next, e.seq + 1);
  }
  return next;
}

const statusFrom = (passports: readonly { angleId: string; status: AngleStatus }[]) => {
  const m = new Map(passports.map((p) => [p.angleId, p.status] as const));
  return (id: string): AngleStatus => m.get(id) ?? "candidate";
};

export const probeCellId = (market: string, family: string, angleId: string, d: string): string =>
  `learn-probe:${market}:${family}:${angleId}:${d}`;
export const baseCellId = (market: string, family: string, version: number): string =>
  `learn-base:${market}:${family}:v${version}`;

// ---- opening a probe -----------------------------------------------------------------------------

export type OpenProbeOpts = {
  readonly market: string;
  readonly family: CortexFamily;
  readonly angleId: string;
  readonly d: string;
  readonly now: string;
  readonly seq: number;
  readonly cause?: string | null;
  readonly words: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
};

/** Opens one probe: the trial charge FIRST (ledger cell + trial row), then the 'probe_open' event. */
export async function openProbe(db: BatchExec, o: OpenProbeOpts): Promise<{ cellId: string }> {
  const cellId = probeCellId(o.market, o.family, o.angleId, o.d);
  await chargeTrial(db, {
    market: o.market,
    family: o.family,
    angleId: o.angleId,
    kind: PROBE_CELL_KIND,
    cellId,
    spec: { test: "base_promotion", blocks: BLOCK_SESSIONS, maxBlocks: MAX_BLOCKS, q: BASE_Q },
    at: o.now,
    d: o.d,
    ruleVersion: `cortex:${o.family}.probe`,
    variant: `probe:${o.angleId}`,
  });
  await logEvent(db, {
    market: o.market,
    d: o.d,
    seq: o.seq,
    kind: "probe_open",
    family: o.family,
    angleId: o.angleId,
    evidence: { ...(o.evidence ?? {}), cause: o.cause ?? null, cellId },
    words: o.words,
    createdAt: o.now,
  });
  return { cellId };
}

// ---- nightly --------------------------------------------------------------------------------------

export type ProbeNightOpts = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** The daily learning's World of night d (its bars score the probes); absent = no scoring. */
  readonly world?: World;
  /** Tonight's explained movers (daily learning). */
  readonly movers: readonly Pick<MoverExplanation, "code" | "side" | "cause">[];
  /** created_at of the events and the charge instant; never part of a statistic. */
  readonly now: string;
  /** A synthetic registry (tests); default the code registry. */
  readonly angles?: readonly AngleDef[];
};

export type ProbeNightResult = {
  /** cortex_angle_day rows written for the probes tonight. */
  readonly scoredRows: number;
  readonly opened: readonly { family: string; angleId: string }[];
  readonly escalated: readonly string[];
  /** The night's Owner lines (already in the events' words). */
  readonly lines: readonly string[];
};

/**
 * The nightly probe step (call it after `cortexLearnNight`, in its own try/catch; a failure never
 * stops the picks). Null off-session. Idempotent: a re-run of the night writes nothing new.
 */
export async function probeNight(
  db: BatchExec,
  o: ProbeNightOpts,
): Promise<ProbeNightResult | null> {
  if (!isTradingDay(o.d, o.calendar)) return null;
  const events = await baseEvents(db, o.market, o.d);
  const { open, closed } = probeStates(events);

  // 1. score the open probes from their stored values (the same scorecard as the scored set)
  let scoredRows = 0;
  const ids = [...new Set(open.map((p) => p.angleId))].sort(byText);
  if (o.world !== undefined && ids.length > 0) {
    const prev = previousTradingDay(o.d, o.calendar);
    const back20 = sessionsBack(o.d, BACK20_SESSIONS, o.calendar);
    const nights = await probeFeatureNights(db, o.market, [prev, back20], ids);
    if (nights.size > 0) {
      const regimes = new Map<string, string>([
        [prev, await regimeBefore(db, o.market, prev)],
        [back20, await regimeBefore(db, o.market, back20)],
      ]);
      const card = scorecardNight({
        market: o.market,
        d: o.d,
        featuresPrev: nights.get(prev) ?? null,
        featuresBack20: nights.get(back20) ?? null,
        end20: prev,
        bars: new Map(
          [...o.world.shares].map(([code, s]) => [code, s.bars.map((b) => ({ d: b.d, c: b.c }))]),
        ),
        liquidCodes: o.world.liquidCodes,
        movers: o.movers.map((m) => ({ code: m.code, side: m.side, cause: m.cause })),
        regimes,
        resultsSeason: (fd) => inResultsWindow(fd, DEFAULT_MOVERS_PARAMS),
        prior60: null,
      });
      scoredRows = (await insertAngleDays(db, card.rows)).inserted;
    }
  }

  // 2. the mover causes of the last four weeks → probes to open, or a measure to ask for
  const window = sessionsBetween(
    addDays(o.d, -CAUSE_WINDOW_SESSIONS * CALENDAR_SPAN),
    o.d,
    o.calendar,
  ).slice(-CAUSE_WINDOW_SESSIONS);
  const before = window.filter((x) => x < o.d);
  const stored =
    before.length === 0
      ? []
      : await moverNights(db, o.market, before[0]!, before[before.length - 1]!);
  const causes = recurringCauses([
    ...stored,
    { d: o.d, movers: o.movers.map((m) => ({ code: m.code, cause: m.cause })) },
  ]);
  const opened: { family: string; angleId: string }[] = [];
  const escalated: string[] = [];
  const lines: string[] = [];
  if (causes.length === 0) return { scoredRows, opened, escalated, lines };
  const bases = new Map<string, readonly string[]>();
  for (const [f, v] of latestBases(await baseVersions(db, o.market))) bases.set(f, v.angles);
  const status = statusFrom(await latestPassports(db, o.market));
  const lastEscalated = new Map<string, string>();
  for (const e of events) {
    const cause = (e.evidence as { cause?: unknown } | null)?.cause;
    if (e.kind === "escalate" && typeof cause === "string") lastEscalated.set(cause, e.d);
  }
  const actions = probeActions({
    d: o.d,
    calendar: o.calendar,
    causes,
    bases,
    status,
    open,
    closed,
    lastEscalated,
    angles: o.angles,
  });
  let seq = seqFrom(events, o.d, PROBE_SEQ0);
  for (const a of actions) {
    if (seq >= PROBE_SEQ0 + SEQ_SPAN) break;
    if (a.kind === "open") {
      const words = probeOpenWords(a.family, a.angleId, a.tally);
      await openProbe(db, {
        market: o.market,
        family: a.family as CortexFamily,
        angleId: a.angleId,
        d: o.d,
        now: o.now,
        seq: seq++,
        cause: a.cause,
        words,
        evidence: { tally: a.tally },
      });
      opened.push({ family: a.family, angleId: a.angleId });
      lines.push(words);
    } else if (a.kind === "escalate") {
      const words = escalateWords(a.tally);
      await logEvent(db, {
        market: o.market,
        d: o.d,
        seq: seq++,
        kind: "escalate",
        evidence: { cause: a.cause, tally: a.tally, need: "new_measure" },
        words,
        createdAt: o.now,
      });
      escalated.push(a.cause);
      lines.push(words);
    }
  }
  return { scoredRows, opened, escalated, lines };
}

// ---- weekly ---------------------------------------------------------------------------------------

export type BaseWeeklyOpts = {
  readonly market: string;
  /** The week's last session (the night the weekly run belongs to). */
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  /** fitted_at of a system map row and created_at of the rows: after the night's cut-off. */
  readonly now: string;
  /** A synthetic registry (tests); default the code registry. */
  readonly angles?: readonly AngleDef[];
  /** BH q of a base change (C.9 learn_probe_q; default 0.05). */
  readonly q?: number;
};

export type BaseFamilyResult = {
  readonly family: CortexFamily;
  /** The family's newest base version after tonight. */
  readonly version: number;
  readonly count: number;
  readonly change: "initial" | "owner_import" | "promote" | "retire" | null;
  readonly angleId?: string;
};

export type BaseWeeklyResult = {
  readonly families: readonly BaseFamilyResult[];
  readonly closed: readonly { family: string; angleId: string; reason: ProbeCloseReason }[];
  /**
   * Families whose base changed tonight: the learner must restart there — its next weekly run writes
   * a new generation 0 with `based_on` = `ruleVersion` (the new system row) on the new base.
   */
  readonly restartLearner: readonly {
    family: CortexFamily;
    ruleVersion: string;
    baseVersion: number;
    sinceD: string;
  }[];
  readonly lines: readonly string[];
};

type AngleNights = Map<
  string,
  Map<string, { ic1: number | null; ic20: number | null; regime: string }>
>;

function evidenceOf(nights: AngleNights, angleId: string): EvidenceNight[] {
  return [...(nights.get(angleId) ?? new Map()).entries()]
    .sort((a, b) => byText(a[0], b[0]))
    .map(([d, x]) => ({ d, ic1: x.ic1, ic20: x.ic20, regime: x.regime }));
}

/** The first night the test of an item reads: the start of its first block in the window. */
function readFrom(start: string, d: string, calendar: readonly CalendarRow[]): string {
  const days = sessionsBetween(start, d, calendar);
  const done = Math.floor(days.length / BLOCK_SESSIONS);
  const first = Math.max(0, done - MAX_BLOCKS);
  return days[first * BLOCK_SESSIONS] ?? start;
}

const evidenceJson = (e: BlockEvidence): Record<string, unknown> => ({
  blocks: e.blockMeans,
  blocksDone: e.blocksDone,
  nights: e.nights,
  mean: e.mean,
  t: e.t === null || Number.isFinite(e.t) ? e.t : String(e.t),
  p: e.p,
  mean20: e.mean20,
  regimes: e.regimes,
});

/**
 * The weekly base step (call it inside the weekly learning run's "cortex" stage, before the learner's
 * reweight, on the week's last session). Null off-session. Idempotent on a re-run of the night.
 */
export async function baseWeekly(
  db: BatchExec,
  o: BaseWeeklyOpts,
): Promise<BaseWeeklyResult | null> {
  if (!isTradingDay(o.d, o.calendar)) return null;
  const angles = o.angles ?? ANGLES;
  const q = o.q ?? BASE_Q;
  const maps = await latestMaps(db, o.market, o.d);
  const fixed = newestPerFamily(maps);
  const status = statusFrom(await latestPassports(db, o.market));
  const globalIds = scoredSet(angles, status).map((a) => a.id);
  const latest = latestBases(await baseVersions(db, o.market));
  const events = await baseEvents(db, o.market, o.d);
  const { open } = probeStates(events);
  const probeCells = new Map(
    (await chargedCells(db, o.market, PROBE_CELL_KIND)).map((c) => [c.cellId, c] as const),
  );
  const baseCells = new Map(
    (await chargedCells(db, o.market, BASE_CELL_KIND)).map((c) => [c.cellId, c] as const),
  );
  const families: BaseFamilyResult[] = [];
  const closedOut: BaseWeeklyResult["closed"][number][] = [];
  const restart: BaseWeeklyResult["restartLearner"][number][] = [];
  const lines: string[] = [];
  let seq = seqFrom(events, o.d, BASE_SEQ0);
  const nextSeq = (): number | null => (seq < BASE_SEQ0 + SEQ_SPAN ? seq++ : null);
  const sinceD = nextTradingDay(o.d, o.calendar);

  const chargeBase = async (v: BaseVersionRow): Promise<void> => {
    const cellId = baseCellId(o.market, v.family, v.version);
    await chargeTrial(db, {
      market: o.market,
      family: v.family,
      angleId: null,
      kind: BASE_CELL_KIND,
      cellId,
      spec: { test: "base_retirement", version: v.version, blocks: BLOCK_SESSIONS, q },
      at: o.now,
      d: o.d,
      ruleVersion: `cortex:${v.family}.base`,
      variant: `base:v${v.version}`,
    });
    if (!baseCells.has(cellId)) {
      baseCells.set(cellId, {
        cellId,
        family: v.family,
        angleId: null,
        loggedAt: o.now,
        settled: false,
      });
    }
  };
  const closeProbe = async (
    p: ProbeState,
    reason: ProbeCloseReason,
    ev: unknown,
  ): Promise<void> => {
    const s = nextSeq();
    if (s === null) return;
    const words = probeCloseWords(p.family, p.angleId, reason);
    await logEvent(db, {
      market: o.market,
      d: o.d,
      seq: s,
      kind: "probe_close",
      family: p.family,
      angleId: p.angleId,
      evidence: { reason, openedD: p.openedD, cellId: p.cellId, evidence: ev },
      words,
      createdAt: o.now,
    });
    if (p.cellId !== "") await settleTrial(db, p.cellId, o.now, { verdict: reason, evidence: ev });
    closedOut.push({ family: p.family, angleId: p.angleId, reason });
    lines.push(words);
  };

  // the scorecard nights every test needs, one read from the earliest first block
  const starts: string[] = [];
  for (const family of V1_FAMILIES) {
    const cur = latest.get(family);
    if (cur !== undefined && fixed.has(family)) starts.push(readFrom(cur.sinceD, o.d, o.calendar));
  }
  for (const p of open) starts.push(readFrom(p.openedD, o.d, o.calendar));
  const from = starts.sort(byText)[0];
  const nights: AngleNights = new Map();
  if (from !== undefined && from <= o.d) {
    for (const r of await angleDaysSince(db, o.market, from, o.d)) {
      const perAngle = nights.get(r.angleId) ?? new Map();
      const x = perAngle.get(r.d) ?? { ic1: null, ic20: null, regime: r.regime };
      if (r.horizon === 1) {
        x.ic1 = r.ic;
        x.regime = r.regime;
      } else x.ic20 = r.ic;
      perAngle.set(r.d, x);
      nights.set(r.angleId, perAngle);
    }
  }

  for (const family of V1_FAMILIES) {
    const m: MapRow | undefined = fixed.get(family);
    if (m === undefined) continue;
    const cur = latest.get(family);
    const ownAngles = (m.params as unknown as { angles?: unknown }).angles;
    const mapAngles = Array.isArray(ownAngles)
      ? (ownAngles as string[]).filter((x) => typeof x === "string")
      : globalIds;
    if (
      cur === undefined ||
      (!isSystemRow(m) && m.ruleVersion !== cur.ruleVersion && m.fittedAt > cur.createdAt)
    ) {
      // version 1 (first sight) or an Owner import of a new fixed rule: the base is that rule's set
      const v: BaseVersionRow = {
        market: o.market,
        family,
        version: cur === undefined ? 1 : cur.version + 1,
        sinceD: cur === undefined ? o.d : sinceD,
        reason: cur === undefined ? "initial" : "owner_import",
        ruleVersion: m.ruleVersion,
        angles: [...mapAngles].sort(byText),
        added: [],
        removed: [],
        evidence: { from: m.ruleVersion, fittedAt: m.fittedAt },
        createdAt: o.now,
      };
      await insertBaseVersion(db, v);
      await chargeBase(v);
      if (v.reason === "owner_import") {
        const s = nextSeq();
        const words = `The base of ${familyWords(family)} now follows the Owner's new rule (the base now has ${v.angles.length} ${v.angles.length === 1 ? "measure" : "measures"}).`;
        if (s !== null) {
          await logEvent(db, {
            market: o.market,
            d: o.d,
            seq: s,
            kind: "base_change",
            family,
            generation: v.version,
            evidence: { reason: v.reason, version: v.version, ruleVersion: v.ruleVersion },
            words,
            createdAt: o.now,
          });
        }
        lines.push(words);
        restart.push({
          family,
          ruleVersion: v.ruleVersion,
          baseVersion: v.version,
          sinceD: v.sinceD,
        });
      }
      families.push({ family, version: v.version, count: v.angles.length, change: v.reason });
      continue;
    }

    // probes of the family: the base already has it → close; futile or a year done → close
    const mine = open.filter((p) => p.family === family);
    const promotions: {
      verdict: ReturnType<typeof strictVerdicts>[number];
      evidence: BlockEvidence;
    }[] = [];
    const live: { p: ProbeState; e: BlockEvidence }[] = [];
    for (const p of mine) {
      if (cur.angles.includes(p.angleId)) {
        await closeProbe(p, "base_has_it", null);
        continue;
      }
      const e = blockEvidence(
        sessionsBetween(p.openedD, o.d, o.calendar),
        evidenceOf(nights, p.angleId),
        "up",
      );
      live.push({ p, e });
    }
    const pv = strictVerdicts(
      live.map(({ p, e }) => {
        const cell = probeCells.get(p.cellId);
        return {
          angleId: p.angleId,
          evidence: e,
          charged: cell !== undefined && cell.loggedAt < o.now,
        };
      }),
      probeCells.size,
      q,
    );
    live.forEach((x, i) => promotions.push({ verdict: pv[i]!, evidence: x.e }));

    // the mirror test on the base's own measures, from the version's first night
    const baseSessions = sessionsBetween(cur.sinceD, o.d, o.calendar);
    const baseCell = baseCells.get(baseCellId(o.market, family, cur.version));
    const baseEv = cur.angles.map((id) => ({
      angleId: id,
      evidence: blockEvidence(baseSessions, evidenceOf(nights, id), "down"),
      charged: baseCell !== undefined && baseCell.loggedAt < o.now,
    }));
    const rv = strictVerdicts(baseEv, cur.angles.length, q);
    const retirements = baseEv.map((x, i) => ({ verdict: rv[i]!, evidence: x.evidence }));

    const change: BaseChange | null = changeAllowed(cur, o.d, o.calendar)
      ? chooseChange(promotions, retirements, cur.angles.length)
      : null;
    let result: BaseFamilyResult = {
      family,
      version: cur.version,
      count: cur.angles.length,
      change: null,
    };
    if (change !== null) {
      const nb = nextBase({
        current: cur,
        map: m,
        change,
        sinceD,
        now: o.now,
        angles,
        status,
        evidence: { test: change.kind, verdict: change.verdict, ...evidenceJson(change.evidence) },
      });
      if (nb !== null) {
        await insertBaseVersion(db, nb.version);
        await insertMap(db, nb.map);
        await chargeBase(nb.version);
        await settleTrial(db, baseCellId(o.market, family, cur.version), o.now, {
          next: nb.version.version,
          change: change.kind,
          angleId: change.angleId,
        });
        const words = baseChangeWords({
          family,
          change,
          count: nb.version.angles.length,
          sinceD,
          tonight: o.d,
          angles,
        });
        const s = nextSeq();
        if (s !== null) {
          await logEvent(db, {
            market: o.market,
            d: o.d,
            seq: s,
            kind: "base_change",
            family,
            angleId: change.angleId,
            generation: nb.version.version,
            evidence: {
              reason: change.kind,
              version: nb.version.version,
              from: cur.version,
              ruleVersion: nb.version.ruleVersion,
              count: nb.version.angles.length,
              ...evidenceJson(change.evidence),
            },
            words,
            createdAt: o.now,
          });
        }
        lines.push(words);
        restart.push({
          family,
          ruleVersion: nb.version.ruleVersion,
          baseVersion: nb.version.version,
          sinceD,
        });
        result = {
          family,
          version: nb.version.version,
          count: nb.version.angles.length,
          change: change.kind,
          angleId: change.angleId,
        };
        if (change.kind === "promote") {
          const p = live.find((x) => x.p.angleId === change.angleId)!.p;
          await closeProbe(p, "promoted", evidenceJson(change.evidence));
        }
      }
    }
    // futility closes (never the probe just promoted)
    for (const { p, e } of live) {
      if (change?.kind === "promote" && change.angleId === p.angleId) continue;
      const why = probeFutility(e);
      if (why !== null) await closeProbe(p, why, evidenceJson(e));
    }
    families.push(result);
  }
  return { families, closed: closedOut, restartLearner: restart, lines };
}

export type { CauseTally };
