// The numbered base of the fixed Cortex and the strict test that changes it (Owner O-81, which
// overrides D-925 on this point; design B.2 tier "Learning", Part D). Pure: no database, no clock, no
// randomness.
//
// A family's BASE is the scored set of its fixed rule: version 1 is that set as the loop first saw it
// (~50 measures for a rule on the global set, one for F1.v2-mom). A candidate measure (probe) joins it
// only at the "Learning" tier, and a base measure leaves it only under the mirror test:
//   - blocks: the probe's (or base's) trading days from its start, cut into non-overlapping
//     BLOCK_SESSIONS-session blocks; the test sees the last ≤ MAX_BLOCKS complete blocks and needs
//     ≥ MIN_BLOCKS, each with ≥ BLOCK_MIN_NIGHTS nights of a next-day result, every block's mean in
//     the same direction. Blocks are fixed from the start, so the evidence only changes when a block
//     completes: a weekly run re-reading the same blocks is not a new look;
//   - pooled: the mean next-day rank correlation over those nights, Student t > T_MIN (Harvey–Liu
//     strict, t > 3), and its one-sided p rejected by Benjamini–Hochberg at q (learn_probe_q = 0.05)
//     across ALL probes ever tried in the market (untested ones count as p = 1);
//   - the four-week rows (horizon 20) of the same nights must not point the other way;
//   - no market regime with ≥ REGIME_MIN_NIGHTS nights against the direction;
//   - the trial was charged to the ledger before this result (the caller passes `charged`).
// Retirement mirrors it: every block negative, t < −T_MIN, BH over the family's base measures, no
// regime of ≥ REGIME_MIN_NIGHTS nights positive. At most one base change per family per
// CHANGE_GAP_SESSIONS (a month); a change is a new version and a new system cortex_map row.
import {
  ANGLE_CLUSTERS,
  type AngleCluster,
  type AngleDef,
  type AngleStatus,
} from "../angles/types";
import { activeSetHash } from "../score/map";
import type { MapRow } from "../store/maps";
import type { CalendarRow } from "@/lib/data/calendar";
import { benjaminiHochberg } from "@/lib/stats/multiplicity";
import { studentTCdf } from "@/lib/stats/studentT";
import type { BaseVersionRow } from "./baseStore";
import { dayWords, familyWords } from "./learnWords";
import { measureName, sessionsSince } from "./probes";

/** Non-overlapping block length (design B.2: "60-session blocks"). */
export const BLOCK_SESSIONS = 60; // threshold-ok: design B.2 block (one quarter)
/** Blocks that must agree in sign before anything changes (design B.2: "≥ 2", ≈ 6 months). */
export const MIN_BLOCKS = 2; // threshold-ok: design B.2
/** Most recent complete blocks the test reads (a year); a probe still unproven then is closed. */
export const MAX_BLOCKS = 4; // threshold-ok: one year of blocks, the reads bound
/** A block counts only with at least this many nights of a next-day result (half the block). */
export const BLOCK_MIN_NIGHTS = 30; // threshold-ok: half of a block
/** Harvey–Liu strict level on the pooled t. */
export const T_MIN = 3; // threshold-ok: Harvey–Liu-strict t > 3 (design B.2)
/** A regime with at least this many nights must not point against the change (design B.2). */
export const REGIME_MIN_NIGHTS = 30; // threshold-ok: design B.2 "each regime with ≥ 30 nights"
/** BH q of a base change (C.9 learn_probe_q default). */
export const BASE_Q = 0.05; // threshold-ok: C.9 learn_probe_q default
/** At most one base change per family per month of trading days. */
export const CHANGE_GAP_SESSIONS = 21; // threshold-ok: one month of trading days
/** The system rows' rule-version suffix: `<fixed rule>+b<version>`. */
export const BASE_SUFFIX = "+b";

export type Direction = "up" | "down";

/** One night of an angle's scorecard, as the test reads it (cortex_angle_day, both horizons). */
export type EvidenceNight = {
  readonly d: string;
  /** Next-day rank correlation (horizon 1); null when not computable that night. */
  readonly ic1: number | null;
  /** Four-week rank correlation (horizon 20) known that night; null when absent. */
  readonly ic20: number | null;
  readonly regime: string;
};

