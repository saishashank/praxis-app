// @vitest-environment node
// M21 B1 (D-1217, F): the night's sizing maths is extracted unchanged into `sizeForAmount`. Hand-computed known answers,
// and the extracted function equals the OLD inline maths (copied below, as it was in generate.ts before M21) over a grid
// and on every pick the generator produces, so the pick rows and their hash cannot move.
import { describe, expect, it } from "vitest";
import { generatePicks, sizeForAmount, type GenerateContext } from "@/lib/picks/generate";
import type { PickInput, UniverseCode } from "@/lib/picks/types";
import { slippageFill } from "@/lib/arena/slippage";
import { divCeil, divFloor, parseRational } from "@/lib/money/rational";
import { params } from "./harness";

const MICRO = 1_000_000n;

/** The inline maths of generate.ts `build` before the extraction, verbatim. */
function oldInline(
  amountMicro: bigint,
  maxPctText: string,
  riskPctText: string,
  buyMax: bigint,
  perShareRisk: bigint,
): { size: bigint; risk: bigint } | null {
  const PERCENT = 100n;
  const maxPct = parseRational(maxPctText);
  const riskPct = parseRational(riskPctText);
  const sizeCap = divFloor(amountMicro * maxPct.num, maxPct.den * PERCENT);
  const riskBudget = divFloor(amountMicro * riskPct.num, riskPct.den * PERCENT);
  const sizeByRisk = divFloor(riskBudget * buyMax, perShareRisk);
  const size = sizeCap < sizeByRisk ? sizeCap : sizeByRisk;
  if (size <= 0n) return null;
  const risk = divCeil(size * perShareRisk, buyMax);
  return { size, risk };
}

describe("sizeForAmount known answers", () => {
  it("the profile cap binds: A$10,000, 10 % cap, 1 % risk, buy 10.00, per-share risk 0.80", () => {
    // cap = 1,000.00; risk budget = 100.00; by risk = 100 * 10 / 0.8 = 1,250.00; size = 1,000.00;
    // risk = ceil(1,000.00 * 0.80 / 10.00) = 80.00
    expect(
      sizeForAmount(
        { amountMicro: 10_000n * MICRO, maxPct: "10", riskPct: "1" },
        10_000_000n,
        800_000n,
      ),
    ).toEqual({ size: 1_000_000_000n, risk: 80_000_000n });
  });

  it("the risk cap binds: a 0.5 % risk gives 625.00 and a risk of exactly 50.00", () => {
    expect(
      sizeForAmount(
        { amountMicro: 10_000n * MICRO, maxPct: "10", riskPct: "0.5" },
        10_000_000n,
        800_000n,
      ),
    ).toEqual({ size: 625_000_000n, risk: 50_000_000n });
  });

  it("rounds the risk up, never down (a size of 333.33 at a third of the price)", () => {
    // amount 1,000.00, cap 100 % -> 1,000.00; risk 100 % -> budget 1,000.00; buy 3.00, per-share risk 1.00
    // by risk = 1,000 * 3 / 1 = 3,000.00 -> size 1,000.00; risk = ceil(1,000.00 * 1.00 / 3.00) = 333.333334
    expect(
      sizeForAmount(
        { amountMicro: 1_000n * MICRO, maxPct: "100", riskPct: "100" },
        3_000_000n,
        1_000_000n,
      ),
    ).toEqual({ size: 1_000_000_000n, risk: 333_333_334n });
  });

  it("is null when the amount is zero or the size floors to zero", () => {
    expect(
      sizeForAmount({ amountMicro: 0n, maxPct: "10", riskPct: "1" }, 10_000_000n, 800_000n),
    ).toBeNull();
    expect(
      sizeForAmount({ amountMicro: 1n, maxPct: "5", riskPct: "0.5" }, 10_000_000n, 1n),
    ).toBeNull();
  });
});

describe("sizeForAmount equals the old inline maths", () => {
  it("over a grid of amounts, caps, prices and risks", () => {
    let n = 0;
    for (const amount of [1n, 777n, 500n * MICRO, 10_000n * MICRO, 1_234_567n * MICRO]) {
      for (const [maxPct, riskPct] of [
        ["20", "2"],
        ["10", "1"],
        ["5", "0.5"],
        ["0.1", "0.01"],
        ["33.3333", "7"],
      ] as const) {
        for (const buyMax of [1_000n, 10_000_000n, 123_456_789n]) {
          for (const risk of [1n, 799_999n, buyMax - 1n]) {
            if (risk <= 0n) continue;
            expect(sizeForAmount({ amountMicro: amount, maxPct, riskPct }, buyMax, risk)).toEqual(
              oldInline(amount, maxPct, riskPct, buyMax, risk),
            );
            n += 1;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it("on every pick the generator produces, size and risk are what the function gives", () => {
    const universe: UniverseCode[] = ["ZZ01", "ZZ02", "ZZ03", "ZZ04"].map((code, i) => ({
      code,
      tier: i < 3 ? "U1" : "U2",
      vol: 0.01 * (i + 1),
    }));
    const ctx: GenerateContext = {
      market: "AU",
      d: "2030-03-22",
      calendar: [],
      picks: params.picks,
      universe,
      createdAt: "2030-03-22T07:00:00.000Z",
    };
    const inputs: PickInput[] = universe.map((u, i) => ({
      code: u.code,
      signalId: `sig:${u.code}`,
      cardId: `card:${u.code}`,
      family: i % 2 === 0 ? "F1" : "F2",
      ruleVersion: "F1.v1",
      variant: "U" as const,
      tier: u.tier,
      rankScore: `${5 - i}/1`,
      label: "UNVALIDATED",
      referenceMicro: 10_000_000n + BigInt(i) * 1_000_000n,
      stopMicro: 9_200_000n + BigInt(i) * 900_000n,
      advValueMicro: 5_000_000_000n,
      vol: u.vol,
      scenario: { n: 87, badPpm: -60_000, typicalPpm: 30_000, goodPpm: 110_000 },
      aimReachPpm: 400_000,
      holdMedianSessions: 15,
      medianDropPpm: 50_000,
      factors: [],
      basedOn: ["a", "b"],
    }));
    const out = generatePicks(inputs, ctx);
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const p of out) {
      const spec = params.picks.profiles[p.profile]!;
      const amount = BigInt(params.picks.portfolioAmounts[p.profile]!) * MICRO;
      const buyMax = slippageFill(p.referenceMicro, "buy", 5_000_000_000n).fillMicro;
      expect(p.buyMaxMicro).toBe(buyMax);
      expect({ size: p.sizeMicro, risk: p.riskMicro }).toEqual(
        sizeForAmount(
          {
            amountMicro: amount,
            maxPct: String(spec.maxPctPerPick),
            riskPct: String(spec.riskPctPerPick),
          },
          buyMax,
          buyMax - p.stopMicro,
        ),
      );
    }
  });
});
