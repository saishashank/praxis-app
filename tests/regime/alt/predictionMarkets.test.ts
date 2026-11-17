// @vitest-environment node
// M22 E5 (DAT-248, D-1439): the two parsers over fixture payloads, and the fetcher that requests nothing unless the register row
// is accepted. The network is a stub; no test reaches a real host.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  fetchPredictionMarkets,
  parseKalshi,
  parsePolymarket,
  ppmOf,
} from "@/lib/data/sources/predictionMarkets.mjs";
import { cleanupTempDbs } from "../../db/helpers";
import { D, NOW, accept, world } from "./harness";

afterEach(cleanupTempDbs);

describe("parsers", () => {
  it("polymarket: the first outcome price, from a JSON text or a list", () => {
    expect(parsePolymarket({ outcomePrices: '["0.62","0.38"]' })).toBe(620_000);
    expect(parsePolymarket({ outcomePrices: ["0.5", "0.5"] })).toBe(500_000);
    for (const bad of [
      null,
      {},
      { outcomePrices: "nope" },
      { outcomePrices: ["2"] },
      { outcomePrices: [] },
      { outcomePrices: ["x"] },
    ])
      expect(parsePolymarket(bad)).toBeNull();
  });
  it("kalshi: the last price in cents, else the middle of the quote", () => {
    expect(parseKalshi({ market: { last_price: 37 } })).toBe(370_000);
    expect(parseKalshi({ market: { last_price: 0, yes_bid: 40, yes_ask: 44 } })).toBe(420_000);
    for (const bad of [
      null,
      {},
      { market: { last_price: 101 } },
      { market: { yes_bid: 50, yes_ask: 40 } },
    ])
      expect(parseKalshi(bad)).toBeNull();
  });
  it("ppmOf is strict", () => {
    expect(ppmOf("0.123456")).toBe(123_456);
    expect(ppmOf(NaN)).toBeNull();
    expect(ppmOf(-0.1)).toBeNull();
  });
});

describe("fetchPredictionMarkets", () => {
  const events = [
    { registerId: "polymarket_public", eventKey: "recession", url: "https://example.invalid/p" },
    { registerId: "kalshi_public", eventKey: "rates", url: "https://example.invalid/k" },
  ];
  const mk = (bodies: Record<string, unknown>) => {
    const calls: string[] = [];
    return {
      calls,
      fetch: async (url: string) => {
        calls.push(url);
        return { ok: true, text: async () => JSON.stringify(bodies[url]) };
      },
    };
  };

  it("requests nothing and stores nothing while both rows are pending (or absent)", async () => {
    const db = await world();
    const net = mk({});
    const r = await fetchPredictionMarkets(db, {
      fetch: net.fetch,
      now: () => new Date(NOW),
      d: D,
      events,
    });
    expect(r).toEqual({ status: "not_enabled", stored: 0, skipped: 0 });
    expect(net.calls).toEqual([]);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM alt_input_point")).rows[0]!.n)).toBe(0);
  });

  it("fetches only the accepted source, stores one point once, and a repeat adds nothing", async () => {
    const db = await world();
    await accept(db, "kalshi_public");
    const net = mk({ "https://example.invalid/k": { market: { last_price: 25 } } });
    const deps = { fetch: net.fetch, now: () => new Date(NOW), d: D, events };
    expect(await fetchPredictionMarkets(db, deps)).toEqual({
      status: "done",
      stored: 1,
      skipped: 0,
    });
    expect(net.calls).toEqual(["https://example.invalid/k"]);
    expect(await fetchPredictionMarkets(db, deps)).toEqual({
      status: "done",
      stored: 0,
      skipped: 0,
    });
    const row = (await db.execute("SELECT source, event_key, d, prob_ppm FROM alt_input_point"))
      .rows[0]!;
    expect(row).toMatchObject({ source: "kalshi", event_key: "rates", d: D, prob_ppm: 250_000 });
  });

  it("skips a malformed event, a non-https address, an unreadable body and a failing request", async () => {
    const db = await world();
    await accept(db, "polymarket_public");
    const fetcher = async (url: string) => {
      if (url.endsWith("/boom")) throw new Error("network");
      return { ok: true, text: async () => "not json" };
    };
    const r = await fetchPredictionMarkets(db, {
      fetch: fetcher,
      now: () => new Date(NOW),
      d: D,
      events: [
        { registerId: "polymarket_public", eventKey: "bad key!", url: "https://example.invalid/a" },
        { registerId: "polymarket_public", eventKey: "http", url: "http://example.invalid/a" },
        { registerId: "nope", eventKey: "x", url: "https://example.invalid/a" },
        { registerId: "polymarket_public", eventKey: "text", url: "https://example.invalid/a" },
        { registerId: "polymarket_public", eventKey: "boom", url: "https://example.invalid/boom" },
      ],
    });
    expect(r).toEqual({ status: "done", stored: 0, skipped: 5 });
  });

  it("holds no address of its own", () => {
    const src = readFileSync("src/lib/data/sources/predictionMarkets.mjs", "utf8");
    expect(src).not.toMatch(/https?:\/\/[a-z0-9]/i);
  });
});
