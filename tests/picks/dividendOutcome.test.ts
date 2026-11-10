// @vitest-environment node
// ARN-123 (M18 B3, D-956; money maths): a NEW pick settlement credits the confirmed cash and special
// dividends that went ex after the fill session and on or before the exit session, on the quantity held
// at the prior close (the books' entitlement rule, ARN-036), and says so (outcome basis 'total_return').
// Hand table (P5 costs; size A$1,000 at A$10.00 = 100 shares; dividend 0.50 per share = A$50.00):
//   total  = price-only net + qty x dps            (brokerage and the cost of the buy do not change)
//   ex-date window: fill session < ex-date <= exit session
import { describe, expect, it } from "vitest";
import { feeFor, getCostProfile } from "@/lib/arena/costs";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { outcomeBasisLabel } from "@/lib/picks/benchmark";
import { makeRational } from "@/lib/money/rational";
import {
  pickExDividends,
  simulateOutcome,
  type DatedBar,
  type Levels,
  type PickExDividend,
} from "@/lib/picks/track";

const profile = getCostProfile("P5");
const L: Levels = {
  buyMaxMicro: 10_050_000n,
  stopMicro: 9_200_000n,
  aimMicro: 11_000_000n,
  timeFrameSessions: 3,
  validUntilD: "2030-04-30",
  sizeMicro: 1_000_000_000n,
};
const bar = (d: string, o: number, h: number, l: number, c: number): DatedBar => ({
  d,
  openMicro: BigInt(Math.round(o * 1e6)),
  highMicro: BigInt(Math.round(h * 1e6)),
  lowMicro: BigInt(Math.round(l * 1e6)),
  closeMicro: BigInt(Math.round(c * 1e6)),
});
const MON = "2030-03-25";
const TUE = "2030-03-26";
const WED = "2030-03-27";
const THU = "2030-03-28";
const FRI = "2030-03-29";
const base = { advMicro: 5_000_000_000n, profile };
const DPS = 500_000n; // A$0.50
const QTY = 100n; // A$1,000.00 / A$10.00
const CREDIT = 50_000_000n; // QTY x DPS = A$50.00

// bought Monday at 10.00; quiet Tuesday; the aim 11.00 is reached on Wednesday (exit session)
const aimBars = [
  bar(MON, 10.0, 10.2, 9.9, 10.1),
  bar(TUE, 10.1, 10.3, 10.0, 10.2),
  bar(WED, 10.4, 11.2, 10.3, 11.0),
];
const run = (
  bars: readonly DatedBar[],
  exDividends: readonly PickExDividend[],
  credit: boolean,
  extra: Record<string, unknown> = {},
) =>
  simulateOutcome(L, bars, {
    ...base,
    asOfD: bars[bars.length - 1]!.d,
    exDividends,
    creditDividends: credit,
    ...extra,
  });

describe("a dividend inside the holding window", () => {
  it("0.50 ex on the second held session lifts net by qty x 0.50 to the micro", () => {
    const priceOnly = run(aimBars, [{ exD: TUE, dpsMicro: DPS }], false);
    const total = run(aimBars, [{ exD: TUE, dpsMicro: DPS }], true);
    expect(priceOnly.state).toBe("closed");
    expect(priceOnly.exitReason).toBe("aim");
    expect(total.exitReason).toBe("aim");
    expect(total.dividendMicro).toBe(CREDIT);
    expect(total.basis).toBe("total_return");
    expect(total.netMicro! - priceOnly.netMicro!).toBe(CREDIT); // 50 000 000 micro, exact
    // the full formula, written out: sale - sell fee - (buy + buy fee) + dividend
    const cost = QTY * total.entryMicro! + feeFor(profile, QTY * total.entryMicro!, "buy");
    const sale = QTY * total.exitMicro!;
    expect(total.netMicro).toBe(sale - feeFor(profile, sale, "sell") - cost + CREDIT);
    expect(total.netPpm).toBe(Number((total.netMicro! * 1_000_000n + cost / 2n) / cost));
  });

  it("the same run without the credit flag is price only and byte-identical to before", () => {
    const a = run(aimBars, [{ exD: TUE, dpsMicro: DPS }], false);
    const noList = run(aimBars, [], false);
    expect(a).toEqual({ ...noList }); // a dividend list alone changes nothing without the flag
    expect(a.basis ?? "price_only").toBe("price_only");
    expect(a.dividendMicro ?? 0n).toBe(0n);
  });

  it("two dividends on two held sessions add up", () => {
    const total = run(
      aimBars,
      [
        { exD: TUE, dpsMicro: DPS },
        { exD: WED, dpsMicro: 250_000n },
      ],
      true,
    );
    expect(total.dividendMicro).toBe(CREDIT + 25_000_000n); // 100 x 0.50 + 100 x 0.25
  });
});

describe("no dividend: nothing changes", () => {
  it("total return with an empty list equals price only, credit 0, basis still total_return", () => {
    const priceOnly = run(aimBars, [], false);
    const total = run(aimBars, [], true);
    expect(total.dividendMicro).toBe(0n);
    expect(total.basis).toBe("total_return");
    expect(total.netMicro).toBe(priceOnly.netMicro);
    expect(total.netPpm).toBe(priceOnly.netPpm);
  });
});

