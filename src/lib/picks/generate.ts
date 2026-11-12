// AGT-113 pick generator: pure and deterministic (no clock, no database, no randomness other than
// a hash of the pick itself, no LLM). From tonight's signals it selects, for every profile of
// `pick_profiles`, up to `picks_per_profile` picks with at most `picks_max_per_family` per family.
//
// Order: validation label first (better-proven families before unproven), then the signal's rank
// score (AGT-110), then code, family and variant so the same inputs always give the same picks.
// Every figure is stored or exact: reference = tonight's close, buy zone = reference + the family's
// slippage allowance (ARN-032), stop = the family's own initial stop as a price, aim = the
// good-case (90th percentile) price, cases = 10th / 50th / 90th percentile of past similar trades,
// time frame = their median holding time, size = the smaller of the profile cap and the risk cap.
import { slippageFill } from "@/lib/arena/slippage";
import { addDays, isTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { divCeil, divFloor, parseRational } from "@/lib/money/rational";
import type { PicksParams } from "@/lib/agents/params";
import { canonicalJson, sha256Hex } from "./canonical";
import type { Pick, PickInput, Tier, UniverseCode } from "./types";

const PPM = 1_000_000n; // threshold-ok: parts per million
const MICRO = 1_000_000n; // threshold-ok: micro-AUD per A$
const PERCENT = 100n; // threshold-ok: percent base
/** UXN-037: the Based-on list shows two to three reasons. */
const BASED_ON_MAX = 3; // threshold-ok: UXN-037 shows 2-3 Based-on reasons
/** D-1000: the volatility bands are thirds of the night's universe. */
const BAND_THIRDS = 3; // threshold-ok: D-1000 risk bands are thirds of the universe by volatility
const LUCK_SALT = "luck";

/** Validation labels, best first (ARN-086). An unknown or missing label sorts as UNVALIDATED. */
export const LABEL_ORDER: readonly string[] = [
  "CONSISTENT-FORWARD",
  "PASSED-BACKTEST",
  "UNVALIDATED",
  "insufficient evidence",
  "possible luck",
  "NOT-DEMONSTRATED",
  "UNVALIDATABLE",
  "FAILED",
];

export function labelRank(label: string): number {
  const i = LABEL_ORDER.indexOf(label);
  return i < 0 ? LABEL_ORDER.indexOf("UNVALIDATED") : i;
}

/** D-1000: the three risk bands. Every stock of a night sits in exactly one. */
export type RiskBand = "aggressive" | "balanced" | "conservative";
export const RISK_BANDS: readonly RiskBand[] = ["aggressive", "balanced", "conservative"];

/** Volatility cut-offs of the night: calm = lowest third (<= low), wild = highest third (> high). */
export type BandCuts = { readonly low: number | null; readonly high: number | null };

/** D-1000: the thirds of the universe's volatility (codes without a volatility are not counted). */
export function bandCuts(universe: readonly UniverseCode[]): BandCuts {
  const vols = universe
    .filter((u) => u.vol !== null)
    .map((u) => u.vol as number)
    .sort((a, b) => a - b);
  if (vols.length === 0) return { low: null, high: null };
  return {
    low: vols[Math.ceil(vols.length / BAND_THIRDS) - 1]!,
    high: vols[Math.ceil((vols.length * 2) / BAND_THIRDS) - 1]!,
  };
}

/**
 * D-1000: the one band of a stock. Aggressive = small companies (U3) or the most volatile third;
 * Conservative = large companies (U1) in the calmest third; Balanced = everything else. A stock
 * with no known volatility is never calm: small ones are Aggressive, the rest Balanced.
 */
export function riskBand(tier: Tier, vol: number | null, cuts: BandCuts): RiskBand {
  if (tier === "U3") return "aggressive";
  if (vol === null || cuts.low === null || cuts.high === null) return "balanced";
  if (vol > cuts.high) return "aggressive";
  if (tier === "U1" && vol <= cuts.low) return "conservative";
  return "balanced";
}

/** True for the three default profile names; other names keep the plain tier filter. */
const isBandProfile = (name: string): name is RiskBand =>
  (RISK_BANDS as readonly string[]).includes(name);

function fraction(text: string): { num: bigint; den: bigint } {
  const [n, d] = text.split("/");
  return { num: BigInt(n!), den: d === undefined ? 1n : BigInt(d) };
}

/** Compare two stored rank scores (`a/b|c/d|unknown`): higher first, unknown last. */
export function compareRankScore(a: string, b: string): number {
  const x = a.split("|");
  const y = b.split("|");
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const p = x[i] ?? "unknown";
    const q = y[i] ?? "unknown";
    if (p === q) continue;
    if (p === "unknown") return 1;
    if (q === "unknown") return -1;
    const l = fraction(p);
    const r = fraction(q);
    const left = l.num * r.den;
    const right = r.num * l.den;
    if (left !== right) return left > right ? -1 : 1;
  }
  return 0;
}

