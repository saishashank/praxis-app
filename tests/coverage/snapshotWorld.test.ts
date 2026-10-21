// @vitest-environment node
// M8 T3 coverage (TST-121): the snapshot-backed replay source on a small synthetic snapshot with a
// split, a bonus issue, a delisting and a tier history (invented codes ZZA..ZZC, SEC-110): split
// ratios found or refused, bars and facts by session, halted flags, the control universe and the
// refusals for unknown sessions. Deterministic: no clock, no randomness.
import { describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { buildSnapshot, loadSnapshot } from "@/lib/replay/snapshot";
import { blockOf, ledgerTestRows, matchedQ, randomSignalSource, realNullBatch } from "@/lib/replay/nullRuns";
import { replayLedger } from "@/lib/replay/ledger";
import { SnapshotWorld, corpRecordsOf, ratioPayload } from "@/lib/replay/snapshotWorld";
import { series, weekdays } from "../fixtures/replay/synthetic";

const params = defaultAgentParams();
const days = [...weekdays("2026-04"), ...weekdays("2026-05"), ...weekdays("2026-06"), ...weekdays("2026-07")];
const last = days[days.length - 1]!;
const mid = days[Math.floor(days.length / 2)]!;

const action = (code: string, type: string, factor: number, id: number, exDate = mid) => ({
  code,
  ex_date: exDate,
  action_id: id,
  type,
  factor,
});

function world(opts: { indexCode?: string } = {}) {
  const calendar = [
    ...days.map((d, i) => ({ d, kind: i === 3 ? "early_close" : "session", close_time: null, confirmed: 1 })),
    { d: "2026-04-25", kind: "holiday", close_time: null, confirmed: 1 },
  ];
  const universe = [
    // ZZA: U1 from the start, halted on one day.
    ...days.map((d) => ({ d, code: "ZZA", status: "active", tier: "U1", mcap_est: 1e8, adv: 5e5, halted: d === mid ? 1 : 0 })),
    // ZZB: a later first row, so earlier sessions use its first row.
    ...days.slice(10).map((d) => ({ d, code: "ZZB", status: "active", tier: "U2", mcap_est: 1e8, adv: 5e5, halted: 0 })),
    // ZZC has no universe rows at all.
  ];
  const index_bars = days.map((d, i) => ({
    index_code: "ZZIDX",
    d,
    o_micro: 5_000_000_000 + i * 10,
    h_micro: 5_000_000_100 + i * 10,
    l_micro: 4_999_999_900 + i * 10,
    c_micro: 5_000_000_050 + i * 10,
  }));
  const corporate_actions = [
    action("ZZA", "split", 0.5, 1),
    action("ZZA", "bonus_issue", 0.8, 2, days[days.length - 5]!),
    action("ZZA", "dividend", 1, 3),
    action("ZZB", "delisting", 1, 4, last),
    action("ZZB", "delisting", 1, 5, days[days.length - 3]!),
    action("ZZB", "split", 0.3779, 6),
  ];
  const announcements = [
    { code: "ZZA", ann_id: "a1", published_at: `${days[5]}T01:00:00.000Z`, type: "Synthetic", price_sensitive: 0, title: "x" },
  ];
  const bars = [
    ...series("ZZA", days, 3, 500_000),
    ...series("ZZB", days.slice(10), 1, 900_000),
    ...series("ZZC", days.slice(20), 2, 400_000),
  ];
  const snap = buildSnapshot({
    from: days[0]!,
    to: last,
    inputs: { bars, calendar, universe, index_bars, corporate_actions, announcements },
  });
  return new SnapshotWorld(loadSnapshot(snap.bytes), { params, indexCode: opts.indexCode });
}

describe("ratioPayload", () => {
  it("finds small-integer ratios for splits, consolidations and bonus issues", () => {
    expect(ratioPayload("split", 0.5)).toEqual({ new: 2, old: 1 });
    expect(ratioPayload("split", 2 / 3)).toEqual({ new: 3, old: 2 });
    expect(ratioPayload("consolidation", 2)).toEqual({ new: 1, old: 2 });
    expect(ratioPayload("bonus_issue", 0.8)).toEqual({ new: 1, old: 4 });
  });

  it("refuses a bonus that does not add shares, a ratio with no small form and a non-positive factor", () => {
    expect(ratioPayload("bonus_issue", 1.5)).toBeNull();
    expect(ratioPayload("split", 0.3779)).toBeNull();
    expect(ratioPayload("split", 0)).toBeNull();
    expect(ratioPayload("split", -1)).toBeNull();
    expect(ratioPayload("split", Number.NaN)).toBeNull();
  });
});

describe("corpRecordsOf", () => {
  it("keeps only the replayed quantity changes that have a usable ratio", () => {
    const w = world();
    expect(w.corpActions("ZZA").map((a) => a.type)).toEqual(["split", "bonus_issue"]);
    expect(w.corpActions("ZZA")[0]).toMatchObject({ code: "ZZA", exDate: mid, payload: { new: 2, old: 1 } });
    expect(w.corpActions("ZZB")).toEqual([]);
    expect(w.corpActions("ZZC")).toEqual([]);
    const snap = loadSnapshot(
      buildSnapshot({
        from: days[0]!,
        to: last,
        inputs: {
          bars: series("ZZA", days, 3, 1000),
          calendar: days.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 })),
          universe: [],
          index_bars: [],
          corporate_actions: [action("ZZA", "dividend", 1, 1), action("ZZA", "split", 0.5, 2)],
          announcements: [],
        },
      }).bytes,
    );
    expect(corpRecordsOf(snap).map((r) => r.id)).toEqual([`snap:ZZA:${mid}:2`]);
  });
});

