// D-980…D-984 (Owner 2026-11-11: "start picking stocks based on new candidates so that you can validate;
// show me those in the picks, a flag telling it's via a candidate"): CANDIDATE PICKS. Each night, for
// each candidate measure the learning Cortex is trying (an open probe, cortex/learn/baseStage.ts), the
// best-ranked liquid share(s) by that measure's value of the night become pick candidates, published
// through the same pick builder (profiles, sizing, luck twins, tracking, History) AFTER the strategy and
// shortlist picks of each profile, in the places they leave free (generate.ts `extras`), so they never
// displace them.
//
//   measure values  cortex_feature_probe of night d (written by the Cortex stage for the probes open
//                   before d), else the measure's value in cortex_feature_daily (a measure the scored
//                   set also carries); highest value first, ties by code
//   universe        U1/U2, active, not halted (the shortlist's universe); codes a strategy signal or
//                   the shortlist already offers tonight are skipped, so the next share is taken
//   plan            reference = tonight's close; stop 2 x ATR(14) below it, only when that is 3–10 % of
//                   the price (else the next share); aim = twice the stop distance above; at most 20
//                   trading days. No past trades of the measure exist, so the "cases" are the plan
//                   (bad = the stop, typical = 0, good = the aim) with n = 0 and the page says so
//   record          family F1 (the pick table's family check), rule version CAND.v1:<angle id>, variant
//                   C, signal id candidate:<market>:<d>:<angle id>:<code>, label UNVALIDATED
//   limits          picks_candidate_per_measure (default 1) per measure, picks_candidate_max (default 3)
//                   a night in total
// Reads: one universe read, one ordered value read per open measure (LIMIT, no OFFSET) and about 60
// calendar days of bars of the few chosen codes (IN chunks of 200). Nothing after d is read.
import type { Client } from "@libsql/client";
import { priceMicro } from "@/lib/arena/marketData";
import { getConfig } from "@/lib/config/store";
import type { ConfigKey } from "@/lib/config/keys";
import { openProbeAngles } from "@/lib/cortex/learn/baseStore";
import { measureName } from "@/lib/cortex/learn/probes";
import type { CandidateTally } from "@/lib/cortex/learn/top5";
import { addDays } from "@/lib/data/calendar";
import { divFloor } from "@/lib/money/rational";
import type { DayBar } from "./shortlist";
import type { PickInput, Tier } from "./types";

/** Rule version prefix of a candidate pick (the portfolio builder leaves these out; keep it). */
export const CANDIDATE_RULE_PREFIX = "CAND";
export const CANDIDATE_RULE = "CAND.v1";
export const candidateRuleVersion = (angleId: string): string => `${CANDIDATE_RULE}:${angleId}`;
export const isCandidateRule = (ruleVersion: string): boolean =>
  ruleVersion.startsWith(`${CANDIDATE_RULE_PREFIX}.`);
/** The measure (angle id) of a candidate rule version; null for any other pick. */
export const candidateAngle = (ruleVersion: string): string | null =>
  isCandidateRule(ruleVersion) ? ruleVersion.slice(ruleVersion.indexOf(":") + 1) || null : null;