export type BlockEvidence = {
  readonly direction: Direction;
  /** Complete blocks since the start, and the first block the test read. */
  readonly blocksDone: number;
  readonly firstBlock: number;
  readonly blockMeans: readonly (number | null)[];
  readonly blocksAgree: boolean;
  readonly nights: number;
  readonly mean: number | null;
  readonly t: number | null;
  /** One-sided p in `direction` (1 when not computable). */
  readonly p: number;
  readonly mean20: number | null;
  readonly fourWeeksAgree: boolean;
  readonly regimes: readonly {
    readonly regime: string;
    readonly nights: number;
    readonly mean: number;
  }[];
  readonly regimesOk: boolean;
  /** At least MIN_BLOCKS complete blocks were read. */
  readonly ready: boolean;
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const avg = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

function tStat(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null; // threshold-ok: a t needs two values
  const m = avg(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (n - 1);
  if (v === 0) return m === 0 ? 0 : m > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return m / Math.sqrt(v / n);
}

function oneSidedP(t: number | null, df: number, direction: Direction): number {
  if (t === null || !(df >= 1)) return 1;
  const s = direction === "up" ? t : -t;
  if (s === Number.POSITIVE_INFINITY) return 0;
  if (s === Number.NEGATIVE_INFINITY) return 1;
  return Math.min(1, Math.max(0, 1 - studentTCdf(s, df)));
}

/**
 * The block evidence of one angle: `sessions` are the trading days from the start (the probe's open
 * night, or the base version's first night) to tonight inclusive; `nights` its scorecard nights (any
 * order, others ignored). Pure and deterministic.
 */
export function blockEvidence(
  sessions: readonly string[],
  nights: readonly EvidenceNight[],
  direction: Direction,
): BlockEvidence {
  const blocksDone = Math.floor(sessions.length / BLOCK_SESSIONS);
  const firstBlock = Math.max(0, blocksDone - MAX_BLOCKS);
  const byD = new Map(nights.map((n) => [n.d, n] as const));
  const blockMeans: (number | null)[] = [];
  const used: EvidenceNight[] = [];
  for (let b = firstBlock; b < blocksDone; b += 1) {
    const days = sessions.slice(b * BLOCK_SESSIONS, (b + 1) * BLOCK_SESSIONS);
    const xs: number[] = [];
    for (const d of days) {
      const n = byD.get(d);
      if (n !== undefined && n.ic1 !== null && Number.isFinite(n.ic1)) {
        xs.push(n.ic1);
        used.push(n);
      }
    }
    blockMeans.push(xs.length >= BLOCK_MIN_NIGHTS ? avg(xs) : null);
  }
  const sign = direction === "up" ? 1 : -1;
  const ready = blockMeans.length >= MIN_BLOCKS;
  const blocksAgree = ready && blockMeans.every((m) => m !== null && Math.sign(m) === sign);
  const ic1 = used.map((n) => n.ic1!);
  const t = tStat(ic1);
  const mean = ic1.length === 0 ? null : avg(ic1);
  const ic20 = used.map((n) => n.ic20).filter((x): x is number => x !== null && Number.isFinite(x));
  const mean20 = ic20.length === 0 ? null : avg(ic20);
  const fourWeeksAgree = mean20 === null || Math.sign(mean20) !== -sign;
  const groups = new Map<string, number[]>();
  for (const n of used) {
    const list = groups.get(n.regime) ?? [];
    list.push(n.ic1!);
    groups.set(n.regime, list);
  }
  const regimes = [...groups]
    .sort((a, b) => byText(a[0], b[0]))
    .map(([regime, xs]) => ({ regime, nights: xs.length, mean: avg(xs) }));
  const regimesOk = regimes.every(
    (r) => r.nights < REGIME_MIN_NIGHTS || Math.sign(r.mean) !== -sign,
  );
  return {
    direction,
    blocksDone,
    firstBlock,
    blockMeans,
    blocksAgree,
    nights: ic1.length,
    mean,
    t,
    p: oneSidedP(t, ic1.length - 1, direction),
    mean20,
    fourWeeksAgree,
    regimes,
    regimesOk,
    ready,
  };
}

export type Candidate = {
  readonly angleId: string;
  readonly evidence: BlockEvidence;
  /** The trial was charged to the ledger before this result (LRN-AT-12). */
  readonly charged: boolean;
};

export type Verdict = {
  readonly angleId: string;
  readonly pass: boolean;
  /** BH-adjusted p across the family of tests. */
  readonly adjustedP: number;
  readonly failed: readonly string[];
};

/**
 * The strict verdicts of one family of tests: BH at `q` over `m = max(familySize, candidates)` tests
 * (the untested ones count p = 1), then every other condition. Order of `candidates` kept.
 */
export function strictVerdicts(
  candidates: readonly Candidate[],
  familySize: number,
  q: number = BASE_Q,
): Verdict[] {
  if (candidates.length === 0) return [];
  const m = Math.max(familySize, candidates.length);
  const ps = [
    ...candidates.map((c) => c.evidence.p),
    ...new Array<number>(m - candidates.length).fill(1),
  ];
  const bh = benjaminiHochberg(ps, q);
  return candidates.map((c, i) => {
    const e = c.evidence;
    const failed: string[] = [];
    if (!c.charged) failed.push("not_charged");
    if (!e.ready) failed.push("blocks");
    else if (!e.blocksAgree) failed.push("blocks_disagree");
    const s = e.direction === "up" ? (e.t ?? 0) : -(e.t ?? 0);
    if (!(s > T_MIN)) failed.push("t");
    if (!bh.rejected[i]) failed.push("bh");
    if (!e.fourWeeksAgree) failed.push("four_weeks");
    if (!e.regimesOk) failed.push("regime");
    return { angleId: c.angleId, pass: failed.length === 0, adjustedP: bh.adjusted[i]!, failed };
  });
}

/** A probe whose evidence can no longer pass: pointing the wrong way at a block end, or a year done. */
export function probeFutility(e: BlockEvidence): "futile" | "expired" | null {
  if (e.ready && e.t !== null && e.t <= 0) return "futile";
  if (e.blocksDone >= MAX_BLOCKS) return "expired";
  return null;
}

export type BaseChange =
  | {
      readonly kind: "promote";
      readonly angleId: string;
      readonly verdict: Verdict;
      readonly evidence: BlockEvidence;
    }
  | {
      readonly kind: "retire";
      readonly angleId: string;
      readonly verdict: Verdict;
      readonly evidence: BlockEvidence;
    };

/** Whether the family may change its base tonight (at most one change per month of trading days). */
export function changeAllowed(
  current: Pick<BaseVersionRow, "version" | "sinceD">,
  d: string,
  calendar: readonly CalendarRow[],
): boolean {
  if (current.version <= 1) return true;
  return sessionsSince(current.sinceD, d, calendar) >= CHANGE_GAP_SESSIONS;
}

/**
 * The one base change of a family tonight, or null: a retirement first (a broken measure is the
 * risk), the most negative t; else the promotion with the largest t. Ties by angle id.
 */
export function chooseChange(
  promotions: readonly { verdict: Verdict; evidence: BlockEvidence }[],
  retirements: readonly { verdict: Verdict; evidence: BlockEvidence }[],
  baseSize: number,
): BaseChange | null {
  const order = (xs: readonly { verdict: Verdict; evidence: BlockEvidence }[], sign: 1 | -1) =>
    xs
      .filter((x) => x.verdict.pass)
      .sort(
        (a, b) =>
          sign * ((b.evidence.t ?? 0) - (a.evidence.t ?? 0)) ||
          byText(a.verdict.angleId, b.verdict.angleId),
      );
  const retire = baseSize > 1 ? order(retirements, -1)[0] : undefined; // never empty the base
  if (retire !== undefined)
    return {
      kind: "retire",
      angleId: retire.verdict.angleId,
      verdict: retire.verdict,
      evidence: retire.evidence,
    };
  const promote = order(promotions, 1)[0];
  if (promote !== undefined)
    return {
      kind: "promote",
      angleId: promote.verdict.angleId,
      verdict: promote.verdict,
      evidence: promote.evidence,
    };
  return null;
}

/** O-81: a system-written base row (`params_json.system === true`). */
export const isSystemRow = (m: Pick<MapRow, "params">): boolean =>
  (m.params as unknown as Record<string, unknown>).system === true;

/** The fixed rule version a base descends from (`F1.v2-mom+b3` → `F1.v2-mom`). */
export function rootRuleVersion(ruleVersion: string): string {
  return ruleVersion.replace(/\+b\d+$/, "");
}

export const baseRuleVersion = (root: string, version: number): string =>
  `${rootRuleVersion(root)}${BASE_SUFFIX}${version}`;

/** The learner-only keys a system base row never carries over from the map it copies. */
const LEARNER_KEYS = [
  "learner",
  "generation",
  "weights",
  "weights_hash",
  "evidence",
  "window",
  "words",
];

/**
 * The new base version and its system cortex_map row (pure). The row copies the map in force (the
 * fixed rule or the previous system row) and replaces: `angles` = the new base in registry order,
 * `clusters` / `K` = its clusters, `admitted` = base angles whose passport is not active / watch (the
 * rule scores them as active, nothing else does), `system: true`, `base_version`, `based_on` = the
 * root fixed rule, and NO p: `claims_p: false`, `p_hidden: true`, a = b = 0 (p = ½ for every share)
 * with `refit_from` = the first night of the version: a refit may use only outcomes of decisions
 * from then on (never the sealed holdout, never the development years). `fitted_at` = `now`, after
 * the night's cut-off, so the row is used from the next night only (D-924 as-of rule).
 */
export function nextBase(input: {
  readonly current: BaseVersionRow;
  readonly map: MapRow;
  readonly change: BaseChange;
  /** The first night the new version is in force (the session after tonight). */
  readonly sinceD: string;
  readonly now: string;
  readonly angles: readonly AngleDef[];
  readonly status: (id: string) => AngleStatus;
  readonly evidence: Readonly<Record<string, unknown>>;
}): { version: BaseVersionRow; map: MapRow } | null {
  const { current, change } = input;
  const defs = new Map(input.angles.map((a) => [a.id, a] as const));
  const ids = new Set(current.angles);
  if (change.kind === "promote") ids.add(change.angleId);
  else ids.delete(change.angleId);
  const list = input.angles.filter((a) => ids.has(a.id) && a.kind === "score").map((a) => a.id);
  if (list.length === 0 || list.length !== ids.size) return null; // an unknown or non-score id
  const clusters = ANGLE_CLUSTERS.filter((c) =>
    list.some((id) => defs.get(id)!.cluster === c),
  ) as AngleCluster[];
  const admitted = list.filter((id) => {
    const s = input.status(id);
    return s !== "active" && s !== "watch";
  });
  const version = current.version + 1;
  const ruleVersion = baseRuleVersion(current.ruleVersion, version);
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.map.params as unknown as Record<string, unknown>)) {
    if (!LEARNER_KEYS.includes(k)) params[k] = v;
  }
  Object.assign(params, {
    a: 0,
    b: 0,
    K: clusters.length,
    clusters,
    angles: list,
    system: true,
    base_version: version,
    based_on: rootRuleVersion(current.ruleVersion),
    claims_p: false,
    p_hidden: true,
    refit_from: input.sinceD,
  });
  if (admitted.length > 0) params.admitted = admitted;
  else delete params.admitted;
  const set = list.map((id) => {
    const def = defs.get(id)!;
    return { id, version: def.version, cluster: def.cluster as AngleCluster };
  });
  return {
    version: {
      market: current.market,
      family: current.family,
      version,
      sinceD: input.sinceD,
      reason: change.kind,
      ruleVersion,
      angles: list,
      added: change.kind === "promote" ? [change.angleId] : [],
      removed: change.kind === "retire" ? [change.angleId] : [],
      evidence: input.evidence,
      createdAt: input.now,
    },
    map: {
      market: input.map.market,
      family: input.map.family,
      ruleVersion,
      fittedAt: input.now,
      params: params as unknown as MapRow["params"],
      activeSetHash: activeSetHash(set),
      nEff: 0,
      pool: "system",
      fitSplit: "base_change",
    },
  };
}

