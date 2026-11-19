// @vitest-environment node
// M20 IN1 (AT-M5, MKT-110, D-1120): market isolation. AU and IN are both enabled in one development database and both
// days run; the AU night's tables hash EQUAL to the single-market run (IN's rows change nothing AU reads or writes),
// and no cohort, ledger, label, pick or execution row carries the other market. The IN rows exist only in the data
// tables the IN batch 1 writes.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { runDay } from "@/lib/data/sources/in/day.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { allowMarket, cleanupTempDbs } from "../db/helpers";
import { dumpTables, makeStrategy, NOW, setupReplay, MARKET } from "../arena/replayHarness";
import { bandsFile, barsOf, bhavFile } from "../markets/in/dayFixture";

afterEach(cleanupTempDbs);

const OPTS = { startD: "2030-01-07", sessions: 14, seed: 3, keep: ["E01", "E02"] };

/** The tables the IN batch 1 writes (market-keyed data), the only places an IN row may appear. */
const IN_DATA_TABLES = new Set([
  "price_bar",
  "universe_snapshot",
  "price_band",
  "surveillance_list",
  "completion_marker",
  "run_record",
  "instrument",
  "quality_score",
  "data_quality_flag",
  "bar_latency_sample",
  "index_bar",
  "announcement",
  "announcement_category",
  "insider_notice",
  "short_interest",
]);

async function auNight(withIn: boolean): Promise<{ db: Client; hash: string }> {
  const s = await setupReplay(OPTS);
  const strategy = makeStrategy(s.db, s.ds);
  if (withIn) {
    await allowMarket(s.db, "IN");
    await s.db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
    await ensureMarketSources(s.db, "IN");
  }
  for (const [i, d] of s.ds.dates.entries()) {
    if (withIn) {
      // the IN day runs first on the same date, as the two markets' batches would
      const r = await runDay(s.db, {
        market: "IN",
        d,
        files: { bhavcopy: bhavFile(d, barsOf(i)), bands: bandsFile() },
        nowMs: () => Date.parse(`${d}T12:00:00.000Z`),
      });
      expect(r.status).toBe("ok");
    }
    const res = await closeBooksDay(s.db, { market: MARKET, d, replay: true, now: NOW });
    await strategy(d, res);
  }
  const dump = await dumpTables(s.db);
  return { db: s.db, hash: createHash("sha256").update(JSON.stringify(dump)).digest("hex") };
}

describe("AT-M5: AU and IN side by side", () => {
  it("the AU night is identical with IN enabled and its day run", async () => {
    const solo = await auNight(false);
    const both = await auNight(true);
    expect(both.hash).toBe(solo.hash);
    // the night really did something (a hash of nothing proves nothing)
    const fills = Number((await both.db.execute("SELECT COUNT(*) AS n FROM fill")).rows[0]!.n);
    expect(fills).toBeGreaterThan(0);
  });

  it("no cohort, ledger, label or pick row carries the other market; IN rows sit in the data tables only", async () => {
    const { db } = await auNight(true);
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
    ).rows.map((r) => String(r.name));
    const withIn: string[] = [];
    const withAu: string[] = [];
    for (const t of tables) {
      const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((c) => String(c.name));
      const col = cols.includes("market") ? "market" : null;
      if (col === null) continue;
      // rows-ok: a test-database census, one count per market-keyed table
      const n = async (m: string) =>
        Number(
          (await db.execute({ sql: `SELECT COUNT(*) AS n FROM ${t} WHERE market = ?`, args: [m] }))
            .rows[0]!.n,
        );
      if ((await n("IN")) > 0) withIn.push(t);
      if (t === "execution" || t === "cohort") withAu.push(`${t}:${await n("AU")}`);
    }
    expect(withIn.filter((t) => !IN_DATA_TABLES.has(t))).toEqual([]);
    expect(withIn).toEqual(
      expect.arrayContaining(["price_bar", "universe_snapshot", "completion_marker"]),
    );
    // the AU execution rows are the only execution rows, and cohort params never name IN
    const execs = Number(
      (await db.execute("SELECT COUNT(*) AS n FROM execution WHERE market <> 'AU'")).rows[0]!.n,
    );
    expect(execs).toBe(0);
    const cohorts = Number(
      (await db.execute("SELECT COUNT(*) AS n FROM cohort WHERE params_json LIKE '%\"IN\"%'"))
        .rows[0]!.n,
    );
    expect(cohorts).toBe(0);
    // none of AU's own data tables gained an IN row, and IN's bars are not AU's
    const auBars = Number(
      (await db.execute("SELECT COUNT(*) AS n FROM price_bar WHERE market = 'AU'")).rows[0]!.n,
    );
    expect(auBars).toBeGreaterThan(0);
  });
});
