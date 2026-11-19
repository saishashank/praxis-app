// Brokerage cost profiles P0 to P5b (spec 05 ARN-031 l.64; M3 design 4.4, decisions 6, 7, 10).
// Profiles are data; `feeFor` evaluates one with exact rationals and a single half-away-from-zero
// rounding to 1 micro-AUD (no cent rounding: P5 at A$25,000.01 = 30_000_012 micro exactly).
// Fees are the same on both sides ("AU profiles each side"); only P2's first-buy rule looks at the
// side. GST: the spec states none, so none is added [VERIFY]. Every profile is unverified
// (verified = 0) until the Owner approves a source; the Arena stays data_only until then.
import { type Micro } from "@/lib/money/micro";
import { HOME_MARKET, type MarketProfile } from "@/lib/market/profileCore.mjs";
import { costProfilesOf } from "@/lib/market/staticProfile.mjs";
import { builtMarkets } from "@/lib/market/seed/index.mjs";
import type { AuCostProfile, AuFeeRule } from "@/lib/market/seed/au/costProfiles.mjs";
import type {
  ComponentItem,
  ComponentsCostProfile,
  ComponentsFeeRule,
} from "@/lib/market/seed/componentsRule.mjs";
import {
  addRat,
  cmpRat,
  divFloor,
  makeRational,
  mulRat,
  parseDecimalParts,
  parseRational,
  ratFromInt,
  type Rational,
} from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { type Side } from "@/lib/money/tick";
import { serializeBuckets, SLIPPAGE_BUCKETS } from "./slippage";

export const COST_PROFILE_CODES = ["P0", "P1", "P2", "P3", "P4", "P5", "P5b", "P6"] as const;
export type CostProfileCode = (typeof COST_PROFILE_CODES)[number];

export type FeeRule =
  | { readonly kind: "flat"; readonly feeMicro: Micro }
  | {
      /** Fee by order value; `upToMicro` is INCLUSIVE ("<= A$1,000.00"), so A$1,000.01 pays more. */
      readonly kind: "tiered";
      readonly tiers: readonly { readonly upToMicro: Micro; readonly feeMicro: Micro }[];
      readonly above: FeeRule;
    }
  | {
      /** rate x whole order value, rounded once; then clamped to [minMicro, maxMicro]. */
      readonly kind: "pct";
      readonly rate: Rational;
      readonly minMicro: Micro;
      readonly maxMicro: Micro | null;
      /** P2: a first buy of a security for the day below this value (exclusive) pays nothing. */
      readonly freeFirstBuyBelowMicro: Micro | null;
    }
  | {
      /** P0: no fee for a code on the zero-fee list, else `otherwise` (P1). List is empty today. */
      readonly kind: "zeroFeeListElse";
      readonly otherwise: FeeRule;
    }
  | {
      /**
       * M20 (D-1102, D-1103): a sum of named charges, each an exact rational, rounded to the currency cent
       * (1 cent = 10_000 micro) half away from zero: once on the TOTAL (`total_half_up_cent`, IN) or on every
       * item before the sum (`per_item_half_up_cent`, US).
       */
      readonly kind: "components";
      readonly round: "total_half_up_cent" | "per_item_half_up_cent";
      readonly items: readonly ComponentRule[];
    };

/** One charge of a `components` rule; every amount is exact (micro as a rational), nothing floats. */
export type ComponentRule = {
  readonly name: string;
  readonly side: "buy" | "sell" | "both";
  readonly basis: "value" | "per_share" | "per_order" | "pct_of";
  readonly of: readonly string[];
  /** value / pct_of: a fraction; per_share / per_order: currency units (so x 1_000_000 for micro). */
  readonly rate: Rational;
  /** Clamp of the item's exact amount, micro (a rational), before rounding. */
  readonly minMicro: Rational | null;
  readonly maxMicro: Rational | null;
};

export type CostProfile = {
  readonly code: CostProfileCode;
  readonly version: number;
  readonly name: string;
  /** Spec reference including the line number in spec/05_paper_trading_arena.md. */
  readonly specRef: string;
  /** Every figure is flagged [VERIFY] in ARN-031 until the Owner approves a source. */
  readonly verify: true;
  readonly verified: boolean;
  readonly rule: FeeRule;
};

export type FeeContext = {
  /** Code of the security (P0 zero-fee list lookup). */
  readonly code?: string;
  /** P0 zero-fee list. Empty until supplied (decision 10). */
  readonly zeroFeeCodes?: ReadonlySet<string>;
  /** P2: true when this buy is the cohort's first buy of this security today. Default false. */
  readonly firstBuyOfSecurityToday?: boolean;
  /** Whole shares of the fill: required by a `components` rule with a `per_share` item (US TAF). */
  readonly quantity?: bigint;
};

