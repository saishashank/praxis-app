// V1-S2 / D-710: the [VERIFY] money constants are listed, reported, never changed here, and gate `full`.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { MIN_MARKETABLE_PARCEL_MICRO, MIN_MARKETABLE_PARCEL_VERIFIED } from "@/lib/arena/sizing";
import { SLIPPAGE_BUCKETS, SLIPPAGE_BUCKETS_VERIFIED } from "@/lib/arena/slippage";
import { GO_LIVE_ITEM_IDS, V2_GO_LIVE_STEPS } from "@/lib/golive/checklist";
import { moneyConstants, unverifiedMoneyConstants } from "@/lib/golive/moneyConstants";
import { TICK_TABLE, TICK_TABLE_VERIFIED } from "@/lib/money/tick";

describe("money constants", () => {
  it("lists every cost profile, the tick table, the slippage buckets and the parcel", () => {
    const ids = moneyConstants().map((c) => c.id);
    for (const code of Object.keys(COST_PROFILES)) expect(ids).toContain(`cost_profile:${code}`);
    expect(ids).toEqual(expect.arrayContaining(["tick_table", "slippage_buckets", "min_parcel"]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every one is unverified today (nothing was approved by the Owner)", () => {
    expect(moneyConstants().every((c) => !c.verified)).toBe(true);
    expect(unverifiedMoneyConstants()).toHaveLength(moneyConstants().length);
    expect(TICK_TABLE_VERIFIED).toBe(false);
    expect(SLIPPAGE_BUCKETS_VERIFIED).toBe(false);
    expect(MIN_MARKETABLE_PARCEL_VERIFIED).toBe(false);
  });

  it("the gate never changes a figure: values are exactly the spec's", () => {
    expect(MIN_MARKETABLE_PARCEL_MICRO).toBe(500_000_000n);
    expect(SLIPPAGE_BUCKETS.map((b) => b.fromAdvMicro)).toEqual([
      5_000_000_000_000n,
      1_000_000_000_000n,
      250_000_000_000n,
      100_000_000_000n,
    ]);
    expect(TICK_TABLE.map((b) => b.tickMicro)).toEqual([1_000n, 5_000n, 10_000n]);
  });

  it("an approved list passes; one unapproved entry is named", () => {
    const list = moneyConstants().map((c) => ({ ...c, verified: true }));
    expect(unverifiedMoneyConstants(list)).toEqual([]);
    list[2] = { ...list[2]!, verified: false };
    expect(unverifiedMoneyConstants(list)).toEqual([list[2]!.id]);
  });

  it("the V2 go-live steps carry the Owner's approval, outside the stored V1 sign-off (D-706)", () => {
    expect(GO_LIVE_ITEM_IDS).not.toContain("money_constants");
    expect(V2_GO_LIVE_STEPS.map((s) => s.id)).toContain("v2_money_constants");
  });
});
