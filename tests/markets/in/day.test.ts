// @vitest-environment node
// M20 IN1 (D-1127, D-1119, D-1125; AT-M4 data stage): India batch 1 on hand-made day files in a development database
// with IN enabled. The counts are known answers; a market that is off refuses before any file is read or client is
// called; a disabled source is never processed; a re-run adds nothing.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import { prepareDay, runDay } from "@/lib/data/sources/in/day.mjs";
import { loadDayModule, runBatch1, prepareBatch1 } from "@/lib/data/pipeline/batch1-core.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import { isMarketNotEnabled } from "@/lib/market/guard.mjs";
import { allowMarket, cleanupTempDbs } from "../../db/helpers";
import { freshReplayDb } from "../../arena/replayHarness";
import {
  asmFile,
  bandsFile,
  barsOf,
  bhavFile,
  classificationFile,
  CODES,
  gsmFile,
  indexFile,
} from "./dayFixture";

afterEach(() => {
  vi.restoreAllMocks();
  return cleanupTempDbs();
});

const SESSIONS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
const NOW = (d: string) => () => Date.parse(`${d}T12:00:00.000Z`);

async function enabledDb(): Promise<Client> {
  const db = await freshReplayDb();
  await allowMarket(db, "IN");
  await db.execute("UPDATE market SET mode = 'data_only' WHERE code = 'IN'");
  await ensureMarketSources(db, "IN");
  return db;
}
const count = async (db: Client, sql: string, ...args: (string | number)[]) =>
  Number((await db.execute({ sql, args })).rows[0]!.n);

function filesFor(i: number, over: Record<string, string | undefined> = {}) {
  const d = SESSIONS[i]!;
  return {
    bhavcopy: bhavFile(d, barsOf(i)),
    bands: bandsFile(),
    ...(i === SESSIONS.length - 1 ? { asm: asmFile(), gsm: gsmFile() } : {}),
    ...(i === 0 ? { classification: classificationFile() } : {}),
    ...over,
  } as Record<string, string | undefined>;
}