const MONTHS_PER_BLOCK = 3; // threshold-ok: a 60-trading-day block is about three months

/** The Owner line of a base change (no ids, no ISO dates; LRN-AT-9). */
export function baseChangeWords(x: {
  readonly family: string;
  readonly change: Pick<BaseChange, "kind" | "angleId" | "evidence">;
  readonly count: number;
  readonly sinceD: string;
  readonly tonight: string;
  readonly angles?: readonly AngleDef[];
}): string {
  const name = measureName(x.change.angleId, x.angles);
  const blocks = x.change.evidence.blockMeans.length;
  const months = blocks * MONTHS_PER_BLOCK;
  const n = `${x.count} ${x.count === 1 ? "measure" : "measures"}`;
  const from = dayWords(x.sinceD, x.tonight);
  const span = `each three-month stretch of the last ${months} months`;
  if (x.change.kind === "promote") {
    return `New measure added to the base of ${familyWords(x.family)}: ${name} (the base now has ${n}). It pointed the right way in ${span}, far beyond what luck explains; the Cortex scores with it from ${from} and claims no chance figures for it until enough trades have finished.`;
  }
  return `Measure taken out of the base of ${familyWords(x.family)}: ${name} (the base now has ${n}). It pointed the wrong way in ${span}, far beyond what luck explains; the Cortex stops using it from ${from}.`;
}
