// @vitest-environment node
// The `market` row is the Worker's projection of the profile (M19 A1; D-992, D-996): the row's tz, open, close,
// cut-off and currency equal the profile's, and `slots_json` equals slotsProjection(profile) for every seeded
// market. The AU projection also reproduces the Worker's recorded AU slot table (the step-0 snapshot,
// worker/test/fixtures/au-slots.snapshot.json): the same anchors, to the minute.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addMinutes, slotsProjection } from "@/lib/market/profileCore.mjs";
import { invalidateProfiles, loadProfile, loadProfiles } from "@/lib/market/profile";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";

afterEach(() => {
  cleanupTempDbs();
  invalidateProfiles();
});

type Slot = {
  id: string;
  time: string;
  until?: string;
  everyMin?: number;
  extra?: { attempt: number };
};
const au = JSON.parse(
  readFileSync(path.join(ROOT, "worker", "test", "fixtures", "au-slots.snapshot.json"), "utf8"),
) as { slots: Slot[] };
const slot = (id: string): Slot => au.slots.find((s) => s.id === id)!;

describe("the market row equals the profile's projection", () => {
  it("tz, session, cut-off, currency and slots_json, for every seeded market", async () => {
    const db = await freshDb("main");
    for (const p of await loadProfiles(db)) {
      const row = (await db.execute({ sql: "SELECT * FROM market WHERE code = ?", args: [p.code] }))
        .rows[0]!;
      expect(
        {
          tz: row.tz,
          open: row.open_time,
          close: row.close_time,
          cutoff: row.cutoff_time,
          currency: row.currency,
        },
        p.code,
      ).toEqual({
        tz: p.tz,
        open: p.sessionOpen,
        close: p.sessionClose,
        cutoff: p.decisionCutoff,
        currency: p.currency,
      });
      expect(p.slots, p.code).not.toBeNull();
      expect(JSON.parse(String(row.slots_json)), p.code).toEqual(p.slots);
      expect(slotsProjection(p)).toEqual(p.slots);
    }
  });

  it("AU's projection reproduces the Worker's recorded slot minutes", async () => {
    const db = await freshDb("main");
    const s = (await loadProfile(db, "AU")).slots!;
    expect(s.b1).toBe(slot("ingest-batch1").time);
    expect(s.b2a).toBe(slot("arena-close").time);
    expect(s.b2b).toBe(slot("arena-signals").time);
    expect(s.cutoff_poll).toBe(slot("decision-cutoff").time);
    expect(s.cutoff).toBe(slot("decision-cutoff").time);
    expect(s.preopen_recheck).toEqual([slot("pre-open").time, slot("pre-open-retry").time]);
    expect(s.quote_from).toBe(slot("quote-poll").time);
    expect(s.quote_until).toBe(slot("quote-poll").until);
    expect(s.intraday_scan_from).toBe(slot("intraday-scan").time);
    expect(s.intraday_scan_until).toBe(slot("intraday-scan").until);
    // the late-2a threshold (LATE_2A_AFTER, D-953): 2b slot + 30 minutes
    expect(s.late_2a_after).toBe(addMinutes(s.b2b, 30));
  });

  it("IN and US project close + 60 / + 80 / + 100 / + 130 minutes (spec 20.1) in the market's own zone", async () => {
    const db = await freshDb("main");
    const inn = (await loadProfile(db, "IN")).slots!;
    expect([inn.b1, inn.b2a, inn.b2b, inn.late_2a_after]).toEqual([
      "16:30",
      "16:50",
      "17:10",
      "17:40",
    ]);
    expect(inn.preopen_recheck).toEqual(["09:09", "09:13"]);
    const us = (await loadProfile(db, "US")).slots!;
    expect([us.b1, us.b2a, us.b2b, us.late_2a_after]).toEqual(["17:00", "17:20", "17:40", "18:10"]);
    expect(us.cutoff).toBe("18:00");
  });

  it("the projection is null while a needed field is not set, and wraps at midnight", () => {
    expect(
      slotsProjection({
        sessionOpen: null,
        sessionClose: "16:00",
        decisionCutoff: "18:10",
        batchSchedule: {},
        preopenRecheckMin: 5,
      }),
    ).toBeNull();
    expect(
      slotsProjection({
        sessionOpen: "10:00",
        sessionClose: "16:00",
        decisionCutoff: "18:10",
        batchSchedule: { kind: "weird" },
        preopenRecheckMin: 5,
      }),
    ).toBeNull();
    expect(addMinutes("23:50", 20)).toBe("00:10");
    expect(addMinutes("00:05", -10)).toBe("23:55");
  });
});
