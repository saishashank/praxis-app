// @vitest-environment node
// M20 A5 (DAT-226, AT-38, D-1111; AT-70 as-filed clause): company facts AS FILED. The first-filed value is what a
// decision between the two filings reads; the restated value is read only after its own filing; a read ahead of a
// filing fails the TST-109 fact check. A restatement is a new accession, never an overwrite.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  appendFacts,
  factAsOf,
  filedInstant,
  parseCompanyFacts,
  type CompanyFactsJson,
} from "@/lib/data/sources/us/companyFacts";
import { assertFactsKnown, FactAheadOfFiling, factVisible } from "@/lib/replay/snapshotWorld";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";

const JSON_FACTS = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../fixtures/markets/us/companyfacts-zz.json"), "utf8"),
) as CompanyFactsJson;

const FIRST = "0001234567-26-000010"; // the 10-K filed 2026-02-20
const RESTATED = "0001234567-26-000030"; // the 10-K/A filed 2026-04-10
const parse = (acceptance?: Record<string, string>) =>
  parseCompanyFacts(JSON_FACTS, { market: "US", code: "ZZ1", acceptance });

describe("parseCompanyFacts", () => {
  const rows = parse();
  const find = (concept: string, end: string, accn: string) =>
    rows.find((r) => r.concept === concept && r.periodEnd === end && r.accession === accn);

  it("one row per concept, period end and accession: six rows from the fixture", () => {
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => `${r.concept}|${r.periodEnd}|${r.accession}`)).size).toBe(6);
  });

  it("keeps the first filing and the restatement as two rows (a restatement is a new accession)", () => {
    expect(find("Revenues", "2025-12-31", FIRST)).toMatchObject({
      value: "1000",
      form: "10-K",
      fy: 2025,
      fp: "FY",
    });
    expect(find("Revenues", "2025-12-31", RESTATED)).toMatchObject({
      value: "940",
      form: "10-K/A",
    });
  });

  it("the longest duration wins where a period end repeats (fiscal year 1000, not the fourth quarter 260)", () => {
    expect(rows.filter((r) => r.concept === "Revenues" && r.accession === FIRST)).toHaveLength(1);
    // the instant with the same end as a quarter duration does not displace it
    expect(find("Revenues", "2026-03-31", "0001234567-26-000040")!.value).toBe("250");
  });

  it("drops entries without an end date, and keeps the first unit alphabetically", () => {
    expect(rows.some((r) => r.accession === "0001234567-26-000099")).toBe(false);
    expect(find("Assets", "2025-12-31", FIRST)).toMatchObject({ unit: "USD", value: "5000" });
  });

  it("drops the taxonomy prefix, normalises the cik and carries the code and market", () => {
    expect(find("EntityCommonStockSharesOutstanding", "2026-02-10", FIRST)).toMatchObject({
      unit: "shares",
      cik: "1234567",
      code: "ZZ1",
      market: "US",
    });
  });

  it("a date-only filing is known at the END of its day (UTC); an acceptance instant replaces it", () => {
    expect(find("Revenues", "2025-12-31", RESTATED)!.filedAt).toBe("2026-04-10T23:59:59.999Z");
    expect(filedInstant("2026-04-10", "2026-04-10T13:05:00Z")).toBe("2026-04-10T13:05:00.000Z");
    const withAcceptance = parse({ [RESTATED]: "2026-04-10T13:05:00Z" });
    expect(
      withAcceptance.find((r) => r.accession === RESTATED && r.concept === "Revenues")!.filedAt,
    ).toBe("2026-04-10T13:05:00.000Z");
  });

  it("is ordered oldest filing first and is deterministic", () => {
    const again = parse();
    expect(again).toEqual(rows);
    const filed = rows.map((r) => r.filedAt);
    expect([...filed].sort()).toEqual(filed);
  });

  it("refuses a JSON with no cik", () => {
    expect(() => parseCompanyFacts({ facts: {} }, { market: "US", code: "ZZ1" })).toThrow(
      RangeError,
    );
  });
});

