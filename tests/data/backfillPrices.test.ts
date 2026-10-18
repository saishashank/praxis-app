// @vitest-environment node
// Price-history backfill (M4 T4): raw reconstruction (DAT-126), write-once month files (D-065),
// the Yahoo source gate (O-26) and the resumable cursor. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  JOB_YAHOO,
  commitPriceMonth,
  cumulativeFactor,
  ensurePriceJob,
  planPrices,
  priceHistoryLocation,
  reconstructRaw,
  titleFactor,
  validateBars,
} from "@/lib/data/backfill/priceHistory.mjs";
import { fromJsonlGz, gzipDeterministic, toJsonl } from "@/lib/data/backfill/rules.mjs";
import {
  NOW,
  addBatch1Usage,
  backfillDb,
  count,
  fakeStore,
  jobRow,
  killOnBatch,
  runs,
  stateOf,
} from "../backfill/helpers";
import { acceptYahoo, bar, seedAction, series, weekdays } from "../fixtures/replay/synthetic";

const MONTH = "2026-09";
const EX = "2026-09-15";
const days = weekdays(MONTH);
const pre = days.filter((d) => d < EX);
const post = days.filter((d) => d >= EX);

/** Vendor (split-adjusted) bars of a 2-for-1 split on EX: pre bars carry raw x 0.5 and volume / 0.5. */
function splitVendor() {
  return [
    ...pre.map((d) => bar("ZZA", d, 5, 2000)), // raw 10.00, volume 1000
    ...post.map((d) => bar("ZZA", d, 5.05, 1000)),
  ];
}

async function ready() {
  const db = await backfillDb();
  await acceptYahoo(db);
  return db;
}

