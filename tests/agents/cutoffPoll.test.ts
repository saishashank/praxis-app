// @vitest-environment node
// GL-05 (D-207 item 5; AT-42): the "first completed poll after 18:10" marker, batch 2b's bounded wait,
// the announcement ingest bound in the decision view, and `cutoff_poll_missing` on the run record.
// Synthetic data only. NULL first_ingested_at = stored before the column = always visible (as D-211).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { signalsKey } from "@/lib/agents/batch2b";
import { defaultAgentParams } from "@/lib/agents/params";
import {
  CUTOFF_POLL_WINDOW_MS,
  announcementIngestBound,
  cutoffPollStatement,
  cutoffWindowEnd,
  loadIngestBound,
  readCutoffPoll,
  validCutoffPoll,
  waitForCutoffPoll,
} from "@/lib/sentinel/cutoffPoll";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import {
  MARKET,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden, D, DATE } from "./batch2bScenario";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
afterEach(cleanupTempDbs);

const p = defaultAgentParams();
const DAY = "2026-10-15"; // Thursday, AEDT: the cut-off 18:10 Melbourne is 07:10Z
const CUTOFF = decisionCutoffUtc(DAY, p.decisionCutoff);
const at = (hms: string): string => `${DAY}T${hms}.000Z`;
const run = (db: Client, sql: string, args: (string | number | null)[] = []) =>
  db.execute({ sql, args });
const mark = (db: Client, iso: string) => db.execute(cutoffPollStatement("AU", DAY, iso));

async function ann(
  db: Client,
  id: string,
  published: string,
  first: string | null,
  ingested: string = first ?? published,
): Promise<void> {
  await run(
    db,
    `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, type, price_sensitive, title, url, source, first_ingested_at)
     VALUES ('AU', 'AAA', ?, ?, ?, NULL, 1, 'Trading update', NULL, 'test', ?)`,
    [id, published, ingested, first],
  );
}

const visible = async (db: Client, bound: string | undefined, live = true): Promise<string[]> => {
  const view = createDecisionView(db, {
    market: "AU",
    d: DAY,
    cutoff: CUTOFF,
    liveIngestBound: live,
    announcementIngestBound: bound,
  });
  return (await view.announcements({ codes: ["AAA"] })).map((a) => a.ann_id).sort();
};

describe("marker and bound (pure)", () => {
  it("cut-off 07:10Z; the window ends 4 minutes later", () => {
    expect(CUTOFF).toBe(at("07:10:00"));
    expect(CUTOFF_POLL_WINDOW_MS).toBe(240_000);
    expect(cutoffWindowEnd(CUTOFF)).toBe(at("07:14:00"));
  });

  it("a marker counts only inside [cut-off, cut-off + 4 min]; else the bound is cut-off + 4 min", () => {
    expect(validCutoffPoll(at("07:12:40"), CUTOFF)).toBe(at("07:12:40"));
    expect(validCutoffPoll(at("07:10:00"), CUTOFF)).toBe(at("07:10:00"));
    expect(validCutoffPoll(at("07:14:00"), CUTOFF)).toBe(at("07:14:00"));
    expect(validCutoffPoll(at("07:14:01"), CUTOFF)).toBeNull(); // too late: treated as missing
    expect(validCutoffPoll(at("07:09:59"), CUTOFF)).toBeNull();
    expect(validCutoffPoll(null, CUTOFF)).toBeNull();
    expect(announcementIngestBound(at("07:12:40"), CUTOFF)).toBe(at("07:12:40"));
    expect(announcementIngestBound(at("07:20:00"), CUTOFF)).toBe(at("07:14:00"));
    expect(announcementIngestBound(null, CUTOFF)).toBe(at("07:14:00"));
  });

  it("the marker is insert-once: the first completed poll stays", async () => {
    const db = await freshDb("main");
    await mark(db, at("07:12:40"));
    await mark(db, at("07:16:40"));
    expect(await readCutoffPoll(db, "AU", DAY)).toBe(at("07:12:40"));
    expect(await loadIngestBound(db, "AU", DAY, CUTOFF)).toEqual({
      bound: at("07:12:40"),
      missing: false,
    });
    expect(await loadIngestBound(db, "AU", "2026-10-16", CUTOFF)).toEqual({
      bound: at("07:14:00"),
      missing: true,
    });
  });
});