/** A seed fee rule (src/lib/market/seed/au/costProfiles.mjs) as an engine rule: a decimal-percent rate text becomes an exact rational. */
function ruleFromSeed(rule: AuFeeRule): FeeRule {
  switch (rule.kind) {
    case "flat":
      return { kind: "flat", feeMicro: rule.feeMicro };
    case "tiered":
      return {
        kind: "tiered",
        tiers: rule.tiers.map((t) => ({ upToMicro: t.upToMicro, feeMicro: t.feeMicro })),
        above: ruleFromSeed(rule.above),
      };
    case "pct":
      return {
        kind: "pct",
        rate: parseRational(rule.rate),
        minMicro: rule.minMicro,
        maxMicro: rule.maxMicro,
        freeFirstBuyBelowMicro: rule.freeFirstBuyBelowMicro,
      };
    case "zeroFeeListElse":
      return { kind: "zeroFeeListElse", otherwise: ruleFromSeed(rule.otherwise) };
  }
}

const MICRO_RAT: Rational = ratFromInt(1_000_000n);

/** Currency units as decimal text -> micro as an exact rational. */
function microOfUnits(text: string): Rational {
  return mulRat(parseRational(text), MICRO_RAT);
}

function componentFromSeed(item: ComponentItem): ComponentRule {
  return {
    name: item.name,
    side: item.side,
    basis: item.basis,
    of: item.of ?? [],
    rate: parseRational(item.rate),
    minMicro: item.min === undefined ? null : microOfUnits(item.min),
    maxMicro: item.max === undefined ? null : microOfUnits(item.max),
  };
}

function componentsFromSeed(rule: ComponentsFeeRule): FeeRule {
  return { kind: "components", round: rule.round, items: rule.items.map(componentFromSeed) };
}

export function profileFromSeed(p: AuCostProfile | ComponentsCostProfile): CostProfile {
  if (p.rule.kind === "components") {
    return {
      code: p.code as CostProfileCode,
      version: p.version,
      name: p.name,
      specRef: p.specRef,
      verify: p.verify,
      verified: p.verified,
      rule: componentsFromSeed(p.rule),
    };
  }
  return {
    code: p.code as CostProfileCode,
    version: p.version,
    name: p.name,
    specRef: p.specRef,
    verify: p.verify,
    verified: p.verified,
    rule: ruleFromSeed(p.rule),
  };
}

/** The cost profiles of a market's seed table (the P-profile codes its `cost_formula` may name), as engine profiles. */
export function costProfilesOfMarket(market: string): Readonly<Record<string, CostProfile>> {
  const hit = PROFILE_CACHE.get(market);
  if (hit !== undefined) return hit;
  const built = Object.fromEntries(
    Object.entries(costProfilesOf(market)).map(([code, p]) => [code, profileFromSeed(p)]),
  );
  PROFILE_CACHE.set(market, built);
  return built;
}
/** Never invalidated: valid only because the seeds are static (a changed rate is a new code version and a new process). */
const PROFILE_CACHE = new Map<string, Readonly<Record<string, CostProfile>>>();

/** The profile a market's `cost_formula` names ("P5" for AU); throws when the market has no table built (M20). */
export function costProfileOfMarket(profile: MarketProfile): CostProfile {
  const code = profile.costFormula;
  const found = code === null ? undefined : costProfilesOfMarket(profile.code)[code];
  if (found === undefined)
    throw new RangeError(`cost formula ${String(code)} of market ${profile.code} not built (M20)`);
  return found;
}

/**
 * ARN-031 (l.64), each side, all [VERIFY]:
 *  P0 zero-fee list else P1 | P1 A$3.00 | P2 first buy < A$1,000 per security per day A$0, else
 *  greater of A$11.00 or 0.10% | P3 (stress) A$6.50 | P4 0.03% min A$3 max A$9.99 |
 *  P5 default: <= 1,000.00 A$5.00; <= 3,000.00 A$10.00; <= 10,000.00 A$19.95; <= 25,000.00 A$29.95;
 *  above 25,000.00 0.12% | P5b <= 1,000.00 A$2.00, above 0.20%.
 * P6 (D-895, O-79d; not in ARN-031): the greater of A$1.00 and 0.03% of the order value, GST
 * included, each side (Webull Australia, CHESS-sponsored; webull.com.au/pricing read 2026-11-08).
 * The Owner asked the costs to follow the cheapest reliable broker, so P6 carries that source and
 * is verified; a fee change there is a new version.
 */
