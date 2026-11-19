// @vitest-environment node
// M21 R1 (VAL-121, D-1228): the selection. The 5 lowest by the stored rank order among the gate-passers of every arm, plus up
// to 5 U1/U2 names with a polarity -1 event on day 0; a name outside the shortable tiers is kept with shortable 0.
import { afterEach, describe, expect, it } from "vitest";
import { shortRulesOf } from "@/lib/market/seed/shortRules.mjs";
import { parseRankKey, selectShort } from "@/lib/shortShadow/select";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { MKT, seedDecision, seedEvent, seedTier } from "./shortHarness";

afterEach(cleanupTempDbs);
const D = "2030-01-07";

describe("short-sale rules seed", () => {
  it("AU: no naked shorts, borrow through securities lending, U1 only, 3 % a year, marked [VERIFY]", () => {
    expect(shortRulesOf("AU")).toEqual({
      naked: false,
      borrow: "slb",
      shortableTiers: ["U1"],
      borrowBpsPa: 300,
      verify: 1,
    });
    expect(() => shortRulesOf("ZZ")).toThrow(/no short-sale rules/);
  });
});

describe("parseRankKey", () => {
  it("reads a numeric key; a null, empty, broken or non-finite key has no rank", () => {
    expect(parseRankKey("[1.5,-0.2,-0.1]")).toEqual([1.5, -0.2, -0.1]);
    expect(parseRankKey(null)).toBeNull();
    expect(parseRankKey("[]")).toBeNull();
    expect(parseRankKey("not json")).toBeNull();
    expect(parseRankKey("[null,0,0]")).toBeNull(); // JSON.stringify(Infinity) is null
  });
});

describe("selectShort", () => {
  it("takes the 5 lowest-ranked gate-passers of every arm, never a blocked one, and breaks ties by code", async () => {
    const db = await freshDb("main");
    const keys: [string, number, ("live" | "shadow")?, (string | null)?][] = [
      ["C1", 0.9],
      ["C2", 0.1],
      ["C3", -0.5, "shadow"],
      ["C4", 0.1],
      ["C5", 0.3],
      ["C6", 0.2],
      ["C7", 2],
      ["BLK", -9, "live", "G03"], // blocked: never eligible
    ];
    for (const [code, k, arm, fail] of keys) {
      await seedDecision(db, {
        d: D,
        code,
        key: [k, 0, 0],
        arm: arm ?? "live",
        fail: fail ?? null,
      });
      await seedTier(db, D, code, "U1");
    }
    await seedDecision(db, { d: D, code: "NOKEY", key: null });
    const got = await selectShort(db, { market: MKT, d: D });
    const low = got.filter((s) => s.origin === "lowest_rank").map((s) => s.code);
    expect(low).toEqual(["C3", "C2", "C4", "C6", "C5"]);
    expect(got.every((s) => s.shortable)).toBe(true);
    expect(got.find((s) => s.code === "C3")!.rankKey).toBe("[-0.5,0,0]");
  });

  it("a code on two books counts once, at its lowest rank", async () => {
    const db = await freshDb("main");
    await seedDecision(db, { d: D, code: "A", key: [0.5, 0, 0], book: "b1" });
    await seedDecision(db, { d: D, code: "A", key: [-0.5, 0, 0], book: "b2" });
    await seedTier(db, D, "A", "U1");
    const got = await selectShort(db, { market: MKT, d: D });
    expect(got).toHaveLength(1);
    expect(got[0]!.bookId).toBe("b2");
  });

  it("adds up to 5 U1/U2 names with a polarity -1 event on D, ignores U3, polarity 0/1, other days and names already chosen", async () => {
    const db = await freshDb("main");
    await seedDecision(db, { d: D, code: "L1", key: [0.1, 0, 0] });
    await seedTier(db, D, "L1", "U1");
    const ev: [string, "U1" | "U2" | "U3", -1 | 0 | 1][] = [
      ["E1", "U1", -1],
      ["E2", "U2", -1],
      ["E3", "U3", -1],
      ["E4", "U1", 1],
      ["E5", "U1", 0],
      ["L1", "U1", -1], // already a lowest_rank pick
      ["E6", "U1", -1],
      ["E7", "U1", -1],
      ["E8", "U2", -1],
      ["E9", "U2", -1],
      ["E10", "U1", -1],
    ];
    for (const [c, t, p] of ev) {
      await seedTier(db, D, c, t).catch(() => undefined); // L1 already has a row
      await seedEvent(db, D, c, p);
    }
    await seedTier(db, "2030-01-04", "OLD", "U1");
    await seedEvent(db, "2030-01-04", "OLD", -1);
    const got = await selectShort(db, { market: MKT, d: D });
    const evs = got.filter((s) => s.origin === "event_polarity").map((s) => s.code);
    expect(evs).toHaveLength(5);
    expect(evs).not.toContain("E3");
    expect(evs).not.toContain("E4");
    expect(evs).not.toContain("E5");
    expect(evs).not.toContain("L1");
    expect(evs).not.toContain("OLD");
    expect(evs.every((c) => c !== "E10" || evs.length === 5)).toBe(true);
    expect(
      got
        .filter((s) => s.origin === "event_polarity")
        .every((s) => s.bookId === "none" && s.rankKey === null),
    ).toBe(true);
  });

  it("a U2 name is selected but not shortable (the U1 tier stands in for borrow available)", async () => {
    const db = await freshDb("main");
    await seedDecision(db, { d: D, code: "X1", key: [0, 0, 0] });
    await seedTier(db, D, "X1", "U2");
    await seedDecision(db, { d: D, code: "X2", key: [1, 0, 0] });
    // X2 has no universe row at all: not shortable
    const got = await selectShort(db, { market: MKT, d: D });
    expect(got.map((s) => [s.code, s.shortable])).toEqual([
      ["X1", false],
      ["X2", false],
    ]);
  });

  it("writes nothing", async () => {
    const db = await freshDb("main");
    await seedDecision(db, { d: D, code: "A", key: [0, 0, 0] });
    await selectShort(db, { market: MKT, d: D });
    const n = await db.execute("SELECT COUNT(*) AS n FROM short_shadow_decision");
    expect(Number(n.rows[0]!.n)).toBe(0);
  });
});