describe("factAsOf: the AT-38 pair", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
    await allowMarket(db, "US");
    await appendFacts(db, parse());
  });
  afterEach(cleanupTempDbs);

  const read = (at: string) => factAsOf(db, "US", "ZZ1", "Revenues", "2025-12-31", at);

  it("a decision between the two filings reads the first value", async () => {
    const f = await read("2026-03-01T22:00:00Z");
    expect(f).toMatchObject({ value: "1000", accession: FIRST });
  });

  it("a decision after the restatement reads the restated value", async () => {
    const f = await read("2026-04-11T22:00:00Z");
    expect(f).toMatchObject({ value: "940", accession: RESTATED });
  });

  it("a decision before any filing reads nothing", async () => {
    expect(await read("2026-02-01T00:00:00Z")).toBeNull();
    expect(await factAsOf(db, "US", "ZZ1", "NoSuchConcept", "2025-12-31", "2027-01-01")).toBeNull();
  });

  it("on the filing day itself the date-only filing is not yet known (end-of-day rule), the next day it is", async () => {
    expect((await read("2026-04-10T21:30:00Z"))!.value).toBe("1000");
    expect((await read("2026-04-11T00:00:00Z"))!.value).toBe("940");
  });

  it("an acceptance instant makes the filing known from that instant", async () => {
    const db2 = await freshDb("main");
    await allowMarket(db2, "US");
    await appendFacts(db2, parse({ [RESTATED]: "2026-04-10T13:05:00Z" }));
    const at = (t: string) => factAsOf(db2, "US", "ZZ1", "Revenues", "2025-12-31", t);
    expect((await at("2026-04-10T13:04:59Z"))!.value).toBe("1000");
    expect((await at("2026-04-10T13:05:00Z"))!.value).toBe("940");
  });

  it("accepts a Date and refuses an unreadable instant", async () => {
    expect((await read("2026-03-01"))!.value).toBe("1000");
    await expect(factAsOf(db, "US", "ZZ1", "Revenues", "2025-12-31", "not a date")).rejects.toThrow(
      RangeError,
    );
    expect(
      (await factAsOf(db, "US", "ZZ1", "Revenues", "2025-12-31", new Date("2026-05-01T00:00:00Z")))!
        .value,
    ).toBe("940");
  });

  it("append is idempotent and never overwrites: a second run adds no row, an update is refused", async () => {
    const before = Number(
      (await db.execute("SELECT COUNT(*) AS n FROM fundamental_fact")).rows[0]!.n,
    );
    expect(before).toBe(6);
    await appendFacts(db, parse());
    expect(
      Number((await db.execute("SELECT COUNT(*) AS n FROM fundamental_fact")).rows[0]!.n),
    ).toBe(6);
    await expect(db.execute("UPDATE fundamental_fact SET value = '1'")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.execute("DELETE FROM fundamental_fact")).rejects.toThrow(/append-only/);
  });

  it("the database refuses facts of a market that is off (the 0036 guard)", async () => {
    await db.execute("UPDATE market SET enabled = 0 WHERE code = 'US'");
    await expect(appendFacts(db, parse().slice(0, 1))).rejects.toThrow(/MarketNotEnabled/);
  });
});

describe("TST-109: a read ahead of its filing fails", () => {
  const rows = parse();
  const restated = rows.find((r) => r.accession === RESTATED && r.concept === "Revenues")!;
  const first = rows.find((r) => r.accession === FIRST && r.concept === "Revenues")!;

  it("a fact filed after the decision instant is not visible and the check throws", () => {
    expect(factVisible(restated, "2026-03-01T00:00:00Z")).toBe(false);
    expect(factVisible(first, "2026-03-01T00:00:00Z")).toBe(true);
    expect(() => assertFactsKnown([first, restated], "2026-03-01T00:00:00Z")).toThrow(
      FactAheadOfFiling,
    );
    expect(() => assertFactsKnown([first, restated], "2026-03-01T00:00:00Z")).toThrow(/TST-109/);
  });

  it("facts known at the decision pass, including the restatement after its filing", () => {
    expect(() => assertFactsKnown([first], "2026-03-01T00:00:00Z")).not.toThrow();
    expect(() => assertFactsKnown([first, restated], "2026-04-11T00:00:00Z")).not.toThrow();
  });

  it("the as-filed reader never returns a fact the check would refuse, and a naive latest-value read does", async () => {
    const db = await freshDb("main");
    try {
      await allowMarket(db, "US");
      await appendFacts(db, rows);
      const decision = "2026-03-01T22:00:00Z";
      const viaReader = await factAsOf(db, "US", "ZZ1", "Revenues", "2025-12-31", decision);
      expect(() => assertFactsKnown([viaReader!], decision)).not.toThrow();
      // the restated (latest) row, read without the filing-date filter: the look-ahead TST-109 exists to catch
      const naive = rows
        .filter((r) => r.concept === "Revenues" && r.periodEnd === "2025-12-31")
        .at(-1)!;
      expect(() => assertFactsKnown([naive], decision)).toThrow(FactAheadOfFiling);
    } finally {
      cleanupTempDbs();
    }
  });
});
