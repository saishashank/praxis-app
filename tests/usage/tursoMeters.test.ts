// @vitest-environment node
// OPS-104 (D-958, PRD-045): the Turso meters read the platform sample and show it against 20 % of the
// free plan; without a usable sample they stay the labelled estimate.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMeters, tursoThresholds, type Meter } from "@/lib/usage/meters";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
const SAMPLE_AT = "2026-10-10T06:40:00.000Z";
const byId = (ms: Meter[], id: string) => ms.find((m) => m.id === id)!;

async function sample(p: {
  at?: string;
  read?: number;
  written?: number;
  storage?: number;
  plan?: string | null;
  source?: "platform" | "unavailable";
}) {
  const platform = (p.source ?? "platform") === "platform";
  await db.execute({
    sql: `INSERT INTO usage_sample (sampled_at, rows_read_month, rows_written_month, storage_bytes,
          plan_name, source) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      p.at ?? SAMPLE_AT,
      platform ? (p.read ?? 0) : null,
      platform ? (p.written ?? 0) : null,
      platform ? (p.storage ?? 0) : null,
      p.plan ?? null,
      p.source ?? "platform",
    ],
  });
}

describe("tursoThresholds", () => {
  it("notice and alert at the notice share of the ceiling, degrade at the ceiling", () => {
    expect(tursoThresholds(15, 20)).toEqual({ notice: 0.75, alert: 0.75, degrade: 1 });
    expect(tursoThresholds(10, 20)).toEqual({ notice: 0.5, alert: 0.5, degrade: 1 });
  });
});

describe("getMeters with a Turso platform sample", () => {
  it("uses the platform figure against 20 % of the free plan and shows our count beside it", async () => {
    await db.execute({
      sql: `INSERT INTO run_record (job, concurrency_key, started_at, status, rows_read, rows_written)
            VALUES ('data-refresh', 'k1', '2026-10-02T00:00:00.000Z', 'success', 1000000, 100)`,
      args: [],
    });
    await sample({ read: 50_000_000, written: 1_000_000, storage: 250_000_000, plan: "free" });
    const ms = await getMeters(db, NOW, "production");
    const reads = byId(ms, "turso-rows-read");
    expect(reads).toMatchObject({
      used: 50_000_000,
      limit: 100_000_000,
      source: "platform",
      planLimit: 500_000_000,
      level: "ok",
    });
    expect(reads.note).toMatch(/Platform figure, sampled 17:40 Melbourne/); // 06:40 UTC = 17:40 AEDT
    expect(reads.note).toMatch(/Our count: .*% against the platform/);
    expect(reads.note).not.toMatch(/Estimate/);
    expect(byId(ms, "turso-rows-written")).toMatchObject({
      used: 1_000_000,
      limit: 2_000_000,
      source: "platform",
      planLimit: 10_000_000,
    });
    expect(byId(ms, "turso-storage")).toMatchObject({
      used: 0.25,
      limit: 1,
      unit: "GB",
      source: "platform",
      planLimit: 5,
      level: "ok",
    });
  });

  // 500 M reads is the plan: 14.9 % = 74.5 M, 15 % = 75 M, 19.9 % = 99.5 M, 20 % = 100 M
  it.each([
    [74_500_000, "ok"],
    [75_000_000, "alert"],
    [99_500_000, "alert"],
    [100_000_000, "degrade"],
  ] as const)("reads at %i of the plan's 500 M is level %s", async (read, level) => {
    await sample({ read, plan: "free" });
    expect(byId(await getMeters(db, NOW, "production"), "turso-rows-read").level).toBe(level);
  });

  it("with no sample, an unavailable sample or an old one the meter is the labelled estimate", async () => {
    for (const arrange of [
      async () => {},
      async () => sample({ source: "unavailable" }),
      async () => sample({ at: "2026-10-05T06:40:00.000Z", read: 99 }), // five days old at NOW
    ]) {
      await arrange();
      const m = byId(await getMeters(db, NOW, "production"), "turso-rows-read");
      expect(m).toMatchObject({ source: "estimate", limit: 100_000_000, planLimit: 500_000_000 });
      expect(m.note).toMatch(/Estimate\./);
      expect(m.note).toMatch(/No platform sample/);
    }
    expect(byId(await getMeters(db, NOW, "production"), "turso-storage").level).toBe("no data");
  });

  it("ignores a sample from an earlier month", async () => {
    await sample({ at: "2026-09-30T06:40:00.000Z", read: 400_000_000 });
    expect(byId(await getMeters(db, NOW, "production"), "turso-rows-read").source).toBe("estimate");
  });
});
