// @vitest-environment node
// Opinion meters (M22 C4; AGT-148, CTX-060; D-1427, D-1517, D-1518): the arithmetic, hand-checked, and the two readers
// on a real migrated database. Synthetic ZZ data only.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  liftOf,
  loadMeters,
  meterOf,
  NO_METER,
  steelmanLean,
  type Case,
} from "@/lib/opinions/meter";
import { viewOf } from "@/lib/opinions/view";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { build, dayOf } from "../committee/trialWorld";

afterAll(cleanupTempDbs);

const c = (lean: Case["lean"], netPpm: number, model: string | null = null): Case => ({
  lean,
  netPpm,
  model,
});

/** `n` favoured and `n` marked-down cases, outcomes 1000 + k*100 and k*100 (k = 0, 1, 2 in turn), for one model. */
function twoSided(n: number, model: string, shift = 0): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < n; i++) {
    out.push(c("for", 1000 + (i % 3) * 100 + shift, model));
    out.push(c("against", (i % 3) * 100, model));
  }
  return out;
}

describe("liftOf: hand-checked", () => {
  it("favoured [100, 200, 300] against marked down [0, 100]", () => {
    // means 200 and 50, gap 150; sample variances 10000 and 5000; se = sqrt(10000/3 + 5000/2) = 76.376;
    // lower bound 150 - 1.28155 * 76.376 = 52.12, rounded down to 52
    const l = liftOf([
      c("for", 100),
      c("for", 200),
      c("for", 300),
      c("against", 0),
      c("against", 100),
      c("none", 99_999),
    ]);
    expect(l).toEqual({ ppm: 150, lower90Ppm: 52, forN: 3, againstN: 2 });
  });

  it("is null with fewer than two cases on a side", () => {
    expect(liftOf([c("for", 1), c("for", 2), c("against", 1)])).toBeNull();
    expect(liftOf([c("none", 1), c("none", 2)])).toBeNull();
    expect(liftOf([])).toBeNull();
  });

  it("a noisy gap has a lower bound at or below zero", () => {
    const l = liftOf([
      c("for", 500),
      c("for", -500),
      c("for", 100),
      c("against", 400),
      c("against", -400),
      c("against", 0),
    ]);
    expect(l!.ppm).toBe(33); // 100/3
    expect(l!.lower90Ppm).toBeLessThanOrEqual(0);
  });
});

describe("steelmanLean", () => {
  it("more bull points leans for, more bear points leans against, equal leans neither", () => {
    expect(steelmanLean({ bull: 3, bear: 1, monitorable: 1 })).toBe("for");
    expect(steelmanLean({ bull: 1, bear: 2, monitorable: 0 })).toBe("against");
    expect(steelmanLean({ bull: 2, bear: 2, monitorable: 0 })).toBe("none");
    expect(steelmanLean(null)).toBe("none");
    expect(steelmanLean({ bull: "x" })).toBe("none");
  });
});

