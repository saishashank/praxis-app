// Deterministic challenger generator (M6 T9; ARN-065, ARN-085, KB-040; D-110 #20, #21, #47).
// Weekly, development data only, no LLM: for a family, every numeric B key of the incumbent's
// parameter set is moved one grid step up or down within its ch.15 bounds; each candidate is
// evaluated on the development split (NO trial is charged for a development replay); the best
// development mean excess with at least `min_trades` rows and `min_blocks` blocks wins; ties go to
// the key name, then the direction. Keys named by the lineage's L2/L3 lessons are tried first as a
// tier: if one of them qualifies and beats the incumbent, the winner comes from that tier.
//
// The only data the generator can reach is a `DevelopmentView`, an interface whose single method
// returns a development-split summary. It has no method that returns validation or holdout rows
// (module-boundary type, KB-040 "never shown to the agents that propose challengers"), and every
// evaluation is checked at runtime to be tagged `development`.
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import { FAMILY_PARAM_KEYS, paramBounds } from "@/lib/agents/families/ruleSchema";
import type { LearningParams, StatsParams } from "@/lib/agents/params";
import type { Family } from "@/lib/agents/schema";
import { lineageId } from "@/lib/stats/splits";
import {
  challengerSlots,
  createChallenger,
  familyFrozen,
  generatedThisWeek,
  incumbentOf,
  isoWeekBounds,
  lineageTrialBudget,
  type CreateResult,
} from "./challengerLifecycle";

/** What the generator may see of a candidate: a development-split summary, nothing else. */
export type DevelopmentEvaluation = {
  readonly split: "development";
  /** Closed signal-ledger rows of the candidate's replay inside the development split. */
  readonly rows: number;
  /** Independent blocks of those rows. */
  readonly blocks: number;
  /** Mean per-trade excess over matched controls; null without controls. */
  readonly meanExcess: number | null;
  /** Mean net return (P5) of those rows; null without rows (ARN-106/108). */
  readonly meanNet?: number | null;
  /** One-sided 90 % lower bound of the mean net under P5; null when rows or blocks are too few. */
  readonly netLower90?: number | null;
};

export interface DevelopmentView {
  /** Replays the family with `params` on the development split only and summarises it. */
  evaluate(params: Readonly<Record<string, unknown>>, seed: bigint): Promise<DevelopmentEvaluation>;
}

export type ParamHint = { readonly lessonId: string; readonly key: string };

export type Direction = "down" | "up";

export type Candidate = {
  readonly key: string;
  readonly direction: Direction;
  readonly value: number;
  readonly hinted: boolean;
  readonly params: Readonly<Record<string, unknown>>;
};

/** ARN-106: the keys that set a trailing stop; a challenger that changes one must beat the time-stop-only comparator. */
export const TRAIL_KEYS: readonly string[] = [
  "f1_trail_atr",
  "f3_trail_atr",
  "f3_trail_after_pct",
  "f5_trail_atr",
];

const STEP_FRACTION = 0.1; // threshold-ok: decision 20 "10 % of its range" when the registry gives no step
const SIG_DIGITS = 12; // threshold-ok: float noise guard for v +- step
const SEED_BYTES = 8; // threshold-ok: bytes of the digest used as the 64-bit seed

/** Seed of a lineage's weekly generation (same lineage and ISO week -> same seed). */
export function generatorSeed(lineage: string, d: string): bigint {
  const digest = createHash("sha256")
    .update(`generator:${lineage}:${isoWeekBounds(d).start}`)
    .digest();
  return digest.readBigUInt64BE(0) & BigInt("0x" + "ff".repeat(SEED_BYTES));
}

/** The registry has no kind field: an integer key is one whose validator refuses a fractional probe. */
const PROBES = [0.4999, 0.3333] as const; // threshold-ok: fractions of the range used as non-integer probes
async function isIntegerKey(key: string, range: readonly [number, number]): Promise<boolean> {
  const def = CONFIG_KEYS[key as ConfigKey];
  for (const f of PROBES) {
    const err = await def.validate(range[0] + (range[1] - range[0]) * f, async () => undefined);
    if (err !== null) return true;
  }
  return false;
}

