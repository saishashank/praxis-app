// @vitest-environment node
// GL-05 / AT-42 "replay = live": the offline replay snapshot carries first_ingested_at and the stored
// cut-off poll markers, and applies the SAME bound the live decision view used (marker inside
// [cut-off, cut-off + 4 min], else cut-off + 4 min). Synthetic data only.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { defaultAgentParams } from "@/lib/agents/params";
import { buildSnapshot, loadSnapshot } from "@/lib/replay/snapshot";
import { snapshotAnnouncementVisible } from "@/lib/replay/snapshotWorld";
import { cutoffPollStatement, loadIngestBound } from "@/lib/sentinel/cutoffPoll";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const HHMM = defaultAgentParams().decisionCutoff;
const DAY = "2026-10-15"; // AEDT: cut-off 18:10 = 07:10Z
const CUTOFF = decisionCutoffUtc(DAY, HHMM);
const at = (hms: string): string => `${DAY}T${hms}.000Z`;
const ITEM = { published: at("07:08:00"), first: at("07:11:00") }; // published 18:08, stored 18:11

async function liveVisible(marker: string | null): Promise<boolean> {
  const db: Client = await freshDb("main");
  await db.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, price_sensitive, title, source, first_ingested_at)
          VALUES ('AU', 'AAA', 'A', ?, ?, 1, 't', 'test', ?)`,
    args: [ITEM.published, ITEM.first, ITEM.first],
  });
  if (marker !== null) await db.execute(cutoffPollStatement("AU", DAY, marker));
  const { bound } = await loadIngestBound(db, "AU", DAY, CUTOFF);
  const view = createDecisionView(db, {
    market: "AU",
    d: DAY,
    cutoff: CUTOFF,
    announcementIngestBound: bound,
  });
  return (await view.announcements({ codes: ["AAA"] })).length === 1;
}

function snapshotVisible(marker: string | null): boolean {
  const snap = loadSnapshot(
    buildSnapshot({
      from: DAY,
      to: DAY,
      inputs: {
        bars: [],
        calendar: [],
        universe: [],
        index_bars: [],
        corporate_actions: [],
        announcements: [
          {
            code: "AAA",
            ann_id: "A",
            published_at: ITEM.published,
            type: null,
            price_sensitive: 1,
            title: "t",
            first_ingested_at: ITEM.first,
          },
        ],
        cutoff_polls: marker === null ? [] : [{ d: DAY, at: marker }],
      },
    }).bytes,
  );
  const rows = snap.tables.announcements as unknown as { first_ingested_at: string | null }[];
  expect(rows[0]!.first_ingested_at).toBe(ITEM.first);
  const markers = new Map(
    (snap.tables.cutoff_polls as unknown as { d: string; at: string }[]).map((m) => [m.d, m.at]),
  );
  return snapshotAnnouncementVisible(
    { code: "AAA", ann_id: "A", published_at: ITEM.published, first_ingested_at: ITEM.first },
    markers,
    HHMM,
  );
}

describe("replay = live for an item published 18:08 and first stored 18:11", () => {
  it.each([
    ["marker 18:10:30: invisible live and in the snapshot", at("07:10:30"), false],
    ["marker 18:12:40: visible live and in the snapshot", at("07:12:40"), true],
    ["no marker: the 18:14 bound, visible in both", null, true],
    [
      "a marker later than 18:14 counts as missing: 18:14 bound, visible in both",
      at("07:20:00"),
      true,
    ],
  ] as const)("%s", async (_n, marker, expected) => {
    expect(await liveVisible(marker)).toBe(expected);
    expect(snapshotVisible(marker)).toBe(expected);
  });

  it("an item first stored after 18:14 is invisible in both without a marker", async () => {
    const a = {
      code: "AAA",
      ann_id: "B",
      published_at: ITEM.published,
      first_ingested_at: at("07:15:00"),
    };
    expect(snapshotAnnouncementVisible(a, new Map(), HHMM)).toBe(false);
    expect(snapshotAnnouncementVisible({ ...a, first_ingested_at: null }, new Map(), HHMM)).toBe(
      true,
    );
    expect(
      snapshotAnnouncementVisible({ ...a, first_ingested_at: undefined }, new Map(), HHMM),
    ).toBe(true);
  });

  it("an item published after the cut-off belongs to the next session's bound", () => {
    const a = {
      code: "AAA",
      ann_id: "C",
      published_at: at("09:00:00"),
      first_ingested_at: at("09:05:00"),
    };
    expect(snapshotAnnouncementVisible(a, new Map(), HHMM)).toBe(true);
  });
});

describe("older snapshots read as no marker", () => {
  it("a snapshot built without cutoff_polls loads with an empty table and legacy announcements", () => {
    const snap = loadSnapshot(
      buildSnapshot({
        from: DAY,
        to: DAY,
        inputs: {
          bars: [],
          calendar: [],
          universe: [],
          index_bars: [],
          corporate_actions: [],
          announcements: [
            {
              code: "AAA",
              ann_id: "A",
              published_at: ITEM.published,
              type: null,
              price_sensitive: 1,
              title: "t",
            },
          ],
        },
      }).bytes,
    );
    expect(snap.tables.cutoff_polls).toEqual([]);
    expect(
      (snap.tables.announcements as unknown as { first_ingested_at: unknown }[])[0]!
        .first_ingested_at,
    ).toBeNull();
  });
});
