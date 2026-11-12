// @vitest-environment node
// M20 US1 (D-1127, D-1180; AT-70, AT-75 US, AT-M4): the US batch-1 day on the synthetic five-session data set. Offline,
// development mode only: the market is `data_only` in a migrated test database (never production), the data is the
// generator's (fictional codes ZZA..ZZD, source synthetic_fixture, see scripts/ingest/us/synthetic.mjs).
import { afterEach, describe, expect, it } from "vitest";
import { prepareBatch1, runBatch1 } from "@/lib/data/pipeline/batch1-core.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";
import { DAYS, MARKET, nightMs, sessionFiles, usDevDb } from "./usDev";

afterEach(cleanupTempDbs);

const count = async (
  db: Awaited<ReturnType<typeof usDevDb>>,
  sql: string,
  args: (string | number)[] = [],
) => Number((await db.execute({ sql, args })).rows[0]!.n);

describe("the dispatcher reaches the US day module", () => {
  it("prepare asks the fetch step for the universe codes, with an empty suffix and the profile currency", async () => {
    const db = await usDevDb();
    const r = await prepareBatch1(db, { nowMs: nightMs(DAYS[0]!), market: MARKET });
    expect(r.action).toBe("fetch");
    expect(r.codes).toBe(4);
    expect(r.request.suffix).toBe("");
    expect(r.request.currency).toBe("USD");
    expect(r.request.end).toBe(DAYS[0]);
  });
});

describe("one night", () => {
  it("writes the universe, the bars, the filings with categories, the notices, the short volume, the index and the marker", async () => {
    const db = await usDevDb();
    const d = DAYS[1]!; // 2026-11-03: an 8-K item 1.01 and a Form 4 on ZZB
    const { barsText, feeds } = sessionFiles(d);
    const res = await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
    expect(res.exit).toBe(0);
    expect(res.status).toBe("ok");
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US' AND d = ?", [d]),
    ).toBe(4);
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM universe_snapshot WHERE market = 'US' AND d = ?", [
        d,
      ]),
    ).toBe(4);
    // the SIC group is in instrument.industry (D-1182)
    const ind = await db.execute(
      "SELECT code, industry FROM instrument WHERE market = 'US' ORDER BY code",
    );
    expect(ind.rows.map((r) => `${r.code}:${r.industry}`)).toEqual([
      "ZZA:73",
      "ZZB:60",
      "ZZC:53",
      "ZZD:28",
    ]);
    // the filings of the last 3 days: ZZA 8-K 2.02 of 11-02 (results, 3), ZZB 8-K 1.01 (contract, 2 -> price sensitive), ZZB Form 4 (director trade, 1)
    const ann = await db.execute(
      `SELECT a.type, a.price_sensitive AS ps, c.category, c.materiality FROM announcement a
       JOIN announcement_category c ON c.market = a.market AND c.source = a.source AND c.ann_id = a.ann_id
       WHERE a.market = 'US' ORDER BY a.published_at`,
    );
    expect(ann.rows.map((r) => `${r.type}|${r.category}|${r.materiality}|${r.ps}`)).toEqual([
      "8-K:2.02,9.01|results|3|1",
      "8-K:1.01|contract|2|1",
      "4|director_trade|1|0",
    ]);
    // Form 4: purchase 1000 x 24.50 = 24,500 vs sale 200 x 25.10 = 5,020 -> director_buy 24,500
    const ins = await db.execute(
      "SELECT code, kind, value_micro FROM insider_notice WHERE market = 'US'",
    );
    expect(ins.rows.map((r) => `${r.code}|${r.kind}|${r.value_micro}`)).toEqual([
      "ZZB|director_buy|24500000000",
    ]);
    // short volume ratio of the four covered codes only (the two outside symbols are not written)
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM short_interest WHERE market = 'US' AND as_of = ?",
        [d],
      ),
    ).toBe(4);
    expect(
      await count(db, "SELECT COUNT(*) AS n FROM index_bar WHERE market = 'US' AND d = ?", [d]),
    ).toBe(2);
    const marker = await db.execute(
      "SELECT kind, outcome FROM completion_marker WHERE market = 'US' AND d = ?",
      [d],
    );
    expect(marker.rows.map((r) => `${r.kind}:${r.outcome}`)).toEqual(["data:complete"]);
    const rr = await db.execute("SELECT status, job FROM run_record WHERE concurrency_key = ?", [
      `batch1:US:${d}`,
    ]);
    expect(rr.rows.map((r) => `${r.job}:${r.status}`)).toEqual(["ingest-batch1:success"]);
  });

  it("a re-run adds nothing (the success record is the PLT-076 early exit)", async () => {
    const db = await usDevDb();
    const d = DAYS[0]!;
    const { barsText, feeds } = sessionFiles(d);
    await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
    const before = await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US'");
    const again = await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
    expect(again.status).toBe("skipped");
    expect(again.reason).toBe("already_done");
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US'")).toBe(before);
  });

  it("a missing bars file fails the date visibly and writes no bar (DAT-004: nothing is invented)", async () => {
    const db = await usDevDb();
    const d = DAYS[0]!;
    const res = await runBatch1(db, {
      nowMs: () => nightMs(d),
      market: MARKET,
      barsText: null,
      feeds: {},
    });
    expect(res.exit).toBe(1);
    expect(res.status).toBe("failed");
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(0);
    const rr = await db.execute(
      "SELECT status, error_summary FROM run_record WHERE concurrency_key = ?",
      [`batch1:US:${d}`],
    );
    expect(rr.rows[0]!.status).toBe("failed");
    expect(String(rr.rows[0]!.error_summary)).toContain("bars file missing");
  });

  it("a feed that fails degrades the night and never the bars", async () => {
    const db = await usDevDb();
    const d = DAYS[0]!;
    const { barsText } = sessionFiles(d);
    // an unreadable submissions JSON shape for a covered code: the filings stage fails, the bars stand
    const feeds = {
      submissions: [{ code: "ZZA", json: { filings: { recent: { accessionNumber: 5 } } } }],
      halts: "<rss><item><ndaq:IssueSymbol>ZZA</ndaq:IssueSymbol></item></rss>",
    };
    const res = await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
    expect(res.exit).toBe(0);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US'")).toBe(4);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM completion_marker WHERE market = 'US' AND kind = 'data'",
      ),
    ).toBe(1);
  });

  it("a weekend writes a non-trading marker and no bar", async () => {
    const db = await usDevDb();
    const sat = "2026-11-07";
    const res = await runBatch1(db, {
      nowMs: () => nightMs(sat),
      market: MARKET,
      barsText: "[]",
      feeds: {},
    });
    expect(res.exit).toBe(0);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM completion_marker WHERE market = 'US' AND kind = 'non-trading' AND d = ?",
        [sat],
      ),
    ).toBe(1);
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar")).toBe(0);
  });

  it("a market in mode off writes only a skipped run record", async () => {
    const db = await freshDb("main");
    await allowMarket(db, MARKET); // enabled, but mode off (the seed)
    const res = await runBatch1(db, {
      nowMs: () => nightMs(DAYS[0]!),
      market: MARKET,
      barsText: "[]",
      feeds: {},
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("market_off");
  });
});

