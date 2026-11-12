// @vitest-environment node
// M20 A5 (DAT-245/246, D-1108, AGT-011a; AT-69/AT-70 50-item clause): 50 hand-labelled fixture announcements are
// classified by the US category map; every one of the 11 AGT-020 categories appears; the map is first-match and
// deterministic; materiality and the verifiable flag follow CTX-043; the category is written by the one writer, not by
// an LLM.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  ANNOUNCEMENT_CATEGORIES,
  categoryMapReader,
  classify,
  writeAnnouncementCategory,
  type AnnouncementItem,
} from "@/lib/cortex/profileReaders";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";

type Fixture = {
  id: string;
  expect: { category: string; materiality: number; verifiable: boolean };
} & AnnouncementItem;
const FIXTURE = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../fixtures/markets/us/announcements-50.json"), "utf8"),
) as { items: Fixture[] };

const MARKET = "US";
const map = categoryMapReader(staticProfile(MARKET))!;

describe("the US category map on 50 hand-labelled items (D-1108)", () => {
  it("the fixture holds 50 items and every one of the 11 categories", () => {
    expect(FIXTURE.items).toHaveLength(50);
    expect(new Set(FIXTURE.items.map((i) => i.expect.category))).toEqual(
      new Set(ANNOUNCEMENT_CATEGORIES),
    );
    expect(ANNOUNCEMENT_CATEGORIES).toHaveLength(11);
  });

  it.each(FIXTURE.items.map((i) => [i.id, i] as const))(
    "%s is classified as labelled",
    (_id, it_) => {
      const c = classify(map, it_);
      expect({
        category: c.category,
        materiality: c.materiality,
        verifiable: c.verifiable,
      }).toEqual(it_.expect);
      expect(c.mapVersion).toBe(map.version);
    },
  );

  it("is first-match: the winning row is the lowest index whose match holds, and a rerun agrees", () => {
    for (const item of FIXTURE.items) {
      const a = classify(map, item);
      const b = classify(map, structuredClone(item));
      expect(b).toEqual(a);
      // no earlier row would also have claimed it under a different category label than the winner's own
      expect(map.rows[a.rule]!.category).toBe(a.category);
    }
  });

  it("the last row is a catch-all so every item has a category", () => {
    expect(map.rows[map.rows.length - 1]!.match).toEqual({});
    expect(classify(map, { type: "zzz unknown", title: "zzz" }).category).toBe("other");
  });

  it("materiality follows AGT-011: results, guidance, takeover and halt 3; capital raising and exchange query 2; the rest lower", () => {
    const by = new Map<string, Set<number>>();
    for (const i of FIXTURE.items) {
      const m = by.get(i.expect.category) ?? new Set<number>();
      m.add(classify(map, i).materiality);
      by.set(i.expect.category, m);
    }
    const only = (c: string): number[] => [...by.get(c)!];
    for (const c of ["results", "guidance", "takeover", "halt"]) expect(only(c)).toEqual([3]);
    for (const c of ["capital_raising", "exchange_query"]) expect(only(c)).toEqual([2]);
    for (const c of ["director_trade", "substantial_holder", "dividend"])
      expect(only(c)).toEqual([1]);
    expect(only("other")).toEqual([0]);
    expect(only("contract").sort()).toEqual([2, 3]);
  });

  it("verifiable needs the evidence (CTX-043): parsed statements for results and guidance, value and counterparty for a contract", () => {
    const parsed = { facts: { statementsParsed: true } };
    const noEvidence = { facts: {} };
    const resultsRow = map.rows.find((r) => r.category === "results")!;
    const base = FIXTURE.items.find((i) => i.expect.category === "results" && i.expect.verifiable)!;
    expect(classify(map, { ...base, ...parsed }).verifiable).toBe(true);
    expect(classify(map, { ...base, ...noEvidence }).verifiable).toBe(false);
    expect(resultsRow.verifiable).toBe(true);
    // a category outside CTX-043 is never verifiable, whatever the facts say
    const holder = FIXTURE.items.find((i) => i.expect.category === "dividend")!;
    expect(
      classify(map, {
        ...holder,
        facts: { statementsParsed: true, valueDisclosed: true, counterpartyDisclosed: true },
      }).verifiable,
    ).toBe(false);
  });

  it("the profile reader returns this map for the market and null for the home market", () => {
    expect(categoryMapReader(staticProfile("AU"))).toBeNull();
    expect(map.version).toMatch(/-categories-v1$/);
  });
});

describe("the one writer of announcement_category (never an LLM, AGT-011a)", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
    await allowMarket(db, MARKET);
  });
  afterEach(cleanupTempDbs);

  it("writes the classified row, keeps the first on a repeat, and refuses a market that is off", async () => {
    const item = FIXTURE.items[0]!;
    const c = await writeAnnouncementCategory(
      db,
      { market: MARKET, source: "t_src", annId: item.id },
      map,
      item,
    );
    const rows = (await db.execute("SELECT * FROM announcement_category")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      market: MARKET,
      source: "t_src",
      ann_id: item.id,
      category: c.category,
      materiality: c.materiality,
      verifiable: c.verifiable ? 1 : 0,
      map_version: map.version,
    });
    await writeAnnouncementCategory(db, { market: MARKET, source: "t_src", annId: item.id }, map, {
      type: "zzz",
    });
    expect((await db.execute("SELECT category FROM announcement_category")).rows[0]!.category).toBe(
      c.category,
    );
    await db.execute({ sql: "UPDATE market SET enabled = 0 WHERE code = ?", args: [MARKET] });
    await expect(
      writeAnnouncementCategory(db, { market: MARKET, source: "t_src", annId: "x2" }, map, item),
    ).rejects.toThrow(/MarketNotEnabled/);
  });
});
