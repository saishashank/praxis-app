// The nightly duel's pure glue (design C.5; D-927): from stored rows to compare.ts's inputs and back.
//
//   duelPicks       the top pick of each real book on a decision night, for the fixed rule and the
//                   learner (rows are classified by their stored rule version, so the roles hold when
//                   the learner leads and the fixed rule runs as `#fixed`); a side with no taken row
//                   abstained (null). The top pick is the best rank key (the night's own order), ties
//                   by code.
//   forwardReturns  next-day and 20-session raw-close returns from a decision night, from the daily
//                   loop's bars (the World); the 20-session leg ends on `end20` (the night before d, as
//                   the scorecard's 20-session rows), so a decision of d-21 matures on night d.
//   netDeltas       matured hold-length learner - fixed net per trade (fractions of the money put in),
//                   paired by decision night and book, disagreement nights only.
//   duelStatus      the e-processes of both series, the primary one by D-927 (Δ_net unless the rule
//                   holds 20 sessions or fewer) and the leader evaluation (compare.ts leaderDecision).
// Pure: rows in, numbers out.
import { baseBookId } from "../night";
import { duelDeltas, eProcess, forwardKey, leaderDecision, regimeOk } from "./compare";
import type { DuelPick, ForwardReturns, LeaderDecision } from "./compare";
import type { LearnConfig } from "./config";
import type { CompareRow, DuelDecisionRow, DuelOutcomeRow, Leader } from "./types";

const PPM = 1_000_000; // threshold-ok: fraction to ppm
const H20 = 20; // threshold-ok: the 20-session leg (C.6)

/** Lexicographic descending comparison of two stored rank keys (JSON number arrays). */
function rankCmp(a: string | null, b: string | null): number {
  const parse = (s: string | null): number[] => {
    if (s === null) return [];
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v.map((x) => (typeof x === "number" ? x : -Infinity)) : [];
    } catch {
      return [];
    }
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const p = x[i] ?? -Infinity;
    const q = y[i] ?? -Infinity;
    if (p !== q) return p > q ? -1 : 1;
  }
  return 0;
}

const better = (r: DuelDecisionRow, best: DuelDecisionRow | undefined): boolean => {
  if (best === undefined) return true;
  const c = rankCmp(r.rankKey, best.rankKey);
  return c < 0 || (c === 0 && r.code < best.code);
};

/** The paired top picks of one decision night (see the header); sorted by (family, book). */
export function duelPicks(input: {
  readonly decisionD: string;
  readonly rows: readonly DuelDecisionRow[];
  /** family -> the learner rule version and the generation in force on the decision night. */
  readonly learners: ReadonlyMap<
    string,
    { readonly ruleVersion: string; readonly generation: number }
  >;
  readonly regime: string;
}): DuelPick[] {
  type Side = { fixed?: DuelDecisionRow; learner?: DuelDecisionRow; fixedRv?: string };
  const by = new Map<string, Side>();
  for (const r of input.rows) {
    const l = input.learners.get(r.family);
    if (l === undefined || r.d !== input.decisionD) continue;
    const key = `${r.family}\u0000${baseBookId(r.bookId)}`;
    const s = by.get(key) ?? {};
    if (r.ruleVersion === l.ruleVersion) {
      if (better(r, s.learner)) s.learner = r;
    } else if (better(r, s.fixed)) {
      s.fixed = r;
      s.fixedRv = r.ruleVersion ?? `${r.family}.v1`;
    }
    by.set(key, s);
  }
  const out: DuelPick[] = [];
  for (const key of [...by.keys()].sort()) {
    const [family, bookId] = key.split("\u0000") as [string, string];
    const s = by.get(key)!;
    const l = input.learners.get(family)!;
    out.push({
      decisionD: input.decisionD,
      family,
      bookId,
      fixedRuleVersion: s.fixedRv ?? "none",
      learnerRuleVersion: l.ruleVersion,
      learnerGeneration: l.generation,
      fixedCode: s.fixed?.code ?? null,
      learnerCode: s.learner?.code ?? null,
      regime: input.regime,
    });
  }
  return out;
}

/** Raw-close returns of `codes` from `decisionD` (see the header); keyed by `forwardKey`. */
export function forwardReturns(input: {
  readonly codes: readonly string[];
  readonly decisionD: string;
  readonly end20: string;
  readonly bars: ReadonlyMap<string, readonly { readonly d: string; readonly c: number }[]>;
}): Map<string, ForwardReturns> {
  const out = new Map<string, ForwardReturns>();
  for (const code of [...new Set(input.codes)].sort()) {
    const list = input.bars.get(code) ?? [];
    const i = list.findIndex((b) => b.d === input.decisionD);
    if (i < 0 || !(list[i]!.c > 0)) continue;
    const c0 = list[i]!.c;
    const next = list[i + 1];
    const end = list.find((b) => b.d === input.end20);
    out.set(forwardKey(code, input.decisionD), {
      ret1Ppm: next === undefined ? null : Math.round((next.c / c0 - 1) * PPM),
      ret20Ppm: end === undefined ? null : Math.round((end.c / c0 - 1) * PPM),
    });
  }
  return out;
}

