// The learner's map rows (design C.2, C.4, B.4; D-923, D-924, D-928). Pure helpers over `cortex_map`
// rows of a learner rule version (`<family>.learn`, `params_json.learner === true`): generation 0 from
// the fixed rule, the next generation of the weekly run, the checkpoint's capped / rolled-back row and
// the row that lifts an expired cap. Every learned change is a NEW row (append-only), so the refit
// guard holds literally and a replay of night d sees exactly the row in force at d's cut-off.
//
// Instants (the one-session embargo, C.8): a row the nightly job writes on night d is fitted
// `CAP_FIT_OFFSET_MS` after d's decision cut-off, and the weekly row of a week whose last session is
// d `WEEKLY_FIT_OFFSET_MS` after it (later than the same night's checkpoint row): both are first in
// force on the next session, never on d itself. The instants are a function of d alone, so a re-run
// writes the same primary key and is ignored.
import { canonicalJson, sha256Hex } from "@/lib/arena/cohort";
import { weightsHash } from "../score/map";
import { isLearnerRow, mapCutoffOf, type MapParams, type MapRow } from "../store/maps";
import { applyCheckpoint, type CheckpointDecision } from "./checkpoint";
import type { LearnConfig } from "./config";
import { LEARN_CONFIG_SPEC } from "./config";
import type { LearnerWeights } from "./types";

/** The families the learner runs for in v1 (D-887: F1 is the only family with a live rule). */
export const LEARN_FAMILIES = ["F1"] as const;
export const LEARN_SUFFIX_RULE = ".learn";
export const CAP_FIT_OFFSET_MS = 1000; // threshold-ok: one second after the cut-off (nightly rows)
export const WEEKLY_FIT_OFFSET_MS = 2000; // threshold-ok: two seconds after the cut-off (weekly rows)
/** The generation tag suffixes of the nightly rows (design B.4 "generation suffix c"). */
export const CAP_TAG = "c";
export const ROLLBACK_TAG = "r";
export const EXPIRY_TAG = "e";

/** The learner rule version of a family (D-923). */
export const learnerRuleVersion = (family: string): string => `${family}${LEARN_SUFFIX_RULE}`;

/** The instant `offsetMs` after night d's decision cut-off. */
export function embargoFittedAt(d: string, offsetMs: number, cutoffHhmm?: string): string {
  return new Date(Date.parse(mapCutoffOf(d, cutoffHhmm)) + offsetMs).toISOString();
}

