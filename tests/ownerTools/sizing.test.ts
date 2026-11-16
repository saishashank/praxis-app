// @vitest-environment node
// M21 B1 (UXN-315, D-1217, F): the Owner's parcel sizing on hand-computed figures, with the real AU cost profile for one
// case; the concentration line; the "enter an amount" and "too small" states. Exact integer micro throughout.
import { describe, expect, it } from "vitest";
import { costProfilesOfMarket, feeFor } from "@/lib/arena/costs";
import { formatBp, sectorLine, sizeParcel, type FeeFn } from "@/lib/ownerTools/sizing";

const M = 1_000_000n;
const FLAT5: FeeFn = () => 5n * M; // a flat 5.00 each side, to keep the hand maths plain
const AGGRESSIVE = { maxPct: "20", riskPct: "2" };
const STEADY = { maxPct: "5", riskPct: "0.5" };
const PICK = { limitMicro: 10n * M, stopMicro: 9_200_000n, parcelFloorMicro: 500n * M };

describe("sizeParcel known answers", () => {
  it("Turbo (aggressive caps), capital 10,000, flat fee 5.00 a side", () => {
    // cap 20 % = 2,000.00; risk budget 2 % = 200.00 -> by risk 200 x 10 / 0.80 = 2,500.00; size 2,000.00
    // shares = 200; value 2,000.00; risk at stop = 200 x 0.80 = 160.00 + 5.00 + 5.00 = 170.00 = 1.70 % of 10,000
    expect(sizeParcel({ capitalWhole: 10_000, caps: AGGRESSIVE, ...PICK, fee: FLAT5 })).toEqual({
      kind: "ok",
      shares: 200n,
      valueMicro: 2_000n * M,
      riskMicro: 170n * M,
      riskBp: 170n,
    });
  });

  it("Steady (conservative caps), capital 10,000", () => {
    // cap 5 % = 500.00; budget 0.5 % = 50.00 -> by risk 625.00; size 500.00; shares 50; value 500.00 (at the floor)
    // risk = 50 x 0.80 = 40.00 + 10.00 = 50.00 = 0.50 %
    expect(sizeParcel({ capitalWhole: 10_000, caps: STEADY, ...PICK, fee: FLAT5 })).toEqual({
      kind: "ok",
      shares: 50n,
      valueMicro: 500n * M,
      riskMicro: 50n * M,
      riskBp: 50n,
    });
  });

  it("uses the real AU cost profile: 10.00 each side for parcels of 1,000.01 to 3,000.00", () => {
    const p5 = costProfilesOfMarket("AU").P5!;
    const fee: FeeFn = (n, side, q) => feeFor(p5, n, side, { quantity: q });
    // value 2,000.00 buys at 10.00; the sell of 200 x 9.20 = 1,840.00 is also 10.00: risk 160.00 + 20.00 = 180.00 = 1.80 %
    expect(sizeParcel({ capitalWhole: 10_000, caps: AGGRESSIVE, ...PICK, fee })).toMatchObject({
      kind: "ok",
      riskMicro: 180n * M,
      riskBp: 180n,
    });
  });

  it("a capital of 0 is the 'enter an amount' state, never a size", () => {
    expect(sizeParcel({ capitalWhole: 0, caps: AGGRESSIVE, ...PICK, fee: FLAT5 })).toEqual({
      kind: "no_amount",
    });
  });

  it("a parcel under the market's floor is 'too small'", () => {
    // capital 1,000: Steady cap 50.00 -> 5 shares = 50.00, under the 500.00 floor
    expect(sizeParcel({ capitalWhole: 1_000, caps: STEADY, ...PICK, fee: FLAT5 })).toEqual({
      kind: "too_small",
    });
    // a price above the whole cap buys no share
    expect(
      sizeParcel({
        capitalWhole: 1_000,
        caps: STEADY,
        ...PICK,
        limitMicro: 400n * M,
        stopMicro: 380n * M,
        fee: FLAT5,
      }),
    ).toEqual({ kind: "too_small" });
  });

  it("a stop at or above the limit cannot be sized", () => {
    expect(
      sizeParcel({ capitalWhole: 10_000, caps: STEADY, ...PICK, stopMicro: 10n * M, fee: FLAT5 }),
    ).toEqual({ kind: "too_small" });
  });

  it("no fraction of a share is bought: the share count rounds down and the risk follows it", () => {
    // limit 3.00 stop 2.00, capital 1,000, caps 20 % and 20 %: size 200.00 -> 66 shares (198.00), floor 100.00
    const r = sizeParcel({
      capitalWhole: 1_000,
      caps: { maxPct: "20", riskPct: "20" },
      limitMicro: 3n * M,
      stopMicro: 2n * M,
      parcelFloorMicro: 100n * M,
      fee: () => 0n,
    });
    expect(r).toMatchObject({ kind: "ok", shares: 66n, valueMicro: 198n * M, riskMicro: 66n * M });
  });
});