/** The n-th trading session after d (n >= 1). */
export function nthSessionAfter(d: string, n: number, calendar: readonly CalendarRow[]): string {
  let day = d;
  let seen = 0;
  while (seen < n) {
    day = addDays(day, 1);
    if (isTradingDay(day, calendar)) seen += 1;
  }
  return day;
}

export type GenerateContext = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly picks: PicksParams;
  readonly universe: readonly UniverseCode[];
  /** ISO instant stamped on every pick of the night. */
  readonly createdAt: string;
};

const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function cmpTail(a: PickInput, b: PickInput): number {
  return (
    compareRankScore(a.rankScore, b.rankScore) ||
    cmpText(a.code, b.code) ||
    cmpText(a.family, b.family) ||
    cmpText(a.variant, b.variant)
  );
}

/** Typical return per unit of risk: typicalPpm x reference / (reference - stop), as a fraction. */
function perRisk(i: PickInput): { num: bigint; den: bigint } {
  return {
    num: BigInt(i.scenario!.typicalPpm) * i.referenceMicro,
    den: i.referenceMicro - i.stopMicro!,
  };
}

/**
 * D-1001: the order inside a profile, after the validation label. Aggressive: the biggest good case.
 * Balanced: typical return per unit of risk (typical case over the distance to the stop-loss).
 * Conservative: the mildest bad case first (the 10th-percentile outcome of past similar trades, the
 * nearest stored stand-in for "how often similar trades made money"), then the biggest typical case.
 * Ties fall to the stored rank score, then code, family and variant.
 */
export function cmpForProfile(profile: string): (a: PickInput, b: PickInput) => number {
  const label = (a: PickInput, b: PickInput) => labelRank(a.label) - labelRank(b.label);
  if (profile === "aggressive") {
    return (a, b) => label(a, b) || b.scenario!.goodPpm - a.scenario!.goodPpm || cmpTail(a, b);
  }
  if (profile === "balanced") {
    return (a, b) => {
      const x = perRisk(a);
      const y = perRisk(b);
      const l = x.num * y.den;
      const r = y.num * x.den;
      return label(a, b) || (l === r ? 0 : l > r ? -1 : 1) || cmpTail(a, b);
    };
  }
  if (profile === "conservative") {
    return (a, b) =>
      label(a, b) ||
      b.scenario!.badPpm - a.scenario!.badPpm ||
      b.scenario!.typicalPpm - a.scenario!.typicalPpm ||
      cmpTail(a, b);
  }
  return (a, b) => label(a, b) || cmpTail(a, b);
}

/** The band of a pick input: the universe's own tier and volatility when the code is in it. */
type BandLookup = (inp: PickInput) => RiskBand;

function bandLookup(universe: readonly UniverseCode[]): BandLookup {
  const cuts = bandCuts(universe);
  const known = new Map(universe.map((u) => [u.code, u]));
  return (inp) => {
    const u = known.get(inp.code);
    return riskBand(u?.tier ?? inp.tier, u ? u.vol : inp.vol, cuts);
  };
}

