// @vitest-environment node
// PLT-050, PLT-051, PLT-014, DAT-141, UX-100, LLM-050 (usage meters)
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setConfig } from "@/lib/config/store";
import {
  dayBounds,
  getMeters,
  levelFor,
  monthBounds,
  usageEnvironment,
  worstMeter,
  type Meter,
} from "@/lib/usage/meters";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
let seq = 0;
async function insert(p: {
  job?: string;
  at: string;
  read?: number;
  written?: number;
  tokens?: number;
  ms?: number | null;
}) {
  await db.execute({
    sql: `INSERT INTO run_record (job, concurrency_key, started_at, status, rows_read, rows_written,
          llm_tokens, duration_ms) VALUES (?, ?, ?, 'success', ?, ?, ?, ?)`,
    args: [
      p.job ?? "data-refresh",
      `k${seq++}`,
      p.at,
      p.read ?? 0,
      p.written ?? 0,
      p.tokens ?? 0,
      p.ms === undefined ? null : p.ms,
    ],
  });
}
const byId = (ms: Meter[], id: string) => ms.find((m) => m.id === id)!;

describe("levelFor", () => {
  const t = { notice: 0.7, alert: 0.9, degrade: 0.95 };
  it("steps exactly at 70 / 90 / 95 %", () => {
    expect(levelFor(0.6999, t)).toBe("ok");
    expect(levelFor(0.7, t)).toBe("notice");
    expect(levelFor(0.8999, t)).toBe("notice");
    expect(levelFor(0.9, t)).toBe("alert");
    expect(levelFor(0.9499, t)).toBe("alert");
    expect(levelFor(0.95, t)).toBe("degrade");
    expect(levelFor(2, t)).toBe("degrade");
  });
  it("is capped for soft ceilings and daily quotas", () => {
    expect(levelFor(1.5, t, "alert")).toBe("alert");
    expect(levelFor(0.75, t, "alert")).toBe("notice");
  });
});

describe("period bounds and environment", () => {
  it("uses UTC calendar month and day, including December rollover", () => {
    expect(monthBounds(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
      label: "2026-12 (UTC)",
    });
    expect(dayBounds(NOW).start).toBe("2026-10-10T00:00:00.000Z");
    expect(dayBounds(NOW).label).toBe("2026-10-10 (UTC)");
  });
  it("staging only when TEST_IDENTITY_SECRET is present", () => {
    expect(usageEnvironment({ TEST_IDENTITY_SECRET: "x" })).toBe("staging");
    expect(usageEnvironment({ TEST_IDENTITY_SECRET: "" })).toBe("production");
    expect(usageEnvironment({})).toBe("production");
  });
});

