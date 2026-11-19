// @vitest-environment node
// M21 R1 (VAL-121, D-1228, D-1295): the step end to end on a small database: off by default and then silent, on it stores the
// selection and scores it (a closed short, an unfilled entry, a not-shortable name), idempotent, and touches only its tables.
import { afterEach, describe, expect, it } from "vitest";
import { testParams } from "../agents/batch2bHarness";
import { runShortShadow } from "@/lib/shortShadow";
import { shortShadowEnabled } from "@/lib/shortShadow/enabled";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { MKT, WHEN, count, seedBars, seedDecision, seedTier } from "./shortHarness";

afterEach(cleanupTempDbs);
const D = "2030-01-07";
const days = [
  "2030-01-08",
  "2030-01-09",
  "2030-01-10",
  "2030-01-11",
  "2030-01-14",
  "2030-01-15",
  "2030-01-16",
  "2030-01-17",
  "2030-01-18",
  "2030-01-21",
  "2030-01-22",
  "2030-01-23",
];
const flat = (d: string) => ({ d, o: 10, h: 10.2, l: 9.8, c: 10 });

async function world() {
  const db = await freshDb("main");
  await seedDecision(db, { d: D, code: "AAA", key: [-1, 0, 0] }); // shortable, bars present
  await seedDecision(db, { d: D, code: "BBB", key: [-0.5, 0, 0] }); // shortable, no next-day bar
  await seedDecision(db, { d: D, code: "CCC", key: [0, 0, 0] }); // U2: not shortable
  await seedTier(db, D, "AAA", "U1");
  await seedTier(db, D, "BBB", "U1");
  await seedTier(db, D, "CCC", "U2");
  await seedBars(db, "AAA", [flat(D), ...days.map(flat)]);
  await seedBars(db, "BBB", [flat(D), { ...flat("2030-01-10") }]);
  await seedBars(db, "CCC", [flat(D), ...days.map(flat)]);
  return db;
}
const run = (db: Awaited<ReturnType<typeof world>>, d = "2030-03-01") =>
  runShortShadow(db, { market: MKT, d, params: testParams(), now: () => WHEN });

describe("runShortShadow", () => {
  it("is off in a fresh database and writes nothing", async () => {
    const db = await world();
    expect(await shortShadowEnabled(db, MKT)).toBe(false);
    expect(await run(db)).toEqual({ ran: false });
    expect(await count(db, "short_shadow_decision")).toBe(0);
    expect(await count(db, "short_shadow_outcome")).toBe(0);
  });

  it("a market without short-sale rules stays off even with its switch row", async () => {
    const db = await world();
    expect(await shortShadowEnabled(db, "ZZ")).toBe(false);
  });

  it("on: stores the three selected names and scores them once; a second pass writes nothing new", async () => {
    const db = await world();
    await setConfigRaw(db);
    const r = await run(db, D); // the night's own session
    expect(r.ran).toBe(true);
    expect(await count(db, "short_shadow_decision")).toBe(3);
    // asked with a later session the same night's rows score: closed, unfilled, not shortable
    const r2 = await run(db, "2030-03-01");
    expect(r2.ran).toBe(true);
    const out = (
      await db.execute("SELECT code, status, exit_reason FROM short_shadow_outcome ORDER BY code")
    ).rows.map((x) => [
      String(x.code),
      String(x.status),
      x.exit_reason === null ? null : String(x.exit_reason),
    ]);
    expect(out).toEqual([
      ["AAA", "closed", "time"],
      ["BBB", "unfilled", null],
      ["CCC", "not_shortable", null],
    ]);
    const before = [
      await count(db, "short_shadow_decision"),
      await count(db, "short_shadow_outcome"),
    ];
    await run(db, "2030-03-01");
    expect([
      await count(db, "short_shadow_decision"),
      await count(db, "short_shadow_outcome"),
    ]).toEqual(before);
    expect(await count(db, "holdout_look")).toBe(0); // below the sample: no look
    expect(await count(db, "app_log")).toBe(0); // not even a log line
  });
});

async function setConfigRaw(db: Awaited<ReturnType<typeof world>>): Promise<void> {
  // the switch is not a registered setting (D-1295): its row is written the way an operator script writes one
  await db.execute({
    sql: `INSERT INTO config_version (key, scope, value_json, previous_json, changed_by_user_id, changed_at, reason)
          VALUES ('short_shadow_enabled', ?, '"on"', NULL, NULL, ?, 'test')`,
    args: [MKT, WHEN],
  });
}
