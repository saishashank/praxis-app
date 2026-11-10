// The 2–3-day review of the learning Cortex (cortex_learning_architecture B.4, C.7 `checkpoint.ts`;
// D-928: checkpoints act only downward and reversibly). Checks, per scored angle, in order — the first
// that fires stops the later ones for that angle:
//
//   1. data break   tonight's PSI of the angle's features > `psiBreak`, or tonight's universe size off its
//                   median by more than `universeBand` → "data, not learning"; nothing else.
//   2. alarm        Page–Hinkley on the angle's daily (horizon-1) IC, alarm level = the `phFaPct`
//                   percentile of the end statistic under the angle's own stationary-block-bootstrap null
//                   (scope `cortex-learn:ph:<market>:<angle>:<d>`), resampled to the observed length from
//                   the window minus its latest `phRecentNights` (a fresh change must not calibrate its own
//                   alarm: a pool holding a large shift inflates the level). A FALL alarm → `rollback` (when a
//                   weekly update in the last `capSessions` raised this angle the most), else `cap` (weight
//                   above its floor: halved until `capSessions` later), else `watch`. A RISE alarm →
//                   `escalate` (a note for the Friday run; a checkpoint never raises a weight).
//   3. form         `formK` of the last `formN` nights below the angle's median → words only.
//
// Then the duel per family: when the learner leads and the "learner worse" e-process on either Δ series
// crosses 1/α_fb (or the Owner kill is on) → `fallback`. A checkpoint never switches TO the learner.
//
// Closed decision list: none | watch | cap | escalate | fallback | rollback. Weekly cap: at most
// `actionsWeekMax` angle actions (watch, cap, rollback) per ISO week counting the week's earlier events;
// the extra ones are recorded as `escalate`. A fallback is protective and family-level and is not
// counted against that cap. `applyCheckpoint` turns decisions into the learner's next weights and can
// only lower a weight (LRN-AT-8). Pure: rows in, decisions out; randomness only from scopedPrng.
import { percentile } from "@/lib/stats/bootstrap";
import { median } from "@/lib/stats/rankIc";
import { belowInt, scopedPrng, uniform01 } from "@/lib/stats/rng";
import { isoWeek } from "@/lib/view/format";
import { duelDeltas, eProcess, leaderDecision } from "./compare";
import type { LearnConfig } from "./config";
import {
  capWords,
  dataBreakWords,
  fallbackWords,
  NOTHING_TO_CHANGE,
  ownerOffWords,
  quietWords,
  riseWords,
  rollbackWords,
  watchWords,
  weeklyLimitWords,
} from "./learnWords";
import type {
  AngleDayRow,
  CompareRow,
  LeaderRow,
  LearnerWeights,
  LearnEvent,
  LearnEventKind,
} from "./types";

export const CHECKPOINT_KINDS = [
  "none",
  "watch",
  "cap",
  "escalate",
  "fallback",
  "rollback",
] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export type CheckpointReason =
  | "nothing"
  | "data_break"
  | "fall_alarm"
  | "rise_alarm"
  | "quiet"
  | "weekly_cap"
  | "duel_behind"
  | "owner_off";

export type CheckpointDecision = {
  readonly kind: CheckpointKind;
  readonly reason: CheckpointReason;
  readonly angleId: string | null;
  readonly family: string | null;
  /** rollback: the generation being undone. */
  readonly generation: number | null;
  /** rollback: the reweight event undone (its d and seq). */
  readonly reversesD: string | null;
  readonly reversesSeq: number | null;
  /** cap: auto-expiry session; fallback: first session the learner may be compared again. */
  readonly expiresD: string | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly words: string;
};