describe("India batch 1 on five hand-made sessions", () => {
  it("writes bars, universe, bands, lists, instruments and a complete marker; AU stays empty", async () => {
    const db = await enabledDb();
    const res = [];
    for (const [i, d] of SESSIONS.entries()) {
      res.push(await runDay(db, { d, files: filesFor(i), nowMs: NOW(d) }));
    }
    expect(res.every((r) => r.exit === 0 && r.status === "ok")).toBe(true);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market='IN'")).toBe(30);
    expect(await count(db, "SELECT COUNT(*) AS n FROM universe_snapshot WHERE market='IN'")).toBe(
      30,
    );
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_band WHERE market='IN'")).toBe(30);
    // the lists exist for the last session only (one snapshot was published to us)
    expect(await count(db, "SELECT COUNT(*) AS n FROM surveillance_list WHERE market='IN'")).toBe(
      2,
    );
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM surveillance_list WHERE d = ?", SESSIONS[4]!),
    ).toBe(2);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM completion_marker WHERE market='IN' AND outcome='complete'",
      ),
    ).toBe(5);
    expect(await count(db, "SELECT COUNT(*) AS n FROM bar_latency_sample WHERE market='IN'")).toBe(
      5,
    );
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM instrument WHERE market='IN' AND industry IS NOT NULL",
      ),
    ).toBe(2);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market='AU'")).toBe(0);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM run_record WHERE market='IN' AND status='success'",
      ),
    ).toBe(5);
    // the IN bhavcopy source and the bar's known time: close 15:30 IST + 60 min assumed latency = 11:00Z
    const bar = (
      await db.execute(
        "SELECT source, published_at FROM price_bar WHERE market='IN' AND d='2026-11-02' LIMIT 1",
      )
    ).rows[0]!;
    expect(bar.source).toBe("in_nse_bhavcopy");
    expect(bar.published_at).toBe("2026-11-02T11:00:00.000Z");
  });

  it("tiers come from the IN table: a young book is below the floors, never AU's tiers", async () => {
    const db = await enabledDb();
    await runDay(db, { d: SESSIONS[0]!, files: filesFor(0), nowMs: NOW(SESSIONS[0]!) });
    const rows = (
      await db.execute(
        "SELECT code, tier, status FROM universe_snapshot WHERE market='IN' ORDER BY code",
      )
    ).rows;
    expect(rows.map((r) => String(r.code))).toEqual([...CODES].sort());
    // no 60-session history yet: nobody reaches U1 or U2
    expect(rows.every((r) => String(r.tier) === "U3")).toBe(true);
  });

  it("a re-run of a done session writes nothing", async () => {
    const db = await enabledDb();
    const d = SESSIONS[0]!;
    await runDay(db, { d, files: filesFor(0), nowMs: NOW(d) });
    const before = await count(db, "SELECT COUNT(*) AS n FROM price_bar");
    const again = await runDay(db, { d, files: filesFor(0), nowMs: NOW(d) });
    expect(again.dates[0]!.status).toBe("already_done");
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(before);
  });

  it("a holiday row writes only a non-trading marker", async () => {
    const db = await enabledDb();
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, close_time, confirmed, source) VALUES ('IN','2026-11-10','holiday',NULL,1,'test')",
    );
    const r = await runDay(db, { d: "2026-11-10", files: {}, nowMs: NOW("2026-11-10") });
    expect(r.dates[0]!.status).toBe("non_trading");
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(0);
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM completion_marker WHERE kind='non-trading'"),
    ).toBe(1);
  });

  it("a missing or empty bars file fails the date and invents nothing", async () => {
    const db = await enabledDb();
    const d = SESSIONS[0]!;
    const r = await runDay(db, { d, files: { bands: bandsFile() }, nowMs: NOW(d) });
    expect(r.exit).toBe(1);
    expect(r.status).toBe("failed");
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM run_record WHERE status='failed'")).toBe(1);
    const empty = await runDay(db, { d, files: { bhavcopy: bhavFile(d, []) }, nowMs: NOW(d) });
    expect(empty.exit).toBe(1);
  });

  it("the manual index file fills index_bar when present; no file, no rows and the stage says so", async () => {
    const db = await enabledDb();
    const d = SESSIONS[0]!;
    const without = await runDay(db, { d, files: filesFor(0), nowMs: NOW(d) });
    expect(without.dates[0]!.stages.index).toBe("no_file");
    expect(await count(db, "SELECT COUNT(*) AS n FROM index_bar")).toBe(0);
    const d2 = SESSIONS[1]!;
    const withIdx = await runDay(db, {
      d: d2,
      files: filesFor(1, { index: indexFile(d2) }),
      nowMs: NOW(d2),
    });
    expect(withIdx.dates[0]!.stages.index).toMatchObject({ rows: 2, inserted: 2 });
    expect(await count(db, "SELECT COUNT(*) AS n FROM index_bar WHERE market='IN'")).toBe(2);
  });

  it("macro rows are counted, never stored (D-1171)", async () => {
    const db = await enabledDb();
    const d = SESSIONS[0]!;
    const r = await runDay(db, {
      d,
      files: filesFor(0, { macro: "series_id,d,value\nRBI_REPO,2026-10-01,5.50\n" }),
      nowMs: NOW(d),
    });
    expect(r.dates[0]!.stages.macro).toMatchObject({ parsed: 1, stored: "not_stored" });
    expect(await count(db, "SELECT COUNT(*) AS n FROM macro_series")).toBe(0);
  });
});