function eligible(
  inp: PickInput,
  profile: string,
  tiers: readonly string[],
  bandOf: BandLookup,
): boolean {
  if (!tiers.includes(inp.tier)) return false;
  if (isBandProfile(profile) && bandOf(inp) !== profile) return false; // D-1000: disjoint bands
  if (inp.scenario === null) return false; // the three cases need enough history (scenario_min_n)
  if (inp.stopMicro === null || inp.stopMicro <= 0n || inp.stopMicro >= inp.referenceMicro) {
    return false;
  }
  if (inp.holdMedianSessions === null || inp.holdMedianSessions < 1) return false;
  if (inp.scenario.goodPpm <= 0) return false; // an aim must lie above the reference price
  return true;
}

/** Deterministic index from a hash (the luck-check twin draw). */
export function drawIndex(seed: string, size: number): number {
  const h = BigInt(`0x${sha256Hex(`${seed}|${LUCK_SALT}`)}`);
  return Number(h % BigInt(size));
}

function chooseTwin(
  pickSha: string,
  code: string,
  tiers: readonly string[],
  universe: readonly UniverseCode[],
): string | null {
  const pool = universe
    .filter((u) => tiers.includes(u.tier as Tier) && u.code !== code)
    .map((u) => u.code)
    .sort();
  if (pool.length === 0) return null;
  return pool[drawIndex(pickSha, pool.length)]!;
}

/** The published fields that the pick hash covers (everything but the hash and the stamp). */
export function pickContent(p: Omit<Pick, "pickSha" | "createdAt" | "luckCode">): unknown {
  return {
    market: p.market,
    d: p.d,
    profile: p.profile,
    rank: p.rank,
    code: p.code,
    family: p.family,
    tier: p.tier,
    rule_version: p.ruleVersion,
    signal_id: p.signalId,
    card_id: p.cardId,
    label: p.label,
    reference_micro: p.referenceMicro,
    buy_max_micro: p.buyMaxMicro,
    valid_until_d: p.validUntilD,
    stop_micro: p.stopMicro,
    aim_micro: p.aimMicro,
    aim_reach_ppm: p.aimReachPpm,
    n_similar: p.nSimilar,
    bad_ppm: p.badPpm,
    typical_ppm: p.typicalPpm,
    good_ppm: p.goodPpm,
    time_frame_sessions: p.timeFrameSessions,
    size_micro: p.sizeMicro,
    risk_micro: p.riskMicro,
    factors: p.factors,
    based_on: p.basedOn,
  };
}

function build(
  inp: PickInput,
  profile: string,
  rank: number,
  ctx: GenerateContext,
  caps: { maxPct: string; riskPct: string; amountMicro: bigint },
  tiers: readonly string[],
): Pick | null {
  const sc = inp.scenario!;
  const ref = inp.referenceMicro;
  const stop = inp.stopMicro!;
  const buyMax = slippageFill(ref, "buy", inp.advValueMicro).fillMicro;
  const aimRaw = ref + (ref * BigInt(sc.goodPpm) + PPM / 2n) / PPM; // threshold-ok: half-up rounding
  const perShareRisk = buyMax - stop;
  if (perShareRisk <= 0n || aimRaw <= ref) return null;
  const maxPct = parseRational(caps.maxPct);
  const riskPct = parseRational(caps.riskPct);
  const sizeCap = divFloor(caps.amountMicro * maxPct.num, maxPct.den * PERCENT);
  const riskBudget = divFloor(caps.amountMicro * riskPct.num, riskPct.den * PERCENT);
  const sizeByRisk = divFloor(riskBudget * buyMax, perShareRisk);
  const size = sizeCap < sizeByRisk ? sizeCap : sizeByRisk;
  if (size <= 0n) return null;
  const risk = divCeil(size * perShareRisk, buyMax);
  const base = {
    market: ctx.market,
    d: ctx.d,
    profile,
    rank,
    code: inp.code,
    family: inp.family,
    tier: inp.tier,
    ruleVersion: inp.ruleVersion,
    signalId: inp.signalId,
    cardId: inp.cardId,
    label: inp.label,
    referenceMicro: ref,
    buyMaxMicro: buyMax,
    // D-187: no session window; the stored date is the first session it can be bought, and the
    // pick then stands while its nightly check passes (./validity.ts)
    validUntilD: nthSessionAfter(ctx.d, 1, ctx.calendar),
    stopMicro: stop,
    aimMicro: aimRaw,
    aimReachPpm: inp.aimReachPpm,
    nSimilar: sc.n,
    badPpm: sc.badPpm,
    typicalPpm: sc.typicalPpm,
    goodPpm: sc.goodPpm,
    timeFrameSessions: inp.holdMedianSessions!,
    sizeMicro: size,
    riskMicro: risk,
    factors: inp.factors,
    basedOn: inp.basedOn.slice(0, BASED_ON_MAX),
  };
  const pickSha = sha256Hex(canonicalJson(pickContent(base)));
  return {
    ...base,
    pickSha,
    createdAt: ctx.createdAt,
    luckCode: chooseTwin(pickSha, inp.code, tiers, ctx.universe),
  };
}

