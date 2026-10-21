// @vitest-environment node
// M8 T12: the PLT-073 deadline checker (docs/M8_design.md 2.2, decision 45; TST-106, AT-28).
// Pure cases (normal, late, missing, early close, DST forward and back), the table against the spec
// text and the Worker slot table, and the record readers on a migrated database.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarRow } from "@/lib/data/calendar";
import {
  STEPS,
  checkDay,
  dayPasses,
  evaluateDay,
  hhmmLocal,
  readObservations,
  renderTable,
  type Observation,
  type Observations,
  type StepRow,
} from "@/lib/runs/deadlines";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";

afterEach(cleanupTempDbs);

const ok = (startedAt: string, finishedAt: string): Observation => ({
  startedAt,
  finishedAt,
  ok: true,
});
const OPEN = "10:00";
const byId = (rows: StepRow[], id: string) => rows.find((r) => r.id === id)!;

// Melbourne 2026-10-05 (Monday) is AEDT, UTC+11: 17:30 local = 06:30Z.
const FULL_DAY_AEDT: Observations = {
  preopen: null,
  batch1: ok("2026-10-05T06:30:10.000Z", "2026-10-05T06:55:00.000Z"), // 17:30..17:55
  batch2: ok("2026-10-05T07:10:10.000Z", "2026-10-05T07:25:00.000Z"), // 18:10..18:25
  batch3: ok("2026-10-05T07:40:10.000Z", "2026-10-05T07:52:00.000Z"), // 18:40..18:52
  narrative: ok("2026-10-05T08:10:10.000Z", "2026-10-05T08:25:00.000Z"), // 19:10..19:25
  late_sweep: ok("2026-10-05T08:36:00.000Z", "2026-10-05T08:40:00.000Z"), // 19:40
  marker: ok("2026-10-05T08:45:00.000Z", "2026-10-05T08:45:00.000Z"), // 19:45
  email: ok("2026-10-05T09:00:00.000Z", "2026-10-05T09:02:00.000Z"), // 20:02
};
// The pre-open check ran at 09:54 AEDT on the same date = 22:54Z the day before.
FULL_DAY_AEDT.preopen = ok("2026-10-04T22:54:05.000Z", "2026-10-04T22:54:30.000Z");

const NOW_EVENING = new Date("2026-10-05T11:00:00.000Z"); // 22:00 AEDT, everything is due

function day(
  date: string,
  observations: Observations,
  now: Date,
  calendar: CalendarRow[] = [],
  config: Parameters<typeof evaluateDay>[0]["config"] = {},
): StepRow[] {
  return evaluateDay({ date, calendar, observations, now, openTime: OPEN, config });
}

describe("evaluateDay: a normal trading day", () => {
  it("passes every step when each job finished before its deadline", () => {
    const rows = day("2026-10-05", FULL_DAY_AEDT, NOW_EVENING);
    expect(rows.map((r) => r.status)).toEqual(STEPS.map(() => "on_time"));
    expect(dayPasses(rows)).toBe(true);
    expect(byId(rows, "batch1")).toMatchObject({ start: "17:30", deadline: "18:10" });
    expect(byId(rows, "batch1").finishedAt).toBe("17:55");
    expect(byId(rows, "preopen")).toMatchObject({ deadline: "10:00", finishedAt: "09:54" });
  });

  it("each step's deadline is the next step's start (PLT-073)", () => {
    const rows = day("2026-10-05", FULL_DAY_AEDT, NOW_EVENING);
    const chain = ["batch1", "batch2", "batch3", "narrative", "late_sweep"];
    for (let i = 0; i < chain.length - 1; i++) {
      expect(byId(rows, chain[i]).deadline).toBe(byId(rows, chain[i + 1]).start);
    }
    expect(byId(rows, "late_sweep").deadline).toBe(byId(rows, "marker").start);
  });
});

