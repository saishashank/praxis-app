// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStale } from "@/lib/health/jobs";
import { formatMelbourne } from "@/lib/health/format";
import { recordSelfCheckRun } from "@/lib/health/recordSelfCheck";
import { getHealthSummary } from "@/lib/health/summary";
import { finishRun, startRun } from "@/lib/runs/runRecord";
import type { SelfCheckReport } from "@/lib/selfcheck/checks";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const NOW = new Date("2026-10-10T12:00:00.000Z");
const at = (secAgo: number) => new Date(NOW.getTime() - secAgo * 1000).toISOString();

async function run(
  job: string,
  status: "success" | "failed",
  secAgo: number,
  extra: { errorSummary?: string; details?: unknown } = {},
) {
  const id = await startRun(db, {
    job,
    concurrencyKey: `${job}:${secAgo}:${status}`,
    now: at(secAgo + 1),
  });
  await finishRun(db, id, { status, now: at(secAgo), ...extra });
}
const find = (s: Awaited<ReturnType<typeof getHealthSummary>>, job: string) =>
  s.jobs.find((j) => j.job === job)!;

describe("isStale", () => {
  it("exactly 2x interval is not stale, one ms more is", () => {
    const edge = new Date(NOW.getTime() - 120_000).toISOString();
    expect(isStale(60, edge, NOW)).toBe(false);
    expect(isStale(60, new Date(NOW.getTime() - 120_001).toISOString(), NOW)).toBe(true);
  });
  it("no interval, no success or an unparsable time is never stale", () => {
    expect(isStale(null, at(10_000_000), NOW)).toBe(false);
    expect(isStale(60, null, NOW)).toBe(false);
    expect(isStale(60, "garbage", NOW)).toBe(false);
  });
});

describe("getHealthSummary", () => {
  it("empty database: every known job is 'no data' with a note", async () => {
    const s = await getHealthSummary(db, NOW, "viewer");
    expect(s.jobs.map((j) => j.job)).toEqual([
      "credential-selfcheck-vercel",
      "worker-heartbeat",
      "nightly-backup",
    ]);
    for (const j of s.jobs) {
      expect(j).toMatchObject({ state: "no data", stale: false, lastRun: null });
      expect(j.note).toBeTruthy();
    }
  });

  it("staleness boundary at exactly 2x the interval, then beyond", async () => {
    await run("worker-heartbeat", "success", 120);
    expect(find(await getHealthSummary(db, NOW, "viewer"), "worker-heartbeat")).toMatchObject({
      state: "ok",
      stale: false,
    });
    const later = new Date(NOW.getTime() + 1);
    expect(find(await getHealthSummary(db, later, "viewer"), "worker-heartbeat")).toMatchObject({
      state: "stale",
      stale: true,
    });
  });

  it("on-demand job is never stale; failed beats ok; failed with no success is failed", async () => {
    await run("credential-selfcheck-vercel", "success", 90_000_000);
    expect(
      find(await getHealthSummary(db, NOW, "viewer"), "credential-selfcheck-vercel"),
    ).toMatchObject({ state: "ok", stale: false });
    await run("nightly-backup", "failed", 5, { errorSummary: "disk full" });
    const j = find(await getHealthSummary(db, NOW, "viewer"), "nightly-backup");
    expect(j).toMatchObject({ state: "failed", lastSuccessAt: null, stale: false });
    expect(j.lastRun?.status).toBe("failed");
  });

  it("a running job with no success yet is 'no data'", async () => {
    await startRun(db, { job: "on-demand-x", concurrencyKey: "k", now: at(5) });
    await startRun(db, { job: "worker-heartbeat", concurrencyKey: "k2", now: at(5) });
    const s = await getHealthSummary(db, NOW, "viewer");
    expect(find(s, "worker-heartbeat").state).toBe("no data");
  });

  it("owner sees secrets and error details", async () => {
    await run("credential-selfcheck-vercel", "failed", 30, {
      errorSummary: "1 check(s) failed",
      details: [
        { name: "AUTH_SECRET format", ok: true, pending: false, detail: "present" },
        { name: "RESEND", ok: false, pending: true, detail: "later" },
        { name: "no flags", detail: 5 },
        { ok: true },
        "junk",
        null,
      ],
    });
    const s = await getHealthSummary(db, NOW, "owner");
    expect(s.secrets?.lastVerifiedAt).toBe(at(30));
    expect(s.secrets?.results).toEqual([
      { name: "AUTH_SECRET format", ok: true, pending: false, detail: "present" },
      { name: "RESEND", ok: false, pending: true, detail: "later" },
      { name: "no flags", ok: false, pending: false, detail: "" },
    ]);
    expect(find(s, "credential-selfcheck-vercel").errorSummary).toBe("1 check(s) failed");
    expect(find(s, "nightly-backup").errorSummary).toBeNull();
  });

  it("owner with no self-check run or non-array details gets empty secrets", async () => {
    expect((await getHealthSummary(db, NOW, "owner")).secrets).toEqual({
      lastVerifiedAt: null,
      results: [],
    });
    await run("credential-selfcheck-vercel", "success", 3, { details: { not: "array" } });
    expect((await getHealthSummary(db, NOW, "owner")).secrets?.results).toEqual([]);
  });

  it.each(["editor", "viewer"] as const)(
    "%s gets neither secrets nor error details",
    async (role) => {
      await run("credential-selfcheck-vercel", "failed", 30, {
        errorSummary: "boom",
        details: [{ name: "X", ok: false, pending: false, detail: "missing" }],
      });
      const s = await getHealthSummary(db, NOW, role);
      expect("secrets" in s).toBe(false);
      for (const j of s.jobs) expect("errorSummary" in j).toBe(false);
      expect(JSON.stringify(s)).not.toContain("boom");
      expect(JSON.stringify(s)).not.toContain("missing");
    },
  );

  it("throws when the database fails", async () => {
    db.close();
    await expect(getHealthSummary(db, NOW, "viewer")).rejects.toThrow();
  });
});