/** The highest rank the pick table allows (its CHECK rank BETWEEN 1 AND 10). */
export const PICK_RANK_MAX = 10; // threshold-ok: pick.rank CHECK (migration 0010)

/**
 * D-982: inputs placed after a profile's own picks, in the places they leave free, up to `perProfile`
 * a profile and never beyond PICK_RANK_MAX (the candidate picks: they never displace a strategy or a
 * shortlist pick, whatever their label or rank score).
 */
export type ExtraInputs = { readonly inputs: readonly PickInput[]; readonly perProfile: number };

/**
 * AGT-113 + D-1000: the night's picks for every profile, in profile-name then rank order. A stock
 * belongs to one risk band only, so it appears in one of the three default profiles per night.
 */
export function generatePicks(
  inputs: readonly PickInput[],
  ctx: GenerateContext,
  extras?: ExtraInputs,
): Pick[] {
  const out: Pick[] = [];
  const bandOf = bandLookup(ctx.universe);
  for (const profile of Object.keys(ctx.picks.profiles).sort()) {
    const spec = ctx.picks.profiles[profile]!;
    const amount = ctx.picks.portfolioAmounts[profile];
    if (amount === undefined) continue; // no portfolio amount: nothing to size against
    // only inputs that can ever be picked are sorted (the order reads their scenario)
    const usable = (inp: PickInput) => eligible(inp, profile, spec.tiers, bandOf);
    const cmp = cmpForProfile(profile);
    const sorted = inputs.filter(usable).sort(cmp);
    const extraSorted = (extras?.inputs ?? []).filter(usable).sort(cmp);
    const caps = {
      maxPct: String(spec.maxPctPerPick),
      riskPct: String(spec.riskPctPerPick),
      amountMicro: BigInt(amount) * MICRO,
    };
    const perFamily = new Map<string, number>();
    const seen = new Set<string>();
    let rank = 0;
    for (const inp of sorted) {
      if (rank >= ctx.picks.picksPerProfile) break;
      if (seen.has(inp.code)) continue; // one pick per company per profile
      if ((perFamily.get(inp.family) ?? 0) >= ctx.picks.picksMaxPerFamily) continue;
      const pick = build(inp, profile, rank + 1, ctx, caps, spec.tiers);
      if (pick === null) continue;
      rank += 1;
      seen.add(inp.code);
      perFamily.set(inp.family, (perFamily.get(inp.family) ?? 0) + 1);
      out.push(pick);
    }
    let extra = 0;
    for (const inp of extraSorted) {
      if (extra >= (extras?.perProfile ?? 0) || rank >= PICK_RANK_MAX) break;
      if (seen.has(inp.code)) continue;
      const pick = build(inp, profile, rank + 1, ctx, caps, spec.tiers);
      if (pick === null) continue;
      rank += 1;
      extra += 1;
      seen.add(inp.code);
      out.push(pick);
    }
  }
  return out;
}