describe("getMeters", () => {
  it("sums rows read/written inside the month only (boundaries)", async () => {
    await insert({ at: "2026-09-30T23:59:59.999Z", read: 1000, written: 100 }); // before
    await insert({ at: "2026-10-01T00:00:00.000Z", read: 10, written: 1 }); // first ms
    await insert({ at: "2026-10-31T23:59:59.999Z", read: 20, written: 2 }); // last ms
    await insert({ at: "2026-11-01T00:00:00.000Z", read: 5000, written: 500 }); // after
    const ms = await getMeters(db, NOW, "production");
    expect(byId(ms, "turso-rows-read")).toMatchObject({
      used: 30,
      limit: 300_000_000,
      period: "monthly",
      periodLabel: "2026-10 (UTC)",
      level: "ok",
    });
    expect(byId(ms, "turso-rows-written")).toMatchObject({ used: 3, limit: 6_000_000 });
    expect(byId(ms, "turso-rows-read").note).toMatch(/app traffic not included/);
  });

  it("reaches notice / alert / degrade at exactly 70 / 90 / 95 % of the writes ceiling", async () => {
    for (const [w, level] of [
      [4_200_000, "notice"],
      [5_400_000, "alert"],
      [5_700_000, "degrade"],
    ] as const) {
      await db.execute("DELETE FROM run_record");
      await insert({ at: "2026-10-02T00:00:00.000Z", written: w });
      const m = byId(await getMeters(db, NOW, "production"), "turso-rows-written");
      expect(m.level).toBe(level);
    }
    await db.execute("DELETE FROM run_record");
    await insert({ at: "2026-10-02T00:00:00.000Z", written: 4_199_999 });
    expect(byId(await getMeters(db, NOW, "production"), "turso-rows-written").level).toBe("ok");
  });

  it("staging limits are 15 % of the ceilings", async () => {
    const ms = await getMeters(db, NOW, "staging");
    expect(byId(ms, "turso-rows-written").limit).toBe(900_000);
    expect(byId(ms, "turso-rows-read").limit).toBe(45_000_000);
    expect(byId(ms, "turso-rows-written").note).toMatch(/staging/);
    await insert({ at: "2026-10-02T00:00:00.000Z", written: 900_000 });
    expect(byId(await getMeters(db, NOW, "staging"), "turso-rows-written").level).toBe("degrade");
  });

  it("limits and thresholds come from configuration", async () => {
    await setConfig(db, {
      key: "turso_writes_ceiling_month",
      value: 1000,
      userId: 1,
      now: "2026-10-01T00:00:00.000Z",
    });
    await setConfig(db, {
      key: "quota_thresholds",
      value: { notice: 0.1, alert: 0.2, degrade: 0.3 },
      userId: 1,
      now: "2026-10-01T00:00:00.000Z",
    });
    await insert({ at: "2026-10-02T00:00:00.000Z", written: 100 });
    const m = byId(await getMeters(db, NOW, "production"), "turso-rows-written");
    expect(m).toMatchObject({ limit: 1000, level: "notice" });
  });

  it("no-data meters: storage, actions without rows, emails without a limit", async () => {
    const ms = await getMeters(db, NOW, "production");
    expect(byId(ms, "turso-storage")).toMatchObject({
      used: null,
      limit: 3,
      ratio: null,
      level: "no data",
    });
    expect(byId(ms, "turso-storage").note).toMatch(/Not measured yet/);
    expect(byId(ms, "actions-minutes")).toMatchObject({ used: null, level: "no data" });
    expect(byId(ms, "emails-sent")).toMatchObject({ used: 0, limit: null, level: "no data" });
  });

  it("actions minutes come from actions-* jobs, are capped at alert and only warn", async () => {
    await insert({ job: "actions-nightly", at: "2026-10-03T00:00:00.000Z", ms: 60_000 * 2900 });
    await insert({ job: "actions-batch", at: "2026-10-04T00:00:00.000Z", ms: 60_000 * 100 + 1 });
    await insert({ job: "data-refresh", at: "2026-10-04T00:00:00.000Z", ms: 999_999_999 });
    await insert({ job: "actions-old", at: "2026-09-04T00:00:00.000Z", ms: 999_999_999 });
    const m = byId(await getMeters(db, NOW, "production"), "actions-minutes");
    expect(m).toMatchObject({ used: 3001, limit: 3000, level: "alert" });
  });

  it("counts email-* jobs this month", async () => {
    await insert({ job: "email-digest", at: "2026-10-05T00:00:00.000Z" });
    await insert({ job: "email-alert", at: "2026-10-06T00:00:00.000Z" });
    await insert({ job: "email-alert", at: "2026-09-06T00:00:00.000Z" });
    expect(byId(await getMeters(db, NOW, "production"), "emails-sent").used).toBe(2);
  });

  it("LLM tokens are totalled for today (UTC) against the daily budget", async () => {
    await insert({ at: "2026-10-09T23:59:59.999Z", tokens: 999_999 });
    await insert({ at: "2026-10-10T00:00:00.000Z", tokens: 100_000 });
    await insert({ at: "2026-10-10T11:00:00.000Z", tokens: 50_000 });
    const m = byId(await getMeters(db, NOW, "production"), "llm-tokens");
    expect(m).toMatchObject({ used: 150_000, limit: 150_000, period: "daily", level: "alert" });
  });
});

describe("worstMeter", () => {
  const m = (id: string, level: Meter["level"]): Meter => ({
    id,
    label: id,
    used: 1,
    limit: 2,
    unit: "u",
    period: "monthly",
    periodLabel: "p",
    ratio: 0.5,
    level,
    note: "",
  });
  it("picks the most severe, first on ties; no data only when all are", () => {
    expect(worstMeter([m("a", "ok"), m("b", "alert"), m("c", "notice"), m("d", "alert")])).toEqual(
      expect.objectContaining({ level: "alert", meter: expect.objectContaining({ id: "b" }) }),
    );
    expect(worstMeter([m("a", "no data"), m("b", "ok")]).level).toBe("ok");
    expect(worstMeter([m("a", "no data")]).level).toBe("no data");
    expect(worstMeter([])).toEqual({ level: "no data" });
  });
});