/** The grid step of a key: 10 % of its range, at least 1 and whole for an integer key. */
export async function gridStep(key: string): Promise<number | null> {
  const range = paramBounds(key);
  if (range === null) return null;
  const raw = (range[1] - range[0]) * STEP_FRACTION;
  if (await isIntegerKey(key, range)) return Math.max(1, Math.round(raw));
  return raw > 0 ? raw : null;
}

const round = (x: number): number => Number(x.toPrecision(SIG_DIGITS));

/**
 * Every one-step neighbour of the incumbent's parameters inside the bounds, in the fixed order
 * (key name, then direction down before up). A step that would leave the bounds is not offered.
 */
export async function candidateSteps(
  family: Family,
  incumbent: Readonly<Record<string, unknown>>,
  hints: readonly ParamHint[],
): Promise<readonly Candidate[]> {
  const hinted = new Set(hints.map((h) => h.key));
  const out: Candidate[] = [];
  for (const key of [...FAMILY_PARAM_KEYS[family]].sort()) {
    const v = incumbent[key];
    const range = paramBounds(key);
    const step = await gridStep(key);
    if (typeof v !== "number" || range === null || step === null) continue;
    for (const [direction, value] of [
      ["down", round(v - step)],
      ["up", round(v + step)],
    ] as const) {
      if (value < range[0] || value > range[1]) continue;
      out.push({
        key,
        direction,
        value,
        hinted: hinted.has(key),
        params: { ...incumbent, [key]: value },
      });
    }
  }
  return out;
}

export type Evaluated = {
  readonly candidate: Candidate;
  readonly evaluation: DevelopmentEvaluation;
};

function beatsComparator(e: Evaluated, comparatorMeanNet: number | null): boolean {
  if (comparatorMeanNet === null || !TRAIL_KEYS.includes(e.candidate.key)) return true;
  const m = e.evaluation.meanNet;
  return m !== undefined && m !== null && m > comparatorMeanNet;
}

/**
 * The winner: among candidates with at least `min_trades` rows, `min_blocks` blocks and a mean
 * excess that is strictly above the incumbent's (a step that does not improve development is not
 * worth a trial), the hinted tier first, the highest mean excess, ties by key name then direction.
 * ARN-106 (D-222): when `comparatorMeanNet` is given, a candidate that changes a trail key is also
 * dropped unless its development mean net is above the comparator's (the next candidate is tried).
 */
export function pickWinner(
  evaluated: readonly Evaluated[],
  incumbentMean: number | null,
  stats: Pick<StatsParams, "minTrades" | "minBlocks">,
  comparatorMeanNet: number | null = null,
): Candidate | null {
  const floor = incumbentMean ?? Number.NEGATIVE_INFINITY;
  const ok = evaluated.filter(
    (e) =>
      e.evaluation.rows >= stats.minTrades &&
      e.evaluation.blocks >= stats.minBlocks &&
      e.evaluation.meanExcess !== null &&
      e.evaluation.meanExcess > floor &&
      beatsComparator(e, comparatorMeanNet),
  );
  const cmp = (a: Evaluated, b: Evaluated): number =>
    b.evaluation.meanExcess! - a.evaluation.meanExcess! ||
    (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0) ||
    (a.candidate.direction < b.candidate.direction
      ? -1
      : a.candidate.direction > b.candidate.direction
        ? 1
        : 0);
  const tier = ok.filter((e) => e.candidate.hinted);
  const pool = tier.length > 0 ? tier : ok;
  return pool.length === 0 ? null : [...pool].sort(cmp)[0]!.candidate;
}

async function evaluateDevelopment(
  view: DevelopmentView,
  params: Readonly<Record<string, unknown>>,
  seed: bigint,
): Promise<DevelopmentEvaluation> {
  const e = await view.evaluate(params, seed);
  if ((e as { split: string }).split !== "development") {
    throw new Error("the challenger generator may read the development split only");
  }
  return e;
}