describe("meterOf", () => {
  it("shows the count only, no lift, below opinion_min_n", () => {
    const m = meterOf("AU", "steelman", twoSided(10, "a"), 150);
    expect(m).toMatchObject({ settled: 20, needed: 150, lift: null, earned: false });
    expect(m.conditions).toEqual({ enough: false, liftPositive: false, stable: false });
    expect(viewOf(m, false).status).toBe("counting");
    expect(viewOf(m, false).progress).toBe("20 of 150 settled cases so far");
    expect(viewOf(m, false).lift).toBeNull();
  });

  it("reads the lift once the count is met: 60 cases, 30 on each side", () => {
    // outcomes: favoured 1000/1100/1200 ten times each, marked down 0/100/200 ten times each: gap 1000;
    // each side has sum of squared deviations 2 * 10 * 10000 = 200000, variance 200000 / 29 = 6896.55;
    // se = sqrt(2 * 6896.55 / 30) = 21.4422; lower bound 1000 - 1.28155 * 21.4422 = 972.52, rounded down to 972
    const cases = [...twoSided(15, "a"), ...twoSided(15, "b")];
    const m = meterOf("AU", "committee", cases, 60);
    expect(m.settled).toBe(60);
    expect(m.lift).toEqual({ ppm: 1000, lower90Ppm: 972, forN: 30, againstN: 30 });
    expect(m.versions).toEqual([
      { model: "a", n: 30, liftPpm: 1000 },
      { model: "b", n: 30, liftPpm: 1000 },
    ]);
    expect(m.conditions).toEqual({ enough: true, liftPositive: true, stable: true });
    expect(m.earned).toBe(true);
  });

  it("is not earned with one judge version only", () => {
    const m = meterOf("AU", "committee", twoSided(30, "a"), 60);
    expect(m.conditions).toMatchObject({ enough: true, liftPositive: true, stable: false });
    expect(m.earned).toBe(false);
  });

  it("is not earned when the sign flips in one version", () => {
    const flipped: Case[] = [];
    for (let i = 0; i < 15; i++) {
      flipped.push(c("for", (i % 3) * 100, "b"), c("against", 1000 + (i % 3) * 100, "b"));
    }
    const m = meterOf("AU", "committee", [...twoSided(15, "a"), ...flipped], 60);
    expect(m.versions.find((v) => v.model === "b")!.liftPpm).toBe(-1000);
    expect(m.conditions.stable).toBe(false);
    expect(m.earned).toBe(false);
  });

  it("a version with fewer than 30 cases does not count toward stability", () => {
    const m = meterOf(
      "AU",
      "committee",
      [...twoSided(15, "a"), ...twoSided(14, "b"), ...twoSided(1, "c")],
      60,
    );
    expect(m.conditions.stable).toBe(false);
    expect(m.versions.map((v) => v.model)).toEqual(["a", "b", "c"]);
  });

  it("a gap that could be chance is not earned even with two stable-looking versions", () => {
    const noisy = (model: string): Case[] =>
      Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0
          ? c("for", i % 4 === 0 ? 900 : -800, model)
          : c("against", i % 4 === 1 ? 700 : -600, model),
      );
    const m = meterOf("AU", "steelman", [...noisy("a"), ...noisy("b")], 60);
    expect(m.conditions.liftPositive).toBe(false);
    expect(m.earned).toBe(false);
    expect(viewOf(m, false).missing).toContain("could still be chance");
  });

  it("says the opinion earned a review, with the request state, in plain words", () => {
    const m = meterOf("AU", "committee", [...twoSided(15, "a"), ...twoSided(15, "b")], 60);
    expect(viewOf(m, true).earned).toBe(
      "An opinion has earned a review: needs a new spec version and an Owner decision.",
    );
    expect(viewOf(m, false).earned).toContain("the request is being written");
  });

  it("lists reflections and proposed ideas with the reason they have no forward meter", () => {
    expect(NO_METER.map((n) => n.label)).toEqual(["Looking-back notes", "Proposed new ideas"]);
    for (const n of NO_METER) expect(n.reason.length).toBeGreaterThan(20);
  });
});

async function steelmanWorld(
  db: Client,
  rows: readonly { lean: "for" | "against"; net: number | null; model: string }[],
): Promise<void> {
  let i = 0;
  for (const r of rows) {
    i += 1;
    const d = dayOf(i);
    const id = `steelman:ZZ${i}:${d}:aaaaaaaa`;
    const value =
      r.lean === "for"
        ? { bull: 3, bear: 1, monitorable: 0 }
        : { bull: 1, bear: 3, monitorable: 0 };
    await db.execute({
      sql: "INSERT INTO opinion_track (market, opinion_id, kind, code, d, value_json) VALUES ('AU', ?, 'steelman', ?, ?, ?)",
      args: [id, `ZZ${i}`, d, JSON.stringify(value)],
    });
    if (r.net !== null) {
      await db.execute({
        sql: "UPDATE opinion_track SET settled_d = ?, outcome_json = ? WHERE market = 'AU' AND opinion_id = ?",
        args: [dayOf(i + 3), JSON.stringify({ kind: "pick", netPpm: r.net }), id],
      });
    }
    const pack = String(i).padStart(64, "0");
    await db.execute({
      sql: `INSERT INTO steelman_pack (pack_id, market, d, subject_kind, subject_id, code, cutoff_at, items_json, item_count, created_at)
            VALUES (?, 'AU', ?, 'pick', ?, ?, '2030-01-01T00:00:00Z', '[]', 0, '2030-01-01T00:00:00Z')`,
      args: [pack, d, `AU|${d}|p|${i}`, `ZZ${i}`],
    });
    await db.execute({
      sql: `INSERT INTO steelman_point (point_id, pack_id, side, n, text, citations_json, monitorable, state, author_provider, author_model, created_at)
            VALUES (?, ?, 'bull', 1, 'zz', '["x"]', 0, 'shown', 'zz', ?, '2030-01-01T00:00:00Z')`,
      args: [`pt-${i}`, pack, r.model],
    });
  }
}