describe("five sessions in a row (AT-M4: the recorded data_only days, offline)", () => {
  it("every night is complete, the halts, the 13D and the suspension land, and the second 10-K is the restatement", async () => {
    const db = await usDevDb();
    for (const d of DAYS) {
      const { barsText, feeds } = sessionFiles(d);
      const res = await runBatch1(db, { nowMs: () => nightMs(d), market: MARKET, barsText, feeds });
      expect(res.exit, d).toBe(0);
      expect(res.status, d).toBe("ok");
    }
    expect(await count(db, "SELECT COUNT(*) AS n FROM price_bar WHERE market = 'US'")).toBe(20);
    expect(
      await count(
        db,
        "SELECT COUNT(*) AS n FROM completion_marker WHERE market = 'US' AND kind = 'data'",
      ),
    ).toBe(5);
    const halts = await db.execute(
      "SELECT code, kind, halted_at, resumed_at, reason FROM trading_halt WHERE market = 'US' ORDER BY halted_at",
    );
    expect(
      halts.rows.map((r) => `${r.code}|${r.kind}|${r.halted_at}|${r.resumed_at}|${r.reason}`),
    ).toEqual([
      // 14:10:03 EST = 19:10:03Z; the pause lifted 14:15:03 EST
      "ZZC|luld|2026-11-04T19:10:03.000Z|2026-11-04T19:15:03.000Z|LUDP",
      // a news halt at 15:50 EST resumed next morning 09:30 EST
      "ZZD|halt|2026-11-05T20:50:00.000Z|2026-11-06T14:30:00.000Z|T1",
      "ZZD|suspension|2026-11-06T14:30:00.000Z|null|sec_suspension",
    ]);
    const holders = await db.execute(
      "SELECT code, kind FROM insider_notice WHERE market = 'US' AND kind LIKE 'sh_%'",
    );
    expect(holders.rows.map((r) => `${r.code}|${r.kind}`)).toEqual(["ZZD|sh_new"]);
    // the capital-raising 8-K item 2.03 on the last night
    const cr = await db.execute(
      "SELECT c.category FROM announcement a JOIN announcement_category c ON c.ann_id = a.ann_id WHERE a.type = '8-K:2.03'",
    );
    expect(cr.rows.map((r) => r.category)).toEqual(["capital_raising"]);
    // all SIC groups land by the end
    const ind = await db.execute(
      "SELECT code, industry FROM instrument WHERE market = 'US' ORDER BY code",
    );
    expect(ind.rows.map((r) => `${r.code}:${r.industry}`)).toEqual([
      "ZZA:73",
      "ZZB:60",
      "ZZC:53",
      "ZZD:28",
    ]);
  });
});
