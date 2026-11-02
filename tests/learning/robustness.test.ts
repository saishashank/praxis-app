// @vitest-environment node
// M14 WP3: ARN-106 time-stop-only comparator, ARN-107 one-tick slip, ARN-108 development net / gate and
// the trail-challenger rule of the generator (D-222, D-223, D-224). Synthetic ZZ world, no database.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { getCostProfile } from "@/lib/arena/costs";
import { comparatorLedger, timeStopOnly } from "@/lib/replay/exitAblation";
import { replayLedger, type LedgerEntry } from "@/lib/replay/ledger";
import { developmentNet, oneTickAdverse, repricedNet } from "@/lib/replay/sensitivity";
import { pickWinner, TRAIL_KEYS, type Evaluated } from "@/lib/learning/challengerGenerator";
import { summarise } from "@/lib/learning/robustnessStage";
import { CENT, DOLLAR, makeBars, wobble } from "../fixtures/agents/families/builders";
import { buildWorld, SESSIONS, type WorldCode } from "../fixtures/replay/ledgerWorld";

const p = defaultAgentParams();
const SPIKES = new Set([280, 282, 285, 288, 295]);
const leaderClose = (i: number): bigint => {
  let c = DOLLAR + BigInt(i) * CENT;
  if (i >= 283) c -= 20n * CENT;
  if (i >= 285) c += 70n * CENT;
  return c;
};
const leader: WorldCode = {
  code: "ZZA",
  tier: "U1",
  bars: makeBars({
    close: leaderClose,
    volume: (i) => (SPIKES.has(i) ? 2_000_000n : 1_000_000n),
  }),
};
const peers: WorldCode[] = Array.from({ length: 40 }, (_, i) => ({
  code: `ZZP${String(i).padStart(2, "0")}`,
  tier: "U1" as const,
  bars: makeBars({ close: wobble(2n * DOLLAR + BigInt(i) * 3n * CENT) }),
}));

function firstPass() {
  const world = buildWorld([leader, ...peers], p);
  const outputs = new Map();
  const result = replayLedger(world, {
    params: p,
    from: SESSIONS[270]!,
    familyOptions: { families: ["F1"] },
    controls: false,
    outputSink: outputs,
  });
  return { world, outputs, result };
}

describe("ARN-106 time-stop-only comparator", () => {
  it("exits the same entries without the stop, reusing the first pass's family outputs", () => {
    const { world, outputs, result } = firstPass();
    const calls = world.inputsCalls.length;
    expect(outputs.size).toBeGreaterThan(0);
    const comp = comparatorLedger(world, "AU", p, outputs);
    expect(world.inputsCalls.length).toBe(calls); // runFamilies did not run again
    const rule = result.entries.find((e) => e.code === "ZZA" && e.row.entry_d === SESSIONS[281]);
    const same = comp.entries.find((e) => e.code === "ZZA" && e.row.entry_d === SESSIONS[281]);
    expect(rule?.exitRule).toBe("stop");
    expect(same).toBeDefined();
    expect(same!.exitRule).not.toBe("stop");
    expect(comp.entries.every((e) => e.exitRule !== "stop")).toBe(true);
  });

  it("is deterministic", () => {
    const a = firstPass();
    const b = firstPass();
    const ca = comparatorLedger(a.world, "AU", p, a.outputs);
    const cb = comparatorLedger(b.world, "AU", p, b.outputs);
    expect(ca.entries.map((e) => [e.row.id, e.net])).toEqual(
      cb.entries.map((e) => [e.row.id, e.net]),
    );
  });

  it("timeStopOnly drops stops, trails and conditional rules", () => {
    const plan = timeStopOnly({
      initialStops: [
        { id: "s", via: null, spec: { atr_micro: 1n, k: null, cap: null, level_micro: null } },
      ],
      trails: [{ id: "trail", via: null, k: { num: 1n, den: 1n }, activateGain: null }],
      cs: [
        {
          id: "time_stop",
          via: null,
          kind: "time_stop",
          sessions: 40,
          minReturn: { num: 1n, den: 20n },
        },
        { id: "max_hold", via: null, kind: "time_stop", sessions: 120, minReturn: null },
        { id: "ev", via: null, kind: "negative_event", categories: null },
      ],
    } as unknown as Parameters<typeof timeStopOnly>[0]);
    expect(plan.initialStops).toEqual([]);
    expect(plan.trails).toEqual([]);
    expect(plan.cs.map((r) => r.id)).toEqual(["max_hold"]);
  });
});

