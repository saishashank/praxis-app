// @vitest-environment node
// ARN-095 tracking (pure simulation): bought only inside the buy zone and window, missed otherwise,
// closed at the stop (with the gap rule), the aim or the end of the time frame, costs included.
import { describe, expect, it } from "vitest";
import { feeFor, getCostProfile } from "@/lib/arena/costs";
import { simulateOutcome, scaleLevels, type DatedBar, type Levels } from "@/lib/picks/track";

const profile = getCostProfile("P5");
const env = (asOfD: string) => ({ advMicro: 5_000_000_000n, profile, asOfD });

const L: Levels = {
  buyMaxMicro: 10_050_000n,
  stopMicro: 9_200_000n,
  aimMicro: 11_000_000n,
  timeFrameSessions: 3,
  validUntilD: "2030-03-26",
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
const NEXT = "2030-04-01";

describe("entry", () => {
  it("buys at the first open inside the buy zone, with slippage", () => {
    const out = simulateOutcome(L, [bar(MON, 10.0, 10.2, 9.9, 10.1)], env(MON));
    expect(out.state).toBe("bought");
    expect(out.entryD).toBe(MON);
    expect(out.entryMicro! >= 10_000_000n).toBe(true); // open plus slippage, never below the open
  });

  it("buys on the second valid session when the first open is above the zone", () => {
    const out = simulateOutcome(
      L,
      [bar(MON, 10.5, 10.6, 10.4, 10.5), bar(TUE, 10.0, 10.2, 9.9, 10.1)],
      env(TUE),
    );
    expect(out.entryD).toBe(TUE);
  });

  it("is missed (not a win, not a loss) when every open in the window is above the zone", () => {
    const bars = [
      bar(MON, 10.5, 10.6, 10.4, 10.5),
      bar(TUE, 10.6, 10.7, 10.5, 10.6),
      bar(WED, 9.9, 10.0, 9.8, 9.9), // back inside the zone, but the window has closed
    ];
    const out = simulateOutcome(L, bars, env(WED));
    expect(out.state).toBe("missed");
    expect(out.netMicro).toBeNull();
    expect(out.netPpm).toBeNull();
    expect(out.entryD).toBeNull();
  });

  it("stays waiting while the window is still open", () => {
    expect(simulateOutcome(L, [bar(MON, 10.5, 10.6, 10.4, 10.5)], env(MON)).state).toBe("waiting");
    expect(simulateOutcome(L, [], env(MON)).state).toBe("waiting");
  });

  it("is missed once the window has passed even with no later bar", () => {
    expect(simulateOutcome(L, [bar(MON, 10.5, 10.6, 10.4, 10.5)], env(TUE)).state).toBe("missed");
  });
});

describe("exit", () => {
  const enter = bar(MON, 10.0, 10.2, 9.9, 10.1);

  it("closes at the stop level when the low reaches it (ARN-021, after the open of the entry day)", () => {
    const out = simulateOutcome(L, [bar(MON, 10.0, 10.1, 9.1, 9.5)], env(MON));
    expect(out.state).toBe("closed");
    expect(out.exitReason).toBe("stop");
    expect(out.exitD).toBe(MON);
    expect(out.exitMicro! <= 9_200_000n).toBe(true);
    expect(out.netMicro! < 0n).toBe(true);
  });

  it("fills at the open when a later session gaps through the stop (gap rule)", () => {
    const out = simulateOutcome(L, [enter, bar(TUE, 8.8, 9.0, 8.7, 8.9)], env(TUE));
    expect(out.exitReason).toBe("gap");
    expect(out.exitMicro! <= 8_800_000n).toBe(true);
  });

  it("takes the aim at the aim price, or at the open when it gaps above", () => {
    const hit = simulateOutcome(L, [enter, bar(TUE, 10.5, 11.2, 10.4, 11.0)], env(TUE));
    expect(hit.exitReason).toBe("aim");
    expect(hit.exitMicro).toBe(11_000_000n);
    expect(hit.netMicro! > 0n).toBe(true);
    const gap = simulateOutcome(L, [enter, bar(TUE, 11.4, 11.6, 11.3, 11.5)], env(TUE));
    expect(gap.exitMicro).toBe(11_400_000n);
  });

  it("checks the stop before the aim in a session that touches both", () => {
    const out = simulateOutcome(L, [enter, bar(TUE, 10.2, 11.5, 9.0, 10.0)], env(TUE));
    expect(out.exitReason).toBe("stop");
  });

  it("closes at the next open after the time frame, and waits for that session", () => {
    const quiet = [
      enter,
      bar(TUE, 10.1, 10.3, 10.0, 10.2),
      bar(WED, 10.2, 10.4, 10.1, 10.3), // third session: time frame reached at its close
    ];
    const open = simulateOutcome(L, quiet, env(WED));
    expect(open.state).toBe("bought");
    const done = simulateOutcome(L, [...quiet, bar(THU, 10.4, 10.5, 10.3, 10.4)], env(THU));
    expect(done.state).toBe("closed");
    expect(done.exitReason).toBe("time_frame");
    expect(done.exitD).toBe(THU);
    expect(done.exitMicro! <= 10_400_000n).toBe(true); // sold at the open minus slippage
  });

  it("charges brokerage on both legs: net is below the price move", () => {
    const out = simulateOutcome(L, [enter, bar(TUE, 10.5, 11.2, 10.4, 11.0)], env(TUE));
    const qty = 1_000_000_000n / 10_000_000n; // 100 shares at A$10.00
    const move = (out.exitMicro! - out.entryMicro!) * qty;
    expect(out.netMicro! < move).toBe(true);
    const cost = qty * out.entryMicro! + feeFor(profile, qty * out.entryMicro!, "buy");
    const sale = qty * out.exitMicro!;
    expect(out.netMicro).toBe(sale - feeFor(profile, sale, "sell") - cost);
    expect(out.netPpm).toBe(Number((out.netMicro! * 1_000_000n + cost / 2n) / cost));
  });

  it("is deterministic and stops moving once closed", () => {
    const bars = [enter, bar(TUE, 10.5, 11.2, 10.4, 11.0), bar(NEXT, 5, 5.1, 4.9, 5)];
    const a = simulateOutcome(L, bars, env(NEXT));
    const b = simulateOutcome(L, bars, env(NEXT));
    expect(a).toEqual(b);
    expect(a.exitReason).toBe("aim");
    void FRI;
  });
});

describe("luck-check twin levels", () => {
  it("keeps the pick's proportions on the twin's own price", () => {
    const t = scaleLevels(L, 10_000_000n, 20_000_000n);
    expect(t.stopMicro).toBe(18_400_000n);
    expect(t.aimMicro).toBe(22_000_000n);
    expect(t.buyMaxMicro).toBe(20_100_000n);
    expect(t.timeFrameSessions).toBe(L.timeFrameSessions);
    expect(t.validUntilD).toBe(L.validUntilD);
  });
});