export const DEFAULT_PER_MEASURE = 1; // threshold-ok: D-980 config default (picks_candidate_per_measure), only if the read fails
export const DEFAULT_MAX = 3; // threshold-ok: D-980 config default (picks_candidate_max), only if the read fails
const RANKED = 40; // threshold-ok: best-ranked shares read per measure (the stop rule can pass a few over)
const BAR_DAYS = 60; // threshold-ok: calendar days of bars for ATR(14), the 20-day volatility and traded value
const CHUNK = 200; // threshold-ok: codes per batched read (Turso IN rule)
const ATR_N = 14; // threshold-ok: D-920 rule, ATR(14)
const VOL_N = 20; // threshold-ok: D-920 rule, volatility window
const ADV_N = 20; // threshold-ok: sessions of the traded-value average (slippage)
const STOP_ATR = 2; // threshold-ok: D-920 rule, stop 2 x ATR below the close
const STOP_MIN = 0.03; // threshold-ok: D-920 rule, stop at least 3 % away
const STOP_MAX = 0.1; // threshold-ok: D-920 rule, stop at most 10 % away
const AIM_TIMES_STOP = 2; // threshold-ok: D-981 aim twice the stop distance (no history to set it)
export const CANDIDATE_TIME_LIMIT = 20; // threshold-ok: D-981 at most 20 trading days, as the shortlist evidence
const PPM = 1_000_000; // threshold-ok: parts per million
const TOTAL_RANK_BASE = 1_000_000_000; // threshold-ok: rank score scale below the shortlist's (1e6)
const TIERS: readonly Tier[] = ["U1", "U2"];

const f = (m: bigint): number => Number(m) / PPM; // money-float-ok: indicators only, never a stored price