export type CheckpointInputs = {
  readonly market: string;
  /** Tonight. */
  readonly d: string;
  /** Trading sessions in ascending order; must contain `d` (later sessions give the cap expiry date). */
  readonly calendar: readonly string[];
  /** cortex_angle_day rows of the last `nullSessions` nights (horizon 1 is read; rows after d ignored). */
  readonly angleDays120: readonly AngleDayRow[];
  /** The learner's scored set: angle id → plain name. */
  readonly angles: Readonly<Record<string, { readonly name: string }>>;
  /** The learner's weights in force tonight. */
  readonly weights: LearnerWeights;
  /** cortex_learn_event rows of the last 10 sessions (caps in force, recent updates, this week's actions). */
  readonly events10: readonly LearnEvent[];
  readonly compareRows: readonly CompareRow[];
  /** Matured hold-length learner − fixed net per family (fractions, decision order). */
  readonly netDeltas?: Readonly<Record<string, readonly number[]>>;
  readonly leaders: readonly LeaderRow[];
  readonly config: LearnConfig;
};

const PPM = 1_000_000; // threshold-ok: ppm to fraction
const PERCENT = 100; // threshold-ok: percentile to quantile
const EPS = 1e-9; // threshold-ok: float tolerance of the floor comparison
const ANGLE_ACTIONS: ReadonlySet<LearnEventKind> = new Set<LearnEventKind>([
  "watch",
  "cap",
  "rollback",
]);

/**
 * Checkpoint night (B.4): every second trading session counted from the learner's start, postponed by
 * one session when the night is abstain-all (no features) — hence "every 2 or 3 days".
 */
export function isCheckpointNight(input: {
  readonly startD: string;
  readonly d: string;
  readonly calendar: readonly string[];
  readonly abstainTonight: boolean;
  readonly abstainLastNight: boolean;
}): boolean {
  if (input.abstainTonight) return false;
  const s = input.calendar.indexOf(input.startD);
  const t = input.calendar.indexOf(input.d);
  if (s < 0 || t < 0 || t < s) return false;
  const k = t - s;
  if (k % 2 === 0) return true;
  return input.abstainLastNight;
}

/** Page–Hinkley end statistics of `series` (running mean, drift allowance `delta`), both directions. */
export function pageHinkley(
  series: ArrayLike<number>,
  delta: number,
): { readonly fall: number; readonly rise: number } {
  let mean = 0;
  let up = 0;
  let upMin = 0;
  let down = 0;
  let downMin = 0;
  for (let t = 0; t < series.length; t += 1) {
    const x = series[t]!;
    mean += (x - mean) / (t + 1);
    up += x - mean - delta;
    if (up < upMin) upMin = up;
    down += mean - x - delta;
    if (down < downMin) downMin = down;
  }
  return { fall: down - downMin, rise: up - upMin };
}

/**
 * Alarm levels of Page–Hinkley under the series' own null: the `pct` percentile of the end statistics
 * of stationary-block-bootstrap resamples (blocks of mean `block`, ordered as drawn).
 */
export function phNullLevel(
  series: readonly number[],
  opts: {
    readonly delta: number;
    readonly pct: number;
    readonly block: number;
    readonly replicates: number;
    readonly scope: string;
    /** Nights at the end left out of the null pool (a recent change must not calibrate its own alarm). */
    readonly recent?: number;
    /** Smallest pool; below it the whole series is the pool. */
    readonly minPool?: number;
  },
): { readonly fall: number; readonly rise: number } {
  const n = series.length;
  const cut = n - (opts.recent ?? 0);
  const pool = cut >= (opts.minPool ?? 1) && cut > 0 ? series.slice(0, cut) : series;
  const m = pool.length;
  const block = Math.max(1, Math.min(opts.block, m));
  const logQ = block > 1 ? Math.log(1 - 1 / block) : -Infinity;
  const prng = scopedPrng(opts.scope);
  const buf = new Float64Array(n);
  const falls = new Float64Array(opts.replicates);
  const rises = new Float64Array(opts.replicates);
  for (let b = 0; b < opts.replicates; b += 1) {
    // Stationary block bootstrap (Politis–Romano): geometric block lengths with mean `block`, uniform
    // starts, circular wrap, concatenated in draw order to the observed length n.
    let k = 0;
    while (k < n) {
      let len = 1;
      if (block > 1)
        len = 1 + Math.floor(Math.log(Math.max(uniform01(prng), Number.MIN_VALUE)) / logQ);
      let at = belowInt(prng, m);
      for (let o = 0; o < len && k < n; o += 1) {
        buf[k++] = pool[at]!;
        at = at + 1 === m ? 0 : at + 1;
      }
    }
    const ph = pageHinkley(buf, opts.delta);
    falls[b] = ph.fall;
    rises[b] = ph.rise;
  }
  const q = opts.pct / PERCENT;
  return { fall: percentile(falls, q), rise: percentile(rises, q) };
}

