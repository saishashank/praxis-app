// @vitest-environment node
// FAM-007 (D-219): the ex-date stop. Expected values are hand-computed in micro-AUD.
// Common setup as tests/arena/fills.test.ts: P5, ADV A$5M (10 bps bucket), tick A$0.01 from A$2.00.
import { describe, expect, it } from "vitest";
import { COST_PROFILES } from "@/lib/arena/costs";
import { exDividendOn, toExDividendActions, type ExDividendAction } from "@/lib/arena/exDividend";
import { fillIntradayStop, type Bar, type FillEnv } from "@/lib/arena/fills";

const bar = (open: bigint, low: bigint): Bar => ({
  openMicro: open,
  highMicro: open,
  lowMicro: low,
  closeMicro: open,
});
const env = (b: Bar): FillEnv => ({
  bar: b,
  advMicro: 5_000_000_000_000n,
  profile: COST_PROFILES.P5,
});
const LEVEL = 10_000_000n;
const DIV = 100_000n; // A$0.10

describe("fillIntradayStop with an ex-date dividend", () => {
  it("no dividend (absent or 0n) is the v1 behaviour", () => {
    const b = bar(10_050_000n, 9_950_000n);
    const v1 = fillIntradayStop(env(b), 10n, LEVEL);
    expect(v1?.rule).toBe("level");
    expect(fillIntradayStop(env(b), 10n, LEVEL, { exDividendMicro: 0n })).toEqual(v1);
  });

  it("a low that only reaches the level because of the dividend does not trigger", () => {
    // low 9.95 + 0.10 = 10.05 > 10.00; the open 10.05 + 0.10 is above as well
    expect(
      fillIntradayStop(env(bar(10_050_000n, 9_950_000n)), 10n, LEVEL, { exDividendMicro: DIV }),
    ).toBeNull();
  });

  it("a low below the level net of the dividend fills at (level - dividend) - slippage - 1 tick", () => {
    // low 9.85 + 0.10 = 9.95 <= 10.00. ref 9.90; 10 bps = 9_900 -> one tick 10_000; 9_890_000 - 10_000
    const f = fillIntradayStop(env(bar(10_050_000n, 9_850_000n)), 10n, LEVEL, {
      exDividendMicro: DIV,
    });
    expect(f?.rule).toBe("level");
    expect(f?.refPriceMicro).toBe(9_900_000n);
    expect(f?.fillPriceMicro).toBe(9_880_000n);
    expect(f?.valueMicro).toBe(98_800_000n);
  });

  it("a gap through the level in ex-date terms fills at open - slippage", () => {
    // open 9.90 + 0.10 = 10.00 <= level -> gap_open at 9_900_000 - 10_000
    const f = fillIntradayStop(env(bar(9_900_000n, 9_800_000n)), 10n, LEVEL, {
      exDividendMicro: DIV,
    });
    expect(f?.rule).toBe("gap_open");
    expect(f?.fillPriceMicro).toBe(9_890_000n);
  });

  it("afterOpen keeps the open from gapping through", () => {
    const f = fillIntradayStop(env(bar(9_900_000n, 9_800_000n)), 10n, LEVEL, {
      afterOpen: true,
      exDividendMicro: DIV,
    });
    expect(f?.rule).toBe("level");
  });

  it("rejects a negative dividend", () => {
    expect(() =>
      fillIntradayStop(env(bar(10_050_000n, 9_850_000n)), 10n, LEVEL, { exDividendMicro: -1n }),
    ).toThrow(RangeError);
  });
});

const act = (over: Partial<ExDividendAction>): ExDividendAction => ({
  code: "ZZA",
  type: "cash_dividend",
  exDate: "2026-10-14",
  knownAt: null,
  amountMicro: 100_000n,
  ...over,
});
const CUT = "2026-10-13T07:10:00.000Z";

describe("exDividendOn (GL-02, no look-ahead)", () => {
  it("sums the cash and special dividends of the code on that ex-date", () => {
    const list = [
      act({}),
      act({ type: "special_dividend", amountMicro: 50_000n }),
      act({ code: "ZZB" }),
      act({ exDate: "2026-10-15" }),
      act({ type: "split", amountMicro: 0n }),
    ];
    expect(exDividendOn(list, "ZZA", "2026-10-14", CUT)).toBe(150_000n);
    expect(exDividendOn(list, "ZZA", "2026-10-16", CUT)).toBe(0n);
  });

  it("ignores an action confirmed after the previous session's cut-off", () => {
    const before = act({ knownAt: "2026-10-13T07:10:00.000Z" });
    const after = act({ knownAt: "2026-10-13T07:10:00.001Z", amountMicro: 70_000n });
    expect(exDividendOn([before, after], "ZZA", "2026-10-14", CUT)).toBe(100_000n);
    expect(exDividendOn([after], "ZZA", "2026-10-14", CUT)).toBe(0n);
  });

  it("an unreadable known_at or cut-off is not used", () => {
    expect(exDividendOn([act({ knownAt: "never" })], "ZZA", "2026-10-14", CUT)).toBe(0n);
    expect(exDividendOn([act({ knownAt: CUT })], "ZZA", "2026-10-14", "")).toBe(0n);
    expect(exDividendOn([act({})], "ZZA", "2026-10-14", "")).toBe(100_000n);
  });

  it("builds the amounts from the dividend records (dps)", () => {
    const out = toExDividendActions([
      {
        id: "1",
        code: "ZZA",
        type: "cash_dividend",
        exDate: "2026-10-14",
        payload: { dps: "0.125", pay_date: "2026-11-01" },
        knownAt: null,
      },
      { id: "2", code: "ZZA", type: "split", exDate: "2026-10-14", payload: { old: 1, new: 2 } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.amountMicro).toBe(125_000n);
  });
});