export const COST_PROFILES: Readonly<Record<CostProfileCode, CostProfile>> = costProfilesOfMarket(
  HOME_MARKET,
) as Readonly<Record<CostProfileCode, CostProfile>>;

/**
 * Every cost-profile code of every built market (AU P0..P6, IN-P1, US-P1; M20 IN1, D-1170): what the
 * `cost_profile_default` key may name. AU's list stays first and unchanged.
 */
export function allMarketCostProfileCodes(): readonly string[] {
  const out: string[] = [...COST_PROFILE_CODES];
  for (const m of builtMarkets()) {
    for (const code of Object.keys(costProfilesOfMarket(m)))
      if (!out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * The profile a stored cohort prices with: its own market's table by the code its params carry (AU `P5`, IN `IN-P1`,
 * US `US-P1`; D-1170). Throws for a code the market does not have, never falls back to another market's.
 */
export function cohortCostProfile(p: {
  readonly market: string;
  readonly costProfile: string;
}): CostProfile {
  const found = costProfilesOfMarket(p.market)[p.costProfile];
  if (found === undefined) {
    throw new RangeError(`unknown cost profile ${p.costProfile} for market ${p.market}`);
  }
  return found;
}

/** A profile by code across the built markets (codes are unique: P0..P6, IN-P1, US-P1); for a stored `sleeve_json`. */
export function costProfileByCode(code: string): CostProfile {
  for (const m of builtMarkets()) {
    const found = costProfilesOfMarket(m)[code];
    if (found !== undefined) return found;
  }
  throw new RangeError(`unknown cost profile ${code}`);
}

export function isCostProfileCode(value: unknown): value is CostProfileCode {
  return (COST_PROFILE_CODES as readonly unknown[]).includes(value);
}

export function getCostProfile(code: string): CostProfile {
  if (!isCostProfileCode(code)) throw new RangeError(`unknown cost profile: ${code}`);
  return COST_PROFILES[code];
}

function evaluate(rule: FeeRule, notionalMicro: Micro, side: Side, ctx: FeeContext): Micro {
  switch (rule.kind) {
    case "flat":
      return rule.feeMicro;
    case "tiered": {
      for (const tier of rule.tiers) {
        if (notionalMicro <= tier.upToMicro) return tier.feeMicro;
      }
      return evaluate(rule.above, notionalMicro, side, ctx);
    }
    case "pct": {
      const free = rule.freeFirstBuyBelowMicro;
      if (
        free !== null &&
        side === "buy" &&
        ctx.firstBuyOfSecurityToday === true &&
        notionalMicro < free
      ) {
        return 0n;
      }
      let fee = roundHalfAwayFromZero(mulRat(makeRational(notionalMicro), rule.rate));
      if (fee < rule.minMicro) fee = rule.minMicro;
      if (rule.maxMicro !== null && fee > rule.maxMicro) fee = rule.maxMicro;
      return fee;
    }
    case "zeroFeeListElse": {
      if (ctx.code !== undefined && ctx.zeroFeeCodes?.has(ctx.code) === true) return 0n;
      return evaluate(rule.otherwise, notionalMicro, side, ctx);
    }
    case "components":
      return evaluateComponents(rule, notionalMicro, side, ctx);
  }
}

const CENT_MICRO = 10_000n;
const ONE_CENT: Rational = makeRational(1n, CENT_MICRO);

/** Exact amount (micro, rational) of one item for this fill; 0 when it does not apply to the side. */
function componentAmount(
  item: ComponentRule,
  notionalMicro: Micro,
  side: Side,
  ctx: FeeContext,
  amounts: ReadonlyMap<string, Rational>,
): Rational {
  if (item.side !== "both" && item.side !== side) return ratFromInt(0n);
  let amount: Rational;
  switch (item.basis) {
    case "value":
      amount = mulRat(makeRational(notionalMicro), item.rate);
      break;
    case "per_share": {
      if (ctx.quantity === undefined || ctx.quantity <= 0n) {
        throw new RangeError(`cost item ${item.name} is per share: the quantity is required`);
      }
      amount = mulRat(mulRat(makeRational(ctx.quantity), item.rate), MICRO_RAT);
      break;
    }
    case "per_order":
      amount = mulRat(item.rate, MICRO_RAT);
      break;
    case "pct_of": {
      let base = ratFromInt(0n);
      for (const n of item.of) {
        const a = amounts.get(n);
        if (a === undefined) throw new RangeError(`cost item ${item.name} reads unknown item ${n}`);
        base = addRat(base, a);
      }
      amount = mulRat(base, item.rate);
      break;
    }
  }
  if (item.minMicro !== null && cmpRat(amount, item.minMicro) < 0) amount = item.minMicro;
  if (item.maxMicro !== null && cmpRat(amount, item.maxMicro) > 0) amount = item.maxMicro;
  return amount;
}

/** Round a rational micro amount to a whole cent, half away from zero, back in micro. */
function roundToCentMicro(amount: Rational): Micro {
  return roundHalfAwayFromZero(mulRat(amount, ONE_CENT)) * CENT_MICRO;
}

function evaluateComponents(
  rule: Extract<FeeRule, { kind: "components" }>,
  notionalMicro: Micro,
  side: Side,
  ctx: FeeContext,
): Micro {
  const amounts = new Map<string, Rational>();
  let total = ratFromInt(0n);
  let roundedSum = 0n;
  for (const item of rule.items) {
    const amount = componentAmount(item, notionalMicro, side, ctx, amounts);
    amounts.set(item.name, amount);
    total = addRat(total, amount);
    roundedSum += roundToCentMicro(amount);
  }
  return rule.round === "total_half_up_cent" ? roundToCentMicro(total) : roundedSum;
}

/**
 * Whole shares of an order when only its value and a price are known (M20 US1, D-1154 item 5): floor(value / price),
 * at least 1. A US sell carries per-share items (the FINRA TAF), so every sell and NAV fee site passes this as
 * `FeeContext.quantity` where the quantity itself is not in hand.
 */
export function quantityAt(notionalMicro: Micro, priceMicro: Micro): bigint {
  if (priceMicro <= 0n) throw new RangeError("price must be positive to derive a quantity");
  const q = divFloor(notionalMicro, priceMicro);
  return q < 1n ? 1n : q;
}

/**
 * Brokerage in exact micro-AUD for one fill of `notionalMicro` (quantity x fill price, > 0).
 * Exact rational arithmetic, one half-away-from-zero rounding (decisions 6 and 7).
 */
export function feeFor(
  costProfile: CostProfile,
  notionalMicro: Micro,
  side: Side,
  ctx: FeeContext = {},
): Micro {
  if (typeof notionalMicro !== "bigint" || notionalMicro <= 0n) {
    throw new RangeError("order value must be a positive amount of micro-AUD");
  }
  return evaluate(costProfile.rule, notionalMicro, side, ctx);
}

// ---- cost_profile rows (append-only, versioned; verified = 0 until the Owner approves) ---------

type RuleJson =
  | { kind: "flat"; fee_micro: string }
  | {
      kind: "tiered";
      tiers: { up_to_micro: string; fee_micro: string }[];
      above: RuleJson;
    }
  | {
      kind: "pct";
      rate_num: string;
      rate_den: string;
      min_micro: string;
      max_micro: string | null;
      free_first_buy_below_micro: string | null;
    }
  | { kind: "zeroFeeListElse"; otherwise: RuleJson }
  | {
      kind: "components";
      round: "total_half_up_cent" | "per_item_half_up_cent";
      items: {
        name: string;
        side: "buy" | "sell" | "both";
        basis: "value" | "per_share" | "per_order" | "pct_of";
        of: string[];
        rate_num: string;
        rate_den: string;
        min_micro: { num: string; den: string } | null;
        max_micro: { num: string; den: string } | null;
      }[];
    };

const ratJson = (r: Rational | null) =>
  r === null ? null : { num: r.num.toString(), den: r.den.toString() };

function ruleToJson(rule: FeeRule): RuleJson {
  switch (rule.kind) {
    case "flat":
      return { kind: "flat", fee_micro: rule.feeMicro.toString() };
    case "tiered":
      return {
        kind: "tiered",
        tiers: rule.tiers.map((t) => ({
          up_to_micro: t.upToMicro.toString(),
          fee_micro: t.feeMicro.toString(),
        })),
        above: ruleToJson(rule.above),
      };
    case "pct":
      return {
        kind: "pct",
        rate_num: rule.rate.num.toString(),
        rate_den: rule.rate.den.toString(),
        min_micro: rule.minMicro.toString(),
        max_micro: rule.maxMicro === null ? null : rule.maxMicro.toString(),
        free_first_buy_below_micro:
          rule.freeFirstBuyBelowMicro === null ? null : rule.freeFirstBuyBelowMicro.toString(),
      };
    case "zeroFeeListElse":
      return { kind: "zeroFeeListElse", otherwise: ruleToJson(rule.otherwise) };
    case "components":
      return {
        kind: "components",
        round: rule.round,
        items: rule.items.map((i) => ({
          name: i.name,
          side: i.side,
          basis: i.basis,
          of: [...i.of],
          rate_num: i.rate.num.toString(),
          rate_den: i.rate.den.toString(),
          min_micro: ratJson(i.minMicro),
          max_micro: ratJson(i.maxMicro),
        })),
      };
  }
}

function bigFrom(value: unknown): bigint {
  if (typeof value !== "string") throw new TypeError("expected a decimal integer string");
  const parts = parseDecimalParts(value);
  if (parts.fracDigits !== "") throw new SyntaxError("expected a whole number");
  const magnitude = BigInt(parts.intDigits);
  return parts.negative ? -magnitude : magnitude;
}

function objectFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

function ruleFromJson(json: unknown): FeeRule {
  const o = objectFrom(json);
  switch (o.kind) {
    case "flat":
      return { kind: "flat", feeMicro: bigFrom(o.fee_micro) };
    case "tiered": {
      if (!Array.isArray(o.tiers)) throw new TypeError("tiers must be a list");
      return {
        kind: "tiered",
        tiers: o.tiers.map((t: unknown) => {
          const tier = objectFrom(t);
          return { upToMicro: bigFrom(tier.up_to_micro), feeMicro: bigFrom(tier.fee_micro) };
        }),
        above: ruleFromJson(o.above),
      };
    }
    case "pct": {
      const nullable = (v: unknown): bigint | null => (v === null ? null : bigFrom(v));
      return {
        kind: "pct",
        rate: makeRational(bigFrom(o.rate_num), bigFrom(o.rate_den)),
        minMicro: bigFrom(o.min_micro),
        maxMicro: nullable(o.max_micro),
        freeFirstBuyBelowMicro: nullable(o.free_first_buy_below_micro),
      };
    }
    case "zeroFeeListElse":
      return { kind: "zeroFeeListElse", otherwise: ruleFromJson(o.otherwise) };
    case "components": {
      if (!Array.isArray(o.items)) throw new TypeError("items must be a list");
      const ratOrNull = (v: unknown): Rational | null => {
        if (v === null) return null;
        const r = objectFrom(v);
        return makeRational(bigFrom(r.num), bigFrom(r.den));
      };
      if (o.round !== "total_half_up_cent" && o.round !== "per_item_half_up_cent") {
        throw new TypeError("unknown rounding rule");
      }
      return {
        kind: "components",
        round: o.round,
        items: o.items.map((x: unknown) => {
          const i = objectFrom(x);
          if (!Array.isArray(i.of)) throw new TypeError("of must be a list");
          return {
            name: String(i.name),
            side: i.side as ComponentRule["side"],
            basis: i.basis as ComponentRule["basis"],
            of: i.of.map(String),
            rate: makeRational(bigFrom(i.rate_num), bigFrom(i.rate_den)),
            minMicro: ratOrNull(i.min_micro),
            maxMicro: ratOrNull(i.max_micro),
          };
        }),
      };
    }
    default:
      throw new TypeError("unknown fee rule kind");
  }
}

/** `cost_profile.tiers_json` text for a profile. */
export function serializeProfileRule(costProfile: CostProfile): string {
  return JSON.stringify(ruleToJson(costProfile.rule));
}

/** Rebuild a profile from stored `tiers_json`; throws on any malformed or unknown content. */
export function parseProfileRule(
  code: string,
  version: number,
  tiersJson: string,
  verified: boolean,
): CostProfile {
  const base = getCostProfile(code);
  return { ...base, version, verified, rule: ruleFromJson(JSON.parse(tiersJson)) };
}

export type CostProfileInsert = {
  code: string;
  version: number;
  tiers_json: string;
  slippage_json: string;
  source: string;
  verified: 0 | 1;
  effective_from: string;
};

/**
 * The append-only `cost_profile` row for a profile, `verified = 0` (D-070 note 8: approval is a
 * NEW row at a higher version, never an edit). `effectiveFrom` is an ISO-8601 UTC instant.
 */
export function costProfileRow(costProfile: CostProfile, effectiveFrom: string): CostProfileInsert {
  return {
    code: costProfile.code,
    version: costProfile.version,
    tiers_json: serializeProfileRule(costProfile),
    slippage_json: serializeBuckets(SLIPPAGE_BUCKETS),
    source: costProfile.verified ? costProfile.specRef : `${costProfile.specRef} [VERIFY]`,
    verified: costProfile.verified ? 1 : 0,
    effective_from: effectiveFrom,
  };
}
