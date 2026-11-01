// The [VERIFY] money constants and the go-live gate on them (V1-S2, D-710). The brokerage cost
// profiles (ARN-031), the tick table, the slippage buckets (ARN-032) and the minimum parcel
// (ARN-024) shipped with `verified = false`: spec figures marked [VERIFY] that the Owner has not
// approved. Live P/L, leaderboards and VAL-110 results rest on them, so production may not be set
// to `full` while any is unverified (interlock.ts reads `unverifiedMoneyConstants`). This module
// only READS the flags; it never changes a figure. Approval is a code change recorded as a D-nnn
// (flip the flag, and add `cost_profile` rows at the next version per D-070 note 8).
import { createHash } from "node:crypto";
import { COST_PROFILES } from "@/lib/arena/costs";
import { SLIPPAGE_BUCKETS, SLIPPAGE_BUCKETS_VERIFIED } from "@/lib/arena/slippage";
import { MIN_MARKETABLE_PARCEL_MICRO, MIN_MARKETABLE_PARCEL_VERIFIED } from "@/lib/arena/sizing";
import { TICK_TABLE, TICK_TABLE_VERIFIED } from "@/lib/money/tick";

export type MoneyConstant = {
  readonly id: string;
  readonly label: string;
  readonly specRef: string;
  readonly verified: boolean;
  /** The figure itself (R3-I2): hashed into the Owner's attestation, so a changed value is not covered. */
  readonly value: unknown;
};

/** Canonical JSON: object keys sorted, bigint written as "<n>n", so equal values give equal text. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === "bigint") return `${x.toString()}n`;
    if (Array.isArray(x)) return x.map(norm);
    if (x !== null && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x as object)
          .sort()
          .map((k) => [k, norm((x as Record<string, unknown>)[k])]),
      );
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** sha256 (hex) of the canonical JSON of a figure's value (R3-I2, D-817). */
export function moneyValueHash(c: Pick<MoneyConstant, "value">): string {
  return createHash("sha256").update(canonicalJson(c.value)).digest("hex");
}

/** id -> value hash for every figure currently in code. */
export function moneyValueHashes(
  list: readonly MoneyConstant[] = moneyConstants(),
): Record<string, string> {
  return Object.fromEntries(list.map((c) => [c.id, moneyValueHash(c)]));
}

export function moneyConstants(): readonly MoneyConstant[] {
  return [
    ...Object.values(COST_PROFILES).map((p) => {
      const { verified: _verified, ...figure } = p; // the flag is not part of the figure
      void _verified;
      return {
        id: `cost_profile:${p.code}`,
        label: `Brokerage cost profile ${p.code}: ${p.name}`,
        specRef: p.specRef,
        verified: p.verified,
        value: figure,
      };
    }),
    {
      id: "tick_table",
      label: "Price tick table",
      specRef: "spec 05 (tick sizes)",
      verified: TICK_TABLE_VERIFIED,
      value: TICK_TABLE,
    },
    {
      id: "slippage_buckets",
      label: "Slippage buckets by traded value",
      specRef: "spec 05 ARN-032",
      verified: SLIPPAGE_BUCKETS_VERIFIED,
      value: SLIPPAGE_BUCKETS,
    },
    {
      id: "min_parcel",
      label: "Minimum marketable parcel (A$500)",
      specRef: "spec 05 ARN-024",
      verified: MIN_MARKETABLE_PARCEL_VERIFIED,
      value: MIN_MARKETABLE_PARCEL_MICRO,
    },
  ];
}

/** Ids of the constants the Owner has not approved yet (empty = `full` is not blocked by them). */
export function unverifiedMoneyConstants(
  list: readonly MoneyConstant[] = moneyConstants(),
): string[] {
  return list.filter((c) => !c.verified).map((c) => c.id);
}
