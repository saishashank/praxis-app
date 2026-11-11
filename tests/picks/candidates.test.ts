// @vitest-environment node
// D-980…D-984: candidate picks. The plan of a share (2 x ATR stop within 3–10 %, aim twice the stop,
// 20 trading days), the inputs of the open measures (per measure and total limits, a code used once,
// the next share when the stop rule fails), the pick builder places them only in the places the
// strategy and shortlist picks leave free (never above rank 10), the database step on a real migrated
// file (probe values, the scored-set fallback, the config keys) and the finished-result tally.
// Synthetic ZZ data only.
import type { Client, InStatement } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  candidateAngle,
  candidateInputs,
  candidatePlan,
  candidateRuleVersion,
  candidateTally,
  isCandidateRule,
  loadCandidateInputs,
  type CandidateCode,
} from "@/lib/picks/candidates";
import { generatePicks, PICK_RANK_MAX } from "@/lib/picks/generate";
import { runPicksNight } from "@/lib/picks/nightly";
import type { DayBar } from "@/lib/picks/shortlist";
import { writePicks } from "@/lib/picks/store";
import type { PickInput } from "@/lib/picks/types";
import { logEvent } from "@/lib/cortex/learn/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { params } from "./harness";

afterEach(cleanupTempDbs);

const D = "2030-03-22";
const M = 1_000_000n;

/** 30 weekday bars ending D; close 10, daily range `range` dollars around it. */
function barsOf(range: number, n = 30): DayBar[] {
  const out: DayBar[] = [];
  const t = new Date(`${D}T00:00:00Z`);
  while (out.length < n) {
    if (t.getUTCDay() !== 0 && t.getUTCDay() !== 6) {
      const d = t.toISOString().slice(0, 10);
      const c = 10_000_000n + BigInt(out.length % 2) * 10_000n;
      const half = BigInt(Math.round((range / 2) * 1e6));
      out.unshift({
        d,
        openMicro: c,
        highMicro: c + half,
        lowMicro: c - half,
        closeMicro: c,
        volume: 100_000,
      });
    }
    t.setUTCDate(t.getUTCDate() - 1);
  }
  return out;
}

const share = (code: string, range: number, tier: "U1" | "U2" | "U3" = "U1"): CandidateCode => ({
  code,
  tier,
  bars: barsOf(range),
});

describe("candidatePlan (pure)", () => {
  it("a 2 x ATR stop between 3 % and 10 %, the volatility and the traded value", () => {
    const p = candidatePlan(share("ZZ01", 0.25), D)!; // ATR about 0.25 -> stop 5 % below
    expect(p.stopPpm).toBeGreaterThan(40_000);
    expect(p.stopPpm).toBeLessThan(60_000);
    expect(p.vol).not.toBeNull();
    expect(p.advMicro).toBeGreaterThan(0n);
    expect(candidatePlan(share("ZZ02", 0.05), D)).toBeNull(); // stop 1 % away: too close
    expect(candidatePlan(share("ZZ03", 1), D)).toBeNull(); // stop 20 % away: too far
    expect(candidatePlan({ code: "ZZ04", tier: "U1", bars: barsOf(0.25, 10) }, D)).toBeNull();
    expect(candidatePlan(share("ZZ05", 0.25), "2030-04-01")).toBeNull(); // no bar on the night
  });
});

