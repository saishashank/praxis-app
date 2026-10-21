// @vitest-environment node
// AT-15 golden scenarios for F6, source-off behaviour (DAT-127), determinism and live == replay
// (AGT-003) for the family rule interpreter (M4 T7). Synthetic ZZ data only.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateExit,
  evaluatePositions,
  familyOutputJson,
  runFamilies,
  type CodeFacts,
} from "@/lib/agents/families";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  CENT,
  D,
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
} from "../../fixtures/agents/families/builders";

const p = defaultAgentParams();
const ROOT = path.resolve(__dirname, "../../..");

const leader = (code = "ZZA", tier: "U1" | "U2" = "U1", extra: Partial<CodeFacts> = {}) =>
  override(
    factsOf(
      code,
      tier,
      makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n) }),
      p,
    ),
    extra,
  );
const world = (codes: CodeFacts[]) => [...codes, ...peers("ZZP", "U1", 9, p)];
const f6 = (out: ReturnType<typeof runFamilies>) => out.candidates.filter((c) => c.family === "F6");

describe("F6 leave-one-class-out (ARN-076)", () => {
  const code = () => leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true }); // classes a, c, d
  const run = (off: readonly string[] | undefined) =>
    f6(
      runFamilies(
        inputsOf(world([code()])),
        p,
        off === undefined ? {} : { f6DisabledClasses: off },
      ),
    );

  it("an empty list changes nothing: the output is byte-identical to the live run", () => {
    expect(familyOutputJson(run([]))).toBe(familyOutputJson(run(undefined)));
  });

  it("disabling the insider class (c) leaves (a) and (d) of the three that remain, labelled loco", () => {
    const c = run(["c"])[0]!;
    expect(c.variant).toBe("F6-loco-c");
    expect(c.classes).toEqual(["a", "d"]);
  });

  it("disabling the short-interest class (d) leaves (a) and (c)", () => {
    const c = run(["d"])[0]!;
    expect(c.variant).toBe("F6-loco-d");
    expect(c.classes).toEqual(["a", "c"]);
  });

  it("disabling the technical class (a) leaves no (a) or (b): no entry (at least one of them is needed)", () => {
    expect(run(["a"])).toEqual([]);
  });

  it("disabling two classes keeps the rule that one of (a) or (b) and one more must agree", () => {
    const c = run(["c", "d"])[0];
    expect(c).toBeUndefined(); // only (a) agrees; (b) has no event: 1 of the 2 available
  });
});