describe("ARN-107 one adverse tick per side", () => {
  const profile = getCostProfile("P5");
  const closed = (): LedgerEntry[] => firstPass().result.entries.filter((e) => e.net !== null);

  it("zero extra ticks reproduces the ledger's net exactly", () => {
    const rows = closed();
    expect(rows.length).toBeGreaterThan(0);
    for (const e of rows) {
      const n = repricedNet(e, profile, 0)!;
      expect(n.num * e.net!.den).toBe(e.net!.num * n.den);
    }
  });

  it("one tick lowers every net return, the same input gives the same output", () => {
    const rows = closed();
    const slip = oneTickAdverse(rows, profile);
    expect(slip.length).toBe(rows.length);
    rows.forEach((e, i) => {
      const a = Number(slip[i]!.net.num) / Number(slip[i]!.net.den);
      expect(a).toBeLessThan(Number(e.net!.num) / Number(e.net!.den));
    });
    expect(oneTickAdverse(rows, profile)).toEqual(slip);
  });
});

describe("ARN-108 development net and absolute gate", () => {
  const stats = { bootstrapReplicationsMin: 200, minTrades: 20, minBlocks: 3 };
  const rows = (mean: number) =>
    Array.from({ length: 60 }, (_, i) => ({ session: i * 2, net: mean + (i % 5) * 0.001 }));

  it("passes on a clearly positive set, fails on a negative one, deterministic", () => {
    const up = developmentNet(rows(0.05), 120, 10, stats, "s");
    expect(up.passesAbsoluteGate).toBe(true);
    expect(up.netLower90).toBeGreaterThan(0);
    expect(developmentNet(rows(0.05), 120, 10, stats, "s")).toEqual(up);
    const down = developmentNet(rows(-0.05), 120, 10, stats, "s");
    expect(down.passesAbsoluteGate).toBe(false);
  });

  it("too few rows or blocks never pass and carry no bound", () => {
    const few = developmentNet(rows(0.05).slice(0, 5), 120, 10, stats, "s");
    expect(few.passesAbsoluteGate).toBe(false);
    expect(few.netLower90).toBeNull();
    expect(few.meanNet).not.toBeNull();
    expect(developmentNet([], 120, 10, stats, "s").meanNet).toBeNull();
  });
});

describe("ARN-106 in the generator: a trail challenger must beat the comparator", () => {
  const ev = (key: string, excess: number, meanNet: number | null): Evaluated => ({
    candidate: { key, direction: "up", value: 1, hinted: false, params: {} },
    evaluation: { split: "development", rows: 200, blocks: 20, meanExcess: excess, meanNet },
  });
  const stats = { minTrades: 100, minBlocks: 15 };

  it("drops the better trail candidate when it does not beat the comparator and tries the next", () => {
    expect(TRAIL_KEYS).toContain("f1_trail_atr");
    const list = [ev("f1_trail_atr", 0.05, 0.01), ev("f1_initial_stop_atr", 0.03, 0.01)];
    expect(pickWinner(list, 0, stats)!.key).toBe("f1_trail_atr");
    expect(pickWinner(list, 0, stats, 0.02)!.key).toBe("f1_initial_stop_atr");
    expect(pickWinner(list, 0, stats, 0.005)!.key).toBe("f1_trail_atr");
  });
});

describe("summarise", () => {
  it("n, mean, median, hit rate, sessions held", () => {
    const s = summarise([0.1, -0.05, 0.02], [4, 6, null]);
    expect(s).toEqual({
      n: 3,
      mean_net: (0.1 - 0.05 + 0.02) / 3,
      median_net: 0.02,
      hit_rate: 2 / 3,
      mean_sessions_held: 5,
    });
    expect(summarise([], []).mean_net).toBeNull();
  });
});
