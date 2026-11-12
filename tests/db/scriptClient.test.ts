// @vitest-environment node
// M20 A2 (D-1123; closes D-1020, D-1086; AT-68 a): the script client. A script write for a market that is not enabled
// surfaces as the typed MarketNotEnabled with ONE S2 incident; AU writes pass; nothing about the URL or token leaks.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REFUSAL_KIND,
  marketRefusalReporter,
  resetMarketRefusalReports,
  scriptDb,
} from "@/lib/db/scriptClient.mjs";
import { MarketNotEnabled } from "@/lib/market/errors.mjs";
import { cleanupTempDbs, freshDb, tempDbUrl, track } from "./helpers";
import { createClient } from "@libsql/client";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { MIGRATIONS } from "./helpers";

afterEach(cleanupTempDbs);
beforeEach(resetMarketRefusalReports);

const bar = (market: string, code = "AAA") =>
  `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
   VALUES ('${market}', '${code}', '2026-11-11', 1, 1, 1, 1, 1, 't', 't', 't')`;

async function migratedUrl(): Promise<string> {
  const url = tempDbUrl();
  const c = createClient({ url });
  await migrateUp(c, await loadMigrations(MIGRATIONS("main")));
  c.close();
  return url;
}

const incidents = async (url: string) => {
  const c = track(createClient({ url }));
  const r = await c.execute("SELECT severity, kind, detail_json, resolved_at FROM incident");
  return r.rows.map((x) => ({ ...x }));
};

describe("scriptDb", () => {
  it("a refused write throws the typed MarketNotEnabled and opens one S2 incident", async () => {
    const url = await migratedUrl();
    const db = track(scriptDb({ url }));
    const err = await db.execute(bar("IN")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketNotEnabled);
    expect((err as MarketNotEnabled).market).toBe("IN");
    const rows = await incidents(url);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "S2", kind: REFUSAL_KIND, resolved_at: null });
    expect(JSON.parse(String(rows[0]!.detail_json))).toEqual({ market: "IN", table: "price_bar" });
  });

  it("a second refusal the same day, for the same or another market, opens no second incident", async () => {
    const url = await migratedUrl();
    const db = track(scriptDb({ url }));
    await expect(db.execute(bar("IN"))).rejects.toBeInstanceOf(MarketNotEnabled);
    await expect(db.execute(bar("IN", "BBB"))).rejects.toBeInstanceOf(MarketNotEnabled);
    await expect(db.execute(bar("US"))).rejects.toBeInstanceOf(MarketNotEnabled);
    expect(await incidents(url)).toHaveLength(1); // one open incident per kind
  });

  it("a batch with one refused statement is refused as a whole and stores nothing", async () => {
    const url = await migratedUrl();
    const db = track(scriptDb({ url }));
    await expect(db.batch([bar("AU", "OK"), bar("US", "BAD")], "write")).rejects.toBeInstanceOf(
      MarketNotEnabled,
    );
    const n = await db.execute("SELECT COUNT(*) n FROM price_bar");
    expect(Number(n.rows[0]!.n)).toBe(0);
  });

  it("an AU write passes and opens no incident", async () => {
    const url = await migratedUrl();
    const db = track(scriptDb({ url }));
    await db.execute(bar("AU"));
    expect(await incidents(url)).toHaveLength(0);
  });

  it("intMode bigint is passed through", async () => {
    const url = await migratedUrl();
    const db = track(scriptDb({ url, intMode: "bigint" }));
    const r = await db.execute("SELECT 9007199254740993 AS v");
    expect(r.rows[0]!.v).toBe(9007199254740993n);
  });

  it("an empty URL is refused with a fixed word that carries no value", () => {
    expect(() => scriptDb({ url: undefined })).toThrow("database not configured");
    expect(() => scriptDb({ url: "  " })).toThrow("database not configured");
  });

  it("the reporter never throws, even when the incident table is missing", async () => {
    const raw = track(createClient({ url: tempDbUrl() })); // no schema at all
    const report = marketRefusalReporter(raw, () => new Date("2030-01-02T03:04:05Z"));
    await expect(report({ market: "IN" }, { table: "price_bar" })).resolves.toBeUndefined();
  });

  it("freshDb sanity: the seed enables AU only", async () => {
    const db = await freshDb("main");
    const r = await db.execute("SELECT code FROM market WHERE enabled = 1");
    expect(r.rows.map((x) => String(x.code))).toEqual(["AU"]);
  });
});