describe("sizeParcel with a per-share fee (US-P1)", () => {
  it("passes the share count to the fee: the TAF and the SEC fee on the sell, hand-computed", () => {
    const us = costProfilesOfMarket("US")["US-P1"]!;
    const fee: FeeFn = (n, side, q) => feeFor(us, n, side, { quantity: q });
    // 200 shares sold at the 9.20 stop = 1,840.00: SEC 0.00206 % = 0.037904 -> 0.04; TAF 200 x 0.000195 = 0.039 -> 0.04;
    // the buy has no fee. Risk = 200 x 0.80 + 0.08 = 160.08 = 160.58 bp, floored by half-up to 160 bp.
    expect(sizeParcel({ capitalWhole: 10_000, caps: AGGRESSIVE, ...PICK, fee })).toEqual({
      kind: "ok",
      shares: 200n,
      valueMicro: 2_000n * M,
      riskMicro: 160_080_000n,
      riskBp: 160n,
    });
  });

  it("a stop of zero or below cannot be sized", () => {
    expect(
      sizeParcel({ capitalWhole: 10_000, caps: STEADY, ...PICK, stopMicro: 0n, fee: FLAT5 }),
    ).toEqual({ kind: "too_small" });
  });
});

describe("formatBp", () => {
  it("prints basis points as a percent with two decimals", () => {
    expect(formatBp(170n)).toBe("1.70 %");
    expect(formatBp(5n)).toBe("0.05 %");
    expect(formatBp(0n)).toBe("0.00 %");
    expect(formatBp(12_345n)).toBe("123.45 %");
  });
});

describe("sectorLine", () => {
  it("names the largest single-sector share of the parcels, rounded half up", () => {
    expect(
      sectorLine([
        { sector: "Materials", valueMicro: 2_000n * M },
        { sector: "Materials", valueMicro: 1_000n * M },
        { sector: "Financials", valueMicro: 2_000n * M },
        { sector: "Energy", valueMicro: 1_000n * M },
      ]),
    ).toBe("Largest sector: Materials, 50 % of the amount");
    // 1 of 3 equal parts rounds to 33
    expect(
      sectorLine([
        { sector: "A", valueMicro: M },
        { sector: "B", valueMicro: M },
        { sector: "C", valueMicro: M },
      ]),
    ).toBe("Largest sector: A, 33 % of the amount");
    // 2 of 3 rounds to 67
    expect(
      sectorLine([
        { sector: "A", valueMicro: 2n * M },
        { sector: "B", valueMicro: M },
      ]),
    ).toBe("Largest sector: A, 67 % of the amount");
  });

  it("lumps a missing sector under one word, ignores empty parcels, and is order-free on a tie", () => {
    expect(sectorLine([{ sector: null, valueMicro: M }])).toBe(
      "Largest sector: Not classified yet, 100 % of the amount",
    );
    expect(sectorLine([])).toBeNull();
    expect(sectorLine([{ sector: "X", valueMicro: 0n }])).toBeNull();
    const a = sectorLine([
      { sector: "Zed", valueMicro: M },
      { sector: "Alpha", valueMicro: M },
    ]);
    const b = sectorLine([
      { sector: "Alpha", valueMicro: M },
      { sector: "Zed", valueMicro: M },
    ]);
    expect(a).toBe(b);
    expect(a).toContain("Alpha");
  });
});
