// @vitest-environment node
// Adjusted-price reader (M2 T8): DAT-002 (raw bars never change), DAT-126 (only factors with
// ex-date <= D), AT-08 (no artificial P/L across a split or consolidation). Synthetic ZZ* data.
import { afterEach, describe, expect, it } from "vitest";
import { adjustedBars, effectiveFactors } from "@/lib/data/adjusted";
import { runCorporateActions } from "@/lib/data/corporateActions/engine.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { announced, caDb, count, D0, D1, D2, D3, io, nowOf, putBar, rows } from "./helpers";

afterEach(cleanupTempDbs);

const run = (db: Awaited<ReturnType<typeof caDb>>, d: string, candidates: unknown[] = []) =>
  runCorporateActions({
    db,
    market: "AU",
    d,
    io: io(),
    now: nowOf(d),
    candidates: candidates as never,
  });

describe("adjustedBars", () => {
  it("a confirmed 2-for-1 split makes the series continuous; raw bars are unchanged", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10, 1000);
    await putBar(db, "ZZA", D1, 5.1, 2000);
    await putBar(db, "ZZA", D2, 5.2, 2100);
    await run(db, D1, [announced("ZZA", "split", D1, { new: 2, old: 1 })]);
    const rawBefore = await rows(db, "SELECT * FROM price_bar ORDER BY d");

    const bars = await adjustedBars(db, "ZZA", D0, D2);
    expect(bars.map((b) => [b.d, b.c, b.factor])).toEqual([
      [D0, 5, 0.5],
      [D1, 5.1, 1],
      [D2, 5.2, 1],
    ]);
    // 1000 shares of volume before the split trade like 2000 after it
    expect(bars[0].volume).toBe(2000);
    expect(bars[0].raw).toEqual({ o: 10, h: 10, l: 10, c: 10, volume: 1000 });
    // no artificial P/L: the day-over-day change across the ex-date is the real 2%, not -49%
    expect(bars[1].c / bars[0].c - 1).toBeCloseTo(0.02, 12);
    expect(await rows(db, "SELECT * FROM price_bar ORDER BY d")).toEqual(rawBefore);
  });

  it("a consolidation 1-for-10 scales the earlier bars up by 10", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 0.5);
    await putBar(db, "ZZA", D1, 5.05);
    await run(db, D1, [announced("ZZA", "consolidation", D1, { new: 1, old: 10 })]);
    const [a, b] = await adjustedBars(db, "ZZA", D0, D1);
    expect(a.c).toBe(5);
    expect(b.c).toBe(5.05);
  });

  it("two actions multiply for bars before both", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 40);
    await putBar(db, "ZZA", D1, 20);
    await putBar(db, "ZZA", D2, 5);
    await run(db, D1, [announced("ZZA", "split", D1, { new: 2, old: 1 })]);
    await run(db, D2, [announced("ZZA", "split", D2, { new: 4, old: 1 })]);
    const bars = await adjustedBars(db, "ZZA", D0, D2);
    expect(bars.map((b) => b.c)).toEqual([5, 5, 5]);
    expect(bars.map((b) => b.factor)).toEqual([0.125, 0.25, 1]);
  });

  it("asOf applies only actions with ex-date <= D (DAT-126)", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5.1);
    await run(db, D1, [announced("ZZA", "split", D1, { new: 2, old: 1 })]);
    const early = await adjustedBars(db, "ZZA", D0, D0, { asOf: D0 });
    expect(early[0].c).toBe(10); // the ex-date is after D0: not yet known to that decision date
    const late = await adjustedBars(db, "ZZA", D0, D0, { asOf: D1 });
    expect(late[0].c).toBe(5);
  });

  it("queued, rejected and unconfirmed actions never adjust", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 10.2);
    await run(db, D1, [announced("ZZA", "split", D1, { new: 2, old: 1 })]); // price flat: queued
    expect((await adjustedBars(db, "ZZA", D0, D1)).map((b) => b.c)).toEqual([10, 10.2]);
    expect(await effectiveFactors(db, "ZZA")).toEqual([]);
  });

  it("an action with no event rows or no factor row is ignored", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await db.execute(
      "INSERT INTO corporate_action (id, market, code, type, ex_date, payload_json) VALUES (1, 'AU', 'ZZA', 'split', '2026-10-13', '{}')",
    );
    expect(await effectiveFactors(db, "ZZA")).toEqual([]);
    await db.execute(
      "INSERT INTO corporate_action_event (action_id, at, status, by) VALUES (1, '2026-10-13T00:00:00.000Z', 'auto_confirmed', 'system')",
    );
    expect(await effectiveFactors(db, "ZZA")).toEqual([]); // confirmed but no factor yet
    expect((await adjustedBars(db, "ZZA", D0, D1))[0].c).toBe(10);
  });

  it("the newest factor row of an action wins", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5.1);
    await run(db, D1, [announced("ZZA", "split", D1, { new: 2, old: 1 })]);
    await db.execute({
      sql: "INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at) VALUES ('AU', 'ZZA', ?, 0.25, 1, '2099-01-01T00:00:00.000Z')",
      args: [D1],
    });
    expect((await adjustedBars(db, "ZZA", D0, D0))[0].c).toBe(2.5);
  });

  it("is read-only and validates its arguments", async () => {
    const db = await caDb();
    const before = [await count(db, "price_bar"), await count(db, "adjustment_factor")];
    expect(await adjustedBars(db, "ZZA", D0, D3)).toEqual([]);
    expect(await adjustedBars(db, "ZZB", D0, D3, { market: "AU" })).toEqual([]);
    expect([await count(db, "price_bar"), await count(db, "adjustment_factor")]).toEqual(before);
    await expect(adjustedBars(db, "zz", D0, D1)).rejects.toThrow(RangeError);
    await expect(adjustedBars(db, "ZZA", "2026-02-30", D1)).rejects.toThrow(RangeError);
    await expect(adjustedBars(db, "ZZA", D1, D0)).rejects.toThrow(RangeError);
    await expect(adjustedBars(db, "ZZA", D0, D1, { asOf: "x" })).rejects.toThrow(RangeError);
  });
});
