// @vitest-environment node
// V2-I4 (D-773) Worker route posts per slot per day, V1-I1 (D-770, D-771) the "last 7 nights" table and the
// jobs that were missing from JOBS. Synthetic data.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOBS } from "@/lib/health/jobs";
import {
  buildNights,
  NIGHTS,
  routeFailuresSince,
  routeLinesOf,
  workerRouteLines,
} from "@/lib/health/routePosts";
import { STEPS, type StepRow } from "@/lib/runs/deadlines";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

async function fail(slot: string, date: string, n: number, summary = `route ${slot} HTTP 503`) {
  await db.execute({
    sql:
      "INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status, error_summary, details_json) " +
      "VALUES ('worker-route', 'AU', ?, ?, ?, ?, 'failed', ?, ?)",
    args: [
      `route-failed:${slot}:${date}:${n}`,
      date,
      `${date}T01:0${n}:00.000Z`,
      `${date}T01:0${n}:00.000Z`,
      summary,
      JSON.stringify({ slot, attempt: n }),
    ],
  });
}

describe("routeFailuresSince / workerRouteLines", () => {
  it("counts failed posts per slot and day and says nothing for a clean day", async () => {
    await fail("morning", "2026-11-02", 1);
    await fail("morning", "2026-11-02", 2, "route morning TimeoutError");
    await fail("quote-poll", "2026-11-02", 1);
    await fail("morning", "2026-10-30", 1);
    const f = await routeFailuresSince(db, "2026-10-30");
    expect(f.find((x) => x.slot === "morning" && x.date === "2026-11-02")).toMatchObject({
      count: 2,
      last: "route morning TimeoutError",
    });
    const lines = routeLinesOf(f, "2026-11-02");
    expect(lines).toEqual([
      "Worker route morning: 2 failed posts today (route morning TimeoutError)",
      "Worker route quote-poll: 1 failed post today (route quote-poll HTTP 503)",
    ]);
    expect(routeLinesOf(f, "2026-11-03")).toEqual([]);
    expect(await workerRouteLines(db, new Date("2026-11-03T01:00:00Z"))).toEqual([]);
    expect(await workerRouteLines(db, new Date("2026-11-02T01:00:00Z"))).toHaveLength(2);
  });
});

describe("buildNights", () => {
  const rows = (status: StepRow["status"]): StepRow[] =>
    STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      start: "00:00",
      deadline: "00:00",
      startedAt: null,
      finishedAt: null,
      status,
      reason: "",
    }));

  it("one row per step plus one per failing route slot, one column per night", () => {
    const days = ["2026-11-01", "2026-11-02"].map((date, i) => ({
      date,
      rows: rows(i === 0 ? "on_time" : "missing"),
    }));
    const t = buildNights(days, [
      { slot: "morning", date: "2026-11-02", count: 2, last: "x" },
      { slot: "old", date: "2026-10-01", count: 1, last: "x" }, // outside the window: not a row
    ]);
    expect(t.dates).toEqual(["2026-11-01", "2026-11-02"]);
    expect(t.rows).toHaveLength(STEPS.length + 1);
    expect(t.rows[0].cells.map((c) => c.text)).toEqual(["on time", "MISSING"]);
    expect(t.rows[0].cells.map((c) => c.bad)).toEqual([false, true]);
    const route = t.rows[t.rows.length - 1];
    expect(route).toMatchObject({ id: "route:morning", kind: "route" });
    expect(route.cells.map((c) => c.text)).toEqual(["-", "2 failed"]);
    expect(NIGHTS).toBe(7);
  });
});

describe("JOBS (V1-I1)", () => {
  it("lists nightly maintenance, learning, narrative and the daily re-enable, once each", () => {
    for (const job of ["maintenance-nightly", "arena-learn", "arena-words", "worker-reenable"]) {
      expect(JOBS.filter((j) => j.job === job)).toHaveLength(1);
    }
    expect(new Set(JOBS.map((j) => j.job)).size).toBe(JOBS.length);
  });
});