describe("loadMeters on a database", () => {
  it("an empty database gives two empty meters", async () => {
    const db = await freshDb("main");
    const ms = await loadMeters(db, "AU", 150);
    expect(ms.map((m) => [m.kind, m.settled])).toEqual([
      ["steelman", 0],
      ["committee", 0],
    ]);
  });

  it("steelman: counts settled cases with a net result, leans from the points, versions from the author model", async () => {
    const db = await freshDb("main");
    await steelmanWorld(db, [
      { lean: "for", net: 300, model: "m1" },
      { lean: "for", net: 100, model: "m1" },
      { lean: "against", net: 0, model: "m2" },
      { lean: "against", net: 100, model: "m2" },
      { lean: "for", net: null, model: "m1" }, // not settled: not counted
    ]);
    // a settled pick that was missed has no net result: settled but not counted
    await db.execute(
      "INSERT INTO opinion_track (market, opinion_id, kind, code, d, value_json) VALUES ('AU', 'steelman:ZZM:2030-01-01:bbbbbbbb', 'steelman', 'ZZM', '2030-01-01', '{\"bull\":1,\"bear\":0,\"monitorable\":0}')",
    );
    await db.execute(
      "UPDATE opinion_track SET settled_d = '2030-01-09', outcome_json = '{\"kind\":\"pick\",\"missed\":true}' WHERE opinion_id = 'steelman:ZZM:2030-01-01:bbbbbbbb'",
    );
    const [s] = await loadMeters(db, "AU", 4);
    expect(s).toMatchObject({ kind: "steelman", settled: 4, capped: false });
    // for: 300, 100 (mean 200, var 20000); against: 0, 100 (mean 50, var 5000); se = sqrt(10000 + 2500) = 111.80
    expect(s!.lift).toEqual({
      ppm: 150,
      lower90Ppm: Math.floor(150 - 1.2815515655446004 * Math.sqrt(12500)),
      forN: 2,
      againstN: 2,
    });
    expect(s!.versions).toEqual([
      { model: "m1", n: 2, liftPpm: null },
      { model: "m2", n: 2, liftPpm: null },
    ]);
  });

  it("committee: the settled outcomes of the trial, approve for, reject against, the judge as the version", async () => {
    const specs = [];
    for (let i = 0; i < 6; i++) {
      specs.push({
        night: i,
        rating: "approve" as const,
        net: 1000 + i * 10,
        judge: i < 3 ? "j1" : "j2",
      });
      specs.push({ night: i, rating: "reject" as const, net: i * 10, judge: i < 3 ? "j1" : "j2" });
      specs.push({ night: i, rating: "neutral" as const, net: 5000, judge: "j1" });
    }
    const db = await build(specs);
    const [, cm] = await loadMeters(db, "AU", 12);
    expect(cm).toMatchObject({ kind: "committee", settled: 18 });
    // approve mean 1025, reject mean 25: gap 1000
    expect(cm!.lift).toMatchObject({ ppm: 1000, forN: 6, againstN: 6 });
    expect(cm!.versions.map((v) => v.model)).toEqual(["j1", "j2"]);
  });
});