/**
 * Matured learner - fixed net per trade (fractions), paired by (decision night, real book), only on
 * nights the two sides held different codes; a side's figure is the mean net / (fill x qty) of its
 * matured trades. Decision order. Also the number of paired nights (agreeing ones included).
 */
export function netDeltas(
  rows: readonly DuelOutcomeRow[],
  learnerRuleVersion: string,
): { readonly deltas: number[]; readonly paired: number } {
  type Acc = { l: number[]; f: number[]; lc: string[]; fc: string[] };
  const by = new Map<string, Acc>();
  for (const r of rows) {
    if (!(r.fillMicro > 0) || !(r.qty > 0)) continue;
    const key = `${r.d}\u0000${baseBookId(r.bookId)}`;
    const a = by.get(key) ?? { l: [], f: [], lc: [], fc: [] };
    const ret = r.netMicro / (r.fillMicro * r.qty);
    if (r.ruleVersion === learnerRuleVersion) {
      a.l.push(ret);
      a.lc.push(r.code);
    } else {
      a.f.push(ret);
      a.fc.push(r.code);
    }
    by.set(key, a);
  }
  const mean = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const deltas: number[] = [];
  let paired = 0;
  for (const key of [...by.keys()].sort()) {
    const a = by.get(key)!;
    if (a.l.length === 0 || a.f.length === 0) continue;
    paired += 1;
    if ([...a.lc].sort().join() === [...a.fc].sort().join()) continue;
    deltas.push(mean(a.l) - mean(a.f));
  }
  return { deltas, paired };
}

export type DuelStatus = {
  /** Comparison rows (book-nights) and how many chose the same share. */
  readonly nights: number;
  readonly agree: number;
  /** Disagreement nights of the four-week series and its mean learner - fixed (fraction). */
  readonly differ20: number;
  readonly mean20: number;
  readonly eBetter20: number;
  readonly eWorse20: number;
  /** Matured hold-length disagreement results and their e-values. */
  readonly matured: number;
  readonly eBetterNet: number;
  readonly eWorseNet: number;
  /** D-927: which series a switch binds on. */
  readonly primary: "net" | "four_weeks";
  readonly regimeOk: boolean;
};

/** The duel's numbers for one family (see the header). */
export function duelStatus(input: {
  readonly compareRows: readonly CompareRow[];
  readonly net: readonly number[];
  /** The learner rule's hold in sessions (null = the family plan, longer than four weeks). */
  readonly hold: number | null;
  readonly config: LearnConfig;
}): DuelStatus {
  const { config } = input;
  const d20 = duelDeltas(input.compareRows, H20);
  const b20 = eProcess(d20, "better", config.duelTau);
  const w20 = eProcess(d20, "worse", config.duelTau);
  const bn = eProcess(input.net, "better", config.duelTau);
  const wn = eProcess(input.net, "worse", config.duelTau);
  const primary = input.hold !== null && input.hold <= H20 ? "four_weeks" : "net";
  return {
    nights: input.compareRows.length,
    agree: input.compareRows.filter((r) => r.agree === 1).length,
    differ20: d20.length,
    mean20: b20.mean,
    eBetter20: b20.e,
    eWorse20: w20.e,
    matured: input.net.length,
    eBetterNet: bn.e,
    eWorseNet: wn.e,
    primary,
    regimeOk: regimeOk(input.compareRows, config.regimeMinNights, H20),
  };
}

/** The nightly evaluator's call (C.5): switch only when compare.ts allows it; the kill forces fixed. */
export function evaluateLeader(input: {
  readonly status: DuelStatus;
  readonly leader: Leader;
  readonly sinceLastChange: number | null;
  readonly config: LearnConfig;
}): LeaderDecision {
  const s = input.status;
  const net = s.primary === "net";
  return leaderDecision({
    leader: input.leader,
    eLearnerBetter: net ? s.eBetterNet : s.eBetter20,
    eLearnerWorse: Math.max(s.eWorse20, s.eWorseNet),
    disagreeNights: net ? s.matured : s.differ20,
    regimeOk: s.regimeOk,
    sinceLastChange: input.sinceLastChange,
    config: input.config,
  });
}
