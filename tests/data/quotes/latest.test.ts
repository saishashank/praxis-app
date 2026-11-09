// @vitest-environment node
// D-900 (O-80): the newest delayed quote per code, a display cache for the site's live price.
import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import {
  newerThanClose,
  quoteTimeMelbourne,
  readLatestQuotes,
  storeLatestQuotes,
  storeLatestQuotesSoft,
  type LatestQuote,
} from "@/lib/data/quotes/latest";
import type { DelayedQuote } from "@/lib/data/quotes/types";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../../db/helpers";

let db: Client;
beforeEach(async () => {
  db = track(createClient({ url: tempDbUrl() }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
});
afterEach(cleanupTempDbs);

const q = (code: string, last: bigint, quoteAt: string): DelayedQuote => ({
  code,
  lastMicro: last,
  quoteAt,
  prevCloseMicro: 10_000_000n,
  cumVolume: 1000,
  halted: null,
  fetchedAt: quoteAt,
});

describe("storeLatestQuotes / readLatestQuotes", () => {
  it("stores one row per code and reads it back with the Sydney exchange date", async () => {
    await storeLatestQuotes(db, "AU", [
      q("AAA", 10_500_000n, "2026-11-09T00:35:00.000Z"),
      q("BBB", 2_000_000n, "2026-11-09T00:40:00.000Z"),
    ]);
    const m = await readLatestQuotes(db, "AU", ["AAA", "BBB", "CCC"]);
    expect([...m.keys()].sort()).toEqual(["AAA", "BBB"]);
    expect(m.get("AAA")).toEqual({
      code: "AAA",
      lastMicro: 10_500_000n,
      prevCloseMicro: 10_000_000n,
      quoteAt: "2026-11-09T00:35:00.000Z",
      quoteD: "2026-11-09",
    });
  });

  it("a later quote replaces the row; an earlier or equal one never moves it back", async () => {
    await storeLatestQuotes(db, "AU", [q("AAA", 10_500_000n, "2026-11-09T01:00:00.000Z")]);
    await storeLatestQuotes(db, "AU", [q("AAA", 9_000_000n, "2026-11-09T00:30:00.000Z")]);
    await storeLatestQuotes(db, "AU", [q("AAA", 9_500_000n, "2026-11-09T01:00:00.000Z")]);
    expect((await readLatestQuotes(db, "AU", ["AAA"])).get("AAA")!.lastMicro).toBe(10_500_000n);
    await storeLatestQuotes(db, "AU", [q("AAA", 11_000_000n, "2026-11-09T01:30:00.000Z")]);
    expect((await readLatestQuotes(db, "AU", ["AAA"])).get("AAA")!.lastMicro).toBe(11_000_000n);
  });

  it("markets are separate; an empty code list reads nothing", async () => {
    await storeLatestQuotes(db, "AU", [q("AAA", 10_500_000n, "2026-11-09T00:35:00.000Z")]);
    expect((await readLatestQuotes(db, "US", ["AAA"])).size).toBe(0);
    expect((await readLatestQuotes(db, "AU", [])).size).toBe(0);
  });

  it("a null previous close is kept as null", async () => {
    await storeLatestQuotes(db, "AU", [
      { ...q("AAA", 10_500_000n, "2026-11-09T00:35:00.000Z"), prevCloseMicro: null },
    ]);
    expect((await readLatestQuotes(db, "AU", ["AAA"])).get("AAA")!.prevCloseMicro).toBeNull();
  });

  it("the soft writer never throws: a failing database gives false", async () => {
    const broken = {
      execute: async () => {
        throw new Error("down");
      },
    };
    expect(
      await storeLatestQuotesSoft(broken, "AU", [q("AAA", 1n, "2026-11-09T00:35:00.000Z")]),
    ).toBe(false);
    expect(await storeLatestQuotesSoft(db, "AU", [q("AAA", 1n, "2026-11-09T00:35:00.000Z")])).toBe(
      true,
    );
  });
});

describe("newerThanClose and the time label", () => {
  const lq = (quoteD: string): LatestQuote => ({
    code: "AAA",
    lastMicro: 1n,
    prevCloseMicro: null,
    quoteAt: `${quoteD}T00:35:00.000Z`,
    quoteD,
  });
  it("shows the quote only when it is from a later day than the stored close", () => {
    expect(newerThanClose(lq("2026-11-09"), "2026-11-06")).not.toBeNull();
    expect(newerThanClose(lq("2026-11-09"), "2026-11-09")).toBeNull();
    expect(newerThanClose(lq("2026-11-06"), "2026-11-09")).toBeNull();
    expect(newerThanClose(undefined, "2026-11-09")).toBeNull();
    expect(newerThanClose(lq("2026-11-09"), null)).not.toBeNull();
  });
  it("labels the quote in Melbourne time (AEDT, UTC+11)", () => {
    expect(quoteTimeMelbourne("2026-11-09T00:35:00.000Z")).toBe("11:35");
  });
});
