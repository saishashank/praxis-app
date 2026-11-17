// @vitest-environment node
// D-985…D-987: top-5 gainer coverage per measure in the learning Cortex's words: the flags of a night
// (the top tenth held a top-5 gainer / loser), their four-week sums, the scorecard line and a probe's
// evidence line; the stored history read back; the nightly stage stores the flags and the line, and the
// production probe hook adds the evidence line. Synthetic ZZ data only.
import { afterEach, describe, expect, it } from "vitest";
import { CORTEX_LEARN_HOOKS } from "@/lib/cortex/learn/hooks";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import { cortexLearnNight } from "@/lib/cortex/learn/stage";
import type { FeatureNight } from "@/lib/cortex/learn/scorecard";
import {
  probeEvidenceWords,
  top5Count,
  top5Flags,
  top5History,
  top5ScorecardWords,
  type Top5Flags,
} from "@/lib/cortex/learn/top5";
import { learnConfig } from "@/lib/cortex/learn/config";
import type { World } from "@/lib/learning/dailyLoad";
import { cleanupTempDbs, freshDb } from "../../db/helpers";
import { bars, codes, D, featureNight, PREV } from "./zzLearn";

afterEach(cleanupTempDbs);

const night = (rows: [string, Record<string, unknown>][]): FeatureNight => ({
  d: PREV,
  rows: rows.map(([code, features]) => ({ code, features, activeSetHash: "h", manifestId: "m" })),
});

// 20 codes: A ranks ZZ020 highest, B ranks ZZ001 highest; C has no numeric value
const twenty: [string, Record<string, unknown>][] = Array.from({ length: 20 }, (_, i) => [
  `ZZ${String(i + 1).padStart(3, "0")}`,
  { A: i, B: -i, C: { flag: "x" } },
]);

describe("top5Flags and their words (pure)", () => {
  it("flags whether each measure's top tenth held a top-5 gainer and loser", () => {
    const sets = {
      gainers: [{ code: "ZZ020", movePpm: 9 }],
      losers: [{ code: "ZZ001", movePpm: -9 }],
    };
    expect(top5Flags(night(twenty), sets)).toEqual({ A: [1, 0], B: [0, 1] });
    expect(top5Flags(null, sets)).toEqual({});
    expect(top5Flags(night(twenty), undefined)).toEqual({});
    expect(top5Flags(night(twenty), { gainers: [], losers: [] })).toEqual({});
    // one code: the top tenth is that code
    expect(top5Flags(night([["ZZ001", { A: 1 }]]), sets)).toEqual({ A: [0, 1] });
  });

  it("sums four weeks, names the best measure, and says when none caught one", () => {
    const hist: Top5Flags[] = [{ A: [1, 0], B: [0, 0] }, { A: [1, 1] }, {}];
    expect(top5Count("A", { A: [0, 0] }, hist)).toEqual({ nights: 3, gainer: 2, loser: 1 });
    expect(top5Count("B", {}, hist)).toEqual({ nights: 1, gainer: 0, loser: 0 });
    const line = top5ScorecardWords({ "A-D1-02": [1, 0], "A-D2-01": [0, 1] }, [
      { "A-D1-02": [1, 1] },
    ])!;
    expect(line).toContain("held one of the day's five biggest gainers on 2 nights");
    expect(line).toContain("one of the five biggest losers on one night");
    expect(line).toContain("(1 of the 2 measures caught at least one)");
    expect(cleanWords(line)).toBe(true);
    expect(top5ScorecardWords({}, [])).toBeNull();
    expect(top5ScorecardWords({ "A-D1-02": [0, 0] }, [])).toContain(
      "none of the 1 measures had one of the day's five biggest gainers",
    );
  });

  it("a probe's evidence line: candidate picks first, then its top-5 coverage", () => {
    expect(
      probeEvidenceWords({
        name: "heavy trading without news",
        picks: { finished: 3, madeMoney: 2 },
        top5: { nights: 9, gainer: 2, loser: 1 },
      }),
    ).toBe(
      "Candidate picks of heavy trading without news: 3 finished, 2 made money. Its favourite shares held one of the day's five biggest gainers on 2 nights of the last 9 nights (a top 5 loser on one night).",
    );
    const none = probeEvidenceWords({ name: "x", picks: undefined, top5: null });
    expect(none).toBe("Candidate picks of x: none finished yet.");
    expect(cleanWords(none)).toBe(true);
  });
});

