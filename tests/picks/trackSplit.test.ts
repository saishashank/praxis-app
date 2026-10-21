// @vitest-environment node
// Pick tracking across splits, consolidations and bonus issues (M7 T4, decision 33 / D-132 draft;
// ARN-095, D-122 known limit lifted for quantity-changing actions). The levels move into post-event
// terms by the exact M3 ratio, a held position's shares are re-based with `rebaseQty` (rounded down,
// cash unchanged), and what was paid never changes.
import { describe, expect, it } from "vitest";
import type { CorpActionRecord } from "@/lib/arena/corpActions";
import { feeFor, getCostProfile } from "@/lib/arena/costs";
import { makeRational } from "@/lib/money/rational";
import { pickActions, simulateOutcome, type DatedBar, type Levels } from "@/lib/picks/track";

const profile = getCostProfile("P5");
const MON = "2030-03-25";
const TUE = "2030-03-26";
const WED = "2030-03-27";
const THU = "2030-03-28";
const m = (v: number): bigint => BigInt(Math.round(v * 1e6));
const bar = (d: string, o: number, h: number, l: number, c: number): DatedBar => ({
  d,
  openMicro: m(o),
  highMicro: m(h),
  lowMicro: m(l),
  closeMicro: m(c),
});
const L: Levels = {
  buyMaxMicro: m(10.05),
  stopMicro: m(9.2),
  aimMicro: m(11),
  timeFrameSessions: 5,
  validUntilD: THU,
  sizeMicro: m(1000),
};
const env = (asOfD: string, actions?: Parameters<typeof simulateOutcome>[2]["actions"]) => ({
  advMicro: 5_000_000_000_000n,
  profile,
  asOfD,
  actions,
});

describe("a split inside the window", () => {
  const bars = [
    bar(MON, 10.0, 10.2, 9.9, 10.1),
    bar(TUE, 5.0, 5.1, 4.9, 5.05), // 2-for-1 on TUE: the raw price halves
    bar(WED, 5.5, 5.6, 5.4, 5.55),
  ];
  const split = [{ exD: TUE, ratio: makeRational(2n, 1n) }];

  it("without the re-base the halved price reads as a gap through the stop (the old limit)", () => {
    const out = simulateOutcome(L, bars, env(WED));
    expect(out.exitReason).toBe("gap");
  });

  it("with the re-base: levels halve, shares double, the aim is hit at the post-split level", () => {
    const out = simulateOutcome(L, bars, env(WED, split));
    expect(out.state).toBe("closed");
    expect(out.exitReason).toBe("aim");
    expect(out.exitD).toBe(WED);
    expect(out.exitMicro).toBe(m(5.5)); // aim 11.00 / 2
    const paid = 100n * out.entryMicro! + feeFor(profile, 100n * out.entryMicro!, "buy");
    const net = 200n * m(5.5) - feeFor(profile, 200n * m(5.5), "sell") - paid;
    expect(out.netMicro).toBe(net);
    expect(out.netMicro! > 0n).toBe(true);
  });

  it("a consolidation rounds the shares down: 99 shares at 1-for-2 are 49", () => {
    const cons = [{ exD: TUE, ratio: makeRational(1n, 2n) }];
    const l = { ...L, sizeMicro: m(990) }; // 990 / 10.00 = 99 shares
    const cb = [
      bar(MON, 10.0, 10.2, 9.9, 10.1),
      bar(TUE, 20.0, 20.4, 19.8, 20.2),
      bar(WED, 21.0, 22.5, 20.9, 22.1), // aim 11.00 x 2 = 22.00
    ];
    const out = simulateOutcome(l, cb, env(WED, cons));
    expect(out.exitReason).toBe("aim");
    expect(out.exitMicro).toBe(m(22));
    const paid = 99n * out.entryMicro! + feeFor(profile, 99n * out.entryMicro!, "buy");
    expect(out.netMicro).toBe(49n * m(22) - feeFor(profile, 49n * m(22), "sell") - paid);
  });

  it("a split before the entry moves the buy zone and sizes the buy at the new price", () => {
    const wait = [bar(MON, 10.5, 10.6, 10.4, 10.5), bar(TUE, 5.0, 5.1, 4.9, 5.05)];
    const out = simulateOutcome(L, wait, env(TUE, split));
    expect(out.entryD).toBe(TUE); // 5.00 is inside 10.05 / 2 = 5.025
    expect(out.state).toBe("bought");
  });

  it("a fill on the ex-date is already post-event: its shares are not re-based again", () => {
    const wait = [
      bar(MON, 10.5, 10.6, 10.4, 10.5),
      bar(TUE, 5.0, 5.4, 4.9, 5.3),
      bar(WED, 5.5, 5.6, 5.4, 5.55),
    ];
    const out = simulateOutcome(L, wait, env(WED, split));
    expect(out.exitReason).toBe("aim");
    const shares = 1_000_000_000n / m(5.0); // 200 shares from the open of 5.00
    const paid = shares * out.entryMicro! + feeFor(profile, shares * out.entryMicro!, "buy");
    expect(out.netMicro).toBe(shares * m(5.5) - feeFor(profile, shares * m(5.5), "sell") - paid);
  });
});

describe("pickActions", () => {
  const rec = (
    id: string,
    code: string,
    type: string,
    exDate: string,
    payload: Record<string, unknown>,
  ): CorpActionRecord => ({
    id,
    code,
    type,
    exDate,
    payload,
  });
  const all = [
    rec("a", "ZZA", "split", TUE, { new: 2, old: 1 }),
    rec("b", "ZZB", "split", TUE, { new: 3, old: 1 }),
    rec("c", "ZZA", "cash_dividend", TUE, { amount: "0.10" }),
    rec("d", "ZZA", "consolidation", THU, { new: 1, old: 4 }),
    rec("e", "ZZA", "split", MON, { new: 5, old: 1 }),
    rec("f", "ZZA", "bonus_issue", WED, { new: 1, old: 4 }),
  ];
  it("keeps the code's quantity-changing actions after publication, in ex-date order, as exact ratios", () => {
    const got = pickActions(all, "ZZA", MON);
    expect(got).toEqual([
      { exD: TUE, ratio: makeRational(2n, 1n) },
      { exD: WED, ratio: makeRational(5n, 4n) },
      { exD: THU, ratio: makeRational(1n, 4n) },
    ]);
  });
});