describe("candidateInputs (pure)", () => {
  const shares = new Map(
    [
      share("ZZ01", 0.05), // stop too close: skipped for the next share
      share("ZZ02", 0.25),
      share("ZZ03", 0.3),
      share("ZZ04", 0.25, "U3"), // not liquid
      share("ZZ05", 0.25),
    ].map((s) => [s.code, s] as const),
  );
  const measures = [
    { angleId: "A-D2-07", codes: ["ZZ01", "ZZ02", "ZZ03"] },
    { angleId: "A-D1-10", codes: ["ZZ04", "ZZ02", "ZZ05", "ZZ09"] },
  ];

  it("one per measure in id order, a code used once, the label, rule version and words", () => {
    const xs = candidateInputs(measures, shares, { market: "AU", d: D, perMeasure: 1, max: 3 });
    expect(xs.map((x) => [x.ruleVersion, x.code])).toEqual([
      ["CAND.v1:A-D1-10", "ZZ02"],
      ["CAND.v1:A-D2-07", "ZZ03"],
    ]);
    const x = xs[0]!;
    expect(x).toMatchObject({
      signalId: `candidate:AU:${D}:A-D1-10:ZZ02`,
      family: "F1",
      variant: "C",
      label: "UNVALIDATED",
      holdMedianSessions: 20,
      aimReachPpm: null,
    });
    expect(x.scenario!.n).toBe(0);
    expect(x.scenario!.goodPpm).toBe(-2 * x.scenario!.badPpm);
    expect(x.medianDropPpm).toBe(-x.scenario!.badPpm);
    expect(x.basedOn[0]).toBe(
      "From the candidate measure: strength against its sector — being tested, not proven.",
    );
    expect(x.basedOn[1]).toMatch(/^Plan: stop-loss \d+\.\d% below/);
    // the rank score sits below any shortlist score (k / 1e6)
    expect(x.rankScore).toMatch(/\/1000000000$/);
  });

  it("the per-measure and total limits, the exclusions and a custom measure name", () => {
    const two = candidateInputs(measures, shares, {
      market: "AU",
      d: D,
      perMeasure: 2,
      max: 3,
      exclude: new Set(["ZZ05"]),
      names: (id) => `measure ${id}`,
    });
    expect(two.map((x) => x.code)).toEqual(["ZZ02", "ZZ03"]);
    expect(two[0]!.basedOn[0]).toContain("measure A-D1-10");
    const one = candidateInputs(measures, shares, { market: "AU", d: D, perMeasure: 2, max: 1 });
    expect(one).toHaveLength(1);
    expect(candidateInputs([], shares, { market: "AU", d: D, perMeasure: 1, max: 3 })).toEqual([]);
  });

  it("the rule-version helpers", () => {
    expect(candidateRuleVersion("A-D2-07")).toBe("CAND.v1:A-D2-07");
    expect(isCandidateRule("CAND.v1:A-D2-07")).toBe(true);
    expect(isCandidateRule("SL.v1")).toBe(false);
    expect(candidateAngle("CAND.v1:A-D2-07")).toBe("A-D2-07");
    expect(candidateAngle("CAND.v1:")).toBeNull();
    expect(candidateAngle("F1.v1")).toBeNull();
  });
});

const input = (code: string, over: Partial<PickInput> = {}): PickInput => ({
  signalId: `sig:${code}`,
  cardId: null,
  family: "F1",
  ruleVersion: "F1.v1",
  variant: "U",
  code,
  tier: "U1",
  rankScore: "5/1",
  label: "NOT-DEMONSTRATED",
  referenceMicro: 10n * M,
  stopMicro: 9_500_000n,
  advValueMicro: 5_000_000_000n,
  vol: 0.01,
  scenario: { n: 40, badPpm: -50_000, typicalPpm: 10_000, goodPpm: 100_000 },
  aimReachPpm: 300_000,
  holdMedianSessions: 10,
  medianDropPpm: 50_000,
  factors: [],
  basedOn: ["a"],
  ...over,
});

const gctx = {
  market: "AU",
  d: D,
  calendar: [],
  picks: params.picks,
  universe: [],
  createdAt: `${D}T07:00:00.000Z`,
};

