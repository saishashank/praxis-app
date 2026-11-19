// The evaluation of a text label (M23 M3; CXA-008, D-1636, D-1722). Pure and seeded: no database, no clock. The frozen plan is
// `docs/research/prereg/CXA-008.json`; every number below is a transcription of it and a test checks that the two agree. Order
// of work (D-1605): the caller counts the Owner's golden items from the golden table alone and calls this only once that count
// has reached the floor. Within each sign of the announcement-day abnormal return (a stratum), the Spearman rank correlation of
// the label's ordered value with the 20-session market-adjusted outcome; the statistic is the mean over the strata kept (a
// stratum needs 30 announcements). The interval is a one-sided 90 % stationary block bootstrap over announcement sessions
// (block 20, 2000 replicates) with the ranks recomputed in every replicate. The caller adds the agreement test. Aggregates only.
import { percentile } from "@/lib/stats/bootstrap";
import { spearman } from "@/lib/stats/rankIc";
import { scopedPrng, STATS_MASTER_SEED } from "@/lib/stats/rng";
import { stationaryBlockBootstrap } from "@/lib/stats/stationaryBootstrap";
import { DEFAULT_REPLICATES, FAMILY_ALPHA, type EngineVerdict } from "../eventStudy";

/** The repo path of the frozen plan (the registry hash is the sha256 of this file's text). */
export const LABELS_PLAN_PATH = "docs/research/prereg/CXA-008.json";

export const LABEL_KINDS = ["guidance", "event_confirm", "tone"] as const;
export type LabelKind = (typeof LABEL_KINDS)[number];

export const labelLineage = (kind: LabelKind): string => `text_label_${kind}`;

/** Ordered value of a machine label; a value not listed here is left out (none, unclear). */
export const LABEL_VALUE: Readonly<Record<LabelKind, Readonly<Record<string, number>>>> = {
  guidance: { down: -1, same: 0, up: 1 }, // threshold-ok: D-1722 the ordered coding of the plan
  event_confirm: { contradicted: -1, confirmed: 1 }, // threshold-ok: D-1722 the ordered coding of the plan
  tone: { negative: -1, neutral: 0, positive: 1 }, // threshold-ok: D-1722 the ordered coding of the plan
};

export const LABEL_HORIZON = 20; // threshold-ok: D-1722 the outcome horizon of the plan, also the expected block
export const LABEL_STRATUM_FLOOR = 30; // threshold-ok: D-1722 announcements a stratum needs
const MIN_FINITE_NUM = 95; // threshold-ok: a replicate set needs 95 % of its values defined
const MIN_FINITE_DEN = 100; // threshold-ok: the denominator of that share

/** One matured, labelled announcement: its session, the label's value, the outcome and the announcement-day return, in ppm. */
export type LabelObs = {
  readonly session: string;
  readonly label: number;
  readonly outcome: number;
  readonly ar: number;
};

export type LabelResult =
  | { readonly status: "below_sample"; readonly reason: string }
  | {
      readonly status: "looked";
      /** The verdict of the statistic alone (the agreement test is the caller's second condition). */
      readonly verdict: EngineVerdict;
      readonly n: number;
      readonly strata: number;
      readonly sessions: number;
      readonly blocks: number;
      readonly meanIc: number | null;
      readonly lowerIc: number | null;
    };

const round6 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1e6) / 1e6); // threshold-ok: 6 places kept in a stored aggregate

/** Evaluates one label on its matured announcements. Below the stratum floor nothing is computed. */
export function evaluateLabel(
  kind: LabelKind,
  obs: readonly LabelObs[],
  opts: { readonly replicates?: number; readonly masterSeed?: bigint } = {},
): LabelResult {
  const strata = [obs.filter((o) => o.ar > 0), obs.filter((o) => o.ar < 0)].filter(
    (s) => s.length >= LABEL_STRATUM_FLOOR,
  );
  if (strata.length === 0)
    return {
      status: "below_sample",
      reason: "no sign of the abnormal return has enough announcements",
    };
  const rows = strata.flat();
  const stratumOf = strata.flatMap((s, i) => s.map(() => i));
  const dates = [...new Set(rows.map((o) => o.session))].sort();
  const ix = new Map(dates.map((x, i) => [x, i]));
  const statistic = (drawn: Int32Array): number => {
    const x: number[][] = strata.map(() => []);
    const y: number[][] = strata.map(() => []);
    for (let i = 0; i < drawn.length; i += 1) {
      const r = drawn[i]!;
      x[stratumOf[r]!]!.push(rows[r]!.label);
      y[stratumOf[r]!]!.push(rows[r]!.outcome);
    }
    let sum = 0;
    for (let s = 0; s < strata.length; s += 1) {
      const rho = spearman(x[s]!, y[s]!);
      if (rho === null) return Number.NaN;
      sum += rho;
    }
    return sum / strata.length;
  };
  const point = statistic(Int32Array.from(rows.map((_, i) => i)));
  const head = {
    status: "looked" as const,
    n: rows.length,
    strata: strata.length,
    sessions: dates.length,
    blocks: Math.floor(dates.length / LABEL_HORIZON),
  };
  if (!Number.isFinite(point)) {
    return { ...head, verdict: "INCONCLUSIVE", meanIc: null, lowerIc: null };
  }
  const rep = stationaryBlockBootstrap(
    { sessions: rows.map((o) => ix.get(o.session)!), sessionCount: dates.length },
    statistic,
    scopedPrng(`research:label:${kind}:boot`, opts.masterSeed ?? STATS_MASTER_SEED),
    {
      expectedBlock: LABEL_HORIZON,
      maxHold: LABEL_HORIZON,
      replicates: opts.replicates ?? DEFAULT_REPLICATES,
    },
  );
  const finite = Array.from(rep.values).filter((v) => Number.isFinite(v));
  const defined = finite.length * MIN_FINITE_DEN >= rep.values.length * MIN_FINITE_NUM;
  const lower = defined ? percentile(finite, FAMILY_ALPHA) : Number.NaN;
  if (!Number.isFinite(lower))
    return { ...head, verdict: "INCONCLUSIVE", meanIc: round6(point), lowerIc: null };
  return {
    ...head,
    verdict: lower > 0 ? "PASS" : "NULL",
    meanIc: round6(point),
    lowerIc: round6(lower),
  };
}

/** The verdict of a label look: the statistic and the agreement test must both pass; an undefined statistic is INCONCLUSIVE. */
export function labelVerdict(stat: EngineVerdict, agreementClears: boolean): EngineVerdict {
  if (stat === "INCONCLUSIVE") return "INCONCLUSIVE";
  return stat === "PASS" && agreementClears ? "PASS" : "NULL";
}
