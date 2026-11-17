// @vitest-environment node
// D-908, D-1062 (Owner O-84): how the replay turns a night's strategy candidates into pick inputs, with
// the strategy engine replaced by fixed candidates and the world by a stub (invented ZZ numbers): the
// tightest of several stops, a candidate with no facts skipped, the stored development record (scenario,
// aim share, hold, history line), a record with too little history, a record in another format, the
// label dated on or before the night (never a later one), halted and illiquid codes, and the progress
// callback of the whole run.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewBar } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const mocked = vi.hoisted(() => ({ candidates: [] as unknown[] }));
vi.mock("@/lib/agents/families", async (orig) => ({
  ...(await orig<typeof import("@/lib/agents/families")>()),
  runFamilies: () => ({ d: "x", candidates: mocked.candidates, blocked: [], blockedData: [] }),
}));

import {
  inputsAsOf,
  openReplay,
  replayNightsScored,
  type PickReplayDeps,
} from "@/lib/scorecard/pickReplay";

afterEach(cleanupTempDbs);

const params = defaultAgentParams();
const D = "2026-11-12";
const m = (n: number): bigint => BigInt(Math.round(n * 1_000_000));
const days = Array.from({ length: 30 }, (_, i) => {
  const t = new Date(Date.UTC(2026, 9, 1 + i));
  return t.toISOString().slice(0, 10);
});

const bars = (price: number, until: string = D): ViewBar[] =>
  days
    .filter((d) => d <= until)
    .map((d) => ({
      d,
      open: m(price),
      high: m(price),
      low: m(price),
      close: m(price),
      volume: 100_000n,
    }));

type Fact = { code: string; tier: string; halted?: boolean; price: number };
function stub(facts: Fact[], over: Record<string, unknown> = {}): PickReplayDeps["world"] {
  const by = new Map(facts.map((f) => [f.code, f]));
  return {
    market: "AU",
    familyInputs: () => ({
      codes: facts.map((f) => ({
        code: f.code,
        tier: f.tier,
        halted: f.halted ?? false,
        bar: { close: m(f.price) },
      })),
    }),
    // a bar after the night too: it must never reach the inputs
    barsOf: (code: string) => (by.has(code) ? bars(by.get(code)!.price, "2026-11-30") : []),
    calendarRows: () => [],
    sessions: [],
    ...over,
  } as unknown as PickReplayDeps["world"];
}

const cand = (
  family: string,
  code: string,
  stops: Array<Record<string, unknown>>,
  rules: Array<{ id: string; pass: boolean; value: string; threshold: string }> = [],
) => ({
  family,
  ruleVersion: `${family}.v1`,
  variant: family,
  code,
  tier: "U1",
  rankText: "9/1",
  plan: { initialStops: stops.map((spec) => ({ id: "s", spec })) },
  rules,
});
const stopLevel = (level: number) => ({
  atr_micro: null,
  k: null,
  cap: null,
  level_micro: m(level),
});

const summary = (over: Record<string, unknown> = {}) => ({
  v: 1,
  lineage: "AU:F1",
  split: {
    version: 1,
    dev_end_d: "2026-01-02",
    deferred_until_d: null,
    data_end_d: "2026-01-02",
    stored: false,
  },
  n: 45,
  insufficient: false,
  reason: null,
  p10_ppm: -60_000,
  p50_ppm: 20_000,
  p90_ppm: 90_000,
  hold_median: 6,
  median_drop_ppm: 30_000,
  aim_reach_ppm: 100_000,
  win_rate_ppm: 580_000,
  ...over,
});

async function store(db: Client, group: string, value: unknown, runId = "r"): Promise<void> {
  await db.execute({
    sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, 'dev_summary', '2026-01-02', ?)",
    args: [runId, `pick_history:${group}`, JSON.stringify(value)],
  });
}
async function label(db: Client, family: string, id: string, lab: string, d: string) {
  const ex = `E-${family}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO execution (id, market, kind, family, variant, rule_version, cost_profile)
          VALUES (?, 'AU', 'E', ?, ?, ?, 'P5')`,
    args: [ex, family, "U", `${family}.v1`],
  });
  await db.execute({
    sql: `INSERT INTO label (id, execution_id, rule_version, variant, label, n, d)
          VALUES (?, ?, ?, ?, ?, 40, ?)`,
    args: [id, ex, `${family}.v1`, "U", lab, d],
  });
}

