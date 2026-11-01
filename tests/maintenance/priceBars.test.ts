// @vitest-environment node
// V1-S5 / D-717 (DAT-142 "market data in Turso 500 sessions"): price-bar pruning, bounded, behind the
// 730-day trigger floor, with the re-fetch diffs of pruned bars.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PRICE_BAR_FLOOR_DAYS,
  PRICE_BAR_KEEP_SESSIONS,
  PRUNE_CHUNK,
  prunePriceBars,
} from "@/lib/maintenance/retention";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2026-11-01T00:00:00.000Z";
let db: Client;
beforeEach(async () => {
  db = await freshDb("main");
});

const bar = (code: string, d: string) => ({
  sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
        VALUES ('AU', ?, ?, 1, 1, 1, 1, 1, 'synthetic', ?, ?)`,
  args: [code, d, NOW, NOW],
});
const count = async (sql = "SELECT COUNT(*) AS n FROM price_bar") =>
  Number((await db.execute(sql)).rows[0]!.n);

describe("prunePriceBars", () => {
  it("declares the spec figures", () => {
    expect(PRICE_BAR_KEEP_SESSIONS).toBe(500);
    expect(PRICE_BAR_FLOOR_DAYS).toBe(730);
  });

  it("does nothing while there are fewer sessions than the retention", async () => {
    await db.batch([bar("AAA", "2020-01-02"), bar("AAA", "2020-01-03")], "write");
    expect(await prunePriceBars(db, NOW)).toBe(0);
    expect(await count()).toBe(2);
  });

  it("deletes bars beyond the retained sessions AND older than the 730-day floor", async () => {
    await db.batch(
      [
        bar("AAA", "2023-01-02"),
        bar("BBB", "2023-01-02"),
        bar("AAA", "2023-01-03"),
        bar("AAA", "2026-10-28"),
        bar("AAA", "2026-10-29"),
        bar("AAA", "2026-10-30"),
      ],
      "write",
    );
    expect(await prunePriceBars(db, NOW, "AU", 3)).toBe(3);
    expect((await db.execute("SELECT d FROM price_bar ORDER BY d")).rows.map((r) => r.d)).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
    ]);
    expect(await prunePriceBars(db, NOW, "AU", 3)).toBe(0); // idempotent
  });

  it("never attempts a delete the table trigger refuses: the floor wins over a short retention", async () => {
    // keep 1 session => the 500-session date is today-ish, but a bar 400 days old is inside the floor
    await db.batch([bar("AAA", "2025-10-01"), bar("AAA", "2026-10-30")], "write");
    expect(await prunePriceBars(db, NOW, "AU", 1)).toBe(0);
    expect(await count()).toBe(2);
  });

  it("when the session cutoff is older than the floor it binds (keeps the last N sessions)", async () => {
    await db.batch(
      [bar("AAA", "2020-01-02"), bar("AAA", "2020-01-03"), bar("AAA", "2020-01-06")],
      "write",
    );
    expect(await prunePriceBars(db, NOW, "AU", 2)).toBe(1);
    expect((await db.execute("SELECT d FROM price_bar ORDER BY d")).rows.map((r) => r.d)).toEqual([
      "2020-01-03",
      "2020-01-06",
    ]);
  });

  it("removes the re-fetch diffs of pruned bars and keeps the others", async () => {
    await db.batch(
      [bar("AAA", "2020-01-02"), bar("AAA", "2020-01-03"), bar("AAA", "2020-01-06")],
      "write",
    );
    for (const d of ["2020-01-02", "2020-01-06"]) {
      await db.execute({
        sql: `INSERT INTO bar_refetch (market, code, d, fetched_at, ohlcv_json, max_diff_pct)
              VALUES ('AU', 'AAA', ?, ?, '{}', 0.5)`,
        args: [d, NOW],
      });
    }
    await prunePriceBars(db, NOW, "AU", 2);
    expect((await db.execute("SELECT d FROM bar_refetch")).rows.map((r) => r.d)).toEqual([
      "2020-01-06",
    ]);
  });

  it("deletes every old bar across many codes in one run", async () => {
    expect(PRUNE_CHUNK).toBeGreaterThan(0);
    const stmts = [];
    for (let i = 0; i < 12; i++) {
      for (let c = 0; c < 10; c++)
        stmts.push(bar(`C${c}`, `2019-01-${String(i + 1).padStart(2, "0")}`));
    }
    await db.batch(stmts, "write"); // 120 old bars
    await db.batch([bar("C0", "2026-10-30")], "write");
    expect(await prunePriceBars(db, NOW, "AU", 1)).toBe(120);
    expect(await count()).toBe(1);
  });
});
