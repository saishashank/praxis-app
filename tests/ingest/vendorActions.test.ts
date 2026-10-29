// @vitest-environment node
// DAT-231 / GL-04 (M8.1 B2+B3): vendor split and dividend rows from the nightly Yahoo request, and
// a bar with a null adj_close. Real local libSQL file, synthetic ZZ codes.
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { carryTiers, noopQualityHook, runBatch1 } from "@/lib/data/pipeline/batch1";
import {
  parseVendorActionsText,
  readVendorActions,
  validateVendorAction,
  writeVendorActions,
} from "../../src/lib/data/vendorActions/vendorActions.mjs";
import { cleanupTempDbs } from "../db/helpers";
import { at1730, barsFor, count, pipelineDb, runs, text } from "../pipeline/helpers";

afterEach(cleanupTempDbs);

const TUE = "2026-10-13";
const F1 = "2026-10-13T07:30:00.000Z";
const F2 = "2026-10-14T07:30:00.000Z";
const split = (over: Record<string, unknown> = {}) => ({
  code: "ZZA",
  ex_date: "2026-10-12",
  kind: "split",
  ratio: 2,
  currency: "AUD",
  source: "yahoo",
  fetched_at: F1,
  ...over,
});
const div = (over: Record<string, unknown> = {}) => ({
  code: "ZZB",
  ex_date: TUE,
  kind: "dividend",
  amount: 0.35,
  currency: "AUD",
  source: "yahoo",
  fetched_at: F1,
  ...over,
});

const go = (db: Client, o: Record<string, unknown> = {}) =>
  runBatch1(db, {
    nowMs: () => at1730(TUE),
    barsText: text(barsFor(["2026-10-12", TUE])),
    qualityHook: noopQualityHook,
    tiersHook: carryTiers,
    ...o,
  } as never);

describe("vendor action parsing", () => {
  it("validates split and dividend rows, counting bad rows by reason", () => {
    const parsed = parseVendorActionsText(
      text([
        split(),
        div(),
        split({ ratio: 1 }),
        split({ ratio: 0 }),
        div({ amount: -1 }),
        div({ amount: null }),
        { ...div(), kind: "spin" },
        div({ code: "zz" }),
        div({ source: "other" }),
        div(), // duplicate key
      ]),
    );
    expect(parsed.status).toBe("ok");
    expect(parsed.rows).toEqual([
      expect.objectContaining({ code: "ZZA", kind: "split", ratio: 2, amount_micro: null }),
      expect.objectContaining({ code: "ZZB", kind: "dividend", ratio: null, amount_micro: 350000 }),
    ]);
    expect(parsed.rejected).toEqual({
      bad_ratio: 2,
      bad_amount: 2,
      bad_kind: 1,
      bad_code: 1,
      bad_source: 1,
      duplicate_key: 1,
    });
    expect(parseVendorActionsText(null).status).toBe("no_file");
    expect(parseVendorActionsText("{").status).toBe("invalid");
    expect(parseVendorActionsText("{}").status).toBe("invalid");
    expect(validateVendorAction(div({ ex_date: "2026-02-30" }))).toEqual({ reason: "bad_date" });
  });
});