describe("inputsAsOf with fixed candidates", () => {
  const facts: Fact[] = [
    { code: "ZA1", tier: "U1", price: 10 },
    { code: "ZA2", tier: "U1", price: 12 },
    { code: "ZA3", tier: "U2", price: 15 },
    { code: "ZA4", tier: "U1", price: 11 },
    { code: "ZHL", tier: "U1", price: 10, halted: true },
    { code: "ZSM", tier: "U3", price: 5 },
  ];

  it("builds the inputs: the tightest stop, stored history and the label of the night; skips unknown codes", async () => {
    const db = await freshDb("main");
    await store(db, "F1|F1.v1|F1", summary());
    await store(db, "F2|F2.v1|F2", summary({ insufficient: true }));
    await store(db, "F4|F4.v1|F4", { v: 99 });
    await label(db, "F1", "L-early", "PASSED-BACKTEST", "2026-10-02");
    await label(db, "F1", "L-late", "FAILED", "2026-11-20"); // after the night: not seen that evening
    mocked.candidates = [
      cand(
        "F1",
        "ZA1",
        [stopLevel(8), stopLevel(9)],
        [
          { id: "high_lookback", pass: true, value: "true", threshold: "20-session high" },
          { id: "volume_ratio", pass: false, value: "1.1", threshold: "1.5" },
        ],
      ),
      cand("F2", "ZA2", []),
      cand("F4", "ZA4", [stopLevel(10)]),
      cand("F1", "ZGONE", [stopLevel(1)]), // no facts for this code
      cand("F1", "ZA3", [{ atr_micro: null, k: null, cap: null, level_micro: null }]),
    ];
    const world = stub(facts);
    const deps: PickReplayDeps = { db, world, params };
    const opened = await openReplay(deps);
    for (let pass = 0; pass < 2; pass += 1) {
      // the second pass reads the history and label caches
      const { inputs, universe } = await inputsAsOf(deps, opened, D);
      const strategy = inputs.filter((i) => i.ruleVersion !== "SL.v1");
      expect(strategy.map((i) => i.code)).toEqual(["ZA1", "ZA2", "ZA4", "ZA3"]);
      const [a1, a2, a4, a3] = strategy;
      // the tightest of two stops, as a price level
      expect(a1!.stopMicro).toBe(m(9));
      expect(a1!.referenceMicro).toBe(m(10));
      expect(a1!.label).toBe("PASSED-BACKTEST");
      expect(a1!.scenario).toEqual({ n: 45, badPpm: -60_000, typicalPpm: 20_000, goodPpm: 90_000 });
      expect(a1!.aimReachPpm).toBe(100_000);
      expect(a1!.holdMedianSessions).toBe(6);
      expect(a1!.medianDropPpm).toBe(30_000);
      expect(a1!.rankScore).toBe("9/1");
      expect(a1!.signalId).toContain("F1.v1");
      // only the rules that passed are listed, after the history line
      expect(a1!.basedOn).toHaveLength(2);
      expect(a1!.basedOn[0]).toContain("45");
      expect(a1!.basedOn[1]).toBe("high_lookback: true (needed 20-session high)");
      // no stop spec at all: no stop; no stored record: no history, an unvalidated label
      expect(a2!.stopMicro).toBeNull();
      expect(a2!.label).toBe("UNVALIDATED");
      // too little history: no scenario, no aim share, but the hold and the drop are known
      expect(a2!.scenario).toBeNull();
      expect(a2!.aimReachPpm).toBeNull();
      expect(a2!.holdMedianSessions).toBe(6);
      expect(a2!.basedOn).toEqual([]);
      // a record in another format is no record
      expect(a4!.scenario).toBeNull();
      expect(a4!.holdMedianSessions).toBeNull();
      expect(a4!.medianDropPpm).toBeNull();
      expect(a4!.aimReachPpm).toBeNull();
      // a stop spec without any term gives a zero stop (nothing to hold above)
      expect(a3!.stopMicro).toBe(0n);
      // the universe leaves out the halted code; the other tiers are kept with their volatility
      expect(universe.map((u) => u.code)).toEqual(["ZA1", "ZA2", "ZA3", "ZA4", "ZSM"]);
      expect(universe.find((u) => u.code === "ZA3")!.tier).toBe("U2");
    }
  }, 60_000);

  it("a night with no candidates has only the shortlist; no bar after the night is handed in", async () => {
    const db = await freshDb("main");
    mocked.candidates = [];
    const seen: string[] = [];
    const world = stub(facts, {
      barsOf: (code: string) => {
        const list = bars(10, "2026-11-30");
        seen.push(code);
        return list;
      },
    });
    const deps: PickReplayDeps = { db, world, params };
    const { inputs } = await inputsAsOf(deps, await openReplay(deps), D);
    expect(inputs.every((i) => i.ruleVersion === "SL.v1")).toBe(true);
    // halted and small-tier codes never reach the shortlist
    expect(inputs.map((i) => i.code)).not.toContain("ZHL");
    expect(inputs.map((i) => i.code)).not.toContain("ZSM");
    expect(seen.length).toBeGreaterThan(0);
  }, 60_000);
});