const byD = (a: { d: string }, b: { d: string }) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0);

function sessionAfter(calendar: readonly string[], d: string, k: number): string | null {
  const i = calendar.indexOf(d);
  if (i < 0) return null;
  return calendar[i + k] ?? null;
}

function latestLeaders(leaders: readonly LeaderRow[], d: string): Map<string, LeaderRow> {
  const out = new Map<string, LeaderRow>();
  for (const l of [...leaders].sort((a, b) =>
    a.sinceD < b.sinceD ? -1 : a.sinceD > b.sinceD ? 1 : 0,
  )) {
    if (l.sinceD <= d) out.set(l.family, l);
  }
  return out;
}

function decision(
  partial: Partial<CheckpointDecision> & Pick<CheckpointDecision, "kind" | "reason" | "words">,
): CheckpointDecision {
  return {
    angleId: null,
    family: null,
    generation: null,
    reversesD: null,
    reversesSeq: null,
    expiresD: null,
    evidence: {},
    ...partial,
  };
}

/** The B.4 checkpoint; see the header. Decisions are in a fixed order (angle notes by id, then families). */
export function checkpoint(inputs: CheckpointInputs): CheckpointDecision[] {
  const { config, d, market } = inputs;
  const ids = Object.keys(inputs.angles).sort();
  const floor = config.weightFloor;
  const notes: CheckpointDecision[] = [];
  const actions: CheckpointDecision[] = [];
  const priorEvents = inputs.events10.filter((e) => e.d < d);

  for (const id of ids) {
    const name = inputs.angles[id]!.name;
    const rows = inputs.angleDays120
      .filter((r) => r.angleId === id && r.horizon === 1 && r.d <= d)
      .sort(byD)
      .slice(-config.nullSessions);
    const tonight = rows.find((r) => r.d === d);

    // 1. data break
    if (tonight) {
      const psi = tonight.psiPpm === null ? null : tonight.psiPpm / PPM;
      const prior = rows
        .filter((r) => r.d < d)
        .slice(-config.windowSessions)
        .map((r) => r.n);
      const med = prior.length > 0 ? median(prior) : null;
      const universeOff =
        med !== null && med > 0 && Math.abs(tonight.n - med) / med > config.universeBand;
      if ((psi !== null && psi > config.psiBreak) || universeOff) {
        notes.push(
          decision({
            kind: "none",
            reason: "data_break",
            angleId: id,
            evidence: { psi, n: tonight.n, medianN: med },
            words: dataBreakWords(name),
          }),
        );
        continue;
      }
    }

    const series = rows
      .filter((r) => r.ic !== null && Number.isFinite(r.ic))
      .map((r) => r.ic as number);
    if (series.length < config.phMinNights) continue;

    // 2. alarm
    const ph = pageHinkley(series, config.phDelta);
    const level = phNullLevel(series, {
      delta: config.phDelta,
      pct: config.phFaPct,
      block: config.phBlockSessions,
      replicates: config.replicates,
      scope: `cortex-learn:ph:${market}:${id}:${d}`,
      recent: config.phRecentNights,
      minPool: config.phMinNights,
    });
    const evidence = {
      phFall: ph.fall,
      phRise: ph.rise,
      levelFall: level.fall,
      levelRise: level.rise,
      nights: series.length,
    };
    if (ph.fall > level.fall) {
      const capped = priorEvents.some(
        (e) => e.kind === "cap" && e.angleId === id && (e.expiresD === null || e.expiresD > d),
      );
      if (capped) continue;
      const recent = priorEvents
        .filter(
          (e) =>
            e.kind === "reweight" &&
            e.evidence.raisedMost === id &&
            e.generation !== null &&
            (sessionAfter(inputs.calendar, e.d, config.capSessions) ?? "￿") > d,
        )
        .sort(byD);
      const gen = recent[recent.length - 1];
      if (gen) {
        actions.push(
          decision({
            kind: "rollback",
            reason: "fall_alarm",
            angleId: id,
            generation: gen.generation,
            reversesD: gen.d,
            reversesSeq: gen.seq,
            evidence,
            words: rollbackWords(name, gen.d, d),
          }),
        );
      } else if ((inputs.weights.angle[id] ?? 1) > floor + EPS) {
        const until = sessionAfter(inputs.calendar, d, config.capSessions);
        actions.push(
          decision({
            kind: "cap",
            reason: "fall_alarm",
            angleId: id,
            expiresD: until,
            evidence,
            words: capWords(name, config.phFaPct, until, d),
          }),
        );
      } else {
        actions.push(
          decision({
            kind: "watch",
            reason: "fall_alarm",
            angleId: id,
            evidence,
            words: watchWords(name, config.phFaPct),
          }),
        );
      }
      continue;
    }
    if (ph.rise > level.rise) {
      notes.push(
        decision({
          kind: "escalate",
          reason: "rise_alarm",
          angleId: id,
          evidence,
          words: riseWords(name),
        }),
      );
      continue;
    }

    // 3. form
    const last = series.slice(-config.formN);
    const med = median(series)!;
    const below = last.filter((x) => x < med).length;
    if (last.length === config.formN && below >= config.formK) {
      notes.push(
        decision({
          kind: "none",
          reason: "quiet",
          angleId: id,
          evidence: { below, of: config.formN, median: med },
          words: quietWords(name, below, config.formN),
        }),
      );
    }
  }

  // One rollback per generation; then the weekly cap, most protective first.
  const seenGen = new Set<number>();
  const deduped = actions.filter((a) => {
    if (a.kind !== "rollback") return true;
    if (seenGen.has(a.generation!)) return false;
    seenGen.add(a.generation!);
    return true;
  });
  const rank: Record<string, number> = { rollback: 0, cap: 1, watch: 2 };
  deduped.sort(
    (a, b) =>
      rank[a.kind]! - rank[b.kind]! ||
      (a.angleId! < b.angleId! ? -1 : a.angleId! > b.angleId! ? 1 : 0),
  );
  const week = isoWeek(d);
  let used = priorEvents.filter((e) => ANGLE_ACTIONS.has(e.kind) && isoWeek(e.d) === week).length;
  const angleOut: CheckpointDecision[] = [];
  for (const a of deduped) {
    if (used < config.actionsWeekMax) {
      angleOut.push(a);
      used += 1;
    } else {
      angleOut.push(
        decision({
          kind: "escalate",
          reason: "weekly_cap",
          angleId: a.angleId,
          evidence: { ...a.evidence, wanted: a.kind },
          words: weeklyLimitWords(inputs.angles[a.angleId!]?.name),
        }),
      );
    }
  }

  // Duel per family: fallback only.
  const familyOut: CheckpointDecision[] = [];
  const leaders = latestLeaders(inputs.leaders, d);
  for (const family of [...leaders.keys()].sort()) {
    const l = leaders.get(family)!;
    if (l.leader !== "learner") continue;
    const rows = inputs.compareRows.filter((r) => r.family === family && r.decisionD <= d);
    const d20 = duelDeltas(rows, 20); // threshold-ok: the 20-session leg
    const net = inputs.netDeltas?.[family] ?? [];
    const worse20 = eProcess(d20, "worse", config.duelTau);
    const worseNet = eProcess(net, "worse", config.duelTau);
    const eWorse = Math.max(worse20.e, worseNet.e);
    const call = leaderDecision({
      leader: "learner",
      eLearnerBetter: 1,
      eLearnerWorse: eWorse,
      disagreeNights: d20.length,
      regimeOk: true,
      sinceLastChange: null,
      config,
    });
    if (call !== "fallback") continue;
    const again = sessionAfter(inputs.calendar, d, config.cooldownSessions);
    const off = config.learnerOff === 1;
    familyOut.push(
      decision({
        kind: "fallback",
        reason: off ? "owner_off" : "duel_behind",
        family,
        expiresD: again,
        evidence: { eWorse20: worse20.e, eWorseNet: worseNet.e, n20: worse20.n, nNet: worseNet.n },
        words: off ? ownerOffWords(family) : fallbackWords(family, eWorse, again, d),
      }),
    );
  }

  const out = [...notes, ...angleOut].sort((a, b) =>
    a.angleId! < b.angleId! ? -1 : a.angleId! > b.angleId! ? 1 : 0,
  );
  out.push(...familyOut);
  if (out.length === 0)
    out.push(decision({ kind: "none", reason: "nothing", words: NOTHING_TO_CHANGE }));
  return out;
}