describe("vendor_action table", () => {
  it("upserts idempotently and a revised figure replaces the old one", async () => {
    const db = await pipelineDb();
    const rows = parseVendorActionsText(text([split(), div()])).rows;
    expect(await writeVendorActions(db, { rows })).toBe(2);
    expect(await writeVendorActions(db, { rows })).toBe(2); // same keys: updated, never duplicated
    expect(await count(db, "vendor_action")).toBe(2);
    const revised = parseVendorActionsText(text([div({ amount: 0.4, fetched_at: F2 })])).rows;
    await writeVendorActions(db, { rows: revised });
    expect(await count(db, "vendor_action")).toBe(2);
    const got = await readVendorActions(db, "ZZB", "2026-10-01", "2026-10-31");
    expect(got).toEqual([
      {
        code: "ZZB",
        exDate: TUE,
        kind: "dividend",
        ratio: null,
        amountMicro: 400000n,
        currency: "AUD",
        source: "yahoo",
        fetchedAt: F2,
      },
    ]);
  });

  it("readVendorActions filters by code and the inclusive ex_date window, oldest first", async () => {
    const db = await pipelineDb();
    await writeVendorActions(db, {
      rows: parseVendorActionsText(
        text([
          div({ code: "ZZA", ex_date: "2026-09-01" }),
          split({ ex_date: "2026-10-12" }),
          div({ code: "ZZA", ex_date: "2026-10-12" }),
          split({ ex_date: "2026-11-01" }),
          div(),
        ]),
      ).rows,
    });
    const a = await readVendorActions(db, "ZZA", "2026-09-02", "2026-10-31");
    expect(a.map((x) => `${x.exDate}:${x.kind}`)).toEqual([
      "2026-10-12:dividend",
      "2026-10-12:split",
    ]);
    expect(await readVendorActions(db, "ZZA", "2026-10-13", "2026-10-31")).toEqual([]);
  });

  it("the table refuses a split without a ratio and a dividend with both figures", async () => {
    const db = await pipelineDb();
    const ins = (kind: string, ratio: number | null, amt: number | null) =>
      db.execute({
        sql: "INSERT INTO vendor_action (market, code, ex_date, kind, ratio, amount_micro, currency, source, fetched_at) VALUES ('AU','ZZA','2026-10-12',?,?,?,'AUD','yahoo','t')",
        args: [kind, ratio, amt],
      });
    await expect(ins("split", null, null)).rejects.toThrow();
    await expect(ins("dividend", 2, 5)).rejects.toThrow();
    await expect(ins("split", 2, null)).resolves.toBeDefined();
  });
});

describe("inside a Batch 1 run", () => {
  it("stores the vendor rows of universe codes once, on the target date, and says so", async () => {
    const db = await pipelineDb();
    const actionsText = text([split(), div(), div({ code: "ZZQ" })]);
    const res = await go(db, { actionsText });
    expect(res.exit).toBe(0);
    expect(await count(db, "vendor_action")).toBe(2); // ZZQ is not in the universe
    const rec = (await runs(db)).find((x) => x.status === "success")!;
    const s6 = JSON.parse(String(rec.details_json)).stages.macro_and_other;
    expect(s6.vendor_actions).toMatchObject({ rows: 2, written: 2, not_in_universe: 1 });
    // a re-run changes nothing
    await go(db, { actionsText });
    expect(await count(db, "vendor_action")).toBe(2);
  });

  it("no file or a bad file writes nothing and never fails the bars", async () => {
    const db = await pipelineDb();
    expect((await go(db)).exit).toBe(0);
    expect(await count(db, "vendor_action")).toBe(0);
    const db2 = await pipelineDb();
    expect((await go(db2, { actionsText: "not json" })).exit).toBe(0);
    expect(await count(db2, "vendor_action")).toBe(0);
  });

  it("GL-04: a bar with a null adj_close is stored", async () => {
    const db = await pipelineDb();
    const res = await go(db, {
      barsText: text(barsFor(["2026-10-12", TUE], undefined, { adj_close: null })),
    });
    expect(res.exit).toBe(0);
    expect(await count(db, "price_bar", `d = '${TUE}'`)).toBe(3);
  });
});

describe("GL-01 adjClose map for the corporate-actions hook", () => {
  it("builds prevAdj/exAdj per code and skips nulls (GL-04)", async () => {
    const { buildAdjClose } = await import("../../src/lib/data/pipeline/batch1-core.mjs");
    const rows = [
      { code: "ZZA", date: "2026-10-12", adj_close: 10 },
      { code: "ZZA", date: TUE, adj_close: 5 },
      { code: "ZZB", date: "2026-10-12", adj_close: null },
      { code: "ZZB", date: TUE, adj_close: 7 },
      { code: "ZZC", date: "2026-10-12", adj_close: 8 },
      { code: "ZZC", date: TUE, adj_close: null },
    ];
    expect(buildAdjClose(rows, "2026-10-12", TUE)).toEqual({ ZZA: { prevAdj: 10, exAdj: 5 } });
  });

  it("is passed to the hook from the fetched bars", async () => {
    const db = await pipelineDb();
    const seen: unknown[] = [];
    const bars = [
      ...barsFor(["2026-10-12", TUE], ["ZZA", "ZZB"]),
      ...barsFor(["2026-10-12", TUE], ["ZZC"], { adj_close: null }),
    ];
    const res = await go(db, {
      barsText: text(bars),
      corporateActionsHook: async (c: { adjClose?: unknown }) => {
        seen.push(c.adjClose);
      },
    });
    expect(res.exit).toBe(0);
    const m = seen[seen.length - 1] as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual(["ZZA", "ZZB"]);
  });
});
