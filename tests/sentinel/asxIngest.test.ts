// @vitest-environment node
// D-194: the store half of the GitHub ASX fetch: announcements first-seen through ingestFeed, the
// poll recorded for System Health, the company list through importUniverse; counts only.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { asxIngestMain } from "@/lib/data/asxIngest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = Date.parse("2026-10-26T10:00:00.000Z");

async function setup() {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  const dir = mkdtempSync(path.join(tmpdir(), "asx-"));
  writeFileSync(
    path.join(dir, "feed.json"),
    JSON.stringify({
      data: {
        items: [
          {
            symbol: "ZZA",
            date: "2026-10-26T09:00:00.000Z",
            documentKey: "2924-03150001-A",
            headline: "Quarterly report",
            isPriceSensitive: true,
            announcementTypes: ["Quarterly"],
          },
          {
            symbol: "ZZB",
            date: "2026-10-26T08:00:00.000Z",
            documentKey: "2924-03150002-B",
            headline: "Notice of AGM",
            isPriceSensitive: false,
            announcementTypes: ["Notice"],
          },
        ],
      },
    }),
  );
  return { url, db, dir };
}

const run = (url: string, dir: string, lines: string[]) =>
  asxIngestMain(
    ["--dir", dir],
    { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-do-not-print" },
    {
      nowMs: () => NOW,
      out: (s) => lines.push(s),
      openDb: (u) => createClient({ url: u }),
    },
  );

const count = async (db: Client, sql: string) => Number((await db.execute(sql)).rows[0]!.n);

describe("asx-ingest", () => {
  it("stores the announcements first-seen, records the poll, and a re-run adds nothing", async () => {
    const { url, db, dir } = await setup();
    const lines: string[] = [];
    expect(await run(url, dir, lines)).toBe(0);
    expect(lines[0]).toMatch(/^asx-ingest feed\.json: ok seen=2 new=2/);
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement")).toBe(2);
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM announcement WHERE price_sensitive = 1"),
    ).toBe(1);
    const poll = (await db.execute("SELECT ok, last_ok_at FROM sentinel_poll_day")).rows[0]!;
    expect(poll.ok).toBe(1);
    expect(poll.last_ok_at).toBe("2026-10-26T10:00:00.000Z");
    const again: string[] = [];
    expect(await run(url, dir, again)).toBe(0);
    expect(again[0]).toMatch(/new=0/);
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement")).toBe(2);
    expect([...lines, ...again].join("\n")).not.toMatch(/secret|file:/);
  });

  it("an unreadable feed is a visible failure and records a failed poll", async () => {
    const { url, db, dir } = await setup();
    writeFileSync(path.join(dir, "feed.json"), "<html>challenge</html>");
    const lines: string[] = [];
    expect(await run(url, dir, lines)).toBe(1);
    expect(lines[0]).toBe("asx-ingest feed.json: failed (unrecognised_format)");
    expect(
      (await db.execute("SELECT failed, last_ok_at FROM sentinel_poll_day")).rows[0],
    ).toMatchObject({
      failed: 1,
      last_ok_at: null,
    });
  });

  it("stores every history chunk in order, after the feed (D-197)", async () => {
    const { url, db, dir } = await setup();
    const chunk = (code: string, n: number) =>
      JSON.stringify({
        data: {
          items: Array.from({ length: n }, (_, i) => ({
            symbol: code,
            date: "2026-10-20T09:00:00.000Z",
            documentKey: `2924-0${code}${i}-A`,
            headline: "Update",
          })),
        },
      });
    writeFileSync(path.join(dir, "history-002.json"), chunk("ZZD", 2));
    writeFileSync(path.join(dir, "history-001.json"), chunk("ZZC", 3));
    writeFileSync(path.join(dir, "history.json"), "ignored: not a chunk name");
    const lines: string[] = [];
    expect(await run(url, dir, lines)).toBe(0);
    expect(lines.slice(0, 3)).toEqual([
      expect.stringMatching(/^asx-ingest feed\.json: ok seen=2 new=2/),
      expect.stringMatching(/^asx-ingest history-001\.json: ok seen=3 new=3/),
      expect.stringMatching(/^asx-ingest history-002\.json: ok seen=2 new=2/),
    ]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement")).toBe(7);
  });

  it("a missing folder stores nothing and records a failed poll", async () => {
    const { url, db, dir } = await setup();
    const lines: string[] = [];
    expect(await run(url, path.join(dir, "absent"), lines)).toBe(0);
    expect(lines).toEqual([]);
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement")).toBe(0);
    expect((await db.execute("SELECT failed FROM sentinel_poll_day")).rows[0]!.failed).toBe(1);
  });

  it("without a directory or a database it says so", async () => {
    const l: string[] = [];
    expect(await asxIngestMain([], {}, { out: (s) => l.push(s) })).toBe(2);
    expect(await asxIngestMain(["--dir", "x"], {}, { out: (s) => l.push(s) })).toBe(1);
    expect(l).toEqual([
      "asx-ingest: failed (usage: --dir <dir>)",
      "asx-ingest: failed (database not configured)",
    ]);
  });
});
