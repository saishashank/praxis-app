// @vitest-environment node
// DAT-233 (D-237, M14 WP2): factor_kind and ref_close_micro on adjustment_factor; a price factor is used
// only while its reference close still equals the close before the ex-date; adjustedBars returns the
// price and split factors separately. Synthetic ZZ* data only (SEC-110).
import { afterEach, describe, expect, it } from "vitest";
import { adjustedBars, effectiveFactors } from "@/lib/data/adjusted";
import { loadActions, runCorporateActions, settle } from "@/lib/data/corporateActions/engine.mjs";
import { factorKindOf, refCloseMatches, reasonText } from "@/lib/data/corporateActions/rules.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { announced, caDb, D0, D1, D2, D3, io, nowOf, putBar, rows } from "./helpers";

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
const spin = { retained: { num: 3, den: 4 } };

describe("rules", () => {
  it("share-count changes are split kind, everything else is price kind", () => {
    for (const t of ["split", "consolidation", "bonus_issue"])
      expect(factorKindOf(t)).toBe("split");
    for (const t of ["cash_dividend", "special_dividend", "spin_off", "rights_renounceable"])
      expect(factorKindOf(t)).toBe("price");
  });

  it("a missing reference matches; equal matches; different does not", () => {
    expect(refCloseMatches(null, 10_000_000)).toBe(true);
    expect(refCloseMatches(10_000_000, null)).toBe(true);
    expect(refCloseMatches(10_000_000, 10_000_000)).toBe(true);
    expect(refCloseMatches(10_000_000, 10_000_001)).toBe(false);
    expect(reasonText("ref_close_mismatch")).toMatch(/reference close/);
  });
});

describe("engine writes the kind and the reference close", () => {
  it("a split row is split kind with no reference close; a dividend row is price kind with it", async () => {
    const db = await caDb(["ZZA", "ZZB"]);
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 5.1);
    await putBar(db, "ZZB", D0, 20);
    await putBar(db, "ZZB", D1, 19.9);
    await run(db, D1, [
      announced("ZZA", "split", D1, { new: 2, old: 1 }),
      announced("ZZB", "cash_dividend", D1, { dps: "0.10", pay_date: D3 }, "ann-2"),
    ]);
    const r = await rows(
      db,
      `SELECT ca.code, f.factor, f.factor_kind, f.ref_close_micro FROM adjustment_factor f
       JOIN corporate_action ca ON ca.id = f.corporate_action_id ORDER BY ca.code`,
    );
    expect(r.map((x) => [x.code, x.factor, x.factor_kind, x.ref_close_micro])).toEqual([
      ["ZZA", 0.5, "split", null],
      ["ZZB", 1, "price", 20_000_000],
    ]);
  });
});

describe("a price factor with a changed reference close is queued, not applied", () => {
  it("queues ref_close_mismatch for the Owner and the series stays unadjusted", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 7.4);
    await run(db, D1, [announced("ZZA", "spin_off", D1, spin)]);
    const [a] = await loadActions(db, io(), "AU");
    expect(a?.state).toBe("confirmed");
    expect((await adjustedBars(db, "ZZA", D0, D1))[0]?.priceFactor).toBe(0.75);
    // the stored reference close was recorded against a bar that has since been replaced: simulate it
    // by adding a newer factor row (append-only) with another reference, then settle again
    await db.execute({
      sql: `INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at,
              factor_kind, ref_close_micro) VALUES ('AU','ZZA',?,0.75,?,?,'price',9000000)`,
      args: [D1, a!.id, "2026-10-14T00:00:00.000Z"],
    });
    const s = await settle(db, { market: "AU", now: nowOf(D2), io: io(), today: D2 });
    expect(s.factors).toBe(1); // the neutral row
    const [b] = await loadActions(db, io(), "AU");
    expect(b?.state).toBe("owner");
    expect(b?.note.reasons).toEqual(["ref_close_mismatch"]);
    const bars = await adjustedBars(db, "ZZA", D0, D1);
    expect(bars[0]?.priceFactor).toBe(1);
    expect(bars[0]?.c).toBe(10);
  });
});

describe("adjustedBars returns the factors separately", () => {
  it("priceFactor x splitFactor = factor; a legacy NULL kind comes from the action type", async () => {
    const db = await caDb();
    await putBar(db, "ZZA", D0, 10);
    await putBar(db, "ZZA", D1, 7.5);
    await putBar(db, "ZZA", D2, 3.8);
    await run(db, D1, [announced("ZZA", "spin_off", D1, spin)]);
    await run(db, D2, [announced("ZZA", "split", D2, { new: 2, old: 1 }, "ann-2")]);
    const [b0, b1, b2] = await adjustedBars(db, "ZZA", D0, D2);
    expect([b0?.priceFactor, b0?.splitFactor, b0?.factor]).toEqual([0.75, 0.5, 0.375]);
    expect([b1?.priceFactor, b1?.splitFactor]).toEqual([1, 0.5]);
    expect([b2?.priceFactor, b2?.splitFactor, b2?.factor]).toEqual([1, 1, 1]);
    const f = await effectiveFactors(db, "ZZA");
    expect(f.map((x) => x.kind)).toEqual(["price", "split"]);
  });

  it("a legacy row (NULL kind) takes its kind from the action type", async () => {
    const legacy = await caDb();
    await putBar(legacy, "ZZA", D0, 10);
    await legacy.execute({
      sql: "INSERT INTO corporate_action (market, code, type, ex_date, payload_json) VALUES ('AU','ZZA','cash_dividend',?,?)",
      args: [D1, "{}"],
    });
    await legacy.execute({
      sql: "INSERT INTO corporate_action_event (action_id, at, status, by, note) VALUES (1, ?, 'auto_confirmed', 'system', '{}')",
      args: [nowOf(D1)],
    });
    await legacy.execute({
      sql: "INSERT INTO adjustment_factor (market, code, ex_date, factor, corporate_action_id, computed_at) VALUES ('AU','ZZA',?,0.9,1,?)",
      args: [D1, nowOf(D1)],
    });
    expect((await effectiveFactors(legacy, "ZZA")).map((x) => x.kind)).toEqual(["price"]);
    expect((await adjustedBars(legacy, "ZZA", D0, D0))[0]).toMatchObject({
      priceFactor: 0.9,
      splitFactor: 1,
    });
  });
});