describe("F6 multi-agent consensus", () => {
  it("enters on 3 of 4 evidence classes (a, c, d) and lists the contributing family (golden)", () => {
    const code = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true });
    const out = runFamilies(inputsOf(world([code])), p);
    const c = f6(out)[0]!;
    expect(c.code).toBe("ZZA");
    expect(c.variant).toBe("F6");
    expect(c.classes).toEqual(["a", "c", "d"]);
    expect(c.contributors).toEqual(["F1"]);
    expect(c.rank).toEqual([rat("3"), rat("0.5")]);
    expect(c.stopSpec.k).toEqual(p.f6.stopAtr);
  });

  it("two classes are not enough when all four are available", () => {
    const noShort = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: false });
    expect(f6(runFamilies(inputsOf(world([noShort])), p))).toEqual([]);
    const noInsider = leader("ZZA", "U1", { insiderScoreQ: 1, shortDrop: false });
    expect(f6(runFamilies(inputsOf(world([noInsider])), p))).toEqual([]);
  });

  it("insider score counts from +0.5 (2 quarter units); 0.25 does not; unknown is not 0", () => {
    const run = (q: number | null) =>
      f6(
        runFamilies(
          inputsOf(world([leader("ZZA", "U1", { insiderScoreQ: q, shortDrop: true })])),
          p,
        ),
      );
    expect(run(2)[0]?.classes).toEqual(["a", "c", "d"]);
    expect(run(4)[0]?.classes).toEqual(["a", "c", "d"]);
    expect(run(1)).toEqual([]);
    // unknown: the variant without insider needs 2 of (a), (b), (d)
    const unknown = run(null);
    expect(unknown[0]?.variant).toBe("F6-no-insider");
    expect(unknown[0]?.classes).toEqual(["a", "d"]);
  });

  it("F6-no-short-interest when ASIC is off: needs 2 of (a), (b), (c)", () => {
    const code = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true });
    const out = runFamilies(inputsOf(world([code]), { sources: { asx: "on", asic: "off" } }), p);
    const c = f6(out)[0]!;
    expect(c.variant).toBe("F6-no-short-interest");
    expect(c.classes).toEqual(["a", "c"]);
    // a missing short-interest value for the code does the same
    const missing = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: "unknown" });
    expect(f6(runFamilies(inputsOf(world([missing])), p))[0]?.variant).toBe("F6-no-short-interest");
  });

  it("with insider and short interest both missing it needs (a) and (b) (decision 14)", () => {
    const aOnly = leader("ZZA");
    expect(f6(runFamilies(inputsOf(world([aOnly])), p))).toEqual([]);
    const event = ev({
      code: "ZZA",
      category: "results",
      polarity: 1,
      ar: "0.05",
      vol: "2.5",
    });
    const both = runFamilies(inputsOf(world([aOnly]), { events: [event] }), p);
    const c = f6(both)[0]!;
    expect(c.variant).toBe("F6-no-insider-no-short-interest");
    expect(c.classes).toEqual(["a", "b"]);
    expect(c.contributors).toEqual(["F1", "F2", "F3"]);
    expect(c.groupKey).toBeNull();
  });

  it("class (b) counts once however many event families fire on the same event", () => {
    const code = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true });
    const event = ev({ code: "ZZA", category: "results", polarity: 1, ar: "0.05", vol: "2.5" });
    const c = f6(runFamilies(inputsOf(world([code]), { events: [event] }), p))[0]!;
    expect(c.classes).toEqual(["a", "b", "c", "d"]);
    expect(c.rank[0]).toEqual(rat("4"));
  });

  it("at least one of (a)/(b) is required: (c) and (d) alone never enter", () => {
    const quiet = factsOf("ZZA", "U1", makeBars({ close: () => 2n * DOLLAR }), p);
    const code = override(quiet, { insiderScoreQ: 4, shortDrop: true });
    const out = runFamilies(inputsOf(world([code])), p);
    expect(f6(out)).toEqual([]);
    expect(out.blocked.some((b) => b.family === "F6")).toBe(false);
  });

  it("universe U1-U2: U2 enters (with ARN-011), U3 does not", () => {
    const extra: Partial<CodeFacts> = { insiderScoreQ: 2, shortDrop: true };
    const u2 = runFamilies(inputsOf([leader("ZZA", "U2", extra), ...peers("ZZP", "U2", 9, p)]), p, {
      u2OptInF1: true,
    });
    expect(f6(u2)).toHaveLength(1);
    const u3 = runFamilies(
      inputsOf(
        [leader("ZZA", "U1", extra), ...peers("ZZP", "U1", 9, p)].map((c) =>
          override(c, { tier: "U3" }),
        ),
      ),
      p,
      { u2OptInF1: true },
    );
    expect(f6(u3)).toEqual([]);
  });

  it("regime gate: no entries in RISK-OFF or SHOCK", () => {
    const code = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true });
    for (const regime of ["RISK-OFF", "SHOCK"] as const) {
      const out = runFamilies(inputsOf(world([code]), { regime }), p);
      expect(f6(out)).toEqual([]);
      expect(out.blocked.find((b) => b.family === "F6")?.reasons).toEqual([`regime_${regime}`]);
    }
    expect(f6(runFamilies(inputsOf(world([code]), { regime: "NEUTRAL" }), p))).toHaveLength(1);
  });

  it("ranks by number of classes, then insider score, unknown last", () => {
    const four = leader("ZZB", "U1", { insiderScoreQ: 2, shortDrop: true });
    const high = leader("ZZC", "U1", { insiderScoreQ: 4, shortDrop: true });
    const mid = leader("ZZD", "U1", { insiderScoreQ: 2, shortDrop: true });
    const out = runFamilies(
      inputsOf(world([four, high, mid]), {
        events: [ev({ code: "ZZB", category: "results", polarity: 1, ar: "0.05", vol: "2.5" })],
      }),
      p,
    );
    // ZZB has 4 classes; ZZC and ZZD have 3 and ZZC has the higher insider score
    expect(f6(out).map((c) => c.code)).toEqual(["ZZB", "ZZC", "ZZD"]);
  });

  it("exits: its own IS 2 x ATR and CS 20, plus the earliest exit of each contributing family", () => {
    const code = leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true });
    const c = f6(runFamilies(inputsOf(world([code])), p))[0]!;
    // contributor F1: trailing stop and its +5% rule at 40 sessions are in the plan
    expect(c.plan.trails.map((t) => `${t.id}/${t.via}`)).toEqual(["F1:trail/F1"]);
    expect(c.plan.cs.map((r) => r.id)).toEqual(["time_stop", "F1:time_stop", "F1:max_hold"]);
    expect(evaluateExit(position(c.plan, { family: "F6", sessionsHeld: 20 })).cs?.rule).toBe(
      "time_stop",
    );
    expect(evaluateExit(position(c.plan, { family: "F6", sessionsHeld: 19 })).cs).toBeNull();
    const e = evaluateExit(
      position(c.plan, {
        family: "F6",
        highestCloseMicro: 10n * DOLLAR,
        closeMicro: 9n * DOLLAR,
        atrMicro: 500n * CENT,
      }),
    );
    expect(e.isLevels).toEqual([{ rule: "F1:trail", levelMicro: 10n * DOLLAR - 3n * 500n * CENT }]);
  });

  it("exits: a contributing F4 time exit (10 sessions) beats F6's own 20", () => {
    const oversold = factsOf(
      "ZZD",
      "U1",
      makeBars({
        close: (i) => {
          const base = rising(CENT)(Math.min(i, 296));
          return (base * (100n - 4n * BigInt(Math.max(0, i - 296)))) / 100n;
        },
      }),
      p,
    );
    const code = override(oversold, { insiderScoreQ: 2, shortDrop: true });
    const c = f6(runFamilies(inputsOf([code]), p))[0]!;
    expect(c.contributors).toEqual(["F4"]);
    const e = evaluateExit(position(c.plan, { family: "F6", sessionsHeld: 10 }));
    expect(e.cs).toMatchObject({ rule: "F4:time_stop", via: "F4" });
  });
});

