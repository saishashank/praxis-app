// Brokerage cost profiles P0 to P5b (spec 05 ARN-031 l.64; M3 design 4.4, decisions 6, 7, 10).
// Profiles are data; `feeFor` evaluates one with exact rationals and a single half-away-from-zero
// rounding to 1 micro-AUD (no cent rounding: P5 at A$25,000.01 = 30_000_012 micro exactly).
// Fees are the same on both sides ("AU profiles each side"); only P2's first-buy rule looks at the
// side. GST: the spec states none, so none is added [VERIFY]. Every profile is unverified
// (verified = 0) until the Owner approves a source; the Arena stays data_only until then.
import { type Micro } from "@/lib/money/micro";
import {
  makeRational,
  mulRat,
  parseDecimalParts,
  parseRational,
  type Rational,
} from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { type Side } from "@/lib/money/tick";
import { serializeBuckets, SLIPPAGE_BUCKETS } from "./slippage";

export const COST_PROFILE_CODES = ["P0", "P1", "P2", "P3", "P4", "P5", "P5b"] as const;
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
};

const AUD = 1_000_000n;
const aud = (dollars: bigint, cents: bigint = 0n): Micro => dollars * AUD + cents * 10_000n;
const flat = (feeMicro: Micro): FeeRule => ({ kind: "flat", feeMicro });
const pct = (
  rate: string,
  minMicro: Micro = 0n,
  maxMicro: Micro | null = null,
  freeFirstBuyBelowMicro: Micro | null = null,
): FeeRule => ({
  kind: "pct",
  rate: parseRational(rate),
  minMicro,
  maxMicro,
  freeFirstBuyBelowMicro,
});

const P1_RULE = flat(aud(3n));
const SPEC = "spec 05 ARN-031 l.64";

function profile(code: CostProfileCode, name: string, rule: FeeRule): CostProfile {
  return { code, version: 1, name, specRef: SPEC, verify: true, verified: false, rule };
}

/**
 * ARN-031 (l.64), each side, all [VERIFY]:
 *  P0 zero-fee list else P1 | P1 A$3.00 | P2 first buy < A$1,000 per security per day A$0, else
 *  greater of A$11.00 or 0.10% | P3 (stress) A$6.50 | P4 0.03% min A$3 max A$9.99 |
 *  P5 default: <= 1,000.00 A$5.00; <= 3,000.00 A$10.00; <= 10,000.00 A$19.95; <= 25,000.00 A$29.95;
 *  above 25,000.00 0.12% | P5b <= 1,000.00 A$2.00, above 0.20%.
 */
export const COST_PROFILES: Readonly<Record<CostProfileCode, CostProfile>> = {
  P0: profile("P0", "Zero-fee list, else P1", { kind: "zeroFeeListElse", otherwise: P1_RULE }),
  P1: profile("P1", "A$3.00 flat", P1_RULE),
  P2: profile(
    "P2",
    "First buy under A$1,000 free, else greater of A$11.00 or 0.10%",
    pct("0.10%", aud(11n), null, aud(1_000n)),
  ),
  P3: profile("P3", "Stress: A$6.50 flat", flat(aud(6n, 50n))),
  P4: profile("P4", "0.03% min A$3 max A$9.99", pct("0.03%", aud(3n), aud(9n, 99n))),
  P5: profile("P5", "Default tiers (A$5 to A$29.95, then 0.12%)", {
    kind: "tiered",
    tiers: [
      { upToMicro: aud(1_000n), feeMicro: aud(5n) },
      { upToMicro: aud(3_000n), feeMicro: aud(10n) },
      { upToMicro: aud(10_000n), feeMicro: aud(19n, 95n) },
      { upToMicro: aud(25_000n), feeMicro: aud(29n, 95n) },
    ],
    above: pct("0.12%"),
  }),
  P5b: profile("P5b", "A$2.00 up to A$1,000, then 0.20%", {
    kind: "tiered",
    tiers: [{ upToMicro: aud(1_000n), feeMicro: aud(2n) }],
    above: pct("0.20%"),
  }),
};

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
  }
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
  | { kind: "zeroFeeListElse"; otherwise: RuleJson };

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
    source: `${costProfile.specRef} [VERIFY]`,
    verified: costProfile.verified ? 1 : 0,
    effective_from: effectiveFrom,
  };
}
