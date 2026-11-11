// @vitest-environment node
// The nightly picks entry (D-181, AGT-113, ARN-095): it runs after a reviewed night in full mode
// only, says why when it does not, and prints statuses and counts only. Publication itself is
// covered by nightly.test.ts; this drives the entry on a real migrated file.
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { picksMain } from "@/lib/picks/cli";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = Date.parse("2026-10-20T08:00:00.000Z"); // Tuesday 20 Oct 2026, 19:00 Sydney
const D = "2026-10-20";

async function fileDb(mode: "full" | "data_only"): Promise<{ url: string; db: Client }> {
  const url = tempDbUrl();
  const db = track(createClient({ url }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  await db.execute({ sql: "UPDATE market SET mode = ? WHERE code = 'AU'", args: [mode] });
  return { url, db };
}

async function cli(url: string, args: string[]) {
  const lines: string[] = [];
  const code = await picksMain(
    args,
    { TURSO_MAIN_URL: url, TURSO_MAIN_TOKEN: "secret-token-do-not-print" },
    { nowMs: () => NOW, out: (s) => lines.push(s), openDb: (u) => createClient({ url: u }) },
  );
  return { code, lines };
}

async function reviewed(db: Client, status = "success"): Promise<void> {
  await db.execute({
    sql: `INSERT INTO run_record (job, market, concurrency_key, scheduled_for, started_at, ended_at, status)
          VALUES ('arena-review', 'AU', ?, ?, ?, ?, ?)`,
    args: [`arena-3:AU:${D}`, D, `${D}T08:00:00.000Z`, `${D}T08:05:00.000Z`, status],
  });
}

describe("picks entry", () => {
  it("phases without the review, a replay and data-only mode print and write nothing", async () => {
    const full = await fileDb("full");
    for (const args of [["--phase", "2b"], ["--phase", "learn"], ["--replay"]]) {
      expect(await cli(full.url, ["--date", D, ...args])).toEqual({ code: 0, lines: [] });
    }
    const dataOnly = await fileDb("data_only");
    await reviewed(dataOnly.db);
    expect(await cli(dataOnly.url, ["--date", D])).toEqual({ code: 0, lines: [] });
  });

  it("without a reviewed night it says so and publishes nothing", async () => {
    const { url, db } = await fileDb("full");
    await reviewed(db, "failed");
    const r = await cli(url, ["--date", D]);
    expect(r).toEqual({ code: 0, lines: [`arena-picks AU ${D}: skipped (no reviewed night)`] });
    expect((await db.execute("SELECT COUNT(*) AS n FROM pick")).rows[0]!.n).toBe(0);
  });

  it("after a reviewed night it runs the picks phase and prints counts only", async () => {
    const { url, db } = await fileDb("full");
    await reviewed(db);
    for (const phase of ["all", "3", "picks"]) {
      const r = await cli(url, ["--date", D, "--phase", phase]);
      expect(r.code, phase).toBe(0);
      expect(r.lines, phase).toHaveLength(4);
      expect(r.lines[0]).toMatch(
        /^arena-picks AU 2026-10-20: published=\d+ candidates=\d+ bought=\d+ missed=\d+ closed=\d+ open=\d+ checked=\d+ withdrawn=\d+ shortlist=-?\d+$/,
      );
      // D-950: the three My portfolio profiles run after the picks, counts only
      expect(r.lines[1]).toMatch(
        /^arena-portfolio AU 2026-10-20: trades\/open\/days\/splits\/skipped conservative=\d+\/\d+\/\d+\/\d+\/\d+ balanced=\d+\/\d+\/\d+\/\d+\/\d+ aggressive=\d+\/\d+\/\d+\/\d+\/\d+$/,
      );
      // D-921: the daily learning loop runs after the portfolio, counts only (nothing to learn from on an empty file)
      expect(r.lines[2]).toBe(
        "arena-learning AU 2026-10-20: movers=0 lessons=0 improvements=0 hypotheses=0",
      );
      // D-923: the learning Cortex's scorecard follows on the loop's World (none on an empty file)
      expect(r.lines[3]).toBe(
        "arena-cortex-learn AU 2026-10-20: skipped (no daily learning tonight)",
      );
      expect(r.lines.join("\n")).not.toMatch(/secret|file:/);
    }
  });

  it("a missing database setting fails visibly", async () => {
    const lines: string[] = [];
    expect(await picksMain(["--date", D], {}, { out: (s) => lines.push(s) })).toBe(1);
    expect(lines).toEqual(["arena-picks: failed (database not configured)"]);
  });
});