/** The extra params a learner row carries beyond the fixed rule's (C.2). */
export type LearnerExtra = {
  learner: true;
  based_on: string;
  generation: number;
  weights: LearnerWeights;
  weights_hash: string;
  /** "17c" (capped), "17r" (rolled back), "17e" (a cap lifted); absent on a weekly generation. */
  generation_tag?: string;
  /** Angle id -> first session the cap no longer applies. */
  caps?: Readonly<Record<string, string>>;
  /** The generation's weights without the caps (the weekly run starts from these). */
  uncapped_weights?: LearnerWeights;
  /** Hash of the C.9 learning keys this generation was fitted under (an Owner edit starts a new one). */
  config_hash?: string;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function weightsFrom(v: unknown): LearnerWeights {
  const nums = (x: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (!isObj(x)) return out;
    for (const [k, w] of Object.entries(x)) if (typeof w === "number") out[k] = w;
    return out;
  };
  return isObj(v) ? { angle: nums(v.angle), cluster: nums(v.cluster) } : { angle: {}, cluster: {} };
}

const paramsOf = (m: MapRow): Record<string, unknown> =>
  m.params as unknown as Record<string, unknown>;

/** The weights a learner row scores with. */
export const learnerWeightsOf = (m: MapRow): LearnerWeights => weightsFrom(paramsOf(m).weights);

/** The generation's weights without its caps (the weekly run's `current`). */
export function baseWeightsOf(m: MapRow): LearnerWeights {
  const u = paramsOf(m).uncapped_weights;
  return u === undefined ? learnerWeightsOf(m) : weightsFrom(u);
}

export const generationOf = (m: MapRow): number => {
  const g = paramsOf(m).generation;
  return typeof g === "number" && Number.isInteger(g) ? g : 0;
};

export const basedOnOf = (m: MapRow): string | null => {
  const b = paramsOf(m).based_on;
  return typeof b === "string" ? b : null;
};

/** The caps in force on a row (angle id -> first session without the cap). */
export function capsOf(m: MapRow): Record<string, string> {
  const c = paramsOf(m).caps;
  const out: Record<string, string> = {};
  if (!isObj(c)) return out;
  for (const [k, v] of Object.entries(c)) if (typeof v === "string") out[k] = v;
  return out;
}

/** Equal weights (1) on every listed angle and cluster: the fixed Cortex's arithmetic. */
export function equalWeights(
  angleIds: readonly string[],
  clusters: readonly string[],
): LearnerWeights {
  return {
    angle: Object.fromEntries([...angleIds].sort().map((id) => [id, 1])),
    cluster: Object.fromEntries([...clusters].sort().map((c) => [c, 1])),
  };
}

/** Hash of the C.9 keys of a config (the "derived" rows are code, not Owner edits). */
export function configHash(config: LearnConfig): string {
  const c9: Record<string, number> = {};
  for (const [k, spec] of Object.entries(LEARN_CONFIG_SPEC)) {
    if (spec.source === "C.9") c9[spec.key] = config[k as keyof LearnConfig];
  }
  return sha256Hex(canonicalJson(c9));
}

const withLearner = (base: MapParams, extra: LearnerExtra & Record<string, unknown>): MapParams => {
  const p: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  for (const k of ["generation_tag", "caps", "uncapped_weights", "window", "evidence", "words"]) {
    delete p[k];
  }
  return { ...p, ...extra } as unknown as MapParams;
};

/**
 * Generation 0 of `<family>.learn` (C.13 step 4): the fixed rule's own map (same Platt, clusters,
 * angle list, plan, cadence and scored-set hash) with equal weights, so its `#learn` shadow rows
 * start at once and differ from the fixed rule only once a weekly finding moves a weight.
 */
export function generationZero(
  fixed: MapRow,
  angleIds: readonly string[],
  o: { readonly fittedAt: string; readonly configHash: string; readonly generation?: number },
): MapRow {
  const weights = equalWeights(angleIds, fixed.params.clusters);
  return {
    ...fixed,
    ruleVersion: learnerRuleVersion(fixed.family),
    fittedAt: o.fittedAt,
    params: withLearner(fixed.params, {
      learner: true,
      based_on: fixed.ruleVersion,
      generation: o.generation ?? 0,
      weights,
      weights_hash: weightsHash(weights),
      config_hash: o.configHash,
    }),
  };
}

/** The next weekly generation (caps dropped: the Friday check supersedes them, B.4). */
export function nextGeneration(
  cur: MapRow,
  weights: LearnerWeights,
  o: {
    readonly fittedAt: string;
    readonly configHash: string;
    readonly window?: unknown;
    readonly evidence?: unknown;
    readonly words?: readonly string[];
  },
): MapRow {
  return {
    ...cur,
    fittedAt: o.fittedAt,
    params: withLearner(cur.params, {
      learner: true,
      based_on: basedOnOf(cur) ?? cur.ruleVersion,
      generation: generationOf(cur) + 1,
      weights,
      weights_hash: weightsHash(weights),
      config_hash: o.configHash,
      ...(o.window === undefined ? {} : { window: o.window }),
      ...(o.evidence === undefined ? {} : { evidence: o.evidence }),
      ...(o.words === undefined ? {} : { words: [...o.words] }),
    }),
  };
}

const sameWeights = (a: LearnerWeights, b: LearnerWeights): boolean =>
  canonicalJson(a) === canonicalJson(b);

/**
 * The nightly row after tonight's checkpoint (B.4): first the caps whose end is on or before the next
 * session are lifted (the angle goes back to its generation weight, never above it), then tonight's
 * `cap` halves and `rollback` lowers. `before` = the base weights of the generation before the undone
 * one (rollback). Null when nothing changes (no row is written). The generation number stays; the
 * tag says what the row is. LRN-AT-8: no weight is ever raised above the generation's own weight.
 */
export function nightlyRow(
  cur: MapRow,
  o: {
    readonly nextSession: string;
    readonly decisions: readonly CheckpointDecision[];
    readonly before?: LearnerWeights;
    readonly fittedAt: string;
  },
): { readonly row: MapRow; readonly lifted: readonly string[] } | null {
  if (!isLearnerRow(cur)) return null;
  const weights = learnerWeightsOf(cur);
  let base = baseWeightsOf(cur);
  const caps = capsOf(cur);
  const lifted = Object.keys(caps)
    .filter((a) => caps[a]! <= o.nextSession)
    .sort();
  const angle: Record<string, number> = { ...weights.angle };
  for (const a of lifted) {
    const b = base.angle[a];
    if (typeof b === "number") angle[a] = b;
    delete caps[a];
  }
  let next: LearnerWeights = { angle, cluster: { ...weights.cluster } };
  const acting = o.decisions.filter((x) => x.kind === "cap" || x.kind === "rollback");
  next = applyCheckpoint(next, acting, o.before);
  const rollbacks = acting.filter((x) => x.kind === "rollback");
  if (rollbacks.length > 0) base = applyCheckpoint(base, rollbacks, o.before);
  for (const x of acting) {
    if (x.kind === "cap" && x.angleId !== null && x.angleId in next.angle) {
      caps[x.angleId] = x.expiresD ?? "9999-12-31";
    }
  }
  if (sameWeights(next, weights) && lifted.length === 0) return null;
  const g = generationOf(cur);
  const tag = rollbacks.length > 0 ? ROLLBACK_TAG : acting.length > 0 ? CAP_TAG : EXPIRY_TAG;
  const capped = Object.keys(caps).length > 0;
  const p = paramsOf(cur);
  return {
    lifted,
    row: {
      ...cur,
      fittedAt: o.fittedAt,
      params: withLearner(cur.params, {
        learner: true,
        based_on: basedOnOf(cur) ?? cur.ruleVersion,
        generation: g,
        weights: next,
        weights_hash: weightsHash(next),
        generation_tag: `${g}${tag}`,
        ...(capped ? { caps, uncapped_weights: base } : {}),
        ...(typeof p.config_hash === "string" ? { config_hash: p.config_hash } : {}),
      }),
    },
  };
}

/** The newest row of `history` with generation < g (any tag): the generation a rollback returns to. */
export function generationBefore(
  history: readonly MapRow[],
  ruleVersion: string,
  g: number,
): MapRow | undefined {
  let out: MapRow | undefined;
  for (const m of history) {
    if (m.ruleVersion !== ruleVersion || generationOf(m) >= g) continue;
    if (out === undefined || m.fittedAt > out.fittedAt) out = m;
  }
  return out;
}

/**
 * The first session the current lineage of a learner rule was in force: the session whose cut-off
 * is the first at or after the fit of its generation 0 with the same `based_on`. Null when unknown.
 */
export function learnerStartD(
  history: readonly MapRow[],
  current: MapRow,
  sessions: readonly string[],
  cutoffHhmm?: string,
): string | null {
  const basedOn = basedOnOf(current);
  let first: MapRow | undefined;
  for (const m of history) {
    if (m.family !== current.family || m.ruleVersion !== current.ruleVersion) continue;
    if (basedOnOf(m) !== basedOn) continue;
    if (first === undefined || m.fittedAt < first.fittedAt) first = m;
  }
  if (first === undefined) return null;
  for (const s of sessions) if (mapCutoffOf(s, cutoffHhmm) >= first.fittedAt) return s;
  return null;
}
