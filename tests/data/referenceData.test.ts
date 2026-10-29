// @vitest-environment node
// DAT-234 / FAM-006 (D-238, D-218): the manual reference files. CSV validation, the append-only
// import and the as-of readers (no look-ahead). Synthetic ZZ codes only.
import { afterEach, describe, expect, it } from "vitest";
import {
  importIndexChanges,
  importIndustryMap,
  isIsoDate,
  loadIndexChanges,
  loadIndustryMap,
  parseIndexChangesCsv,
  parseIndustryMapCsv,
} from "@/lib/data/referenceData";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const IDX_HEAD = "code,index,change,announced,effective,source\n";
const NOW = "2026-10-30T00:00:00.000Z";

describe("index-change CSV validation", () => {
  it("accepts a good file, sorts rows and reads empty announced as null", () => {
    const r = parseIndexChangesCsv(
      IDX_HEAD +
        "ZZB,S&P/ASX 200,delete,2026-03-06,2026-03-23,rebalance notice\n" +
        "ZZA,S&P/ASX 200,Add,,2026-03-23,rebalance notice\n",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.code)).toEqual(["ZZA", "ZZB"]);
    expect(r.rows[0]).toMatchObject({ kind: "add", announced: null, effective: "2026-03-23" });
  });

  it.each([
    ["a bad code", "zza,X,add,,2026-03-23,s\n"],
    ["a bad kind", "ZZA,X,buy,,2026-03-23,s\n"],
    ["an impossible date", "ZZA,X,add,,2026-02-30,s\n"],
    ["announced after effective", "ZZA,X,add,2026-04-01,2026-03-23,s\n"],
    ["a missing source", "ZZA,X,add,,2026-03-23,\n"],
    ["a short row", "ZZA,X,add\n"],
    ["a control character", "ZZA,X\u0001,add,,2026-03-23,s\n"],
  ])("refuses the whole file for %s and names the line", (_n, row) => {
    const r = parseIndexChangesCsv(IDX_HEAD + "ZZB,X,add,,2026-03-23,s\n" + row);
    expect(r).toEqual({ ok: false, error: "bad_row", line: 3 });
  });

  it("refuses duplicates, a wrong header, empty and non-text input", () => {
    const row = "ZZA,X,add,,2026-03-23,s\n";
    expect(parseIndexChangesCsv(IDX_HEAD + row + row)).toMatchObject({ error: "bad_row", line: 3 });
    expect(parseIndexChangesCsv("code,name\nZZA,x\n")).toMatchObject({
      error: "unrecognised_format",
    });
    expect(parseIndexChangesCsv("")).toMatchObject({ error: "empty" });
    expect(parseIndexChangesCsv(42)).toMatchObject({ error: "unrecognised_format" });
  });
});

describe("industry-map CSV validation", () => {
  it("accepts a good file and refuses placeholders and bad dates", () => {
    expect(parseIndustryMapCsv("code,industry,as_of\nZZA,Gold miners,2026-01-01\n")).toMatchObject({
      ok: true,
    });
    expect(parseIndustryMapCsv("code,industry,as_of\nZZA,Class Pend,2026-01-01\n")).toMatchObject({
      error: "bad_row",
    });
    expect(parseIndustryMapCsv("code,industry,as_of\nZZA,Gold,2026-13-01\n")).toMatchObject({
      error: "bad_row",
    });
  });

  it("isIsoDate checks the calendar", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
  });
});

describe("import and as-of readers", () => {
  it("is append-only and idempotent: a second upload inserts nothing", async () => {
    const db = await freshDb("main");
    const csv = IDX_HEAD + "ZZA,X,add,2026-03-06,2026-03-23,s\nZZA,X,delete,,2026-06-22,s\n";
    expect(await importIndexChanges(db, csv, NOW)).toEqual({ ok: true, inserted: 2, ignored: 0 });
    expect(await importIndexChanges(db, csv, NOW)).toEqual({ ok: true, inserted: 0, ignored: 2 });
    expect(await importIndexChanges(db, "bad", NOW)).toMatchObject({ ok: false });
  });

  it("loadIndexChanges has no look-ahead: unannounced changes are invisible", async () => {
    const db = await freshDb("main");
    await importIndexChanges(
      db,
      IDX_HEAD +
        "ZZA,X,add,2026-03-06,2026-03-23,s\n" +
        "ZZA,X,delete,2026-06-01,2026-06-22,s\n" +
        "ZZB,X,add,,2026-05-01,s\n",
      NOW,
    );
    const early = await loadIndexChanges(db, "AU", "2026-03-10");
    expect([...early.keys()]).toEqual(["ZZA"]);
    // announced 03-06, effective after d: still returned, so the F3 window can see it
    expect(early.get("ZZA")).toEqual([
      { indexName: "X", kind: "add", announced: "2026-03-06", effective: "2026-03-23" },
    ]);
    const late = await loadIndexChanges(db, "AU", "2026-06-30");
    expect(late.get("ZZA")?.map((c) => c.kind)).toEqual(["add", "delete"]);
    expect(late.get("ZZB")?.[0].announced).toBeNull();
    expect((await loadIndexChanges(db, "AU", "2026-04-30")).has("ZZB")).toBe(false);
    expect((await loadIndexChanges(db, "US", "2026-06-30")).size).toBe(0);
  });

  it("loadIndustryMap returns the newest class on or before d", async () => {
    const db = await freshDb("main");
    await importIndustryMap(
      db,
      "code,industry,as_of\nZZA,Gold,2026-01-01\nZZA,Lithium,2026-06-01\nZZB,Banks,2026-09-01\n",
      NOW,
    );
    expect([...(await loadIndustryMap(db, "AU", "2026-03-01"))]).toEqual([["ZZA", "Gold"]]);
    const later = await loadIndustryMap(db, "AU", "2026-10-01");
    expect(later.get("ZZA")).toBe("Lithium");
    expect(later.get("ZZB")).toBe("Banks");
  });
});