function world(n = 40): World {
  const shares = new Map(
    [...bars(n)].map(([code, list]) => [
      code,
      {
        code,
        tier: "U1",
        bars: list.map((b) => ({ d: b.d, o: b.c, h: b.c, l: b.c, c: b.c, v: 1000 })),
      },
    ]),
  );
  // ZZ040 rises most on D, ZZ001 falls most
  const moves = codes(n).map((code, i) => ({ code, tier: "U1", movePpm: (i - 20) * 1000 }));
  return {
    d: D,
    prev: PREV,
    tierOf: new Map(codes(n).map((c) => [c, "U1"])),
    moves: moves.sort((a, b) => b.movePpm - a.movePpm),
    indexMovePpm: null,
    sectorOf: new Map(),
    shares,
    liquidCodes: codes(n),
    sensitive: new Map(),
    names: new Map(),
    signals: new Map(),
  } as unknown as World;
}

describe("the stored flags and the nightly stage", () => {
  it("reads the stored nights' flags in a date range, skipping nights without them", async () => {
    const db = await freshDb("main");
    const put = (d: string, body: unknown) =>
      db.execute({
        sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, ?, 't')",
        args: [d, JSON.stringify(body)],
      });
    await put("2026-11-02", { cortex: { numbers: { top5: { A: [1, 0] } } } });
    await put("2026-11-03", { cortex: { numbers: {} } });
    await put("2026-11-04", { cortex: { numbers: { top5: [1] } } });
    await put("2026-11-05", { cortex: { numbers: { top5: { B: [0, 1] } } } });
    expect(await top5History(db, "AU", "2026-11-01", "2026-11-05")).toEqual([{ A: [1, 0] }]);
    expect(await top5History(db, "AU", "2026-11-06", "2026-11-05")).toEqual([]);
    db.close();
  });

  it("cortexLearnNight stores the flags with its section and says the top-5 line; the probe hook adds its evidence", async () => {
    const db = await freshDb("main");
    // the evening-before features: A-D1-02 ranks in the order of the day's move (ZZ040 top)
    const fn = featureNight(PREV);
    for (const r of fn.rows) {
      await db.execute({
        sql: `INSERT INTO cortex_feature_daily (market, d, code, features_json, flags_json, active_set_hash, manifest_id)
              VALUES ('AU', ?, ?, ?, '{}', ?, ?)`,
        args: [PREV, r.code, JSON.stringify(r.features), r.activeSetHash, r.manifestId],
      });
    }
    await db.execute({
      sql: "INSERT INTO daily_learning (market, d, body_json, created_at) VALUES ('AU', ?, '{}', 't')",
      args: [D],
    });
    const s = (await cortexLearnNight(db, {
      market: "AU",
      d: D,
      calendar: [],
      world: world(),
      movers: [],
      now: `${D}T09:30:00.000Z`,
      config: learnConfig({ replicates: 200 }, { relaxed: true }),
      candidatePicks: new Map([["A-D2-07", { finished: 1, madeMoney: 1 }]]),
      hooks: {
        probeNight: async (hdb, ctx) => {
          expect(ctx.top5?.gainers[0]!.code).toBe("ZZ040");
          expect(ctx.candidatePicks?.get("A-D2-07")).toEqual({ finished: 1, madeMoney: 1 });
          return { lines: ["probe line"], top5: { "A-D2-07": [1, 0] } };
        },
      },
    }))!;
    expect(s.numbers.top5?.["A-D1-02"]).toEqual([1, 0]);
    expect(s.numbers.top5?.["A-D2-07"]).toEqual([1, 0]);
    expect(s.lines.some((l) => l.startsWith("Top 5 gainers over the last one night"))).toBe(true);
    expect(s.lines[s.lines.length - 1]).toBe("probe line");
    const stored = await db.execute({
      sql: "SELECT json_extract(body_json, '$.cortex.numbers.top5') AS t FROM daily_learning WHERE d = ?",
      args: [D],
    });
    expect(JSON.parse(String(stored.rows[0]!.t))["A-D1-02"]).toEqual([1, 0]);
    db.close();
  });

  it("the production hooks: probeNight off-session returns nothing, on a session its lines and flags", async () => {
    const db = await freshDb("main");
    const ctx = {
      market: "AU",
      calendar: [],
      world: world(),
      movers: [],
      learner: null,
      config: learnConfig({}, { relaxed: true }),
      seqBase: 200,
      now: `${D}T09:30:00.000Z`,
    };
    expect(await CORTEX_LEARN_HOOKS.probeNight!(db, { ...ctx, d: "2026-11-14" })).toEqual({});
    const r = (await CORTEX_LEARN_HOOKS.probeNight!(db, {
      ...ctx,
      d: D,
      top5: { gainers: [], losers: [] },
      top5History: [],
      candidatePicks: new Map(),
    }))!;
    expect(r).toMatchObject({ lines: [], top5: {} });
    expect(r.stats).toEqual([
      { metric: "cortex_probe", value: { scored: 0, opened: 0, escalated: 0 } },
    ]);
    expect(
      await CORTEX_LEARN_HOOKS.baseWeekly!(db, {
        ...ctx,
        d: "2026-11-14",
        lastSession: "2026-11-14",
        fixed: null,
      }),
    ).toEqual({});
    db.close();
  });
});
