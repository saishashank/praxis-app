// The [VERIFY] money constants and the go-live gate on them (V1-S2, D-710). The brokerage cost
// profiles (ARN-031), the tick table, the slippage buckets (ARN-032) and the minimum parcel
// (ARN-024) shipped with `verified = false`: spec figures marked [VERIFY] that the Owner has not
// approved. Live P/L, leaderboards and VAL-110 results rest on them, so production may not be set
// to `full` while any is unverified (interlock.ts reads `unverifiedMoneyConstants`). This module
// only READS the flags; it never changes a figure. Approval is a code change recorded as a D-nnn
// (flip the flag, and add `cost_profile` rows at the next version per D-070 note 8).
import { COST_PROFILES } from "@/lib/arena/costs";
import { SLIPPAGE_BUCKETS_VERIFIED } from "@/lib/arena/slippage";
import { MIN_MARKETABLE_PARCEL_VERIFIED } from "@/lib/arena/sizing";
import { TICK_TABLE_VERIFIED } from "@/lib/money/tick";

export type MoneyConstant = {
  readonly id: string;
  readonly label: string;
  readonly specRef: string;
  readonly verified: boolean;
};

export function moneyConstants(): readonly MoneyConstant[] {
  return [
    ...Object.values(COST_PROFILES).map((p) => ({
      id: `cost_profile:${p.code}`,
      label: `Brokerage cost profile ${p.code}: ${p.name}`,
      specRef: p.specRef,
      verified: p.verified,
    })),
    {
      id: "tick_table",
      label: "Price tick table",
      specRef: "spec 05 (tick sizes)",
      verified: TICK_TABLE_VERIFIED,
    },
    {
      id: "slippage_buckets",
      label: "Slippage buckets by traded value",
      specRef: "spec 05 ARN-032",
      verified: SLIPPAGE_BUCKETS_VERIFIED,
    },
    {
      id: "min_parcel",
      label: "Minimum marketable parcel (A$500)",
      specRef: "spec 05 ARN-024",
      verified: MIN_MARKETABLE_PARCEL_VERIFIED,
    },
  ];
}

/** Ids of the constants the Owner has not approved yet (empty = `full` is not blocked by them). */
export function unverifiedMoneyConstants(
  list: readonly MoneyConstant[] = moneyConstants(),
): string[] {
  return list.filter((c) => !c.verified).map((c) => c.id);
}