describe("raw reconstruction (DAT-126)", () => {
  it("reverses a 2-for-1 split with the confirmed factor", async () => {
    const db = await ready();
    await seedAction(db, { id: 1, code: "ZZA", type: "split", exDate: EX, factor: 0.5 });
    const store = fakeStore();
    const r = await commitPriceMonth(db, { month: MONTH, bars: splitVendor(), store, nowMs: NOW });
    expect(r).toMatchObject({
      status: "ok",
      rows: days.length,
      reversed: pre.length,
      file: "uploaded",
    });
    const rows = fromJsonlGz(
      store.files.get("history-yahoo_prices-2026/yahoo_prices-2026-09.jsonl.gz")!,
    ) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ c: 10, o: 10, volume: 1000 * 1, adj: "reversed" });
    expect(rows[pre.length]).toMatchObject({ c: 5.05, volume: 1000, adj: "none" });
  });

  it("reverses a 1-for-10 consolidation (factor 10, volume goes down by the factor)", () => {
    const f = [{ code: "ZZB", exDate: EX, factor: 10 }];
    const bars = [bar("ZZB", "2026-09-14", 1, 10000), bar("ZZB", EX, 1.02, 10000)];
    const r = reconstructRaw(bars, { factors: f });
    expect(r.findings).toEqual([]);
    expect(r.rows[0]).toMatchObject({ c: 0.1, volume: 100000, adj: "reversed" });
    expect(r.rows[1]).toMatchObject({ c: 1.02, volume: 10000, adj: "none" });
  });

  it("applies the product of several factors and leaves the ex-date bar raw", () => {
    const f = [
      { exDate: "2026-09-10", factor: 0.5 },
      { exDate: "2026-09-20", factor: 10 },
    ];
    expect(cumulativeFactor(f, "2026-09-09")).toBe(5);
    expect(cumulativeFactor(f, "2026-09-10")).toBe(10);
    expect(cumulativeFactor(f, "2026-09-20")).toBe(1);
  });

  it("a vendor that already returns raw prices is stored unchanged", () => {
    const f = [{ code: "ZZA", exDate: EX, factor: 0.5 }];
    const bars = [bar("ZZA", "2026-09-14", 10, 1000), bar("ZZA", EX, 5, 2000)];
    const r = reconstructRaw(bars, { factors: f, vendor: "raw" });
    expect(r.rows.map((x) => x.c)).toEqual([10, 5]);
    expect(r.findings).toEqual([]);
  });

  it("flags a vendor series that was not adjusted (ratio across the ex-date mismatches)", () => {
    const f = [{ code: "ZZA", exDate: EX, factor: 0.5 }];
    // raw-looking input read as adjusted: reversal would double the jump (10 -> 20 then 5).
    const bars = [bar("ZZA", "2026-09-14", 10, 1000), bar("ZZA", EX, 5, 2000)];
    const r = reconstructRaw(bars, { factors: f });
    expect(r.findings).toEqual([{ code: "ZZA", kind: "ratio_mismatch", exDate: EX }]);
  });

  it("a vendor-only split is used and a conflicting vendor split is a finding", () => {
    const bars = splitVendor();
    const vendorOnly = reconstructRaw(bars, {
      factors: [],
      vendorSplits: [{ code: "ZZA", exDate: EX, ratio: 2 }],
    });
    expect(vendorOnly.findings).toEqual([]);
    expect(vendorOnly.rows[0].c).toBe(10);
    expect(vendorOnly.usedFactors[0]).toMatchObject({ from: "vendor_only", factor: 0.5 });
    const conflict = reconstructRaw(bars, {
      factors: [{ code: "ZZA", exDate: EX, factor: 0.5 }],
      vendorSplits: [{ code: "ZZA", exDate: "2026-09-16", ratio: 3 }],
    });
    expect(conflict.findings).toEqual([
      { code: "ZZA", kind: "vendor_factor_conflict", exDate: EX },
    ]);
  });

  it("reads titles and rejects a factor that disagrees with its announcement", () => {
    expect(titleFactor("Share Split 2 for 1")).toEqual({ kind: "split", factor: 0.5 });
    expect(titleFactor("1-for-10 share consolidation")).toEqual({
      kind: "consolidation",
      factor: 10,
    });
    expect(titleFactor("Bonus issue 1 for 5")?.factor).toBeCloseTo(5 / 6, 12);
    expect(titleFactor("Quarterly report")).toBeNull();
    const f = [{ code: "ZZA", exDate: EX, factor: 0.5 }];
    const ok = reconstructRaw(splitVendor(), {
      factors: f,
      titles: [
        { code: "ZZA", publishedAt: "2026-09-10T01:00:00.000Z", title: "Share split 2 for 1" },
      ],
    });
    expect(ok.findings).toEqual([]);
    const bad = reconstructRaw(splitVendor(), {
      factors: f,
      titles: [
        { code: "ZZA", publishedAt: "2026-09-10T01:00:00.000Z", title: "Share split 3 for 1" },
      ],
    });
    expect(bad.findings).toEqual([{ code: "ZZA", kind: "title_mismatch", exDate: EX }]);
  });

  it("a rejected month writes nothing and marks the job failed", async () => {
    const db = await ready();
    await seedAction(db, { id: 1, code: "ZZA", type: "split", exDate: EX, factor: 0.5 });
    const store = fakeStore();
    const r = await commitPriceMonth(db, {
      month: MONTH,
      bars: splitVendor(),
      vendorSplits: [{ code: "ZZA", exDate: EX, ratio: 4 }],
      store,
      nowMs: NOW,
    });
    expect(r).toMatchObject({
      status: "rejected",
      reason: "factor_check",
      rejected: { vendor_factor_conflict: 1 },
    });
    expect(store.files.size).toBe(0);
    expect((await stateOf(db, JOB_YAHOO)).status).toBe("failed");
    expect((await jobRow(db, JOB_YAHOO)).next_date).toBe("2026-09-30");
  });

  it("validates bars (bad numbers, wrong month, duplicates are rejected whole)", () => {
    expect(validateBars([bar("ZZA", "2026-09-01", 5, 1)], MONTH)).toHaveLength(1);
    expect(validateBars([bar("ZZA", "2026-08-31", 5, 1)], MONTH)).toBe("bad_bar");
    expect(validateBars([{ ...bar("ZZA", "2026-09-01", 5, 1), c: -1 }], MONTH)).toBe("bad_bar");
    expect(validateBars([{ ...bar("ZZA", "2026-09-01", 5, 1), volume: 1.5 }], MONTH)).toBe(
      "bad_bar",
    );
    expect(validateBars([bar("zz", "2026-09-01", 5, 1)], MONTH)).toBe("bad_bar");
    const b = bar("ZZA", "2026-09-01", 5, 1);
    expect(validateBars([b, b], MONTH)).toBe("duplicate_bar");
    expect(validateBars("x", MONTH)).toBe("bad_input");
  });
});

