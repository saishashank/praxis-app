// VAL-114 daily rank scores and the KB-081 rank variants (M14, D-232; docs/M14_design.md 2.2).
//
// `rankScores` gives a scalar score for every code of the family's tiers on D where the rank key is
// computable (the keys of rules.ts: F1 relative-strength percentile, F2/F3/F5 event AR or volume
// ratio, F4 minus RSI(2), F6 its first rank key, the number of evidence classes). Entry thresholds are
// NOT applied. Event families score only codes with an eligible event group (right polarity and
// category, no negative member, day 0 inside the family window). The two KB-081 variants live here too:
//   composite3  equal-weight z-scores of 126-session momentum, minus 20-session volatility, and the
//               volume trend (the volume ratio), across the scored codes of the day;
//   vol_scaled  the v1 score divided by the 20-session volatility.
// Both variants apply to F1 and F4 (the families that carry a rank-variant key); other families are v1.
// Pure and deterministic: sorted by code, no clock, no random source.
import type { RANK_VARIANTS } from "@/lib/config/keys";
import type { AgentParams } from "../params";
import { logReturns, microToFloat, stdevFloat } from "../indicators";
import type { Family } from "../schema";
import { F2_CATEGORIES, F3_CATEGORIES } from "./constants";
import { createContext, type EvalContext, type EventGroupFact } from "./context";
import {
  componentsByCode,
  evaluateF1,
  evaluateF2,
  evaluateF3,
  evaluateF4,
  evaluateF5,
  rsiUsable,
} from "./rules";
import type { CodeFacts, FamilyInputs, Tier } from "./types";

export type RankVariant = (typeof RANK_VARIANTS)[number];

export type RankScore = {
  readonly code: string;
  /** Higher = a better rank. A float: the IC is a rank statistic, so exactness is not needed. */
  readonly score: number;
};

const VOL_WINDOW = 20; // threshold-ok: KB-081 volatility window (20 sessions)

const ratNum = (r: { readonly num: bigint; readonly den: bigint }): number =>
  Number(r.num) / Number(r.den);

/** Scored tiers of each family (ARN-010; F5 on U2 only, D-221). */
const FAMILY_TIERS: Readonly<Record<Family, readonly Tier[]>> = {
  F1: ["U1"],
  F2: ["U1", "U2"],
  F3: ["U1", "U2"],
  F4: ["U1"],
  F5: ["U2"],
  F6: ["U1", "U2"],
};

/** 20-session volatility of log returns on adjusted closes; null when there are too few closes. */
function vol20(c: CodeFacts): number | null {
  const n = c.closesAdj.length;
  if (n < VOL_WINDOW + 1) return null;
  const closes = c.closesAdj.slice(n - (VOL_WINDOW + 1)).map(microToFloat);
  return stdevFloat(logReturns(closes), VOL_WINDOW, 1);
}

const hasNegative = (g: EventGroupFact): boolean => g.members.some((m) => m.polarity === -1);

/** Best (highest-scoring) eligible group of a code; ties keep the group nearer D. */
function bestEvent(
  groups: readonly EventGroupFact[],
  eligible: (g: EventGroupFact) => boolean,
  score: (g: EventGroupFact) => number | null,
): number | null {
  let best: number | null = null;
  let bestAgo = 0;
  for (const g of groups) {
    if (!eligible(g)) continue;
    const s = score(g);
    if (s === null || !Number.isFinite(s)) continue;
    if (best === null || s > best || (s === best && g.sessionsAgo < bestAgo)) {
      best = s;
      bestAgo = g.sessionsAgo;
    }
  }
  return best;
}

function v1Scores(
  family: Exclude<Family, "F6">,
  codes: readonly CodeFacts[],
  ctx: EvalContext,
  p: AgentParams,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of codes) {
    const groups = ctx.groupsByCode.get(c.code) ?? [];
    let s: number | null = null;
    switch (family) {
      case "F1": {
        const pct = ctx.returnPercentile.get(c.code) ?? null;
        s = pct === null ? null : ratNum(pct);
        break;
      }
      case "F2":
        s = bestEvent(
          groups,
          (g) =>
            g.sessionsAgo < p.f2.lookbackSessions &&
            g.members.some(
              (m) => m.polarity === 1 && F2_CATEGORIES.some((k) => k === m.category),
            ) &&
            !hasNegative(g),
          (g) => (g.ar === null ? null : ratNum(g.ar)),
        );
        break;
      case "F3":
        s = bestEvent(
          groups,
          (g) =>
            g.sessionsAgo < 1 &&
            g.members.some(
              (m) =>
                m.priceSensitive && m.polarity === 1 && F3_CATEGORIES.some((k) => k === m.category),
            ) &&
            !hasNegative(g),
          (g) => (g.ar === null || g.volRatio === null ? null : ratNum(g.ar) * ratNum(g.volRatio)),
        );
        break;
      case "F4": {
        const rsi2 = c.ind.rsiShort;
        s =
          rsi2 !== null && rsiUsable(rsi2, c.ind.rsiShortWarm, c.closesAdj, p.windows.rsiShort)
            ? -rsi2
            : null;
        break;
      }
      case "F5": {
        const vr = c.ind.volumeRatio;
        s =
          vr === null
            ? null
            : bestEvent(
                groups,
                (g) =>
                  g.sessionsAgo < 1 &&
                  g.members.some((m) => m.priceSensitive && m.polarity === 1) &&
                  !hasNegative(g),
                () => ratNum(vr),
              );
        break;
      }
    }
    if (s !== null && Number.isFinite(s)) out.set(c.code, s);
  }
  return out;
}