describe("batch 2b's wait is bounded", () => {
  const clock = (startIso: string) => {
    let t = Date.parse(startIso);
    return {
      nowMs: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      slept: () => t - Date.parse(startIso),
    };
  };

  it("returns at once when the marker is there; waits for one that lands in the window", async () => {
    const db = await freshDb("main");
    const c = clock(at("07:10:30"));
    await mark(db, at("07:11:00"));
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUTOFF, ...c })).toBe(
      true,
    );
    expect(c.slept()).toBe(0);

    const db2 = await freshDb("main");
    const c2 = clock(at("07:10:30"));
    let calls = 0;
    const sleep = async (ms: number) => {
      await c2.sleep(ms);
      if (++calls === 3) await mark(db2, new Date(c2.nowMs()).toISOString());
    };
    expect(
      await waitForCutoffPoll(db2, {
        market: "AU",
        d: DAY,
        cutoffIso: CUTOFF,
        nowMs: c2.nowMs,
        sleep,
      }),
    ).toBe(true);
    expect(c2.slept()).toBe(45_000);
  });

  it("no marker: gives up at cut-off + 4 minutes and never waits longer than 4 minutes", async () => {
    const db = await freshDb("main");
    const c = clock(at("07:10:05"));
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUTOFF, ...c })).toBe(
      false,
    );
    expect(c.slept()).toBe(235_000); // to 07:14:00, not 4 min from the call
    // started before the cut-off: still at most 4 minutes from the call
    const early = clock(at("07:00:00"));
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUTOFF, ...early })).toBe(
      false,
    );
    expect(early.slept()).toBeLessThanOrEqual(CUTOFF_POLL_WINDOW_MS);
  });

  it("a run that starts after the window does not wait; a stopped clock cannot stall it", async () => {
    const db = await freshDb("main");
    const late = clock(at("07:20:00"));
    expect(await waitForCutoffPoll(db, { market: "AU", d: DAY, cutoffIso: CUTOFF, ...late })).toBe(
      false,
    );
    expect(late.slept()).toBe(0);
    let sleeps = 0;
    const stopped = await waitForCutoffPoll(db, {
      market: "AU",
      d: DAY,
      cutoffIso: CUTOFF,
      nowMs: () => Date.parse(at("07:10:30")),
      sleep: async () => {
        sleeps += 1;
      },
    });
    expect(stopped).toBe(false);
    expect(sleeps).toBeLessThanOrEqual(20);
  });
});