export type GenerateInput = {
  readonly market: string;
  readonly family: Family;
  /** Melbourne date of the weekly run. */
  readonly d: string;
  readonly hints: readonly ParamHint[];
  readonly learning: Pick<LearningParams, "maxChallengers" | "challengerGeneratorPerWeek">;
  readonly stats: Pick<StatsParams, "minTrades" | "minBlocks" | "trialBudgetPerLineage">;
  readonly budgetTotal?: number;
  /** ARN-106: development mean net of the family's time-stop-only comparator; null/absent = not applied. */
  readonly comparatorMeanNet?: number | null;
};

export type GenerateResult =
  | {
      readonly status: "proposed" | "exists";
      readonly id: string;
      readonly key: string;
      readonly direction: Direction;
      readonly evaluated: number;
    }
  | { readonly status: "none"; readonly evaluated: number }
  | { readonly status: "blocked"; readonly reason: string; readonly evaluated: 0 }
  | { readonly status: "refused"; readonly reason: string; readonly evaluated: number };

/**
 * One weekly generation for a family: at most `challenger_generator_per_week` per lineage per ISO
 * week, none for a frozen family, a full market, or an exhausted lineage budget. The search is
 * deterministic (same development data and week -> same winner); a repeat run in a week that already
 * generated is `blocked` (weekly_generator_cap) and charges nothing.
 */
export async function generateChallenger(
  db: Client,
  view: DevelopmentView,
  input: GenerateInput,
  actor = "A6",
): Promise<GenerateResult> {
  const { market, family, d } = input;
  const blocked = (reason: string): GenerateResult => ({ status: "blocked", reason, evaluated: 0 });
  if (await familyFrozen(db, market, family)) return blocked("family_frozen");
  if (!(await challengerSlots(db, market, input.learning)).free) return blocked("max_challengers");
  const lb = await lineageTrialBudget(
    db,
    market,
    family,
    input.budgetTotal ?? input.stats.trialBudgetPerLineage,
  );
  if (lb === null) return blocked("no_split");
  if (lb.budget.exhausted) return blocked("budget_exhausted");
  const incumbentId = await incumbentOf(db, market, family);
  if (incumbentId === null) return blocked("no_incumbent");
  if (
    (await generatedThisWeek(db, market, family, d)) >= input.learning.challengerGeneratorPerWeek
  ) {
    return blocked("weekly_generator_cap");
  }

  const rs = await db.execute({
    sql: "SELECT params_json FROM rule_version WHERE id = ?",
    args: [incumbentId],
  });
  const incumbent = JSON.parse(String(rs.rows[0]!.params_json)) as Record<string, unknown>;
  const seed = generatorSeed(lineageId(market, family), d);
  const incumbentEval = await evaluateDevelopment(view, incumbent, seed);
  const steps = await candidateSteps(family, incumbent, input.hints);
  const evaluated: Evaluated[] = [];
  for (const candidate of steps) {
    evaluated.push({
      candidate,
      evaluation: await evaluateDevelopment(view, candidate.params, seed),
    });
  }
  const winner = pickWinner(
    evaluated,
    incumbentEval.meanExcess,
    input.stats,
    input.comparatorMeanNet ?? null,
  );
  if (winner === null) return { status: "none", evaluated: evaluated.length };

  const lessonIds = input.hints.filter((h) => h.key === winner.key).map((h) => h.lessonId);
  const created: CreateResult = await createChallenger(db, {
    market,
    family,
    origin: "generator",
    params: winner.params,
    lessonIds,
    d,
    actor,
    learning: input.learning,
    stats: input.stats,
    ...(input.budgetTotal === undefined ? {} : { budgetTotal: input.budgetTotal }),
    incumbentVersionId: incumbentId,
  });
  if (created.status === "refused") {
    return { status: "refused", reason: created.reason, evaluated: evaluated.length };
  }
  return {
    status: created.status === "created" ? "proposed" : "exists",
    id: created.id,
    key: winner.key,
    direction: winner.direction,
    evaluated: evaluated.length,
  };
}