describe("write-once month files (D-065)", () => {
  const bars = () => series("ZZA", days, 3, 500);

  it("uses the D-065 layout", () => {
    expect(priceHistoryLocation(MONTH)).toEqual({
      tag: "history-yahoo_prices-2026",
      asset: "yahoo_prices-2026-09.jsonl.gz",
      path: "history/yahoo_prices/2026/09.jsonl.gz",
    });
    expect(() => priceHistoryLocation("2026-13")).toThrow(RangeError);
  });

  it("same name with different content is a conflict: never overwritten, job failed, cursor kept", async () => {
    const db = await ready();
    const other = gzipDeterministic(toJsonl([{ code: "ZZA", d: "2026-09-01", c: 1 }]));
    const store = fakeStore({ "history-yahoo_prices-2026/yahoo_prices-2026-09.jsonl.gz": other });
    const r = await commitPriceMonth(db, { month: MONTH, bars: bars(), store, nowMs: NOW });
    expect(r.status).toBe("conflict");
    expect(store.files.get("history-yahoo_prices-2026/yahoo_prices-2026-09.jsonl.gz")).toBe(other);
    expect((await stateOf(db, JOB_YAHOO)).reason).toBe("history_conflict");
    expect((await jobRow(db, JOB_YAHOO)).next_date).toBe("2026-09-30");
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(0);
  });

  it("a kill between the upload and the cursor is repaired by the SHA skip", async () => {
    const db = await ready();
    const store = fakeStore();
    const k = killOnBatch(db);
    await expect(
      commitPriceMonth(k.db, { month: MONTH, bars: bars(), store, nowMs: NOW }),
    ).rejects.toThrow("killed");
    expect(store.files.size).toBe(1);
    expect((await jobRow(db, JOB_YAHOO)).next_date).toBe("2026-09-30"); // all or nothing
    const again = await commitPriceMonth(db, { month: MONTH, bars: bars(), store, nowMs: NOW });
    expect(again).toMatchObject({ status: "ok", file: "skipped", nextDate: "2026-08-31" });
    expect(store.files.size).toBe(1);
  });

  it("is deterministic: the same inputs give byte-identical files", async () => {
    const a = fakeStore();
    const b = fakeStore();
    await commitPriceMonth(await ready(), { month: MONTH, bars: bars(), store: a, nowMs: NOW });
    await commitPriceMonth(await ready(), {
      month: MONTH,
      bars: [...bars()].reverse(),
      store: b,
      nowMs: NOW,
    });
    expect([...b.files.values()][0]).toEqual([...a.files.values()][0]);
  });
});

