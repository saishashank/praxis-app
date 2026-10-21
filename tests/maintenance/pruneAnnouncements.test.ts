// @vitest-environment node
// DAT-142 (news 400 days), DAT-140, DAT-125, D-057 decisions 7 and 13, M2_design T9 open question
// 4: announcements are pruned ONLY for months already exported to history files, never otherwise.
// `nowIso` is set well in the past (2025-09-01) so that the database trigger, which uses the real
// clock, never interferes with the boundary cases.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneAnnouncements, runMaintenance } from "@/lib/maintenance/retention";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = new Date("2025-09-01T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();
// 400 days before NOW.
const CUTOFF = "2024-07-28T00:00:00.000Z";
const EXPORT_AT = "2025-01-15T12:00:00.000Z";
const RUN = "backfill-history";

let main: Client;
let auth: Client;
beforeEach(async () => {
  main = await freshDb("main");
  auth = await freshDb("auth");
});

let n = 0;
async function ann(
  publishedAt: string,
  over: { ingested?: string; source?: string; market?: string } = {},
): Promise<string> {
  const annId = `a${++n}`;
  await main.execute({
    sql: `INSERT INTO announcement (market, code, ann_id, published_at, ingested_at, title, source)
          VALUES (?, 'ABC', ?, ?, ?, 't', ?)`,
    args: [
      over.market ?? "AU",
      annId,
      publishedAt,
      over.ingested ?? "2024-12-01T00:00:00.000Z",
      over.source ?? "asx_announcements",
    ],
  });
  return annId;
}
async function exported(month: string, over: { status?: string; file?: string; at?: string } = {}) {
  await main.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, started_at, ended_at, status, details_json)
          VALUES (?, 'AU', ?, ?, ?, ?, ?)`,
    args: [
      RUN,
      `${RUN}:export:asx_announcements:${month}`,
      over.at ?? EXPORT_AT,
      over.at ?? EXPORT_AT,
      over.status ?? "success",
      JSON.stringify({ kind: "asx_export", month, file: over.file ?? "uploaded" }),
    ],
  });
}
async function cursor(state: Record<string, unknown>) {
  await main.execute({
    sql: `INSERT INTO ingest_cursor (job, market, source, cursor_json, updated_at)
          VALUES ('backfill:asx_announcements', 'AU', 'asx_announcements', ?, 'x')`,
    args: [JSON.stringify({ status: "ok", ...state })],
  });
}
const left = async () =>
  (await main.execute("SELECT ann_id FROM announcement ORDER BY id")).rows.map((r) =>
    String(r.ann_id),
  );

describe("pruneAnnouncements guard", () => {
  it("deletes nothing when no month has been exported (no cursor state)", async () => {
    const a = await ann("2024-03-10T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0);
    expect(await left()).toEqual([a]);
  });

  it("deletes nothing without exported_down_to, even with export records", async () => {
    await cursor({});
    await exported("2024-03");
    const a = await ann("2024-03-10T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0);
    expect(await left()).toEqual([a]);
    // a malformed boundary is the same as none
    await main.execute('UPDATE ingest_cursor SET cursor_json = \'{"exported_down_to":"2024-3"}\'');
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0);
    await main.execute("UPDATE ingest_cursor SET cursor_json = 'not json'");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0);
  });

  it("deletes old rows of exported months only: other months stay, newer unexported stays", async () => {
    await cursor({ exported_down_to: "2024-05" });
    for (const m of ["2024-05", "2024-06", "2024-07"]) await exported(m);
    const gone = [
      await ann("2024-05-15T00:00:00.000Z"),
      await ann("2024-06-15T00:00:00.000Z"),
      await ann("2024-07-10T00:00:00.000Z"),
    ];
    const keep = [
      await ann("2024-04-15T00:00:00.000Z"), // below the boundary: never exported
      await ann("2024-03-15T00:00:00.000Z"),
      await ann("2024-08-15T00:00:00.000Z"), // no export record for August (and newer than cutoff)
    ];
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(3);
    expect(await left()).toEqual(keep);
    expect(gone).toHaveLength(3);
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0); // idempotent
  });

  it("a month at or above the boundary with no export record is kept (proved, not assumed)", async () => {
    await cursor({ exported_down_to: "2024-05" });
    await exported("2024-05");
    const a = await ann("2024-06-15T00:00:00.000Z");
    const b = await ann("2024-05-15T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual([a]);
    expect(b).not.toBe(a);
  });

  it("the cutoff boundary: just before is deleted, exactly at the cutoff is kept", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07");
    await ann("2024-07-27T23:59:59.999Z");
    const kept = await ann(CUTOFF);
    await ann("2024-07-28T00:00:00.001Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect((await left())[0]).toBe(kept);
    expect(await left()).toHaveLength(2);
  });

  it("a retention shorter than 400 days is raised to 400 (the trigger floor)", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07");
    await ann("2024-07-27T23:59:59.999Z");
    await ann("2024-07-28T00:00:00.001Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 30)).toBe(1);
    expect(await left()).toHaveLength(1);
    expect(await pruneAnnouncements(main, NOW_ISO, 500)).toBe(0); // longer keeps more
  });

  it("a longer retention keeps rows that the 400-day rule would delete", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07");
    await ann("2024-07-10T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 600)).toBe(0);
  });

  it("months in the conflicts list or recorded as a conflict are never pruned", async () => {
    await cursor({ exported_down_to: "2024-05", conflicts: ["2024-06", "junk", 5] });
    await exported("2024-05");
    await exported("2024-06");
    await exported("2024-07", { file: "conflict" });
    const keep = [await ann("2024-06-15T00:00:00.000Z"), await ann("2024-07-10T00:00:00.000Z")];
    await ann("2024-05-15T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual(keep);
  });

  it("a month below the boundary is kept even if an export record exists", async () => {
    await cursor({ exported_down_to: "2024-06" });
    await exported("2024-05");
    await exported("2024-06");
    const a = await ann("2024-05-15T00:00:00.000Z");
    await ann("2024-06-15T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual([a]);
  });

  it("failed, malformed or foreign export records do not count", async () => {
    await cursor({ exported_down_to: "2024-05" });
    await exported("2024-05", { status: "failed" });
    await main.execute(
      `INSERT INTO run_record (job, concurrency_key, started_at, status)
       VALUES ('backfill-history', 'backfill-history:export:asx_announcements:bogus', 'x', 'success'),
              ('other-job', 'backfill-history:export:asx_announcements:2024-06', 'x', 'success')`,
    );
    const a = await ann("2024-05-15T00:00:00.000Z");
    const b = await ann("2024-06-15T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(0);
    expect(await left()).toEqual([a, b]);
  });

  it("a row ingested after the export started is not in the file, so it is kept", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07", { at: "2025-01-15T12:00:00.000Z" });
    await ann("2024-07-10T00:00:00.000Z", { ingested: "2025-01-15T12:00:00.000Z" }); // at the start
    const late = await ann("2024-07-11T00:00:00.000Z", { ingested: "2025-01-15T12:00:00.001Z" });
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual([late]);
  });

  it("only AU rows of source asx_announcements are touched", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07");
    const a = await ann("2024-07-10T00:00:00.000Z", { source: "other_feed" });
    const b = await ann("2024-07-10T00:00:00.000Z", { market: "IN" });
    await ann("2024-07-10T00:00:00.000Z");
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual([a, b]);
  });

  it("uses Sydney months: the last second of March stays out of an April-only export", async () => {
    await cursor({ exported_down_to: "2024-04" });
    await exported("2024-04");
    // AEDT (UTC+11) until 7 April 2024, then AEST (UTC+10).
    const march = await ann("2024-03-31T12:59:59.999Z"); // 23:59:59 on 31 March in Sydney
    await ann("2024-03-31T13:00:00.000Z"); // 00:00 on 1 April
    await ann("2024-04-30T13:59:59.999Z"); // 23:59:59 on 30 April
    const may = await ann("2024-04-30T14:00:00.000Z"); // 00:00 on 1 May
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(2);
    expect(await left()).toEqual([march, may]);
  });

  it("handles a Sydney daylight-saving month (AEDT, UTC+11)", async () => {
    await cursor({ exported_down_to: "2023-12" });
    await exported("2023-12");
    const nov = await ann("2023-11-30T12:59:59.999Z"); // 23:59:59 on 30 November in Sydney
    await ann("2023-11-30T13:00:00.000Z"); // 00:00 on 1 December
    const jan = await ann("2023-12-31T13:00:00.000Z"); // 1 January
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(1);
    expect(await left()).toEqual([nov, jan]);
  });
});

describe("pruneAnnouncements in the nightly maintenance run", () => {
  const run = () =>
    runMaintenance(
      { mainDb: main, authDb: auth, piiHashKey: "4".repeat(64), now: NOW },
      "2025-09-01",
    );

  it("counts the deleted rows in the run record and the outcome", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07");
    await ann("2024-07-10T00:00:00.000Z");
    await ann("2024-07-11T00:00:00.000Z");
    const out = await run();
    expect(out.status).toBe("success");
    expect(out.status !== "skipped" && out.counts.prunedAnnouncements).toBe(2);
    const rec = (await main.execute("SELECT * FROM run_record WHERE job = 'maintenance-nightly'"))
      .rows[0];
    expect(JSON.parse(String(rec.details_json))).toMatchObject({ prunedAnnouncements: 2 });
    expect(Number(rec.items_processed)).toBeGreaterThanOrEqual(2);
    expect(await left()).toEqual([]);
  });

  it("export records outlive the 180-day run retention; other old runs are still pruned", async () => {
    await cursor({ exported_down_to: "2024-07" });
    await exported("2024-07", { at: "2024-08-10T00:00:00.000Z" }); // over a year old
    await main.execute(
      "INSERT INTO run_record (job, concurrency_key, started_at, status) VALUES ('x', 'old', '2024-08-10T00:00:00.000Z', 'success')",
    );
    await ann("2024-07-10T00:00:00.000Z", { ingested: "2024-08-01T00:00:00.000Z" });
    const out = await run();
    expect(out.status === "success" && out.counts.prunedRuns).toBe(1); // only 'old'
    expect(out.status === "success" && out.counts.prunedAnnouncements).toBe(1);
    const keys = (await main.execute("SELECT concurrency_key FROM run_record")).rows.map((r) =>
      String(r.concurrency_key),
    );
    expect(keys).toContain("backfill-history:export:asx_announcements:2024-07");
    expect(keys).not.toContain("old");
  });

  it("without any export it deletes nothing and still succeeds", async () => {
    const a = await ann("2024-07-10T00:00:00.000Z");
    const out = await run();
    expect(out.status).toBe("success");
    expect(await left()).toEqual([a]);
  });

  it("a failing prune is named without detail and the other steps still run", async () => {
    await main.execute("DROP TABLE ingest_cursor");
    await main.execute({
      sql: "INSERT INTO app_log (at, level, source, message) VALUES ('2020-01-01T00:00:00.000Z', 'info', 's', 'm')",
    });
    const out = await run();
    expect(out.status).toBe("failed");
    const rec = (
      await main.execute("SELECT error_summary FROM run_record WHERE job = 'maintenance-nightly'")
    ).rows[0];
    expect(String(rec.error_summary)).toBe("failed steps: prune_announcements");
    expect(out.status === "failed" && out.counts.prunedLogs).toBe(1);
  });
});

describe("pruneAnnouncements with forward-exported months (D-066 follow-up)", () => {
  it("prunes a month exported by the forward run (newer than the first export) after 400 days", async () => {
    // First export: 2024-05 downwards. Forward runs later exported 2024-06 and 2024-07.
    await cursor({ exported_down_to: "2024-05", exported_up_to: "2024-07" });
    for (const m of ["2024-05", "2024-06", "2024-07"]) await exported(m);
    const gone = [await ann("2024-06-20T00:00:00.000Z"), await ann("2024-07-03T00:00:00.000Z")];
    const keep = [
      await ann("2024-08-02T00:00:00.000Z"), // not exported yet (and inside 400 days)
      await ann("2024-07-20T00:00:00.000Z", { ingested: "2025-02-01T00:00:00.000Z" }), // after export
    ];
    expect(await pruneAnnouncements(main, NOW_ISO, 400)).toBe(2);
    expect(await left()).toEqual(keep);
    expect(gone).toHaveLength(2);
  });
});