/** F6 first rank key: the number of agreeing evidence classes (a)-(d), for every code of U1/U2. */
function f6Scores(codes: readonly CodeFacts[], ctx: EvalContext): Map<string, number> {
  const p = ctx.p;
  const comps = componentsByCode([
    ...evaluateF1(ctx),
    ...evaluateF2(ctx),
    ...evaluateF3(ctx),
    ...evaluateF4(ctx),
    ...evaluateF5(ctx),
  ]);
  const insiderMin = ratNum(p.f6.insiderMin);
  const out = new Map<string, number>();
  for (const c of codes) {
    const own = comps.get(c.code) ?? [];
    const a = own.some((x) => x.family === "F1" || x.family === "F4");
    const b = own.some((x) => x.family === "F2" || x.family === "F3" || x.family === "F5");
    const classC = c.insiderScoreQ !== null && c.insiderScoreQ / 4 >= insiderMin; // threshold-ok: quarter units
    const classD = ctx.inputs.sources.asic === "on" && c.shortDrop === true;
    out.set(c.code, [a, b, classC, classD].filter(Boolean).length);
  }
  return out;
}

function zScores(values: ReadonlyMap<string, number>): Map<string, number> {
  const xs = [...values.values()];
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
  const out = new Map<string, number>();
  for (const [k, v] of values) out.set(k, sd > 0 ? (v - m) / sd : 0);
  return out;
}

/** KB-081 composite3: z(momentum) + z(-volatility) + z(volume trend), over codes with all three. */
function composite3(codes: readonly CodeFacts[]): Map<string, number> {
  const mom = new Map<string, number>();
  const lowVol = new Map<string, number>();
  const volTrend = new Map<string, number>();
  for (const c of codes) {
    const m = c.ind.returnLookback === null ? null : ratNum(c.ind.returnLookback);
    const v = vol20(c);
    const t = c.ind.volumeRatio === null ? null : ratNum(c.ind.volumeRatio);
    if (m === null || v === null || t === null) continue;
    mom.set(c.code, m);
    lowVol.set(c.code, -v);
    volTrend.set(c.code, t);
  }
  if (mom.size === 0) return new Map();
  const zm = zScores(mom);
  const zv = zScores(lowVol);
  const zt = zScores(volTrend);
  const out = new Map<string, number>();
  for (const k of mom.keys()) out.set(k, zm.get(k)! + zv.get(k)! + zt.get(k)!);
  return out;
}

/** Scores for one family on the session of `inputs` (sorted by code). */
export function rankScores(
  family: Family,
  inputs: FamilyInputs,
  params: AgentParams,
  variant: RankVariant = "v1",
): readonly RankScore[] {
  return rankScoresWith(createContext(inputs, params), family, variant);
}

/** As `rankScores` over a context built once for the day (the nightly and weekly callers share it). */
export function rankScoresWith(
  ctx: EvalContext,
  family: Family,
  variant: RankVariant = "v1",
): readonly RankScore[] {
  const params = ctx.p;
  const tiers = FAMILY_TIERS[family];
  const codes = ctx.codes.filter((c) => tiers.includes(c.tier));
  let scores: Map<string, number>;
  if (family === "F6") {
    scores = f6Scores(codes, ctx);
  } else if (variant === "composite3" && (family === "F1" || family === "F4")) {
    scores = composite3(codes);
  } else {
    scores = v1Scores(family, codes, ctx, params);
    if (variant === "vol_scaled" && (family === "F1" || family === "F4")) {
      const byCode = new Map(codes.map((c) => [c.code, c]));
      const scaled = new Map<string, number>();
      for (const [code, s] of scores) {
        const v = vol20(byCode.get(code)!);
        if (v !== null && v > 0) scaled.set(code, s / v);
      }
      scores = scaled;
    }
  }
  return [...scores.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((code) => ({ code, score: scores.get(code)! }));
}