describe("SnapshotWorld", () => {
  const w = world();

  it("lists sessions (not closed days), codes, the first bar date, the earliest delisting and announcements", () => {
    expect(w.sessions).toHaveLength(days.length);
    expect(w.sessions).not.toContain("2026-04-25");
    expect(w.codes).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(w.firstBarD).toBe(days[0]);
    expect(w.market).toBe("AU");
    expect(w.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(w.delistings.get("ZZB")).toBe(days[days.length - 3]);
    expect(w.delistings.has("ZZA")).toBe(false);
    expect(w.announcements).toEqual([{ code: "ZZA", d: days[5] }]);
  });

  it("returns a bar on a traded day and null elsewhere", () => {
    expect(w.bar("ZZA", days[2]!)?.d).toBe(days[2]);
    expect(w.bar("ZZB", days[2]!)).toBeNull();
    expect(w.bar("NOPE", days[2]!)).toBeNull();
  });

  it("halted: null without a universe row, true or false on a row", () => {
    expect(w.halted("ZZA", mid)).toBe(true);
    expect(w.halted("ZZA", days[2]!)).toBe(false);
    expect(w.halted("ZZC", days[25]!)).toBeNull();
    expect(w.halted("NOPE", mid)).toBeNull();
  });

  it("position facts: null off-grid, computed once, memoised, with a warm ATR late in the series", () => {
    expect(w.positionFacts("ZZB", days[2]!)).toBeNull();
    const a = w.positionFacts("ZZA", last);
    expect(a).not.toBeNull();
    expect(a!.volumeRatios).toHaveLength(5);
    expect(a!.events).toEqual([]);
    expect(a!.atrMicro === null || typeof a!.atrMicro === "bigint").toBe(true);
    expect(w.positionFacts("ZZA", last)).toBe(a);
    const early = w.positionFacts("ZZA", days[1]!);
    expect(early!.atrMicro).toBeNull();
  });

  it("family inputs: the session list ends on the day, regime and traded codes follow, unknown days throw", () => {
    const fi = w.familyInputs(last);
    expect(fi.sessions[fi.sessions.length - 1]).toBe(last);
    expect(fi.eventCoverage).toBe(false);
    expect(fi.sources).toEqual({ asx: "off", asic: "off" });
    expect(fi.codes.map((c) => c.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(typeof fi.regime).toBe("string");
    expect(w.familyInputs(days[0]!).codes.map((c) => c.code)).toEqual(["ZZA"]);
    expect(() => w.familyInputs("2026-04-25")).toThrow(RangeError);
  });

  it("tiers: the first row serves earlier days, a code with no rows is U1", () => {
    const early = w.familyInputs(days[12]!).codes;
    expect(early.find((c) => c.code === "ZZB")!.tier).toBe("U2");
    expect(early.find((c) => c.code === "ZZA")!.tier).toBe("U1");
    const late = w.familyInputs(days[25]!).codes;
    expect(late.find((c) => c.code === "ZZC")!.tier).toBe("U1");
  });

  it("control universe: one entry per traded code, eligible only for warm U1 codes that are not halted", () => {
    const u = w.controlUniverse(last);
    expect(u.map((c) => c.code)).toEqual(["ZZA", "ZZB", "ZZC"]);
    expect(u.find((c) => c.code === "ZZB")!.eligible).toBe(false);
    expect(u.find((c) => c.code === "ZZA")!.advMicro >= 0n).toBe(true);
    expect(w.controlUniverse(mid).find((c) => c.code === "ZZA")!.eligible).toBe(false);
    expect(w.controlUniverse(days[0]!).find((c) => c.code === "ZZA")!.advMicro).toBe(0n);
  });
});

describe("SnapshotWorld without a benchmark", () => {
  it("has regime 'unknown' on every day when the snapshot has no index bars", () => {
    const calendar = days.map((d) => ({ d, kind: "session", close_time: null, confirmed: 1 }));
    const snap = buildSnapshot({
      from: days[0]!,
      to: last,
      inputs: {
        bars: series("ZZA", days, 3, 1000),
        calendar,
        universe: [],
        index_bars: [],
        corporate_actions: [],
        announcements: [],
      },
    });
    const w = new SnapshotWorld(loadSnapshot(snap.bytes), { params, market: "XX" });
    expect(w.market).toBe("XX");
    expect(w.familyInputs(last).regime).toBe("unknown");
  });

  it("a named benchmark that is absent leaves the regime unknown", () => {
    expect(world({ indexCode: "OTHER" }).familyInputs(last).regime).toBe("unknown");
  });
});

describe("random-signal null on a snapshot world", () => {
  const w = world();

  it("signals are random but reproducible, only for eligible U1 codes", () => {
    const src = randomSignalSource(w, { run: 1, q: 1, params });
    const day = w.sessions[w.sessions.length - 3]!;
    const a = src.familyOutput?.(day);
    const b = randomSignalSource(w, { run: 1, q: 1, params }).familyOutput?.(day);
    expect(a?.candidates.map((c) => c.code)).toEqual(b?.candidates.map((c) => c.code));
    expect(a).not.toBeNull();
    for (const c of a?.candidates ?? []) expect(c.flags).toEqual(["random-signal"]);
    expect(src.familyOutput?.("2000-01-03")).toBeNull();
    expect(randomSignalSource(w, { run: 2, q: 0, params }).familyOutput?.(day)?.candidates).toEqual([]);
    expect(src.market).toBe("AU");
    expect(src.bar("ZZA", day)).toEqual(w.bar("ZZA", day));
    expect(src.positionFacts?.("ZZA", day)).toBe(w.positionFacts("ZZA", day));
    expect(src.corpActions?.("ZZA")).toEqual(w.corpActions("ZZA"));
    expect(src.controlUniverse?.(day, "F1")).toEqual(w.controlUniverse(day));
    expect(src.familyInputs?.(day).d).toBe(day);
  });

  it("the ledger of a random-signal run becomes test rows; block length is at least the floor", () => {
    const src = randomSignalSource(w, { run: 0, q: 0.6, params });
    const result = replayLedger(src, { params });
    const t = ledgerTestRows(result, w.sessions);
    expect(t.sessionCount).toBeGreaterThanOrEqual(1);
    expect(t.rows).toHaveLength(t.holds.length);
    expect(blockOf([], params)).toBe(params.stats.bootstrapBlockMinSessions);
    expect(blockOf([1, 2, 3], params)).toBeGreaterThanOrEqual(params.stats.bootstrapBlockMinSessions);
    expect(blockOf([500, 600], params)).toBeGreaterThan(params.stats.bootstrapBlockMinSessions);
    const none = ledgerTestRows({ entries: [] } as never, w.sessions);
    expect(none).toEqual({ rows: [], sessionCount: 1, holds: [] });
  });

  it("a batch runs, skips runs with no rows and can be stopped between runs", () => {
    const full = realNullBatch({ world: w, params, runs: 3, q: 0.6, B: 100 });
    expect(full.kind).toBe("null");
    expect(full.requested).toBe(3);
    expect(full.pausedBudget).toBe(false);
    expect(full.tests.length).toBeLessThanOrEqual(3);
    const none = realNullBatch({ world: w, params, runs: 2, q: 0, B: 100 });
    expect(none.tests).toEqual([]);
    let calls = 0;
    const stopped = realNullBatch({ world: w, params, runs: 5, q: 0, B: 100, shouldStop: () => ++calls > 1 });
    expect(stopped.pausedBudget).toBe(true);
  });

  it("matchedQ: no eligible session-codes gives zero; the rate is capped at one", () => {
    expect(matchedQ(5, 0)).toBe(0);
    expect(matchedQ(5, -1)).toBe(0);
    expect(matchedQ(5, 50)).toBe(0.1);
    expect(matchedQ(80, 50)).toBe(1);
  });
});