describe("the ex-date edges", () => {
  it("ex on the fill session: bought at the open of the ex-date, no entitlement", () => {
    const total = run(aimBars, [{ exD: MON, dpsMicro: DPS }], true);
    expect(total.dividendMicro).toBe(0n);
    expect(total.netMicro).toBe(run(aimBars, [], false).netMicro);
  });

  it("ex on the exit session: still held at the prior close, so credited", () => {
    const total = run(aimBars, [{ exD: WED, dpsMicro: DPS }], true);
    expect(total.exitD).toBe(WED);
    expect(total.dividendMicro).toBe(CREDIT);
  });

  it("ex after the exit session: no credit", () => {
    const bars = [...aimBars, bar(THU, 11, 11.1, 10.9, 11)];
    const total = run(bars, [{ exD: THU, dpsMicro: DPS }], true);
    expect(total.exitD).toBe(WED);
    expect(total.dividendMicro).toBe(0n);
  });

  it("ex before the fill: the position did not exist, no credit", () => {
    const bars = [
      bar(MON, 10.5, 10.6, 10.4, 10.5), // above the buy zone: no fill
      bar(TUE, 10.0, 10.2, 9.9, 10.1), // filled here
      bar(WED, 10.4, 11.2, 10.3, 11.0),
    ];
    const total = run(bars, [{ exD: MON, dpsMicro: DPS }], true);
    expect(total.entryD).toBe(TUE);
    expect(total.dividendMicro).toBe(0n);
  });

  it("a time-frame exit at the next open: a dividend going ex on that exit session is credited", () => {
    const bars = [
      bar(MON, 10.0, 10.2, 9.9, 10.1),
      bar(TUE, 10.1, 10.3, 10.0, 10.2),
      bar(WED, 10.2, 10.4, 10.1, 10.3), // held 3 sessions: time frame reached
      bar(THU, 10.3, 10.5, 10.2, 10.4), // exit at this open
    ];
    const total = run(bars, [{ exD: THU, dpsMicro: DPS }], true);
    expect(total.exitReason).toBe("time_frame");
    expect(total.exitD).toBe(THU);
    expect(total.dividendMicro).toBe(CREDIT);
    const onFri = run(
      [...bars, bar(FRI, 10.4, 10.5, 10.3, 10.4)],
      [{ exD: FRI, dpsMicro: DPS }],
      true,
    );
    expect(onFri.dividendMicro).toBe(0n); // goes ex after the exit session
  });

  it("a stop on the ex-date (dividend moves the stop trigger too) still receives the dividend", () => {
    // bought Monday; Tuesday (ex-date) gaps open at 8.50, under the 9.20 stop: exits at the open
    const bars = [bar(MON, 10.0, 10.2, 9.9, 10.1), bar(TUE, 8.5, 8.6, 8.4, 8.5)];
    const priceOnly = run(bars, [{ exD: TUE, dpsMicro: DPS }], false);
    const total = run(bars, [{ exD: TUE, dpsMicro: DPS }], true);
    expect(total.exitReason).toBe("gap");
    expect(total.dividendMicro).toBe(CREDIT);
    expect(total.netMicro! - priceOnly.netMicro!).toBe(CREDIT);
  });
});

describe("with a split inside the window", () => {
  // bought Monday (100 shares at 10.00); 2-for-1 split ex Tuesday: 200 shares, levels halve (aim 5.50)
  const split = [{ exD: TUE, ratio: makeRational(2n, 1n) }];
  const bars = [
    bar(MON, 10.0, 10.2, 9.9, 10.1),
    bar(TUE, 5.0, 5.2, 4.9, 5.1),
    bar(WED, 5.4, 5.6, 5.3, 5.5), // aim 5.50 reached (and the exit session)
  ];
  it("a dividend after the split uses the re-based quantity (200 x 0.25)", () => {
    const total = run(bars, [{ exD: WED, dpsMicro: 250_000n }], true, { actions: split });
    expect(total.exitReason).toBe("aim");
    expect(total.dividendMicro).toBe(50_000_000n); // 200 shares x A$0.25
  });
  it("a dividend going ex on the SAME day as the split pays on the prior close's 100 shares", () => {
    const total = run(bars, [{ exD: TUE, dpsMicro: 500_000n }], true, { actions: split });
    expect(total.dividendMicro).toBe(50_000_000n); // 100 shares x A$0.50 (ARN-036: prior close)
  });
});

describe("the label follows the stored basis (D-956; D-143 wording kept for old rows)", () => {
  it("price_only rows keep the old words, total_return rows say dividends are included", () => {
    expect(outcomeBasisLabel([])).toBe("Price only — dividends not included.");
    expect(outcomeBasisLabel(["price_only", "price_only"])).toBe(
      "Price only — dividends not included.",
    );
    expect(outcomeBasisLabel(["total_return"])).toBe("Total return — dividends included.");
  });
  it("a record holding both says so in one sentence", () => {
    const l = outcomeBasisLabel(["price_only", "total_return"]);
    expect(l).toContain("Older results are price only");
    expect(l).toContain("newer results are total return");
  });
});

describe("a dividend not known in time is ignored (GL-02)", () => {
  const rec = (knownAt: string | null): CorpActionRecord => ({
    id: "1",
    code: "ZZA",
    type: "cash_dividend",
    exDate: TUE,
    payload: { dps: "0.50", pay_date: "2030-04-10" },
    knownAt,
  });
  const cutoffOf = (d: string): string => `${d}T07:10:00.000Z`;
  it("confirmed after the previous session's cut-off: not in the list, so no credit", () => {
    const list = pickExDividends(
      [rec("2030-03-25T07:10:00.001Z")],
      "ZZA",
      aimBars.slice(1),
      MON,
      cutoffOf,
    );

    expect(list).toEqual([]);
    expect(run(aimBars, list, true).dividendMicro).toBe(0n);
  });
  it("confirmed in time: credited", () => {
    const list = pickExDividends(
      [rec("2030-03-25T07:10:00.000Z")],
      "ZZA",
      aimBars,
      "2030-03-24",
      cutoffOf,
    );
    expect(list).toEqual([{ exD: TUE, dpsMicro: DPS }]);
    expect(run(aimBars, list, true).dividendMicro).toBe(CREDIT);
  });
});
