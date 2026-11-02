// @vitest-environment node
// AT-15 golden scenarios for F4 and F5 plus the ARN-011 filters (M4 T7; spec 07 section 7.4,
// spec 05 ARN-011) and the D-081 flat-series RSI guard. Synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import { evaluateExit, initialStop, rsiUsable, runFamilies } from "@/lib/agents/families";
import { applyArn011 } from "@/lib/agents/families/arn011";
import { createContext } from "@/lib/agents/families/context";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  CENT,
  DOLLAR,
  dayAgo,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  position,
  rat,
  rising,
  volumes,
  wobble,
} from "../../fixtures/agents/families/builders";

const p = defaultAgentParams();
const N = 300;

/** An uptrend (close well above SMA200) with three sharp down days at the end: oversold. */
const oversold = (i: number): bigint => {
  const base = rising(CENT)(Math.min(i, N - 4));
  const k = BigInt(Math.max(0, i - (N - 4)));
  return (base * (100n - 4n * k)) / 100n;
};

function f4Code(code = "ZZD", tier: "U1" | "U2" = "U1") {
  return factsOf(code, tier, makeBars({ close: oversold }), p);
}

describe("F4 mean reversion", () => {
  it("fixture precondition: the oversold series is above SMA200 with RSI(2) < 10", () => {
    const c = f4Code();
    expect(c.ind.closeAboveSmaLong).toBe(true);
    expect(c.ind.rsiShort!).toBeLessThan(p.f4.rsi2Max);
    expect(c.ind.rsiShortWarm).toBe(true);
  });

  it("enters when close > SMA200 and RSI(2) < 10 (golden); rank is the lowest RSI(2)", () => {
    const out = runFamilies(inputsOf([f4Code()]), p);
    const c = out.candidates.find((x) => x.family === "F4")!;
    expect(c.variant).toBe("F4");
    expect(c.halfSize).toBe(false);
    expect(c.stopSpec.k).toEqual(p.f4.stopAtr);
    expect(c.rules.every((r) => r.pass)).toBe(true);
    // lower RSI(2) ranks first
    const a = override(f4Code("ZZD"), { ind: { rsiShort: 5 } });
    const b = override(f4Code("ZZC"), { ind: { rsiShort: 2 } });
    const two = runFamilies(inputsOf([a, b]), p).candidates.filter((x) => x.family === "F4");
    expect(two.map((x) => x.code)).toEqual(["ZZC", "ZZD"]);
  });

  it("RSI(2) boundary: 9.99 enters, 10 does not; RSI(14) < 30 also enters", () => {
    const base = f4Code();
    const run = (patch: Parameters<typeof override>[1]) =>
      runFamilies(inputsOf([override(base, patch)]), p).candidates.some((x) => x.family === "F4");
    expect(run({ ind: { rsiShort: 9.99 } })).toBe(true);
    expect(run({ ind: { rsiShort: 10, rsiLong: 40 } })).toBe(false);
    expect(run({ ind: { rsiShort: 50, rsiLong: 29.9 } })).toBe(true);
    expect(run({ ind: { rsiShort: 50, rsiLong: 30 } })).toBe(false);
  });

  it("does not enter at or below SMA200", () => {
    const flatBelow = override(f4Code(), { ind: { closeAboveSmaLong: false } });
    expect(runFamilies(inputsOf([flatBelow]), p).candidates.some((x) => x.family === "F4")).toBe(
      false,
    );
  });

  it("D-081: RSI of a flat series (0) must not satisfy RSI(2) < 10", () => {
    const base = f4Code();
    const n = base.closesAdj.length;
    const flat = Array.from({ length: n }, () => 5n * DOLLAR);
    // the A4 value for a flat series is 0 (TA-Lib); the rule must refuse it
    const poisoned = override(base, { closesAdj: flat, ind: { rsiShort: 0, rsiLong: 0 } });
    const out = runFamilies(inputsOf([poisoned]), p);
    expect(out.candidates.some((x) => x.family === "F4")).toBe(false);
    expect(out.blocked.some((x) => x.family === "F4")).toBe(false);
    // the same RSI of 0 on a series that really fell is a genuine reading
    const falling = Array.from({ length: n }, (_, i) => BigInt(n - i) * CENT);
    const genuine = override(base, { closesAdj: falling, ind: { rsiShort: 0, rsiLong: 0 } });
    expect(runFamilies(inputsOf([genuine]), p).candidates.some((x) => x.family === "F4")).toBe(
      true,
    );
  });

  it("D-081: a series that fell and then went flat keeps a stale low RSI that is refused", () => {
    const stale = factsOf(
      "ZZD",
      "U1",
      makeBars({
        close: (i) =>
          i < 270
            ? rising(CENT)(i)
            : i < 285
              ? rising(CENT)(270) - BigInt(i - 269) * 5n * CENT
              : rising(CENT)(270) - 16n * 5n * CENT,
      }),
      p,
    );
    // flat for the last 15 closes: both windows (3 and 15 closes) see no movement
    expect(rsiUsable(stale.ind.rsiShort, true, stale.closesAdj, p.windows.rsiShort)).toBe(false);
    expect(rsiUsable(stale.ind.rsiLong, true, stale.closesAdj, p.windows.rsiLong)).toBe(false);
    const out = runFamilies(inputsOf([stale]), p);
    expect(out.candidates.some((x) => x.family === "F4")).toBe(false);
  });

  it("rsiUsable: needs a warm, finite value and at least one price change in its window", () => {
    const moving = [1n, 2n, 3n, 4n];
    expect(rsiUsable(5, true, moving, 2)).toBe(true);
    expect(rsiUsable(5, false, moving, 2)).toBe(false);
    expect(rsiUsable(null, true, moving, 2)).toBe(false);
    expect(rsiUsable(Number.NaN, true, moving, 2)).toBe(false);
    expect(rsiUsable(5, true, [1n, 2n], 2)).toBe(false);
    expect(rsiUsable(0, true, [3n, 3n, 3n], 2)).toBe(false);
  });

  it("no - polarity event in the last 3 sessions: 2 sessions ago blocks, 3 does not", () => {
    const bad = (ago: number) =>
      ev({ code: "ZZD", category: "guidance_down", polarity: -1, day0: dayAgo(ago), ar: "-0.05" });
    const run = (ago: number) =>
      runFamilies(inputsOf([f4Code()], { events: [bad(ago)] }), p).candidates.some(
        (x) => x.family === "F4",
      );
    expect(run(0)).toBe(false);
    expect(run(2)).toBe(false);
    expect(run(3)).toBe(true);
    const positive = ev({ code: "ZZD", category: "results", polarity: 1, day0: dayAgo(1) });
    expect(
      runFamilies(inputsOf([f4Code()], { events: [positive] }), p).candidates.some(
        (x) => x.family === "F4",
      ),
    ).toBe(true);
  });

  it("regime: all states trade; SHOCK is half size; unknown does not enter", () => {
    const run = (regime: "RISK-ON" | "NEUTRAL" | "RISK-OFF" | "SHOCK" | "unknown") =>
      runFamilies(inputsOf([f4Code()], { regime }), p).candidates.find((x) => x.family === "F4");
    expect(run("RISK-ON")?.halfSize).toBe(false);
    expect(run("NEUTRAL")?.halfSize).toBe(false);
    expect(run("RISK-OFF")?.halfSize).toBe(false);
    expect(run("SHOCK")?.halfSize).toBe(true);
    expect(run("unknown")).toBeUndefined();
  });

  it("validated patterns replace the RSI condition only when PASSED (none in M4)", () => {
    const base = override(f4Code(), {
      ind: { rsiShort: 50, rsiLong: 50 },
      patterns: { hammer: true },
    });
    const none = runFamilies(inputsOf([base]), p);
    expect(none.candidates.some((x) => x.family === "F4")).toBe(false);
    const passed = runFamilies(inputsOf([base], { passedPatterns: new Set(["hammer"]) }), p);
    expect(passed.candidates.some((x) => x.family === "F4")).toBe(true);
    const other = runFamilies(inputsOf([base], { passedPatterns: new Set(["morningStar"]) }), p);
    expect(other.candidates.some((x) => x.family === "F4")).toBe(false);
  });

  it("exits: CS close > SMA5, CS 10 sessions, IS entry - 2 x ATR", () => {
    const c = runFamilies(inputsOf([f4Code()]), p).candidates.find((x) => x.family === "F4")!;
    expect(evaluateExit(position(c.plan, { family: "F4", closeAboveExitSma: true })).cs?.rule).toBe(
      "close_above_sma",
    );
    expect(
      evaluateExit(position(c.plan, { family: "F4", closeAboveExitSma: false })).cs,
    ).toBeNull();
    expect(evaluateExit(position(c.plan, { family: "F4", sessionsHeld: 10 })).cs?.rule).toBe(
      "time_stop",
    );
    expect(evaluateExit(position(c.plan, { family: "F4", sessionsHeld: 9 })).cs).toBeNull();
    const atr = c.stopSpec.atr_micro!;
    expect(initialStop(c.stopSpec, 3n * DOLLAR)).toBe(3n * DOLLAR - 2n * atr);
  });

  it("only U1 trades F4", () => {
    expect(
      runFamilies(inputsOf([f4Code("ZZD", "U2")]), p).candidates.some((x) => x.family === "F4"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

/** A flat small cap whose last session is an announcement-day breakout. */
function f5Bars(
  over: Parameters<typeof makeBars>[0]["last"] = {},
  tierCode = "ZZS",
  tier: "U2" | "U3" = "U2",
) {
  return factsOf(
    tierCode,
    tier,
    makeBars({
      close: () => DOLLAR,
      volume: volumes(1_000_000n, 4_000_000n),
      spread: 2n * CENT,
      last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n, ...over },
    }),
    p,
  );
}

const f5Event = (over: Partial<Parameters<typeof ev>[0]> = {}) =>
  ev({ code: "ZZS", category: "contract_win", polarity: 1, ar: "0.05", vol: "4", ...over });

describe("F5 small/mid-cap discovery", () => {
  it("enters on volume >= 3x with a + price-sensitive day-0 event, AR >= 3%, up day, range >= 0.75 (golden)", () => {
    const out = runFamilies(inputsOf([f5Bars()], { events: [f5Event()] }), p);
    const c = out.candidates.find((x) => x.family === "F5")!;
    expect(c.code).toBe("ZZS");
    expect(c.rules.every((r) => r.pass)).toBe(true);
    expect(c.rank[0]).toEqual(rat("4"));
    // initial stop: 2.5 x ATR capped at a 20% loss
    expect(c.stopSpec.cap).toEqual(rat("0.2"));
    const fill = DOLLAR;
    const huge = { ...c.stopSpec, atr_micro: 5n * DOLLAR };
    expect(initialStop(huge, fill)).toBe(800_000n);
    const small = { ...c.stopSpec, atr_micro: 5n * CENT };
    expect(initialStop(small, fill)).toBe(fill - 125_000n);
  });

  it("AC: a -25% gap day closing near its high on 3x volume does not enter (AR and up-day fail)", () => {
    const crash = f5Bars({
      open: 750_000n,
      high: 760_000n,
      low: 740_000n,
      close: 758_000n,
    });
    const event = f5Event({ category: "results", polarity: -1, ar: "-0.24", vol: "3" });
    const out = runFamilies(inputsOf([crash], { events: [event] }), p);
    expect(out.candidates.some((x) => x.family === "F5")).toBe(false);
    expect(out.blocked.some((x) => x.family === "F5")).toBe(false);
    // each failing rule on its own: a - polarity event, and a close below the prior close
    const upDayFails = runFamilies(inputsOf([crash], { events: [f5Event()] }), p);
    expect(upDayFails.candidates.some((x) => x.family === "F5")).toBe(false);
    const arFails = runFamilies(inputsOf([f5Bars()], { events: [event] }), p);
    expect(arFails.candidates.some((x) => x.family === "F5")).toBe(false);
  });

  it("volume ratio boundary 3 passes, below fails; AR boundary 3% passes, below fails", () => {
    const vol = (last: bigint) =>
      factsOf(
        "ZZS",
        "U2",
        makeBars({
          close: () => DOLLAR,
          volume: volumes(1_000_000n, last),
          spread: 2n * CENT,
          last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n },
        }),
        p,
      );
    const run = (c: ReturnType<typeof vol>, ar = "0.05") =>
      runFamilies(inputsOf([c], { events: [f5Event({ ar })] }), p).candidates.some(
        (x) => x.family === "F5",
      );
    expect(run(vol(3_000_000n))).toBe(true);
    expect(run(vol(2_999_999n))).toBe(false);
    expect(run(vol(4_000_000n), "0.03")).toBe(true);
    expect(run(vol(4_000_000n), "0.0299")).toBe(false);
  });

  it("range position 0.75 passes, below fails", () => {
    const at = f5Bars({ high: 1_060_000n, low: DOLLAR, close: 1_045_000n }); // 0.75
    expect(
      runFamilies(inputsOf([at], { events: [f5Event()] }), p).candidates.filter(
        (x) => x.family === "F5",
      ),
    ).toHaveLength(1);
    const lower = f5Bars({ high: 1_060_000n, low: DOLLAR, close: 1_044_000n });
    expect(
      runFamilies(inputsOf([lower], { events: [f5Event()] }), p).candidates.some(
        (x) => x.family === "F5",
      ),
    ).toBe(false);
  });

  it("needs a price-sensitive + polarity event with day 0 = D", () => {
    const run = (e: ReturnType<typeof f5Event>) =>
      runFamilies(inputsOf([f5Bars()], { events: [e] }), p).candidates.some(
        (x) => x.family === "F5",
      );
    expect(run(f5Event())).toBe(true);
    expect(run(f5Event({ priceSensitive: false }))).toBe(false);
    expect(run(f5Event({ day0: dayAgo(1) }))).toBe(false);
    expect(run(f5Event({ polarity: 0 }))).toBe(false);
  });

  it("universe U2 only (O-49); regime gate blocks RISK-OFF and SHOCK", () => {
    const world = (
      tier: "U1" | "U2" | "U3",
      regime: "RISK-ON" | "RISK-OFF" | "SHOCK" | "NEUTRAL",
    ) =>
      runFamilies(
        inputsOf(
          [
            factsOf(
              "ZZS",
              tier,
              makeBars({
                close: () => DOLLAR,
                volume: volumes(1_000_000n, 4_000_000n),
                spread: 2n * CENT,
                last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n },
              }),
              p,
            ),
          ],
          {
            events: [f5Event()],
            regime,
          },
        ),
        p,
      );
    expect(world("U1", "RISK-ON").candidates.some((x) => x.family === "F5")).toBe(false);
    expect(world("U2", "RISK-ON").candidates.some((x) => x.family === "F5")).toBe(true);
    // O-49 (D-221): U3 is no longer traded
    expect(world("U3", "NEUTRAL").candidates.some((x) => x.family === "F5")).toBe(false);
    for (const regime of ["RISK-OFF", "SHOCK"] as const) {
      const out = world("U2", regime);
      expect(out.candidates.some((x) => x.family === "F5")).toBe(false);
      expect(out.blocked.find((x) => x.family === "F5")?.reasons).toEqual([`regime_${regime}`]);
    }
  });

  it("exits: volume ratio < 0.5 for 3 sessions, - polarity event, 30 sessions", () => {
    const c = runFamilies(inputsOf([f5Bars()], { events: [f5Event()] }), p).candidates.find(
      (x) => x.family === "F5",
    )!;
    const low = [rat("0.4"), rat("0.49"), rat("0.1")];
    expect(evaluateExit(position(c.plan, { family: "F5", volumeRatios: low })).cs?.rule).toBe(
      "volume_dry_up",
    );
    expect(
      evaluateExit(position(c.plan, { family: "F5", volumeRatios: [rat("0.5"), ...low.slice(1)] }))
        .cs,
    ).toBeNull();
    expect(
      evaluateExit(position(c.plan, { family: "F5", volumeRatios: [rat("0.1"), rat("0.1")] })).cs,
    ).toBeNull();
    expect(
      evaluateExit(position(c.plan, { family: "F5", volumeRatios: [null, rat("0.1"), rat("0.1")] }))
        .cs,
    ).toBeNull();
    const neg = ev({ code: "ZZS", category: "capital_raising", polarity: -1, day0: dayAgo(1) });
    expect(evaluateExit(position(c.plan, { family: "F5", events: [neg] })).cs?.rule).toBe(
      "negative_event",
    );
    expect(evaluateExit(position(c.plan, { family: "F5", sessionsHeld: 30 })).cs?.rule).toBe(
      "time_stop",
    );
    expect(evaluateExit(position(c.plan, { family: "F5", sessionsHeld: 29 })).cs).toBeNull();
    // IS: trailing 3 x ATR from the highest close
    const t = evaluateExit(
      position(c.plan, { family: "F5", highestCloseMicro: 2n * DOLLAR, atrMicro: 100_000n }),
    );
    expect(t.isLevels).toEqual([{ rule: "trail", levelMicro: 2n * DOLLAR - 300_000n }]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("ARN-011 filters on U2/U3 entries", () => {
  const ctxOf = (codes: ReturnType<typeof f5Bars>[], events = [] as ReturnType<typeof ev>[]) =>
    createContext(inputsOf(codes, { events }), p);
  const failed = (c: ReturnType<typeof f5Bars>, events = [] as ReturnType<typeof ev>[]) =>
    applyArn011(c, ctxOf([c], events)).failed;

  it("passes a clean small cap", () => {
    expect(failed(f5Bars())).toEqual([]);
  });

  it("halted / suspended", () => {
    expect(failed(override(f5Bars(), { halted: true }))).toEqual(["halted"]);
  });

  it("+30% in one session without a price-sensitive item blocks; with one it passes", () => {
    const jump = f5Bars({ open: DOLLAR, high: 1_400_000n, low: DOLLAR, close: 1_300_000n });
    expect(failed(jump)).toContain("gain_1s_without_price_sensitive_item");
    const item = ev({ code: "ZZS", category: "results", polarity: 1 });
    expect(failed(jump, [item])).not.toContain("gain_1s_without_price_sensitive_item");
    const small = f5Bars({ open: DOLLAR, high: 1_300_000n, low: DOLLAR, close: 1_299_999n });
    expect(failed(small)).not.toContain("gain_1s_without_price_sensitive_item");
  });

  it("+100% in 5 sessions without a price-sensitive item blocks", () => {
    const run = factsOf(
      "ZZS",
      "U2",
      makeBars({ close: (i) => (i < 296 ? DOLLAR : DOLLAR + BigInt(i - 295) * 250_000n) }),
      p,
    );
    expect(failed(run)).toContain("gain_5s_without_price_sensitive_item");
    const item = ev({ code: "ZZS", category: "results", polarity: 1, day0: dayAgo(3) });
    expect(failed(run, [item])).not.toContain("gain_5s_without_price_sensitive_item");
  });

  it("volume ratio > 10 without an announcement blocks", () => {
    const spike = factsOf(
      "ZZS",
      "U2",
      makeBars({ close: () => DOLLAR, volume: volumes(1_000_000n, 10_000_001n) }),
      p,
    );
    expect(failed(spike)).toContain("volume_spike_without_announcement");
    const note = ev({ code: "ZZS", category: "other", polarity: 0, priceSensitive: false });
    expect(failed(spike, [note])).not.toContain("volume_spike_without_announcement");
    const ten = factsOf(
      "ZZS",
      "U2",
      makeBars({ close: () => DOLLAR, volume: volumes(1_000_000n, 10_000_000n) }),
      p,
    );
    expect(failed(ten)).not.toContain("volume_spike_without_announcement");
  });

  it("two placements in 120 sessions block; one only flags discount-unknown", () => {
    const raise = (ago: number) =>
      ev({ code: "ZZS", category: "capital_raising", polarity: -1, day0: dayAgo(ago) });
    const c = f5Bars();
    expect(failed(c, [raise(10), raise(100)])).toContain("placements");
    expect(failed(c, [raise(10), raise(120)])).not.toContain("placements");
    const one = applyArn011(c, ctxOf([c], [raise(10)]));
    expect(one.failed).not.toContain("placements");
    expect(one.flags).toContain("discount-unknown");
    expect(applyArn011(c, ctxOf([c], [raise(70)])).flags).not.toContain("discount-unknown");
  });

  it("promotional pattern, ASX query on D or D-1, consolidation in 90 sessions", () => {
    expect(failed(override(f5Bars(), { promotional: true }))).toEqual(["promotional"]);
    const query = (ago: number) =>
      ev({ code: "ZZS", category: "exchange_query", polarity: -1, day0: dayAgo(ago) });
    expect(failed(f5Bars(), [query(1)])).toContain("asx_query");
    expect(failed(f5Bars(), [query(2)])).not.toContain("asx_query");
    expect(failed(override(f5Bars(), { consolidationSessionsAgo: 89 }))).toContain("consolidation");
    expect(failed(override(f5Bars(), { consolidationSessionsAgo: 90 }))).not.toContain(
      "consolidation",
    );
  });

  it("range > 25% of price on 3 of the last 5 sessions blocks, 2 do not", () => {
    const wide = (days: number) =>
      factsOf(
        "ZZS",
        "U2",
        makeBars({
          close: () => DOLLAR,
          spread: 100n * CENT,
        }).map((b, i, all) =>
          i >= all.length - days || i < all.length - 5
            ? { ...b, high: b.close + 200_000n, low: b.close - 100_000n }
            : { ...b, high: b.close + CENT, low: b.close - CENT },
        ),
        p,
      );
    // helper above widens `days` bars (plus bars older than 5 sessions, which are ignored)
    expect(failed(wide(3))).toContain("wide_range");
    expect(failed(wide(2))).not.toContain("wide_range");
  });

  it("a blocked entry is logged with its reasons instead of becoming a candidate", () => {
    const c = override(f5Bars(), { promotional: true });
    const out = runFamilies(inputsOf([c], { events: [f5Event()] }), p);
    expect(out.candidates.some((x) => x.family === "F5")).toBe(false);
    expect(out.blocked.find((x) => x.family === "F5")?.reasons).toEqual(["arn011:promotional"]);
  });

  it("ARN-011 applies to a U2 entry of any family but never to U1", () => {
    // F1 with the U2 opt-in on a +35% day without an item is blocked
    const rise = factsOf(
      "ZZA",
      "U2",
      makeBars({
        close: rising(CENT),
        volume: volumes(1_000_000n, 2_000_000n),
        last: { open: 3_900_000n, high: 5_400_000n, low: 3_900_000n, close: 5_300_000n },
      }),
      p,
    );
    const peers2 = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) =>
      factsOf(`ZZQ${i}`, "U2", makeBars({ close: wobble(2n * DOLLAR) }), p),
    );
    const out = runFamilies(inputsOf([rise, ...peers2]), p, { u2OptInF1: true });
    expect(out.candidates.some((x) => x.family === "F1")).toBe(false);
    expect(out.blocked.find((x) => x.family === "F1")?.reasons).toContain(
      "arn011:gain_1s_without_price_sensitive_item",
    );
    const asU1 = override(rise, { tier: "U1" });
    const u1 = runFamilies(inputsOf([asU1, ...peers2.map((c) => override(c, { tier: "U1" }))]), p);
    expect(u1.candidates.some((x) => x.family === "F1")).toBe(true);
  });
});
