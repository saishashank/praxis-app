// @vitest-environment node
// AT-15 golden scenarios for F1, F2 and F3 (M4 T7; spec 07 section 7.4): each acceptance criterion
// of the family table is its own test, on synthetic ZZ data. Thresholds come from AgentParams, so
// some tests change a key and watch the outcome move.
import { describe, expect, it } from "vitest";
import {
  evaluateExit,
  gapCancelLevel,
  gapCancelsAtFill,
  initialStop,
  runFamilies,
} from "@/lib/agents/families";
import { buildAgentParams, defaultAgentParams } from "@/lib/agents/params";
import { CONFIG_KEYS, type ConfigKey } from "@/lib/config/keys";
import {
  CENT,
  DOLLAR,
  dayAgo,
  ev,
  factsOf,
  inputsOf,
  makeBars,
  override,
  peers,
  position,
  rat,
  rising,
  volumes,
  wobble,
} from "../../fixtures/agents/families/builders";

const p = defaultAgentParams();
const withKey = (key: ConfigKey, value: number) =>
  buildAgentParams((k) => (k === key ? value : CONFIG_KEYS[k].default));

/** A leader that makes a 250-session high on 2x volume, with nine weaker U1 peers. */
function f1World(
  opts: { lastVolume?: bigint; leaderTier?: "U1" | "U2"; strongPeers?: number } = {},
) {
  const leader = factsOf(
    "ZZA",
    opts.leaderTier ?? "U1",
    makeBars({ close: rising(CENT), volume: volumes(1_000_000n, opts.lastVolume ?? 2_000_000n) }),
    p,
  );
  const strong = Array.from({ length: opts.strongPeers ?? 0 }, (_, i) =>
    factsOf(`ZZS${i}`, "U1", makeBars({ close: rising(2n * CENT) }), p),
  );
  return [leader, ...strong, ...peers("ZZP", "U1", 9, p)];
}

