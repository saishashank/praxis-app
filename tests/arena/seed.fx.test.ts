// @vitest-environment node
// M20 A4 (D-1107, ARN-001 per market): seedForMarket(profile, fxRow) = round_half_up(from_amount x rate, round_to).
// Hand-worked: 600 x 55.123 = 33,073.8 -> round to Rs 1,000 -> 33,000; 600 x 0.6512 = 390.72 -> round to US$10 -> 390.
import { describe, expect, it } from "vitest";
import { seedForMarket } from "@/lib/arena/seed";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

const M = 1_000_000n;

describe("seedForMarket", () => {
  it("AU: fixed A$600, rate 1, no FX row", () => {
    const r = seedForMarket(staticProfile("AU"));
    expect(r.seedMicro).toBe(600n * M);
    expect(r.fx).toBeNull();
    expect(r.record).toEqual({
      seed_micro: "600000000",
      fx_rate: "1",
      fx_date: null,
      fx_source: null,
    });
    // an FX row given to AU is ignored: the fixed amount stands
    expect(
      seedForMarket(staticProfile("AU"), { rate: "2", date: "2026-11-13", source: "x" }).seedMicro,
    ).toBe(600n * M);
  });

  it("IN: 600 x 55.123 -> Rs 33,000", () => {
    const fx = { rate: "55.123", date: "2026-11-12", source: "rba_daily:FXRINR" };
    const r = seedForMarket(staticProfile("IN"), fx);
    expect(r.seedMicro).toBe(33_000n * M);
    expect(r.record).toEqual({
      seed_micro: "33000000000",
      fx_rate: "55.123",
      fx_date: "2026-11-12",
      fx_source: "rba_daily:FXRINR",
    });
  });

  it("US: 600 x 0.6512 -> US$390", () => {
    const r = seedForMarket(staticProfile("US"), {
      rate: "0.6512",
      date: "2026-11-12",
      source: "rba_daily:FXRUSD",
    });
    expect(r.seedMicro).toBe(390n * M);
  });

  it("rounds half up at the edge", () => {
    const p = {
      code: "ZZ",
      fields: {
        seed_amount: {
          value: {
            kind: "fx_rounded",
            from_amount: 10,
            from_currency: "AUD",
            fx_source: "rba_daily",
            round_to: 10,
          },
        },
      },
    } as unknown as Parameters<typeof seedForMarket>[0];
    // 10 x 0.5 = 5 -> 0.5 of a unit -> up to 10; 10 x 0.4999 = 4.999 -> rounds to 0, which is refused
    expect(seedForMarket(p, { rate: "0.5", date: "d", source: "s" }).seedMicro).toBe(10n * M);
    expect(() => seedForMarket(p, { rate: "0.4999", date: "d", source: "s" })).toThrow(
      "rounds to nothing",
    );
    // 10 x 1.5 = 15 -> 1.5 units of 10 -> 2 -> 20
    expect(seedForMarket(p, { rate: "1.5", date: "d", source: "s" }).seedMicro).toBe(20n * M);
  });

  it("a converting market without an FX row, or with a non-positive rate, throws", () => {
    expect(() => seedForMarket(staticProfile("IN"))).toThrow("FX close");
    expect(() => seedForMarket(staticProfile("IN"), { rate: "0", date: "d", source: "s" })).toThrow(
      "positive",
    );
  });
});