describe("visibility of announcements (AT-42)", () => {
  it("published 18:08, first stored 18:11: visible when the marker poll completed at 18:12:40", async () => {
    const db = await freshDb("main");
    await ann(db, "A", at("07:08:00"), at("07:11:00"));
    await mark(db, at("07:12:40"));
    const { bound } = await loadIngestBound(db, "AU", DAY, CUTOFF);
    expect(await visible(db, bound)).toEqual(["A"]);
  });

  it("... and not visible when the marker poll completed at 18:10:30, before the item was stored", async () => {
    const db = await freshDb("main");
    await ann(db, "A", at("07:08:00"), at("07:11:00"));
    await mark(db, at("07:10:30"));
    const { bound } = await loadIngestBound(db, "AU", DAY, CUTOFF);
    expect(bound).toBe(at("07:10:30"));
    expect(await visible(db, bound)).toEqual([]);
  });

  it("marker missing: items stored up to 18:14 are visible, later ones are not", async () => {
    const db = await freshDb("main");
    await ann(db, "A", at("07:08:00"), at("07:11:00"));
    await ann(db, "B", at("07:09:00"), at("07:13:59"));
    await ann(db, "C", at("07:09:30"), at("07:15:00"));
    const { bound, missing } = await loadIngestBound(db, "AU", DAY, CUTOFF);
    expect(missing).toBe(true);
    expect(await visible(db, bound)).toEqual(["A", "B"]);
  });

  it("live and replay see the same set (the bound does not depend on the replay flag)", async () => {
    const db = await freshDb("main");
    await ann(db, "A", at("07:08:00"), at("07:11:00"));
    await ann(db, "B", at("07:09:00"), at("07:16:00"));
    await mark(db, at("07:12:40"));
    const { bound } = await loadIngestBound(db, "AU", DAY, CUTOFF);
    expect(await visible(db, bound, true)).toEqual(await visible(db, bound, false));
    expect(await visible(db, bound, false)).toEqual(["A"]);
  });

  it("an item backfilled days later is invisible to the replay of its own day; legacy NULL rows are unchanged", async () => {
    const db = await freshDb("main");
    await ann(db, "LEGACY", at("06:00:00"), null, "2026-10-20T01:00:00.000Z"); // stored before the column
    await ann(db, "BACKFILLED", at("06:00:00"), "2026-10-20T01:00:00.000Z"); // first stored 5 days later
    await ann(db, "LIVE", at("06:00:00"), at("06:01:00"));
    const { bound } = await loadIngestBound(db, "AU", DAY, CUTOFF);
    expect(await visible(db, bound, false)).toEqual(["LEGACY", "LIVE"]);
    // no bound given (callers that do not set it): nothing is filtered, as before
    expect(await visible(db, undefined, false)).toEqual(["BACKFILLED", "LEGACY", "LIVE"]);
  });
});

describe("migration 0017 columns and writers", () => {
  it("adds a nullable first_ingested_at; existing rows stay NULL; the table is still append-only", async () => {
    const db = await freshDb("main");
    const cols = (await run(db, "PRAGMA table_info(announcement)")).rows.find(
      (r) => r.name === "first_ingested_at",
    );
    expect(cols).toBeDefined();
    expect(Number(cols!.notnull)).toBe(0);
    await ann(db, "L", at("06:00:00"), null);
    expect((await run(db, "SELECT first_ingested_at AS f FROM announcement")).rows[0].f).toBeNull();
    await expect(run(db, "UPDATE announcement SET first_ingested_at = 'x'")).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("cutoff_poll_missing on the batch 2b run record", () => {
  it("a live night without the marker records it; with the marker it does not; a replay never does", async () => {
    const details = async (db: Client): Promise<Record<string, unknown>> => {
      const rs = await run(db, "SELECT details_json FROM run_record WHERE concurrency_key = ?", [
        signalsKey(MARKET, DATE(D)),
      ]);
      return JSON.parse(String(rs.rows[0].details_json)) as Record<string, unknown>;
    };
    const night = async (marker: boolean, replay: boolean): Promise<Record<string, unknown>> => {
      const db = await freshReplayDb();
      await buildGolden(db);
      await setMode(db, "full");
      await startCohortsAt(db, 295, ["E01"]);
      if (marker) {
        const cutoff = decisionCutoffUtc(DATE(D), testParams().decisionCutoff);
        await db.execute(
          cutoffPollStatement("AU", DATE(D), new Date(Date.parse(cutoff) + 90_000).toISOString()),
        );
      }
      await runNights(db, testParams(), D, D, undefined, { replay });
      return details(db);
    };
    expect((await night(false, false)).cutoff_poll_missing).toBe(true);
    expect((await night(true, false)).cutoff_poll_missing).toBeUndefined();
    expect((await night(false, true)).cutoff_poll_missing).toBeUndefined();
  });
});