describe("announcements: headline only, the register decides (D-1125)", () => {
  const FIX = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "../../fixtures/markets/in/announcements-50.json"),
      "utf8",
    ),
  ) as { items: { id: string; type: string; title: string; expect: { category: string } }[] };
  const nse = FIX.items.map((it, i) => ({
    symbol: CODES[i % CODES.length],
    desc: it.type,
    attchmntText: it.title,
    attchmntFile: `https://nsearchives.nseindia.com/corporate/${it.id}.pdf`,
    an_dt: "02-Nov-2026 18:00:00",
    seq_id: it.id,
  }));

  it("a disabled source is ignored even when a file is handed in", async () => {
    const db = await enabledDb(); // the announcement rows are written `disabled`
    const d = SESSIONS[0]!;
    const r = await runDay(db, {
      d,
      files: filesFor(0, { announcements_nse: JSON.stringify(nse) }),
      nowMs: NOW(d),
    });
    expect(r.dates[0]!.stages.announcements.announcements_nse).toBe("disabled");
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM announcement_category")).toBe(0);
  });

  it("once the Owner accepts the source, 50 headlines are stored and classified by the map (AT-69)", async () => {
    const db = await enabledDb();
    await db.execute(
      "UPDATE source_register SET status='enabled' WHERE source='in_nse_announcements'",
    );
    const d = SESSIONS[0]!;
    const r = await runDay(db, {
      d,
      files: filesFor(0, { announcements_nse: JSON.stringify(nse) }),
      nowMs: NOW(d),
    });
    expect(r.dates[0]!.stages.announcements).toMatchObject({ inserted: 50, categorised: 50 });
    const rows = (
      await db.execute(
        "SELECT a.ann_id AS id, c.category AS category, a.price_sensitive AS ps, a.url AS url FROM announcement a JOIN announcement_category c ON c.ann_id = a.ann_id AND c.source = a.source",
      )
    ).rows;
    expect(rows).toHaveLength(50);
    for (const row of rows) {
      const want = FIX.items.find((x) => x.id === String(row.id))!;
      expect(String(row.category)).toBe(want.expect.category);
      expect(Number(row.ps)).toBe(0);
    }
    const cols = (await db.execute("PRAGMA table_info(announcement)")).rows.map((c) =>
      String(c.name),
    );
    expect(cols).not.toContain("body"); // headline and link only
  });
});

describe("the market gate (MKT-110 a)", () => {
  it("with IN off, runDay refuses before reading a file, opening a run or calling a client", async () => {
    const db = await freshReplayDb(); // the production seed: IN is off and disabled
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const touched: string[] = [];
    const files = new Proxy({}, { get: (_t, k) => (touched.push(String(k)), undefined) });
    let err: unknown;
    try {
      await runDay(db, { d: SESSIONS[0]!, files: files as never, nowMs: NOW(SESSIONS[0]!) });
    } catch (e) {
      err = e;
    }
    expect(isMarketNotEnabled(err)).toBe(true);
    expect(touched).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count(db, "SELECT COUNT(*) AS n FROM run_record WHERE market='IN'")).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(0);
  });

  it("prepareDay on an off market skips, and writes nothing", async () => {
    const db = await freshReplayDb();
    const r = await prepareDay(db, { market: "IN", target: SESSIONS[0] });
    expect(r).toEqual({ action: "skip", target: SESSIONS[0], reason: "market_not_enabled" });
  });

  it("prepareDay on an enabled market lists the files and the sources a polite fetch may request", async () => {
    const db = await enabledDb();
    const r = await prepareDay(db, { market: "IN", target: SESSIONS[0] });
    expect(r.action).toBe("fetch");
    expect(r.fetchable).toEqual(["index"]); // only `in_nse_indices_manual` and the like are `enabled` in the register
    expect(r.disabled).toEqual(expect.arrayContaining(["announcements_nse", "announcements_bse"]));
  });

  it("the batch-1 dispatcher finds the IN day by convention (D-1127)", async () => {
    const db = await freshReplayDb();
    const mod = await loadDayModule("IN");
    expect(typeof mod.runDay).toBe("function");
    const prepared = await prepareBatch1(db, {
      market: "IN",
      target: SESSIONS[0],
      nowMs: NOW(SESSIONS[0]!),
    } as never);
    expect(prepared.action).toBe("skip");
    await expect(
      runBatch1(db, { market: "IN", d: SESSIONS[0], files: {}, nowMs: NOW(SESSIONS[0]!) } as never),
    ).rejects.toSatisfy(isMarketNotEnabled);
  });
});