describe("source gate (O-26) and resumable cursor", () => {
  it("source_off while Yahoo is pending: no file, no cursor move, status recorded", async () => {
    const db = await backfillDb(); // yahoo_eod register status is 'pending'
    const store = fakeStore();
    expect(await planPrices(db, { nowMs: NOW })).toEqual({ action: "none", reason: "source_off" });
    const r = await commitPriceMonth(db, {
      month: MONTH,
      bars: series("ZZA", days, 3, 1),
      store,
      nowMs: NOW,
    });
    expect(r).toEqual({ status: "source_off", reason: "source_not_accepted" });
    expect(store.files.size).toBe(0);
    expect(await stateOf(db, JOB_YAHOO)).toMatchObject({
      status: "source_off",
      reason: "source_not_accepted",
    });
    expect((await jobRow(db, JOB_YAHOO)).next_date).toBe("2026-09-30");
  });

  it("an accepted but switched-off source is also source_off", async () => {
    const db = await ready();
    await db.execute("UPDATE source_status SET mode = 'off' WHERE source = 'yahoo_eod'");
    expect(await planPrices(db, { nowMs: NOW })).toEqual({ action: "none", reason: "source_off" });
    expect((await stateOf(db, JOB_YAHOO)).reason).toBe("source_off");
  });

  it("walks newest month first, rejects out-of-order and repeated months, and resumes", async () => {
    const db = await ready();
    const store = fakeStore();
    const m = (month: string) => series("ZZA", weekdays(month), 3, 100);
    expect(await planPrices(db, { nowMs: NOW })).toEqual({ action: "fetch", month: "2026-09" });
    expect(
      await commitPriceMonth(db, { month: "2026-07", bars: m("2026-07"), store, nowMs: NOW }),
    ).toEqual({
      status: "out_of_order",
      expected: "2026-09",
    });
    const first = await commitPriceMonth(db, { month: MONTH, bars: m(MONTH), store, nowMs: NOW });
    expect(first).toMatchObject({ status: "ok", nextDate: "2026-08-31", done: false });
    expect(
      (await commitPriceMonth(db, { month: MONTH, bars: m(MONTH), store, nowMs: NOW })).status,
    ).toBe("already_done");
    expect(await planPrices(db, { nowMs: NOW })).toEqual({ action: "fetch", month: "2026-08" });
    const second = await commitPriceMonth(db, {
      month: "2026-08",
      bars: m("2026-08"),
      store,
      nowMs: NOW,
    });
    expect(second).toMatchObject({ status: "ok", nextDate: "2026-07-31" });
    expect(await count(db, "run_record", "job = 'backfill-history'")).toBe(2);
    expect(await runs(db)).toHaveLength(2);
    expect(await stateOf(db, JOB_YAHOO)).toMatchObject({ status: "active", last_month: "2026-08" });
  });

  it("an empty month moves the cursor without a file and the job ends at the floor", async () => {
    const db = await ready();
    const store = fakeStore();
    await ensurePriceJob(db, NOW);
    await db.execute(
      "UPDATE backfill_job SET next_date = '2020-10-31' WHERE name = 'yahoo_prices'",
    );
    const r = await commitPriceMonth(db, { month: "2020-10", bars: [], store, nowMs: NOW });
    expect(r).toMatchObject({ status: "ok", rows: 0, file: "none", done: true, nextDate: null });
    expect(store.files.size).toBe(0);
    expect((await stateOf(db, JOB_YAHOO)).reason).toBe("floor");
    expect(
      (await commitPriceMonth(db, { month: "2020-09", bars: [], store, nowMs: NOW })).status,
    ).toBe("done");
  });

  it("pauses at the monthly write cap and writes nothing", async () => {
    const db = await ready();
    await addBatch1Usage(db, 1_999_999);
    const store = fakeStore();
    const r = await commitPriceMonth(db, {
      month: MONTH,
      bars: series("ZZA", days, 3, 1),
      store,
      nowMs: NOW,
      cap: 2_000_000,
    });
    expect(r.status).toBe("paused_cap");
    expect(store.files.size).toBe(0);
    expect((await stateOf(db, JOB_YAHOO)).status).toBe("paused_cap");
    expect(await planPrices(db, { nowMs: NOW, cap: 2_000_000 })).toEqual({
      action: "none",
      reason: "paused_cap",
    });
  });
});