async function intConfig(db: Client, key: ConfigKey, fallback: number): Promise<number> {
  try {
    const v = await getConfig(db, key);
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export type CandidateCode = {
  readonly code: string;
  readonly tier: Tier;
  readonly bars: readonly DayBar[];
};

export type CandidatePlan = {
  readonly stopMicro: bigint;
  readonly stopPpm: number;
  readonly vol: number | null;
  readonly advMicro: bigint;
};

/** The plan of one share at the close of d (pure); null when the stop rule fails or bars are short. */
export function candidatePlan(c: CandidateCode, d: string): CandidatePlan | null {
  const i = c.bars.findIndex((b) => b.d === d);
  if (i < ATR_N) return null;
  const close = c.bars.map((b) => f(b.closeMicro));
  let tr = 0;
  for (let k = i - ATR_N + 1; k <= i; k += 1) {
    const b = c.bars[k]!;
    const h = f(b.highMicro);
    const l = f(b.lowMicro);
    const pc = close[k - 1]!;
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr = tr / ATR_N;
  const ref = c.bars[i]!.closeMicro;
  const dist = (STOP_ATR * atr) / close[i]!;
  if (!(dist >= STOP_MIN && dist <= STOP_MAX)) return null;
  const stopMicro = ref - BigInt(Math.round(STOP_ATR * atr * PPM)); // money-float-ok: ATR distance rounded to whole micro-dollars
  if (stopMicro <= 0n || stopMicro >= ref) return null;
  let vol: number | null = null;
  if (i >= VOL_N) {
    const lr: number[] = [];
    for (let k = i - VOL_N + 1; k <= i; k += 1) {
      lr.push(close[k - 1]! > 0 && close[k]! > 0 ? Math.log(close[k]! / close[k - 1]!) : 0);
    }
    const m = lr.reduce((a, b) => a + b, 0) / lr.length;
    vol = Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
  }
  const last = c.bars.slice(Math.max(0, i - ADV_N + 1), i + 1);
  let v = 0n;
  for (const b of last) v += b.closeMicro * BigInt(Math.round(b.volume)); // money-float-ok: whole shares
  return {
    stopMicro,
    stopPpm: Number(((ref - stopMicro) * BigInt(PPM)) / ref), // money-float-ok: ppm of exact micro amounts
    vol,
    advMicro: divFloor(v, BigInt(last.length)),
  };
}

export type RankedMeasure = {
  readonly angleId: string;
  /** Codes best first (highest value of the measure tonight). */
  readonly codes: readonly string[];
};

/**
 * Tonight's candidate pick inputs (pure): per measure in id order, the best-ranked shares whose plan
 * passes, `perMeasure` each, `max` in total, a code used once.
 */
export function candidateInputs(
  measures: readonly RankedMeasure[],
  shares: ReadonlyMap<string, CandidateCode>,
  o: {
    readonly market: string;
    readonly d: string;
    readonly perMeasure: number;
    readonly max: number;
    readonly exclude?: ReadonlySet<string>;
    readonly names?: (angleId: string) => string;
  },
): PickInput[] {
  const out: PickInput[] = [];
  const used = new Set<string>();
  for (const m of [...measures].sort((a, b) => (a.angleId < b.angleId ? -1 : 1))) {
    let took = 0;
    for (const code of m.codes) {
      if (out.length >= o.max || took >= o.perMeasure) break;
      if (used.has(code) || (o.exclude?.has(code) ?? false)) continue;
      const share = shares.get(code);
      if (share === undefined || !TIERS.includes(share.tier)) continue;
      const plan = candidatePlan(share, o.d);
      if (plan === null) continue;
      const bar = share.bars.find((b) => b.d === o.d)!;
      const name = (o.names ?? ((id: string) => measureName(id)))(m.angleId);
      const stopPct = (plan.stopPpm / (PPM / 100)).toFixed(1); // threshold-ok: percent with one decimal
      used.add(code);
      took += 1;
      out.push({
        signalId: `candidate:${o.market}:${o.d}:${m.angleId}:${code}`,
        cardId: null,
        family: "F1",
        ruleVersion: candidateRuleVersion(m.angleId),
        variant: "C",
        code,
        tier: share.tier,
        // below the shortlist (whose scores are k/1e6): the candidates only fill free places
        rankScore: `${o.max - out.length + 1}/${TOTAL_RANK_BASE}`,
        label: "UNVALIDATED",
        referenceMicro: bar.closeMicro,
        stopMicro: plan.stopMicro,
        advValueMicro: plan.advMicro,
        vol: plan.vol,
        scenario: {
          n: 0,
          badPpm: -plan.stopPpm,
          typicalPpm: 0,
          goodPpm: AIM_TIMES_STOP * plan.stopPpm,
        },
        aimReachPpm: null,
        holdMedianSessions: CANDIDATE_TIME_LIMIT,
        medianDropPpm: plan.stopPpm,
        factors: [],
        basedOn: [
          `From the candidate measure: ${name} — being tested, not proven.`,
          `Plan: stop-loss ${stopPct}% below (2 x its average daily range), aim twice that distance above, at most ${CANDIDATE_TIME_LIMIT} trading days. No past trades of this measure yet, so there are no chance figures.`,
        ],
      });
    }
  }
  return out;
}

type Db = Pick<Client, "execute">;

/** The best-ranked codes of one measure tonight (probe values, else the scored-set value). */
async function rankedCodes(db: Db, market: string, d: string, angleId: string): Promise<string[]> {
  const probe = await db.execute({
    sql: `SELECT code FROM cortex_feature_probe WHERE market = ? AND d = ? AND angle_id = ?
            AND value IS NOT NULL ORDER BY value DESC, code LIMIT ?`,
    args: [market, d, angleId, RANKED],
  });
  if (probe.rows.length > 0) return probe.rows.map((r) => String(r.code));
  const daily = await db.execute({
    sql: `SELECT code, json_extract(features_json, ?) AS v FROM cortex_feature_daily
          WHERE market = ? AND d = ? AND typeof(json_extract(features_json, ?)) IN ('real', 'integer')
          ORDER BY v DESC, code LIMIT ?`,
    args: [`$."${angleId}"`, market, d, `$."${angleId}"`, RANKED],
  });
  return daily.rows.map((r) => String(r.code));
}

/** The night's candidate pick inputs (database step); [] when no measure is being tried. */
export async function loadCandidateInputs(
  db: Client,
  o: { market: string; d: string; exclude: ReadonlySet<string> },
): Promise<PickInput[]> {
  const perMeasure = await intConfig(db, "picks_candidate_per_measure", DEFAULT_PER_MEASURE);
  const max = await intConfig(db, "picks_candidate_max", DEFAULT_MAX);
  if (perMeasure === 0 || max === 0) return [];
  const angles = await openProbeAngles(db, o.market, o.d);
  if (angles.length === 0) return [];
  const uni = await db.execute({
    sql: `SELECT code, tier FROM universe_snapshot
          WHERE market = ? AND halted = 0 AND status = 'active' AND tier IN ('U1', 'U2')
            AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
          ORDER BY code`,
    args: [o.market, o.market, o.d],
  });
  const tierOf = new Map(uni.rows.map((r) => [String(r.code), String(r.tier) as Tier]));
  const measures: RankedMeasure[] = [];
  for (const angleId of angles) {
    const ranked = (await rankedCodes(db, o.market, o.d, angleId)).filter(
      (c) => tierOf.has(c) && !o.exclude.has(c),
    );
    if (ranked.length > 0) measures.push({ angleId, codes: ranked });
  }
  const codes = [...new Set(measures.flatMap((m) => m.codes))].sort();
  if (codes.length === 0) return [];
  const bars = new Map<string, DayBar[]>();
  for (let i = 0; i < codes.length; i += CHUNK) {
    const part = codes.slice(i, i + CHUNK);
    const r = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
            WHERE market = ? AND code IN (${part.map(() => "?").join(", ")}) AND d >= ? AND d <= ?
            ORDER BY code, d`,
      args: [o.market, ...part, addDays(o.d, -BAR_DAYS), o.d],
    });
    for (const x of r.rows) {
      const b: DayBar = {
        d: String(x.d),
        openMicro: priceMicro(x.o),
        highMicro: priceMicro(x.h),
        lowMicro: priceMicro(x.l),
        closeMicro: priceMicro(x.c),
        volume: Number(x.volume), // money-float-ok: share count
      };
      if (!(b.lowMicro > 0n && b.lowMicro <= b.closeMicro && b.highMicro >= b.closeMicro)) continue;
      const k = String(x.code);
      if (!bars.has(k)) bars.set(k, []);
      bars.get(k)!.push(b);
    }
  }
  const shares = new Map<string, CandidateCode>();
  for (const code of codes) {
    shares.set(code, { code, tier: tierOf.get(code)!, bars: bars.get(code) ?? [] });
  }
  return candidateInputs(measures, shares, {
    market: o.market,
    d: o.d,
    perMeasure,
    max,
    exclude: o.exclude,
  });
}

export type { CandidateTally };

const TALLY_DAYS = 400; // threshold-ok: calendar days of candidate picks counted (a probe runs up to a year)

/**
 * Finished candidate picks per measure up to night d (D-983): one result per published (night,
 * share), whichever profile carried it (the plan is the same in every profile); "made money" = a
 * net result after costs above zero. Read by the picks entry and handed to the learning Cortex as
 * evidence words only.
 */
export async function candidateTally(
  db: Db,
  market: string,
  d: string,
): Promise<Map<string, CandidateTally>> {
  const r = await db.execute({
    sql: `SELECT p.d, p.code, p.rule_version, MAX(o.net_ppm) AS net FROM pick p
          JOIN pick_outcome o ON o.market = p.market AND o.d = p.d AND o.profile = p.profile
            AND o.rank = p.rank AND o.kind = 'pick'
          WHERE p.market = ? AND p.d >= ? AND p.d <= ? AND p.rule_version LIKE ?
            AND o.state = 'closed' AND o.exit_d <= ?
          GROUP BY p.d, p.code, p.rule_version ORDER BY p.d, p.code`,
    args: [market, addDays(d, -TALLY_DAYS), d, `${CANDIDATE_RULE_PREFIX}.%`, d],
  });
  const out = new Map<string, { finished: number; madeMoney: number }>();
  for (const x of r.rows) {
    const angle = candidateAngle(String(x.rule_version));
    if (angle === null) continue;
    const t = out.get(angle) ?? { finished: 0, madeMoney: 0 };
    t.finished += 1;
    if (Number(x.net) > 0) t.madeMoney += 1; // money-float-ok: SQL integer column
    out.set(angle, t);
  }
  return out;
}
