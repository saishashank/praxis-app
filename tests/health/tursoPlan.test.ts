// @vitest-environment node
// PLT-080 (D-963; AT-83 clause (k)): the Turso plan guard. With a plan other than Free and a clock after
// 1 December 2026 a System Health item appears; with Free, or before 1 December, it does not. The plan
// name arrives in the daily usage sample.
import { afterEach, describe, expect, it } from "vitest";
import {
  computeComponents,
  TURSO_DOWNGRADE_DEADLINE,
  type HealthFacts,
} from "@/lib/health/components";
import { gatherHealthFacts } from "@/lib/health/snapshot";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const facts = (today: string, tursoPlan?: HealthFacts["tursoPlan"]): HealthFacts => ({
  today,
  nowMs: Date.parse(`${today}T01:00:00Z`),
  marketActive: true,
  sentinelLastOkAt: `${today}T00:00:00Z`,
  jobs: {},
  quality: { gateFails: 0, blockingFlags: 0 },
  llmLevel: "ok",
  emailMode: "full",
  lastReview: null,
  dbReadable: true,
  storageLevel: "ok",
  watchdog: "ok",
  failedSecrets: [],
  credentials: [],
  quotaLevel: "ok",
  tursoPlan,
});
const plan = (today: string, name: string | null | undefined) =>
  computeComponents(facts(today, name === undefined ? undefined : { name })).find(
    (c) => c.id === "free_tier_limits",
  )!;

describe("the plan guard", () => {
  it("the deadline is 1 December 2026", () => {
    expect(TURSO_DOWNGRADE_DEADLINE).toBe("2026-12-01");
  });

  it("after 1 December a plan that is not Free is a red item with the plan name", () => {
    for (const name of ["developer", "Scaler", "pro"]) {
      const c = plan("2026-12-01", name);
      expect(c.state).toBe("down");
      expect(c.items).toHaveLength(1);
      expect(c.items[0]).toMatchObject({
        key: "turso.plan_not_free",
        state: "down",
        label: `Turso plan is ${name}: downgrade to Free (PLT-080, $0 rule)`,
      });
    }
  });

  it("Free (any case, and the older Starter id) and a date before 1 December show nothing", () => {
    for (const name of ["free", "Free", "FREE", "starter"])
      expect(plan("2026-12-01", name).items).toEqual([]);
    for (const day of ["2026-11-12", "2026-11-30"])
      expect(plan(day, "developer").items).toEqual([]);
  });

  it("an unknown plan after 1 December asks the Owner to confirm the Free plan; before it, nothing", () => {
    for (const name of [null, "", "  "]) {
      const c = plan("2026-12-02", name);
      expect(c.items.map((i) => i.key)).toEqual(["turso.plan_unknown"]);
      expect(c.items[0]!.label).toBe("Turso plan unknown: confirm the Free plan");
      expect(c.state).toBe("attention");
    }
    expect(plan("2026-11-30", null).items).toEqual([]);
  });

  it("facts that could not be read show nothing", () => {
    expect(plan("2026-12-05", undefined).items).toEqual([]);
  });
});

describe("the plan name comes from the daily usage sample", () => {
  async function sample(
    db: Awaited<ReturnType<typeof freshDb>>,
    at: string,
    planName: string | null,
    source = "platform",
  ) {
    await db.execute({
      sql: `INSERT INTO usage_sample (sampled_at, rows_read_month, rows_written_month, storage_bytes, plan_name, source)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        at,
        source === "platform" ? 1 : null,
        source === "platform" ? 1 : null,
        source === "platform" ? 1 : null,
        planName,
        source,
      ],
    });
  }
  const guardKeys = async (db: Awaited<ReturnType<typeof freshDb>>, today: string) =>
    computeComponents(await gatherHealthFacts(db, new Date(`${today}T01:00:00Z`), today, {}))
      .find((c) => c.id === "free_tier_limits")!
      .items.map((i) => i.key);

  it("no sample: unknown after 1 December; a Developer sample: not free; a Free sample: quiet", async () => {
    const db = await freshDb("main");
    expect(await guardKeys(db, "2026-11-20")).toEqual([]);
    expect(await guardKeys(db, "2026-12-02")).toEqual(["turso.plan_unknown"]);
    await sample(db, "2026-12-01T06:40:00.000Z", "developer");
    expect(await guardKeys(db, "2026-12-02")).toEqual(["turso.plan_not_free"]);
    await sample(db, "2026-12-02T06:40:00.000Z", "free");
    expect(await guardKeys(db, "2026-12-02")).toEqual([]);
    // a later unavailable sample (no plan) does not hide the last known plan
    await sample(db, "2026-12-03T06:40:00.000Z", null, "unavailable");
    expect(await guardKeys(db, "2026-12-03")).toEqual([]);
  });
});