describe("evaluateDay: late, missing, not due", () => {
  it("a job that finishes after its deadline is late and fails the day", () => {
    const obs = {
      ...FULL_DAY_AEDT,
      batch2: ok("2026-10-05T07:10:10.000Z", "2026-10-05T07:41:00.000Z"),
    }; // 18:41
    const rows = day("2026-10-05", obs, NOW_EVENING);
    expect(byId(rows, "batch2")).toMatchObject({ status: "late", finishedAt: "18:41" });
    expect(byId(rows, "batch2").reason).toContain("deadline 18:40");
    expect(dayPasses(rows)).toBe(false);
  });

  it("a finish exactly at the deadline is on time", () => {
    const obs = {
      ...FULL_DAY_AEDT,
      batch1: ok("2026-10-05T06:30:00.000Z", "2026-10-05T07:10:00.000Z"),
    }; // 18:10:00
    expect(byId(day("2026-10-05", obs, NOW_EVENING), "batch1").status).toBe("on_time");
  });

  it("no record after the deadline is missing; before it, not due", () => {
    const obs = { ...FULL_DAY_AEDT, email: null };
    expect(byId(day("2026-10-05", obs, NOW_EVENING), "email").status).toBe("missing");
    const early = new Date("2026-10-05T09:30:00.000Z"); // 20:30 local, before 20:45
    expect(byId(day("2026-10-05", obs, early), "email").status).toBe("not_due");
  });

  it("a failed run is missing even when the deadline has not passed", () => {
    const obs = {
      ...FULL_DAY_AEDT,
      batch3: {
        startedAt: "2026-10-05T07:40:00.000Z",
        finishedAt: "2026-10-05T07:41:00.000Z",
        ok: false,
      },
    };
    const rows = day("2026-10-05", obs, new Date("2026-10-05T07:45:00.000Z"));
    expect(byId(rows, "batch3")).toMatchObject({ status: "missing", reason: "the run failed" });
  });

  it("a run still going: not due before the deadline, missing after it", () => {
    const obs = {
      ...FULL_DAY_AEDT,
      batch2: { startedAt: "2026-10-05T07:10:00.000Z", finishedAt: null, ok: true },
    };
    expect(
      byId(day("2026-10-05", obs, new Date("2026-10-05T07:30:00.000Z")), "batch2").status,
    ).toBe("not_due");
    expect(byId(day("2026-10-05", obs, NOW_EVENING), "batch2").status).toBe("missing");
  });

  it("a non-trading day (holiday) skips the trading-only steps but still needs batch 1, marker and email", () => {
    const cal: CalendarRow[] = [{ d: "2026-10-05", kind: "holiday", close_time: null }];
    const obs: Observations = {
      batch1: ok("2026-10-05T06:30:00.000Z", "2026-10-05T06:40:00.000Z"),
      marker: ok("2026-10-05T08:45:00.000Z", "2026-10-05T08:45:00.000Z"),
      email: null,
    };
    const rows = day("2026-10-05", obs, NOW_EVENING, cal);
    for (const id of ["preopen", "batch2", "batch3", "narrative", "late_sweep"]) {
      expect(byId(rows, id)).toMatchObject({ status: "not_due", reason: "not a trading day" });
    }
    expect(byId(rows, "batch1").status).toBe("on_time");
    expect(byId(rows, "email").status).toBe("missing");
  });
});

describe("evaluateDay: early close (PLT-073 s13)", () => {
  it("keeps the same fixed evening times; only the session close differs", () => {
    const early: CalendarRow[] = [{ d: "2026-12-24", kind: "early_close", close_time: "14:10" }];
    // Melbourne in December is AEDT (UTC+11): 18:05 local = 07:05Z.
    const obs: Observations = {
      batch1: ok("2026-12-24T06:30:00.000Z", "2026-12-24T07:05:00.000Z"),
      batch2: ok("2026-12-24T07:10:00.000Z", "2026-12-24T07:30:00.000Z"),
      batch3: ok("2026-12-24T07:40:00.000Z", "2026-12-24T07:50:00.000Z"),
      narrative: ok("2026-12-24T08:10:00.000Z", "2026-12-24T08:20:00.000Z"),
      late_sweep: ok("2026-12-24T08:30:00.000Z", "2026-12-24T08:40:00.000Z"),
      marker: ok("2026-12-24T08:45:00.000Z", "2026-12-24T08:45:00.000Z"),
      email: ok("2026-12-24T09:00:00.000Z", "2026-12-24T09:01:00.000Z"),
      preopen: ok("2026-12-23T22:54:00.000Z", "2026-12-23T22:54:30.000Z"),
    };
    const normal = day("2026-12-23", {}, new Date("2026-12-23T00:00:00.000Z"));
    const rows = day("2026-12-24", obs, new Date("2026-12-24T12:00:00.000Z"), early);
    expect(rows.map((r) => [r.start, r.deadline])).toEqual(
      normal.map((r) => [r.start, r.deadline]),
    );
    expect(rows.map((r) => r.status)).toEqual(STEPS.map(() => "on_time"));
  });
});