describe("recordSelfCheckRun", () => {
  const report = (failed: number): SelfCheckReport => ({
    env: "staging",
    commit: "abc123",
    results: [
      { name: "A", ok: true, detail: "fine" },
      { name: "B", ok: false, detail: "missing" },
      { name: "C", ok: false, pending: true, detail: "later" },
    ],
    passed: 1,
    failed,
    pending: 1,
  });

  it("stores names, flags and details only; every call is its own run", async () => {
    await recordSelfCheckRun(db, report(1));
    await new Promise((r) => setTimeout(r, 3));
    await recordSelfCheckRun(db, report(0));
    const rows = (await db.execute("SELECT * FROM run_record ORDER BY id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      job: "credential-selfcheck-vercel",
      status: "failed",
      items_processed: 3,
      commit_sha: "abc123",
    });
    expect(String(rows[0].concurrency_key)).toMatch(/^credential-selfcheck-vercel:\d{4}-/);
    expect(rows[1].status).toBe("success");
    expect(rows[1].error_summary).toBeNull();
    expect(JSON.parse(String(rows[0].details_json))).toEqual([
      { name: "A", ok: true, pending: false, detail: "fine" },
      { name: "B", ok: false, pending: false, detail: "missing" },
      { name: "C", ok: false, pending: true, detail: "later" },
    ]);
  });

  it("works with a null commit", async () => {
    await recordSelfCheckRun(db, { ...report(0), commit: null });
    const r = (await db.execute("SELECT commit_sha FROM run_record")).rows[0];
    expect(r.commit_sha).toBeNull();
  });
});

describe("formatMelbourne", () => {
  it("shows Melbourne time (AEDT in October)", () => {
    expect(formatMelbourne("2026-10-10T12:00:00.000Z")).toBe("2026-10-10 23:00 AEDT");
  });
  it("shows AEST in winter", () => {
    expect(formatMelbourne("2026-07-01T00:30:00.000Z")).toBe("2026-07-01 10:30 AEST");
  });
  it("handles null and invalid", () => {
    expect(formatMelbourne(null)).toBe("Never");
    expect(formatMelbourne("nope")).toBe("Unknown");
  });
});