describe("generatePicks extras (D-982)", () => {
  it("candidates come after every strategy pick of a profile, even an unproven label sorts below them", () => {
    const strategy = [input("ZZ01"), input("ZZ02", { label: "FAILED" })];
    const cand = candidateInputs(
      [{ angleId: "A-D2-07", codes: ["ZZ03", "ZZ01"] }],
      new Map([share("ZZ03", 0.25), share("ZZ01", 0.25)].map((s) => [s.code, s] as const)),
      { market: "AU", d: D, perMeasure: 2, max: 2 },
    );
    const picks = generatePicks(strategy, gctx, { inputs: cand, perProfile: cand.length });
    for (const profile of Object.keys(params.picks.profiles)) {
      const mine = picks.filter((p) => p.profile === profile);
      if (mine.length === 0) continue;
      const firstCand = mine.findIndex((p) => isCandidateRule(p.ruleVersion));
      const lastOwn = mine.map((p) => isCandidateRule(p.ruleVersion)).lastIndexOf(false);
      if (firstCand >= 0) expect(firstCand).toBeGreaterThan(lastOwn);
      // one pick per company per profile: ZZ01 is never picked twice
      expect(mine.filter((p) => p.code === "ZZ01").length).toBeLessThanOrEqual(1);
    }
    expect(picks.some((p) => p.code === "ZZ03" && isCandidateRule(p.ruleVersion))).toBe(true);
    // no extras: the same picks as before the change
    expect(generatePicks(strategy, gctx)).toEqual(generatePicks(strategy, gctx, undefined));
  });

  it("never above rank 10 and never more than perProfile a profile", () => {
    const full = Array.from({ length: 12 }, (_, i) =>
      input(`ZZ${String(i + 10)}`, { rankScore: `${20 - i}/1` }),
    );
    const cand = [input("ZZ99", { ruleVersion: "CAND.v1:A-D2-07", rankScore: "1/1000000000" })];
    const picks = generatePicks(
      full,
      { ...gctx, picks: { ...params.picks, picksPerProfile: 10, picksMaxPerFamily: 10 } },
      { inputs: cand, perProfile: 1 },
    );
    expect(Math.max(...picks.map((p) => p.rank))).toBeLessThanOrEqual(PICK_RANK_MAX);
    expect(picks.some((p) => p.code === "ZZ99")).toBe(false);
    const roomy = generatePicks(full.slice(0, 2), gctx, {
      inputs: [
        cand[0]!,
        { ...cand[0]!, code: "ZZ98" },
        { ...cand[0]!, code: "ZZ97", stopMicro: null },
      ],
      perProfile: 1,
    });
    for (const profile of Object.keys(params.picks.profiles)) {
      const c = roomy.filter((p) => p.profile === profile && isCandidateRule(p.ruleVersion));
      expect(c.length).toBeLessThanOrEqual(1);
    }
  });
});

// ---- the database step ------------------------------------------------------------------------------

async function seed(db: Client, codes: readonly [string, number][]): Promise<void> {
  for (const [code, range] of codes) {
    await db.execute({
      sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, halted) VALUES ('AU', ?, ?, 'active', 'U1', 0)`,
      args: [D, code],
    });
    for (const b of barsOf(range)) {
      await db.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'zz', 't', 't')`,
        args: [
          code,
          b.d,
          Number(b.openMicro) / 1e6,
          Number(b.highMicro) / 1e6,
          Number(b.lowMicro) / 1e6,
          Number(b.closeMicro) / 1e6,
          b.volume,
        ],
      });
    }
  }
  // the probe was opened on an earlier night, so the Cortex stage computed it tonight
  await logEvent(db, {
    market: "AU",
    d: "2030-03-01",
    seq: 200,
    kind: "probe_open",
    family: "F1",
    angleId: "A-D2-07",
    evidence: {},
    words: "w",
    createdAt: "t",
  });
}