describe("evaluateDay: daylight saving", () => {
  it("DST forward (first Sunday in October): 18:20 AEDT is late, though it would be 17:20 on AEST", () => {
    // Monday 2026-10-05 after the change on Sunday 2026-10-04. 07:20Z = 18:20 AEDT.
    const obs = { batch1: ok("2026-10-05T06:30:00.000Z", "2026-10-05T07:20:00.000Z") };
    const r = byId(day("2026-10-05", obs, NOW_EVENING), "batch1");
    expect(r).toMatchObject({ status: "late", finishedAt: "18:20" });
  });

  it("DST back (first Sunday in April): the same UTC instant, 07:20Z = 17:20 AEST, is on time", () => {
    // Tuesday 2026-04-07 after the change on Sunday 2026-04-05.
    const obs = { batch1: ok("2026-04-07T07:30:00.000Z", "2026-04-07T07:20:00.000Z") };
    const r = byId(day("2026-04-07", obs, new Date("2026-04-07T12:00:00.000Z")), "batch1");
    // 17:30 AEST = 07:30Z so the start is after the finish only in this synthetic row; the finish is what is judged.
    expect(r).toMatchObject({ status: "on_time", finishedAt: "17:20" });
    const later = byId(
      day(
        "2026-04-07",
        { batch1: ok("2026-04-07T07:30:00.000Z", "2026-04-07T08:20:00.000Z") },
        new Date("2026-04-07T12:00:00.000Z"),
      ),
      "batch1",
    );
    expect(later).toMatchObject({ status: "late", finishedAt: "18:20" });
  });

  it("the changeover Sundays themselves: email and marker are judged on the local clock", () => {
    // Sunday 2026-10-04 (clocks forward at 02:00): 20:00 AEDT = 09:00Z. 20:44 AEDT = 09:44Z.
    const fwd = day(
      "2026-10-04",
      { email: ok("2026-10-04T09:00:00.000Z", "2026-10-04T09:44:00.000Z") },
      new Date("2026-10-04T12:00:00.000Z"),
    );
    expect(byId(fwd, "email")).toMatchObject({ status: "on_time", finishedAt: "20:44" });
    // Sunday 2026-04-05 (clocks back at 03:00): 20:00 AEST = 10:00Z. 20:46 AEST = 10:46Z.
    const back = day(
      "2026-04-05",
      { email: ok("2026-04-05T10:00:00.000Z", "2026-04-05T10:46:00.000Z") },
      new Date("2026-04-05T12:00:00.000Z"),
    );
    expect(byId(back, "email")).toMatchObject({ status: "late", finishedAt: "20:46" });
  });

  it("hhmmLocal follows the zone's offset on each side of both changes", () => {
    expect(hhmmLocal(new Date("2026-10-03T06:30:00.000Z"))).toBe("16:30"); // AEST
    expect(hhmmLocal(new Date("2026-10-05T06:30:00.000Z"))).toBe("17:30"); // AEDT
    expect(hhmmLocal(new Date("2026-04-04T06:30:00.000Z"))).toBe("17:30"); // AEDT
    expect(hhmmLocal(new Date("2026-04-07T07:30:00.000Z"))).toBe("17:30"); // AEST
  });
});

describe("configuration overrides", () => {
  it("decision_cutoff, evening_review_time and send_by move the matching times", () => {
    const rows = day("2026-10-05", {}, NOW_EVENING, [], {
      decision_cutoff: "18:15",
      evening_review_time: "20:05",
      send_by: "20:50",
    });
    expect(byId(rows, "batch1").deadline).toBe("18:15");
    expect(byId(rows, "batch2").start).toBe("18:15");
    expect(byId(rows, "email")).toMatchObject({ start: "20:05", deadline: "20:50" });
  });

  it("a malformed value falls back to the table", () => {
    const rows = day("2026-10-05", {}, NOW_EVENING, [], { send_by: "late" });
    expect(byId(rows, "email").deadline).toBe("20:45");
  });
});