const EVENT_KIND: Record<CheckpointKind, LearnEventKind> = {
  none: "checkpoint",
  watch: "watch",
  cap: "cap",
  escalate: "escalate",
  fallback: "fallback",
  rollback: "rollback",
};

/** The checkpoint's decisions as cortex_learn_event rows, `seq` from `startSeq` in decision order. */
export function checkpointEvents(
  market: string,
  d: string,
  decisions: readonly CheckpointDecision[],
  startSeq: number,
): LearnEvent[] {
  return decisions.map((x, i) => ({
    market,
    d,
    seq: startSeq + i,
    kind: EVENT_KIND[x.kind],
    family: x.family,
    angleId: x.angleId,
    generation: x.generation,
    evidence: {
      reason: x.reason,
      ...x.evidence,
      ...(x.reversesD !== null ? { reverses: `${x.reversesD}:${x.reversesSeq}` } : {}),
    },
    words: x.words,
    reversesSeq: x.reversesSeq,
    expiresD: x.kind === "cap" ? x.expiresD : null,
  }));
}

/**
 * The learner's weights after a checkpoint: `cap` halves the angle's weight; `rollback` takes, angle
 * by angle and cluster by cluster, the lower of tonight's weight and the weight before the undone
 * update (`before`), so undoing an update never raises anything. Every other kind changes nothing.
 * Keys are never added or removed (the scored set is untouched).
 */
export function applyCheckpoint(
  weights: LearnerWeights,
  decisions: readonly CheckpointDecision[],
  before?: LearnerWeights,
): LearnerWeights {
  const angle: Record<string, number> = { ...weights.angle };
  const cluster: Record<string, number> = { ...weights.cluster };
  for (const x of decisions) {
    if (x.kind === "cap" && x.angleId !== null && x.angleId in angle) {
      angle[x.angleId] = angle[x.angleId]! / 2;
    } else if (x.kind === "rollback" && before) {
      for (const k of Object.keys(angle)) {
        const b = before.angle[k];
        if (typeof b === "number" && b < angle[k]!) angle[k] = b;
      }
      for (const k of Object.keys(cluster)) {
        const b = before.cluster[k];
        if (typeof b === "number" && b < cluster[k]!) cluster[k] = b;
      }
    }
  }
  return { angle, cluster };
}