describe("loadCandidateInputs and candidateTally (database)", () => {
  it("ranks by tonight's probe values, skips a share already offered, honours the config keys", async () => {
    const db = await freshDb("main");
    await seed(db, [
      ["ZZ01", 0.25],
      ["ZZ02", 0.25],
      ["ZZ03", 0.25],
    ]);
    for (const [code, v] of [
      ["ZZ01", 0.9],
      ["ZZ02", 0.5],
      ["ZZ03", null],
      ["ZZ08", 1],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version, manifest_id)
              VALUES ('AU', ?, ?, 'A-D2-07', ?, ?, 1, 'm')`,
        args: [D, code, v, v === null ? "x" : null],
      });
    }
    const xs = await loadCandidateInputs(db, { market: "AU", d: D, exclude: new Set(["ZZ01"]) });
    expect(xs.map((x) => [x.code, x.ruleVersion])).toEqual([["ZZ02", "CAND.v1:A-D2-07"]]);
    // the Owner sets the total to 0: no candidate pick
    await db.execute({
      sql: "INSERT INTO config_version (key, scope, value_json, changed_at) VALUES ('picks_candidate_max', 'global', '0', 't')",
    });
    expect(await loadCandidateInputs(db, { market: "AU", d: D, exclude: new Set() })).toEqual([]);
    db.close();
  });

  it("falls back to the measure's scored-set value; nothing without an open measure", async () => {
    const db = await freshDb("main");
    expect(await loadCandidateInputs(db, { market: "AU", d: D, exclude: new Set() })).toEqual([]);
    await seed(db, [
      ["ZZ01", 0.25],
      ["ZZ02", 0.25],
    ]);
    for (const [code, v] of [
      ["ZZ01", 0.1],
      ["ZZ02", 0.7],
    ] as const) {
      await db.execute({
        sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
              VALUES ('AU', ?, ?, ?, '{}', 'h', 'm')`,
        args: [D, code, JSON.stringify({ "A-D2-07": v })],
      });
    }
    const xs = await loadCandidateInputs(db, { market: "AU", d: D, exclude: new Set() });
    expect(xs.map((x) => x.code)).toEqual(["ZZ02"]);
    // no share has a value tonight: nothing
    const later = await loadCandidateInputs(db, {
      market: "AU",
      d: "2030-03-25",
      exclude: new Set(),
    });
    expect(later).toEqual([]);
    db.close();
  });

  it("the nightly phase publishes them as picks; a failing candidate step never blocks the others", async () => {
    const db = await freshDb("main");
    await seed(db, [["ZZ02", 0.25]]);
    await db.execute({
      sql: `INSERT INTO cortex_feature_probe (market, d, code, angle_id, value, flag, angle_version, manifest_id)
            VALUES ('AU', ?, 'ZZ02', 'A-D2-07', 0.4, NULL, 1, 'm')`,
      args: [D],
    });
    const night = (x: Client) =>
      runPicksNight(x, { market: "AU", d: D, params, calendar: [], now: `${D}T07:00:00.000Z` });
    const broken = {
      execute: async (q: InStatement) => {
        const sql = typeof q === "string" ? q : q.sql;
        if (/FROM cortex_feature_probe/.test(sql)) throw new Error("boom");
        return db.execute(q);
      },
      batch: db.batch.bind(db),
    } as unknown as Client;
    const failed = await night(broken);
    expect(failed.candidateMeasures).toBe(-1);
    expect(failed.published).toBe(0);
    const r = await night(db);
    expect(r.candidateMeasures).toBe(1);
    expect(r.published).toBeGreaterThan(0);
    const rows = await db.execute(
      "SELECT DISTINCT code, rule_version, label FROM pick WHERE market = 'AU'",
    );
    expect(rows.rows.map((x) => [x.code, x.rule_version, x.label])).toEqual([
      ["ZZ02", "CAND.v1:A-D2-07", "UNVALIDATED"],
    ]);
    db.close();
  });

  it("tallies finished candidate picks once per night and share, whatever the profile", async () => {
    const db = await freshDb("main");
    await seed(db, [["ZZ02", 0.25]]);
    const cand = candidateInputs(
      [{ angleId: "A-D2-07", codes: ["ZZ02"] }],
      new Map([["ZZ02", share("ZZ02", 0.25)]]),
      { market: "AU", d: D, perMeasure: 1, max: 1 },
    );
    const picks = generatePicks(
      [],
      { ...gctx, universe: [{ code: "ZZ02", tier: "U1", vol: 0.01 }] },
      {
        inputs: cand,
        perProfile: 1,
      },
    );
    expect(picks.length).toBeGreaterThan(1); // in every profile that takes U1
    await writePicks(db, picks);
    for (const p of picks) {
      const key = [p.market, p.d, p.profile, p.rank];
      // writePicks started the outcome as waiting; the tracking moves it on
      await db.execute({
        sql: `UPDATE pick_outcome SET state = 'bought', entry_d = '2030-03-25', entry_micro = 10000000
              WHERE market = ? AND d = ? AND profile = ? AND rank = ? AND kind = 'pick'`,
        args: key,
      });
      await db.execute({
        sql: `UPDATE pick_outcome SET state = 'closed', exit_d = '2030-03-27', exit_micro = 10500000,
                exit_reason = 'aim', net_micro = 5000, net_ppm = 45000, updated_d = '2030-03-27'
              WHERE market = ? AND d = ? AND profile = ? AND rank = ? AND kind = 'pick'`,
        args: key,
      });
    }
    expect(await candidateTally(db, "AU", "2030-03-27")).toEqual(
      new Map([["A-D2-07", { finished: 1, madeMoney: 1 }]]),
    );
    // before the exit night nothing has finished
    expect(await candidateTally(db, "AU", "2030-03-26")).toEqual(new Map());
    db.close();
  });
});