describe("the table against its sources", () => {
  const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  const spec = read("spec/13_review_errata_and_addenda.md");
  const sched = read("worker/src/schedule.ts");

  it("every step start time is a PLT-073 row (spec/13)", () => {
    const table = spec.slice(spec.indexOf("PLT-073 Canonical"), spec.indexOf("## 13.5"));
    for (const s of STEPS.filter((x) => x.id !== "preopen" && x.id !== "marker")) {
      expect(table.includes(`| ${s.start}`), s.id).toBe(true);
    }
    expect(table).toContain("| 19:45 | Completion marker");
  });

  it("the Worker's slot table agrees on the times it dispatches", () => {
    const slotTime = (id: string) =>
      new RegExp(`id: "${id}",\\s*time: "(\\d\\d:\\d\\d)"`).exec(sched)?.[1];
    expect(slotTime("ingest-batch1")).toBe(STEPS.find((s) => s.id === "batch1")!.start);
    expect(slotTime("arena-signals")).toBe(STEPS.find((s) => s.id === "batch2")!.start);
    expect(slotTime("late-sweep")).toBe(STEPS.find((s) => s.id === "late_sweep")!.start);
    expect(slotTime("marker-check")).toBe(STEPS.find((s) => s.id === "marker")!.deadline);
    expect(slotTime("pre-open")).toBe(STEPS.find((s) => s.id === "preopen")!.start);
    expect(slotTime("evening-review")).toBe(STEPS.find((s) => s.id === "email")!.start);
    expect(slotTime("decision-cutoff")).toBe(STEPS.find((s) => s.id === "batch2")!.start);
  });
});

describe("readObservations and checkDay on a migrated database", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
  });

  async function run(job: string, d: string, start: string, end: string | null, status: string) {
    await db.execute({
      sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
            VALUES (?, 'AU', ?, ?, ?, ?, ?)`,
      args: [job, `${job}:AU:${d}:${start}`, d, start, end, status],
    });
  }

  it("reads runs, the marker, the review email and the pre-open record for the date", async () => {
    const d = "2026-10-05";
    await run(
      "ingest-batch1",
      d,
      "2026-10-05T06:30:00.000Z",
      "2026-10-05T06:50:00.000Z",
      "success",
    );
    await run("arena-signals", d, "2026-10-05T07:10:00.000Z", "2026-10-05T07:12:00.000Z", "failed");
    await run(
      "arena-signals",
      d,
      "2026-10-05T07:20:00.000Z",
      "2026-10-05T07:30:00.000Z",
      "success",
    );
    await run("arena-review", d, "2026-10-05T07:40:00.000Z", null, "running");
    await db.execute({
      sql: "INSERT INTO completion_marker (market, d, kind, at, outcome) VALUES ('AU', ?, 'data', ?, 'ok')",
      args: [d, "2026-10-05T08:45:00.000Z"],
    });
    await db.execute({
      sql: `INSERT INTO email_message (email_key, env, kind, d, slot, status, sent_at, created_at)
            VALUES ('review:2026-10-05', 'staging', 'review', ?, 'reserved_review', 'sent', ?, ?)`,
      args: [d, "2026-10-05T09:01:00.000Z", "2026-10-05T09:00:00.000Z"],
    });
    await db.execute({
      sql: `INSERT INTO preopen_run (market, d, attempt, started_at, finished_at, status, checked, cancelled)
            VALUES ('AU', ?, 1, ?, ?, 'ok', 1, 0)`,
      args: [d, "2026-10-04T22:54:00.000Z", "2026-10-04T22:54:20.000Z"],
    });
    const obs = await readObservations(db, d, "staging");
    expect(obs.batch1).toMatchObject({ ok: true, finishedAt: "2026-10-05T06:50:00.000Z" });
    expect(obs.batch2).toMatchObject({ ok: true, finishedAt: "2026-10-05T07:30:00.000Z" });
    expect(obs.batch3).toMatchObject({ ok: true, finishedAt: null });
    expect(obs.narrative).toBeNull();
    expect(obs.marker).toMatchObject({ finishedAt: "2026-10-05T08:45:00.000Z" });
    expect(obs.email).toMatchObject({ finishedAt: "2026-10-05T09:01:00.000Z" });
    expect(obs.preopen).toMatchObject({ ok: true });
    // The email of another environment is ignored.
    expect((await readObservations(db, d, "production")).email).toBeNull();

    const rows = await checkDay(db, d, NOW_EVENING, "staging");
    expect(byId(rows, "batch1").status).toBe("on_time");
    expect(byId(rows, "batch3").status).toBe("missing"); // still running at the deadline
    expect(byId(rows, "narrative").status).toBe("missing");
    expect(byId(rows, "email").status).toBe("on_time");
  });

  it("the rendered table holds step names and times only", async () => {
    const rows = await checkDay(db, "2026-10-05", NOW_EVENING, "staging");
    const text = renderTable(rows);
    expect(text).toContain("| Step | Start | Deadline |");
    expect(text).not.toMatch(/https?:|@|token|secret/i);
    expect(text.split("\n")).toHaveLength(STEPS.length + 2);
  });
});
