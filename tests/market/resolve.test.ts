// @vitest-environment node
// resolveMarket (M19 A1; MKT-110 c, D-997): the one place a market parameter is accepted. A candidate that is
// not in enabledMarkets(db) is invalid (a page turns it into notFound()); none means the single enabled market,
// or the user's default when several are enabled. AT-68 (c).
import { afterEach, describe, expect, it } from "vitest";
import { resolveMarket, resolveMarketOrNotFound } from "@/lib/market/resolve";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("resolveMarket under the production seed (AU enabled, IN and US built and off)", () => {
  it("a candidate IN or US is invalid; AU and no candidate resolve to AU", async () => {
    const db = await freshDb("main");
    expect(await resolveMarket(db, "IN")).toEqual({ ok: false, error: "invalid" });
    expect(await resolveMarket(db, "US")).toEqual({ ok: false, error: "invalid" });
    expect(await resolveMarket(db, "AU")).toEqual({ ok: true, market: "AU" });
    expect(await resolveMarket(db, undefined)).toEqual({ ok: true, market: "AU" });
    expect(await resolveMarket(db, null)).toEqual({ ok: true, market: "AU" });
    expect(await resolveMarket(db, "")).toEqual({ ok: true, market: "AU" });
  });

  it("refuses anything that is not a market code, a repeated query value and a case variant", async () => {
    const db = await freshDb("main");
    for (const bad of ["au", "A", "AUSTRALIA", "AU;DROP", "AU ", "1", "ZZ", "../AU"]) {
      expect(await resolveMarket(db, bad), bad).toEqual({ ok: false, error: "invalid" });
    }
    expect(await resolveMarket(db, ["AU", "AU"])).toEqual({ ok: false, error: "invalid" });
  });

  it("a user preference for a market that is not enabled changes nothing", async () => {
    const db = await freshDb("main");
    expect(await resolveMarket(db, undefined, { defaultMarket: "IN" })).toEqual({
      ok: true,
      market: "AU",
    });
  });
});

describe("with two markets enabled (development lanes)", () => {
  it("no candidate takes the user's default, else the first; both candidates resolve; the third does not", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 1 WHERE code = 'IN'");
    expect(await resolveMarket(db, undefined, { defaultMarket: "IN" })).toEqual({
      ok: true,
      market: "IN",
    });
    expect(await resolveMarket(db, undefined, { defaultMarket: "US" })).toEqual({
      ok: true,
      market: "AU",
    });
    expect(await resolveMarket(db, undefined, null)).toEqual({ ok: true, market: "AU" });
    expect(await resolveMarket(db, "IN")).toEqual({ ok: true, market: "IN" });
    expect(await resolveMarket(db, "US")).toEqual({ ok: false, error: "invalid" });
  });

  it("no enabled market at all resolves nothing", async () => {
    const db = await freshDb("main");
    await db.execute("UPDATE market SET enabled = 0, mode = 'off' WHERE code = 'AU'");
    expect(await resolveMarket(db, undefined)).toEqual({ ok: false, error: "invalid" });
    expect(await resolveMarket(db, "AU")).toEqual({ ok: false, error: "invalid" });
  });
});

describe("resolveMarketOrNotFound", () => {
  it("returns the code for an enabled market and throws the framework's not-found for any other", async () => {
    const db = await freshDb("main");
    expect(await resolveMarketOrNotFound(db, "AU")).toBe("AU");
    await expect(resolveMarketOrNotFound(db, "IN")).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404"),
    });
  });
});
