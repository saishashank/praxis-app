// @vitest-environment node
// V1-S3 / D-711: the live run entry points skip a weekday the calendar has no row for
// (`calendar_missing`) when the caller asks for the strict gate; the default stays the looser walk
// that replays and the synthetic-date suites use. Past the 2027-12-31 seed every weekday is such a day.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signalsDay } from "@/lib/agents/batch2b";
import { reviewDay } from "@/lib/agents/batch3";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { runPreopen } from "@/lib/arena/preopen";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = () => "2028-03-15T09:00:00.000Z";
const GAP = "2028-03-15"; // a Wednesday after the seed: no row
const COVERED = "2026-11-03"; // a Tuesday inside the seed: a session row
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
});

describe("closeBooksDay", () => {
  it("strict: skips a weekday with no calendar row as calendar_missing, with a skipped run record", async () => {
    const r = await closeBooksDay(db, { market: "AU", d: GAP, now: NOW, strictCalendar: true });
    expect(r).toMatchObject({ status: "skipped", reason: "calendar_missing" });
    const runs = await db.execute("SELECT status, details_json FROM run_record");
    expect(runs.rows.map((x) => String(x.status))).toEqual(["skipped"]);
    expect(JSON.parse(String(runs.rows[0]!.details_json))).toEqual({ reason: "calendar_missing" });
  });

  it("default: the looser walk goes on to the next check (no Batch 1 marker)", async () => {
    const r = await closeBooksDay(db, { market: "AU", d: GAP, now: NOW });
    expect(r).toMatchObject({ status: "skipped", reason: "no_completion_marker" });
  });

  it("strict: a covered session day passes the calendar gate", async () => {
    const r = await closeBooksDay(db, { market: "AU", d: COVERED, now: NOW, strictCalendar: true });
    expect(r).toMatchObject({ status: "skipped", reason: "no_completion_marker" });
  });

  it("strict: a seeded holiday is non_trading_day, a weekend too", async () => {
    expect(
      await closeBooksDay(db, { market: "AU", d: "2026-12-25", now: NOW, strictCalendar: true }),
    ).toMatchObject({ reason: "non_trading_day" });
    expect(
      await closeBooksDay(db, { market: "AU", d: "2028-03-18", now: NOW, strictCalendar: true }),
    ).toMatchObject({ reason: "non_trading_day" });
  });
});

describe("runPreopen", () => {
  it("strict: calendar_missing; default: past the gate", async () => {
    expect(await runPreopen(db, { market: "AU", d: GAP, now: NOW, strictCalendar: true })).toEqual({
      status: "skipped",
      reason: "calendar_missing",
    });
    const loose = await runPreopen(db, { market: "AU", d: GAP, now: NOW });
    expect(loose).not.toMatchObject({ reason: "calendar_missing" });
  });
});

describe("signalsDay and reviewDay", () => {
  it("strict: calendar_missing", async () => {
    const sig = await signalsDay(db, {
      market: "AU",
      d: GAP,
      now: NOW,
      strictCalendar: true,
    } as never);
    expect(sig).toMatchObject({ status: "skipped", reason: "calendar_missing" });
    const rev = await reviewDay(db, {
      market: "AU",
      d: GAP,
      now: NOW,
      strictCalendar: true,
    } as never);
    expect(rev).toMatchObject({ status: "skipped", reason: "calendar_missing" });
  });
});
