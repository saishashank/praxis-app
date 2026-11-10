// @vitest-environment node
// D-921 picks hooks for the daily learning loop: who was picked the evening before (strategy pick or
// shortlist pick, first profile and rank), which sessions had a published pick, and the shortlist
// near-miss notes on bars up to the previous session only. Synthetic ZZ data, temp database.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickHooks } from "@/lib/picks/dailyHooks";
import { SHORTLIST_RULE } from "@/lib/picks/shortlist";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const PREV = "2030-03-04";
const SHA = "a".repeat(64);
let db: Client;

async function pick(d: string, profile: string, rank: number, code: string, rule = "F1.v1") {
  await db.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, ?, ?, ?, 'F1', 'U1', ?, ?, 'UNVALIDATED', 10000000, 10050000,
            '2030-03-06', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000,
            '[]', '[]', ?, ?)`,
    args: [d, profile, rank, code, rule, `s-${profile}-${rank}`, SHA, `${d}T07:00:00.000Z`],
  });
}

beforeAll(async () => {
  db = await freshDb("main");
  await pick(PREV, "aggressive", 2, "ZZA");
  await pick(PREV, "balanced", 1, "ZZA"); // the first profile by name wins: aggressive #2
  await pick(PREV, "balanced", 3, "ZZB", SHORTLIST_RULE);
  await pick("2030-03-02", "balanced", 1, "ZZC");
});
afterAll(cleanupTempDbs);

describe("pickHooks (D-921)", () => {
  it("names who was picked the evening before, a shortlist pick as such", async () => {
    const m = await pickHooks.pickedBefore(db, "AU", PREV, ["ZZA", "ZZB", "ZZC", "ZZX"]);
    expect(Object.fromEntries(m)).toEqual({
      ZZA: "Picked (Aggressive #2)",
      ZZB: "Picked from the shortlist (Balanced #3)",
    });
    expect((await pickHooks.pickedBefore(db, "AU", PREV, [])).size).toBe(0);
  });

  it("lists the sessions that had a published pick", async () => {
    const s = await pickHooks.publishedDays(db, "AU", [PREV, "2030-03-02", "2030-03-03"]);
    expect([...s].sort()).toEqual(["2030-03-02", PREV]);
    expect((await pickHooks.publishedDays(db, "AU", [])).size).toBe(0);
  });

  it("near-miss notes use bars up to the previous session only", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({
      d: `2030-02-${String(i + 1).padStart(2, "0")}`
        .replace("2030-02-29", "2030-03-01")
        .replace("2030-02-30", PREV),
      o: 10,
      h: 10.2,
      l: 9.8,
      c: 10,
      v: 1000,
    }));
    const after = [...bars, { d: "2030-03-05", o: 50, h: 60, l: 40, c: 55, v: 1 }];
    const a = pickHooks.shortlistNotes([{ code: "ZZA", tier: "U1", bars }], PREV, ["ZZA"]);
    const b = pickHooks.shortlistNotes([{ code: "ZZA", tier: "U1", bars: after }], PREV, ["ZZA"]);
    expect(b).toEqual(a); // a bar after the previous session changes nothing
  });
});