// ---------------------------------------------------------------------------------------------

describe("source-off behaviour (DAT-127)", () => {
  const mixed = () => {
    const a = leader("ZZA");
    const e = factsOf("ZZE", "U1", makeBars({ close: () => 2n * DOLLAR }), p);
    const s = factsOf(
      "ZZS",
      "U3",
      makeBars({
        close: () => DOLLAR,
        volume: volumes(1_000_000n, 4_000_000n),
        last: { open: DOLLAR, high: 1_060_000n, low: DOLLAR, close: 1_050_000n },
      }),
      p,
    );
    const events = [
      ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.05", vol: "2.5" }),
      ev({ code: "ZZS", category: "contract_win", polarity: 1, ar: "0.05", vol: "4" }),
      ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.05", day0: dayAgo(1), seq: 1 }),
    ];
    return { codes: [a, e, s, ...peers("ZZP", "U1", 9, p)], events };
  };
  const families = (out: ReturnType<typeof runFamilies>) =>
    [...new Set(out.candidates.map((c) => c.family))].sort();

  it("with ASX on every family can enter", () => {
    const { codes, events } = mixed();
    const out = runFamilies(inputsOf(codes, { events }), p);
    expect(families(out)).toEqual(["F1", "F2", "F3", "F5"]);
  });

  it("ASX off: F2/F3/F5/F6 emit no entries (logged as blocked); F1 continues with a halt proxy", () => {
    const { codes, events } = mixed();
    const code = override(codes[0]!, { insiderScoreQ: 2, shortDrop: true });
    const out = runFamilies(
      inputsOf([code, ...codes.slice(1)], { events, sources: { asx: "off", asic: "on" } }),
      p,
    );
    expect(families(out)).toEqual(["F1"]);
    const f1 = out.candidates.find((c) => c.family === "F1")!;
    expect(f1.flags).toContain("halt-proxy");
    for (const fam of ["F2", "F3", "F5", "F6"] as const) {
      expect(out.blocked.find((b) => b.family === fam)?.reasons).toContain("source_off:asx");
    }
  });

  it("ASX off: F1 and F4 do not enter a code that the halt proxy marks as halted", () => {
    const { codes } = mixed();
    const halted = override(codes[0]!, { halted: true });
    const out = runFamilies(
      inputsOf([halted, ...codes.slice(1)], { sources: { asx: "off", asic: "on" } }),
      p,
    );
    expect(out.candidates.some((c) => c.family === "F1")).toBe(false);
    expect(out.blocked.find((b) => b.family === "F1")?.reasons).toEqual(["halted"]);
  });

  it("ASX off: F4 runs as F4-no-event-filter and ignores the unavailable events", () => {
    const oversold = factsOf(
      "ZZD",
      "U1",
      makeBars({
        close: (i) => {
          const base = rising(CENT)(Math.min(i, 296));
          return (base * (100n - 4n * BigInt(Math.max(0, i - 296)))) / 100n;
        },
      }),
      p,
    );
    const bad = ev({ code: "ZZD", category: "guidance_down", polarity: -1, ar: "-0.05" });
    const off = runFamilies(
      inputsOf([oversold], { events: [bad], sources: { asx: "off", asic: "on" } }),
      p,
    );
    expect(off.candidates.find((c) => c.family === "F4")?.variant).toBe("F4-no-event-filter");
    const on = runFamilies(inputsOf([oversold], { events: [bad] }), p);
    expect(on.candidates.some((c) => c.family === "F4")).toBe(false);
    // replay before announcement coverage: same label without any source being off
    const replay = runFamilies(inputsOf([oversold], { eventCoverage: false }), p);
    expect(replay.candidates.find((c) => c.family === "F4")?.variant).toBe("F4-no-event-filter");
  });

  it("exits continue while the source is off: the exit evaluator takes no source or regime state", () => {
    const { codes, events } = mixed();
    const entry = runFamilies(inputsOf(codes, { events }), p).candidates.find(
      (c) => c.family === "F2",
    )!;
    const off = runFamilies(
      inputsOf(codes, { events, sources: { asx: "off", asic: "off" }, regime: "SHOCK" }),
      p,
    );
    expect(off.candidates.some((c) => c.family === "F2")).toBe(false);
    const neg = ev({ code: "ZZE", category: "guidance_down", polarity: -1, day0: D });
    const exits = evaluatePositions([
      position(entry.plan, { tradeId: "T2", family: "F2", events: [neg], fillDay: dayAgo(2) }),
      position(entry.plan, { tradeId: "T1", family: "F2", sessionsHeld: 60 }),
    ]);
    expect(exits.map((e) => e.tradeId)).toEqual(["T1", "T2"]);
    expect(exits[0]!.cs?.rule).toBe("time_stop");
    expect(exits[1]!.cs?.rule).toBe("guidance_down");
    expect(evaluateExit.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe("determinism and one implementation for live and replay", () => {
  const busy = () => {
    const codes = [
      leader("ZZA", "U1", { insiderScoreQ: 2, shortDrop: true }),
      leader("ZZB", "U1"),
      factsOf("ZZE", "U1", makeBars({ close: () => 2n * DOLLAR }), p),
      ...peers("ZZP", "U1", 9, p),
    ];
    const events = [
      ev({ code: "ZZE", category: "results", polarity: 1, ar: "0.05", vol: "2.5", seq: 1 }),
      ev({ code: "ZZB", category: "contract_win", polarity: 1, ar: "0.06", vol: "3" }),
      ev({ code: "ZZE", category: "guidance_up", polarity: 1, ar: "0.04", day0: dayAgo(2) }),
    ];
    return inputsOf(codes, { events });
  };

  it("the same inputs give byte-identical output, in any input order", () => {
    const base = busy();
    const a = familyOutputJson(runFamilies(base, p));
    const b = familyOutputJson(runFamilies(structuredClone(base), p));
    const shuffled = {
      ...base,
      codes: [...base.codes].reverse(),
      events: [...base.events].reverse(),
    };
    const c = familyOutputJson(runFamilies(shuffled, p));
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(JSON.parse(a).candidates.length).toBeGreaterThan(0);
  });

  it("ties on rank break by higher ADV, then code ascending (FAM-001)", () => {
    const base = leader("ZZA");
    const mk = (code: string, adv: ReturnType<typeof rat> | null) =>
      override(base, { code, ind: { ...base.ind, adv } });
    const tied = [mk("ZZC", rat("5000000")), mk("ZZB", rat("9000000")), mk("ZZD", rat("5000000"))];
    // identical series -> identical return, so the tier percentile ties and ranks tie
    const out = runFamilies(inputsOf([...tied, ...peers("ZZP", "U1", 9, p)]), p, {
      families: ["F1"],
    });
    expect(out.candidates.map((c) => c.code)).toEqual(["ZZB", "ZZC", "ZZD"]);
  });

  it("nothing in the output depends on a live/replay mode: one function, no mode switch", () => {
    const dir = path.join(ROOT, "src/lib/agents/families");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/\b(isReplay|isLive|replayMode|liveMode)\b/);
      expect(src, f).not.toMatch(/Date\.now|new Date\(\)|Math\.random|process\.env/);
    }
  });

  it("facts built from a snapshot cut at D equal facts built live from the same bars", () => {
    const full = makeBars({ close: rising(CENT), volume: volumes(1_000_000n, 2_000_000n), n: 305 });
    const live = full.slice(0, 300);
    const replay = full.slice(0, 300);
    const fl = factsOf("ZZA", "U1", live, p);
    const fr = factsOf("ZZA", "U1", replay, p);
    expect(familyOutputJson(fl)).toBe(familyOutputJson(fr));
  });
});