describe("replayNightsScored", () => {
  it("reports progress once a night and gives the nights it tried, even when none can be scored", async () => {
    const db = await freshDb("main");
    mocked.candidates = [];
    const sessions = ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"];
    const world = stub([{ code: "ZA1", tier: "U1", price: 10 }], {
      sessions,
      // no bar on any later session: no night has a move to score
      bar: () => undefined,
      indexBarsOf: () => [],
    });
    const seen: Array<[number, number]> = [];
    const r = await replayNightsScored({ db, world, params }, 2, (done, total) =>
      seen.push([done, total]),
    );
    expect(r.nights).toEqual(["2026-11-10", "2026-11-11"]);
    expect(r.days).toEqual([]);
    // D-1083: no passports in the database, so both nights are counted as having none
    expect(r.cortex).toMatchObject({ nights: 2, noPassports: 2, featured: 0 });
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
    // without a callback the run is the same
    expect((await replayNightsScored({ db, world, params }, 1)).nights).toEqual(["2026-11-11"]);
    // a world with a single session has no night to replay
    const one = stub([], { sessions: ["2026-11-12"], bar: () => undefined, indexBarsOf: () => [] });
    expect(await replayNightsScored({ db, world: one, params }, 3)).toMatchObject({
      nights: [],
      cortex: { nights: 0 },
    });
  }, 60_000);
});

describe("openReplay", () => {
  it("names the live rule version of each family when the database has them, none when it has not", async () => {
    const db = await freshDb("main");
    const world = stub([]);
    const empty = await openReplay({ db, world, params });
    expect(empty.ruleVersions).toEqual({});
    expect(empty.market).toBe("AU");
    await seedRuleVersions(db, { market: "AU", d: "2030-01-02" });
    const seeded = await openReplay({ db, world, params, market: "AU" });
    expect(seeded.ruleVersions.F1).toBe("F1.v1");
    expect(Object.keys(seeded.ruleVersions).sort()).toEqual(["F1", "F2", "F3", "F4", "F5", "F6"]);
    // the label of a group nobody validated is unvalidated, and is remembered
    expect(await seeded.labelOf("F1", "F1.v1", D)).toBe("UNVALIDATED");
    expect(await seeded.labelOf("F1", "F1.v1", D)).toBe("UNVALIDATED");
    expect(await seeded.historyOf("F1", "F1.v1", "F1")).toBeNull();
  }, 60_000);
});
