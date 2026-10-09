// @vitest-environment node
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { finishRun, hasSuccess, latestPerJob, pruneRuns, startRun } from "@/lib/runs/runRecord";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

describe("run records", () => {
  it("start, finish and duration", async () => {
    const id = await startRun(db, {
      job: "eod",
      market: "AU",
      concurrencyKey: "eod:AU:2026-10-10",
      scheduledFor: "2026-10-10T06:00:00.000Z",
      commitSha: "abc",
      now: "2026-10-10T06:00:01.000Z",
    });
    let r = (await latestPerJob(db))[0];
    expect(r.last.status).toBe("running");
    expect(r.lastSuccess).toBeNull();
    expect(r.last.market).toBe("AU");
    await finishRun(db, id, {
      status: "success",
      itemsProcessed: 3,
      rowsRead: 10,
      rowsWritten: 4,
      llmTokens: 99,
      details: { a: 1 },
      now: "2026-10-10T06:00:03.500Z",
    });
    r = (await latestPerJob(db))[0];
    expect(r.last).toMatchObject({
      status: "success",
      durationMs: 2500,
      itemsProcessed: 3,
      rowsRead: 10,
      rowsWritten: 4,
      llmTokens: 99,
      details: { a: 1 },
      commitSha: "abc",
      endedAt: "2026-10-10T06:00:03.500Z",
    });
    expect(r.lastSuccess?.id).toBe(id);
  });

  it("uses the real clock by default and truncates error summaries to 500 chars", async () => {
    const id = await startRun(db, { job: "j", concurrencyKey: "k1" });
    await finishRun(db, id, { status: "failed", errorSummary: "e".repeat(900) });
    const r = (await latestPerJob(db))[0].last;
    expect(r.errorSummary).toHaveLength(500);
    expect(r.startedAt).toMatch(/Z$/);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.details).toBeUndefined();
  });

  it("finishRun on an unknown id throws", async () => {
    await expect(finishRun(db, 999, { status: "failed" })).rejects.toThrow(/not found/);
  });

  it("hasSuccess and one success per concurrency key", async () => {
    const a = await startRun(db, { job: "j", concurrencyKey: "k" });
    expect(await hasSuccess(db, "k")).toBe(false);
    await finishRun(db, a, { status: "success" });
    expect(await hasSuccess(db, "k")).toBe(true);
    const b = await startRun(db, { job: "j", concurrencyKey: "k" });
    await expect(finishRun(db, b, { status: "success" })).rejects.toThrow();
    await finishRun(db, b, { status: "skipped" });
  });

  it("latestPerJob gives last run and last success per job", async () => {
    const s1 = await startRun(db, {
      job: "a",
      concurrencyKey: "a1",
      now: "2026-10-01T00:00:00.000Z",
    });
    await finishRun(db, s1, { status: "success", now: "2026-10-01T00:00:01.000Z" });
    const s2 = await startRun(db, {
      job: "a",
      concurrencyKey: "a2",
      now: "2026-10-02T00:00:00.000Z",
    });
    await finishRun(db, s2, { status: "failed", now: "2026-10-02T00:00:01.000Z" });
    await startRun(db, { job: "b", concurrencyKey: "b1", now: "2026-10-03T00:00:00.000Z" });
    const out = await latestPerJob(db);
    expect(out.map((x) => x.job)).toEqual(["a", "b"]);
    expect(out[0].last.id).toBe(s2);
    expect(out[0].lastSuccess?.id).toBe(s1);
    expect(out[1].lastSuccess).toBeNull();
  });

  it("prunes runs older than the retention window", async () => {
    await startRun(db, { job: "j", concurrencyKey: "old", now: "2026-01-01T00:00:00.000Z" });
    await startRun(db, { job: "j", concurrencyKey: "new", now: "2026-09-30T00:00:00.000Z" });
    const n = await pruneRuns(db, "2026-10-10T00:00:00.000Z", 180);
    expect(n).toBe(1);
    const r = await db.execute("SELECT concurrency_key FROM run_record");
    expect(r.rows.map((x) => x.concurrency_key)).toEqual(["new"]);
  });
});