describe("F1 trend / breakout", () => {
  it("enters a 250-session high on 2x volume in the top 20% of its tier (golden entry)", () => {
    const out = runFamilies(inputsOf(f1World()), p);
    const f1 = out.candidates.filter((c) => c.family === "F1");
    expect(f1.map((c) => c.code)).toEqual(["ZZA"]);
    const c = f1[0]!;
    expect(c.variant).toBe("F1");
    expect(c.rules.every((r) => r.pass)).toBe(true);
    expect(c.rank[0]).toEqual({ num: 1n, den: 1n });
    // initial stop spec: entry - 2 x ATR from the actual fill
    const atr = c.stopSpec.atr_micro!;
    expect(c.stopSpec.k).toEqual(p.f1.initialStopAtr);
    expect(initialStop(c.stopSpec, 4n * DOLLAR)).toBe(4n * DOLLAR - 2n * atr);
    expect(c.plan.trails).toEqual([
      { id: "trail", via: null, k: p.f1.trailAtr, activateGain: null },
    ]);
  });

  it("does not enter when the volume ratio is below 1.5 and enters exactly at 1.5", () => {
    expect(
      runFamilies(inputsOf(f1World({ lastVolume: 1_499_999n })), p).candidates.filter(
        (c) => c.family === "F1",
      ),
    ).toEqual([]);
    expect(
      runFamilies(inputsOf(f1World({ lastVolume: 1_500_000n })), p).candidates.filter(
        (c) => c.family === "F1",
      ),
    ).toHaveLength(1);
  });

  it("takes the volume threshold from AgentParams", () => {
    const strict = withKey("f1_volume_ratio_min", 3);
    expect(
      runFamilies(inputsOf(f1World()), strict).candidates.filter((c) => c.family === "F1"),
    ).toEqual([]);
  });

  it("does not enter when the 6-month return is outside the top 20% of the tier", () => {
    // three stronger peers: the leader's percentile is 9/12 < 0.8
    const out = runFamilies(inputsOf(f1World({ strongPeers: 3 })), p);
    expect(out.candidates.filter((c) => c.family === "F1" && c.code === "ZZA")).toEqual([]);
    const rs = out.candidates.filter((c) => c.family === "F1").map((c) => c.code);
    expect(rs).not.toContain("ZZA");
  });

  it("does not enter when today's close is not the 250-session high", () => {
    const leader = factsOf(
      "ZZA",
      "U1",
      makeBars({
        close: rising(CENT),
        volume: volumes(1_000_000n, 2_000_000n),
        last: { close: 3n * DOLLAR, open: 3n * DOLLAR + CENT },
      }),
      p,
    );
    const out = runFamilies(inputsOf([leader, ...peers("ZZP", "U1", 9, p)]), p);
    expect(out.candidates.filter((c) => c.family === "F1")).toEqual([]);
  });

  it("regime gate: no entries in RISK-OFF or SHOCK; RISK-ON and NEUTRAL enter", () => {
    const world = f1World();
    for (const regime of ["RISK-ON", "NEUTRAL"] as const) {
      const out = runFamilies(inputsOf(world, { regime }), p);
      expect(out.candidates.some((c) => c.family === "F1")).toBe(true);
    }
    for (const regime of ["RISK-OFF", "SHOCK", "unknown"] as const) {
      const out = runFamilies(inputsOf(world, { regime }), p);
      expect(out.candidates.some((c) => c.family === "F1")).toBe(false);
      const b = out.blocked.find((x) => x.family === "F1");
      expect(b?.reasons).toEqual([`regime_${regime}`]);
    }
  });

  it("U2 only with the opt-in; the replay variant F1-U1 stays on U1", () => {
    const world = f1World({ leaderTier: "U2" });
    const off = runFamilies(inputsOf(world), p);
    expect(off.candidates.filter((c) => c.family === "F1")).toEqual([]);
    const on = runFamilies(inputsOf([...world, ...peers("ZZQ", "U2", 9, p)]), p, {
      u2OptInF1: true,
    });
    expect(on.candidates.filter((c) => c.family === "F1").map((c) => c.code)).toEqual(["ZZA"]);
    const u1only = runFamilies(inputsOf([...world, ...peers("ZZQ", "U2", 9, p)]), p, {
      u2OptInF1: true,
      restrictToU1: true,
    });
    expect(u1only.candidates.filter((c) => c.family === "F1")).toEqual([]);
    const label = runFamilies(inputsOf(f1World()), p, { restrictToU1: true });
    expect(label.candidates.find((c) => c.family === "F1")?.variant).toBe("F1-U1");
  });

  it("exits: trailing stop 3 x ATR below the highest close since entry (IS level)", () => {
    const plan = runFamilies(inputsOf(f1World()), p).candidates.find(
      (c) => c.family === "F1",
    )!.plan;
    const e = evaluateExit(
      position(plan, {
        highestCloseMicro: 10n * DOLLAR,
        closeMicro: 9n * DOLLAR,
        atrMicro: 500n * CENT,
      }),
    );
    expect(e.isLevels).toEqual([{ rule: "trail", levelMicro: 10n * DOLLAR - 3n * 500n * CENT }]);
    expect(e.cs).toBeNull();
  });

  it("exits: 40 sessions held with return below +5% is a CS exit; at +5% it is not", () => {
    const plan = runFamilies(inputsOf(f1World()), p).candidates.find(
      (c) => c.family === "F1",
    )!.plan;
    const weak = evaluateExit(
      position(plan, { sessionsHeld: 40, fillMicro: 2n * DOLLAR, closeMicro: 2_099_999n }),
    );
    expect(weak.cs?.rule).toBe("time_stop");
    const exact = evaluateExit(
      position(plan, { sessionsHeld: 40, fillMicro: 2n * DOLLAR, closeMicro: 2_100_000n }),
    );
    expect(exact.cs).toBeNull();
    const early = evaluateExit(
      position(plan, { sessionsHeld: 39, fillMicro: 2n * DOLLAR, closeMicro: 1_500_000n }),
    );
    expect(early.cs).toBeNull();
  });

  it("exits: hard maximum hold of 120 sessions regardless of return", () => {
    const plan = runFamilies(inputsOf(f1World()), p).candidates.find(
      (c) => c.family === "F1",
    )!.plan;
    const e = evaluateExit(
      position(plan, { sessionsHeld: 120, fillMicro: 2n * DOLLAR, closeMicro: 4n * DOLLAR }),
    );
    expect(e.cs?.rule).toBe("max_hold");
    expect(
      evaluateExit(
        position(plan, { sessionsHeld: 119, fillMicro: 2n * DOLLAR, closeMicro: 4n * DOLLAR }),
      ).cs,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

/** One U1 code with an ATR history and a day-0 event on session `ago`. */
function eventCode(code = "ZZE") {
  return factsOf(code, "U1", makeBars({ close: wobble(2n * DOLLAR) }), p);
}

describe("F2 quality-value with catalyst", () => {
  const results = (over: Partial<Parameters<typeof ev>[0]> = {}) =>
    ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.03", day0: dayAgo(2), ...over });

  it("reports the fundamentals conditions as BLOCKED-DATA and runs as F2-no-fundamentals", () => {
    const out = runFamilies(inputsOf([eventCode()], { events: [results()] }), p);
    expect(out.blockedData).toHaveLength(1);
    expect(out.blockedData[0]).toMatchObject({ family: "F2", status: "BLOCKED-DATA" });
    expect(out.blockedData[0]!.conditions).toContain("pe_below_gics_sector_median");
    const f2 = out.candidates.find((c) => c.family === "F2")!;
    expect(f2.variant).toBe("F2-no-fundamentals");
    expect(f2.groupKey).toBe(`ZZE:${dayAgo(2)}`);
  });

  it("enters on a + results event with AR >= +3% in the last 5 sessions (boundary exact)", () => {
    const at = runFamilies(inputsOf([eventCode()], { events: [results({ ar: "0.03" })] }), p);
    expect(at.candidates.some((c) => c.family === "F2")).toBe(true);
    const below = runFamilies(
      inputsOf([eventCode()], { events: [results({ ar: "0.0299999" })] }),
      p,
    );
    expect(below.candidates.some((c) => c.family === "F2")).toBe(false);
  });

  it("the event must be within the last 5 sessions: 4 sessions ago yes, 5 no", () => {
    const four = runFamilies(
      inputsOf([eventCode()], { events: [results({ day0: dayAgo(4) })] }),
      p,
    );
    expect(four.candidates.some((c) => c.family === "F2")).toBe(true);
    const five = runFamilies(
      inputsOf([eventCode()], { events: [results({ day0: dayAgo(5) })] }),
      p,
    );
    expect(five.candidates.some((c) => c.family === "F2")).toBe(false);
  });

  it("only results / guidance-up with + polarity count; a - member of the group vetoes it", () => {
    const contract = results({ category: "contract_win" });
    expect(
      runFamilies(inputsOf([eventCode()], { events: [contract] }), p).candidates.some(
        (c) => c.family === "F2",
      ),
    ).toBe(false);
    const guidance = results({ category: "guidance_up" });
    expect(
      runFamilies(inputsOf([eventCode()], { events: [guidance] }), p).candidates.some(
        (c) => c.family === "F2",
      ),
    ).toBe(true);
    const veto = ev({
      code: "ZZE",
      category: "capital_raising",
      polarity: -1,
      day0: dayAgo(2),
      ar: "0.03",
      seq: 1,
    });
    expect(
      runFamilies(inputsOf([eventCode()], { events: [results(), veto] }), p).candidates.some(
        (c) => c.family === "F2",
      ),
    ).toBe(false);
  });

  it("regime gate: SHOCK blocks, RISK-OFF does not", () => {
    const world = inputsOf([eventCode()], { events: [results()] });
    expect(
      runFamilies({ ...world, regime: "RISK-OFF" }, p).candidates.some((c) => c.family === "F2"),
    ).toBe(true);
    const shock = runFamilies({ ...world, regime: "SHOCK" }, p);
    expect(shock.candidates.some((c) => c.family === "F2")).toBe(false);
    expect(shock.blocked.find((b) => b.family === "F2")?.reasons).toEqual(["regime_SHOCK"]);
  });

  it("ranks by event AR, higher first", () => {
    const a = eventCode("ZZE");
    const b = eventCode("ZZF");
    const out = runFamilies(
      inputsOf([a, b], {
        events: [results({ ar: "0.04" }), results({ code: "ZZF", ar: "0.06" })],
      }),
      p,
    );
    expect(out.candidates.filter((c) => c.family === "F2").map((c) => c.code)).toEqual([
      "ZZF",
      "ZZE",
    ]);
  });

  it("initial stop 2.5 x ATR; exits: - guidance event, close below the event-day low, 60 sessions", () => {
    const low = 1_900_000n;
    const out = runFamilies(inputsOf([eventCode()], { events: [results({ low })] }), p);
    const c = out.candidates.find((x) => x.family === "F2")!;
    expect(c.stopSpec.k).toEqual(p.f2.stopAtr);
    const plan = c.plan;
    const down = ev({
      code: "ZZE",
      category: "guidance_down",
      polarity: -1,
      day0: dayAgo(1),
      ar: "-0.04",
    });
    const fillDay = dayAgo(3);
    expect(
      evaluateExit(
        position(plan, { family: "F2", fillDay, events: [down], closeMicro: 2n * DOLLAR }),
      ).cs?.rule,
    ).toBe("guidance_down");
    // an old - guidance event before the fill does not exit
    const old = { ...down, day0: dayAgo(5) };
    expect(
      evaluateExit(
        position(plan, { family: "F2", fillDay, events: [old], closeMicro: 2n * DOLLAR }),
      ).cs,
    ).toBeNull();
    expect(evaluateExit(position(plan, { family: "F2", closeMicro: low - 1n })).cs?.rule).toBe(
      "below_event_low",
    );
    expect(evaluateExit(position(plan, { family: "F2", closeMicro: low })).cs).toBeNull();
    expect(evaluateExit(position(plan, { family: "F2", sessionsHeld: 60 })).cs?.rule).toBe(
      "time_stop",
    );
    expect(evaluateExit(position(plan, { family: "F2", sessionsHeld: 59 })).cs).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe("F3 event drift", () => {
  const drift = (over: Partial<Parameters<typeof ev>[0]> = {}) =>
    ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.04", vol: "2", ...over });
  const world = (events = [drift()], codes = [eventCode()]) => inputsOf(codes, { events });

  it("enters on a + price-sensitive event with AR >= +4% and day-0 volume ratio >= 2 (golden)", () => {
    const out = runFamilies(world(), p);
    const c = out.candidates.find((x) => x.family === "F3")!;
    expect(c.variant).toBe("F3");
    expect(c.rank[0]).toEqual(rat("0.08"));
  });

  it("boundaries: AR 4% and volume ratio 2 pass; just below fails", () => {
    expect(
      runFamilies(world([drift({ ar: "0.0399" })]), p).candidates.some((c) => c.family === "F3"),
    ).toBe(false);
    expect(
      runFamilies(world([drift({ vol: "1.99" })]), p).candidates.some((c) => c.family === "F3"),
    ).toBe(false);
  });

  it("the event must have day 0 = D, be price-sensitive and in the F3 category list", () => {
    expect(
      runFamilies(world([drift({ day0: dayAgo(1) })]), p).candidates.some((c) => c.family === "F3"),
    ).toBe(false);
    expect(
      runFamilies(world([drift({ priceSensitive: false })]), p).candidates.some(
        (c) => c.family === "F3",
      ),
    ).toBe(false);
    expect(
      runFamilies(world([drift({ category: "capital_raising" })]), p).candidates.some(
        (c) => c.family === "F3",
      ),
    ).toBe(false);
    for (const category of ["results", "contract_win", "guidance_up", "takeover_target"] as const) {
      expect(
        runFamilies(world([drift({ category })]), p).candidates.some((c) => c.family === "F3"),
      ).toBe(true);
    }
  });

  it("order cancelled at fill when the next open gaps >= +8% above the day-0 close (exact)", () => {
    const code = eventCode();
    const close = code.bar.close;
    const out = runFamilies(world(), p);
    const c = out.candidates.find((x) => x.family === "F3")!;
    // 8% of the day-0 close, ceiling: open at that level cancels, one micro less fills
    const level = gapCancelLevel(close, p.f3.maxGap);
    expect(c.maxOpenMicro).toBe(level);
    expect(gapCancelsAtFill(level, c.maxOpenMicro!)).toBe(true);
    expect(gapCancelsAtFill(level - 1n, c.maxOpenMicro!)).toBe(false);
    // a close whose +8% is fractional: 1,234,567 x 1.08 = 1,333,332.36 -> cancel from 1,333,333
    expect(gapCancelLevel(1_234_567n, p.f3.maxGap)).toBe(1_333_333n);
    expect(gapCancelLevel(1_000_000n, p.f3.maxGap)).toBe(1_080_000n);
  });

  it("initial stop is the day-0 low; trail 2.5 x ATR only after a +10% close; CS 20 sessions", () => {
    const code = eventCode();
    const c = runFamilies(world(), p).candidates.find((x) => x.family === "F3")!;
    expect(c.stopSpec.k).toBeNull();
    expect(c.stopSpec.level_micro).toBe(code.bar.low);
    expect(initialStop(c.stopSpec, 2n * DOLLAR)).toBe(code.bar.low);
    const fill = 2n * DOLLAR;
    const below = evaluateExit(
      position(c.plan, {
        family: "F3",
        fillMicro: fill,
        highestCloseMicro: 2_199_999n,
        atrMicro: 100_000n,
      }),
    );
    expect(below.isLevels).toEqual([]);
    const at = evaluateExit(
      position(c.plan, {
        family: "F3",
        fillMicro: fill,
        highestCloseMicro: 2_200_000n,
        atrMicro: 100_000n,
      }),
    );
    expect(at.isLevels).toEqual([{ rule: "trail", levelMicro: 2_200_000n - 250_000n }]);
    expect(evaluateExit(position(c.plan, { family: "F3", sessionsHeld: 20 })).cs?.rule).toBe(
      "time_stop",
    );
    expect(evaluateExit(position(c.plan, { family: "F3", sessionsHeld: 19 })).cs).toBeNull();
  });

  it("regime gate: SHOCK blocks, RISK-OFF does not", () => {
    expect(
      runFamilies({ ...world(), regime: "RISK-OFF" }, p).candidates.some((c) => c.family === "F3"),
    ).toBe(true);
    const shock = runFamilies({ ...world(), regime: "SHOCK" }, p);
    expect(shock.candidates.some((c) => c.family === "F3")).toBe(false);
    expect(shock.blocked.some((c) => c.family === "F3")).toBe(true);
  });

  it("ranks by AR x volume ratio", () => {
    const out = runFamilies(
      inputsOf([eventCode("ZZE"), eventCode("ZZF")], {
        events: [drift({ ar: "0.05", vol: "2" }), drift({ code: "ZZF", ar: "0.04", vol: "3" })],
      }),
      p,
    );
    expect(out.candidates.filter((c) => c.family === "F3").map((c) => c.code)).toEqual([
      "ZZF",
      "ZZE",
    ]);
  });

  it("assumed-time events are flagged", () => {
    const out = runFamilies(world([drift({ timed: false })]), p);
    expect(out.candidates.find((c) => c.family === "F3")?.flags).toContain("assumed-time");
  });

  it("override helper leaves other fields alone", () => {
    const c = eventCode();
    expect(override(c, { halted: true }).bar).toBe(c.bar);
  });
});
