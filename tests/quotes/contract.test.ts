import { describe, expect, it } from "vitest";
import {
  QUOTE_REQUESTS_PER_DAY,
  budgetBand,
  quoteRequestsToday,
  requestsAllowed,
} from "@/lib/data/quotes/budget";
import {
  QUOTE_CALL_BUDGET_MS,
  QUOTE_CHART_URL,
  QUOTE_CONCURRENCY,
  QUOTE_SPACING_MS,
  type QuoteFetchDeps,
  fetchDelayedQuotes,
} from "@/lib/data/quotes/fetch";
import { syntheticChart, syntheticSession, zzCode } from "@/lib/data/quotes/fixture";
import { isFresh, isRejected, isUsableForHit, parseChartMeta } from "@/lib/data/quotes/parse";
import type { QuoteBudget, QuoteSourceState } from "@/lib/data/quotes/types";

const NOW = new Date("2026-11-02T01:30:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const OK: QuoteSourceState = { register: "enabled", mode: "on", dispatchEnabled: true };
const BUDGET: QuoteBudget = { perRunMax: 150, dayMax: QUOTE_REQUESTS_PER_DAY, usedToday: 0 };

describe("parseChartMeta (synthetic ZZ payloads)", () => {
  const good = { price: 12.34, timeS: NOW_S - 60, volume: 250_000, prevClose: 12.0 };

  it("reads price, time, cumulative volume and previous close into micro", () => {
    const q = parseChartMeta(syntheticChart(good), "ZZ01", NOW);
    expect(isRejected(q)).toBe(false);
    if (isRejected(q)) return;
    expect(q.lastMicro).toBe(12_340_000n);
    expect(q.prevCloseMicro).toBe(12_000_000n);
    expect(q.cumVolume).toBe(250_000);
    expect(q.quoteAt).toBe(new Date((NOW_S - 60) * 1000).toISOString());
    expect(q.halted).toBeNull();
  });

  it.each([
    ["price", { ...good, price: null }, "no_price"],
    ["time", { ...good, timeS: null }, "no_time"],
    ["previous close", { ...good, prevClose: null }, "no_prev_close"],
    ["non-positive price", { ...good, price: 0 }, "no_price"],
    ["future time", { ...good, timeS: NOW_S + 3600 }, "future_time"],
  ])("rejects a response missing %s", (_n, meta, reason) => {
    expect(parseChartMeta(syntheticChart(meta), "ZZ01", NOW)).toEqual({ reject: reason });
  });

  it("rejects bad shapes and bad codes", () => {
    expect(parseChartMeta(null, "ZZ01", NOW)).toEqual({ reject: "bad_shape" });
    expect(parseChartMeta({ chart: { result: [] } }, "ZZ01", NOW)).toEqual({ reject: "no_result" });
    expect(parseChartMeta(syntheticChart(good), "../x", NOW)).toEqual({ reject: "bad_code" });
  });

  it("missing or zero volume gives a quote with null volume, unusable for hits", () => {
    for (const volume of [null, 0]) {
      const q = parseChartMeta(syntheticChart({ ...good, volume }), "ZZ01", NOW);
      if (isRejected(q)) throw new Error("expected a quote");
      expect(q.cumVolume).toBeNull();
      expect(isFresh(q, NOW, 10)).toBe(true);
      expect(isUsableForHit(q, NOW, 10)).toBe(false);
    }
  });

  it("a stale quote is never usable for a hit", () => {
    const q = parseChartMeta(syntheticChart({ ...good, timeS: NOW_S - 30 * 60 }), "ZZ01", NOW);
    if (isRejected(q)) throw new Error("expected a quote");
    expect(isFresh(q, NOW, 10)).toBe(false);
    expect(isUsableForHit(q, NOW, 10)).toBe(false);
    const fresh = parseChartMeta(syntheticChart(good), "ZZ01", NOW);
    if (isRejected(fresh)) throw new Error("expected a quote");
    expect(isUsableForHit(fresh, NOW, 10)).toBe(true);
  });
});

describe("budget", () => {
  it("allows the lower of the run cap and the day's remainder", () => {
    expect(requestsAllowed(BUDGET)).toBe(150);
    expect(requestsAllowed({ ...BUDGET, usedToday: 1900 })).toBe(100);
    expect(requestsAllowed({ ...BUDGET, usedToday: 2500 })).toBe(0);
  });

  it("bands: ok below 80 %, narrow from 80 %, stop from 95 %", () => {
    expect(budgetBand({ dayMax: 2000, usedToday: 1599 })).toBe("ok");
    expect(budgetBand({ dayMax: 2000, usedToday: 1600 })).toBe("narrow");
    expect(budgetBand({ dayMax: 2000, usedToday: 1900 })).toBe("stop");
  });

  it("sums quote_run.requests", async () => {
    const db = { execute: async () => ({ rows: [{ n: 42 }] }) } as never;
    expect(await quoteRequestsToday(db, "AU", "2026-11-02")).toBe(42);
  });
});

function harness(over: Partial<QuoteFetchDeps> = {}, byCode?: Map<string, unknown>) {
  let t = NOW.getTime();
  const urls: string[] = [];
  const sleeps: number[] = [];
  const deps: QuoteFetchDeps = {
    now: () => new Date(t),
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sourceState: async () => OK,
    fetch: async (url) => {
      urls.push(url);
      // Any host or path other than the accepted chart endpoint is a test failure.
      if (!url.startsWith(QUOTE_CHART_URL)) throw new Error(`unexpected URL ${url}`);
      const code = decodeURIComponent(url.slice(QUOTE_CHART_URL.length).split("?")[0]).replace(
        ".AX",
        "",
      );
      const body =
        byCode?.get(code) ??
        syntheticChart({ price: 10, timeS: t / 1000 - 30, volume: 1000, prevClose: 9.5 });
      return { ok: true, status: 200, json: async () => body };
    },
    ...over,
  };
  return { deps, urls, sleeps };
}

describe("fetchDelayedQuotes", () => {
  const codes = (n: number) => Array.from({ length: n }, (_, i) => zzCode(i));

  it("fetches one request per code from the chart endpoint only", async () => {
    const { deps, urls } = harness();
    const r = await fetchDelayedQuotes(deps, codes(10), BUDGET);
    expect(r.refused).toBeNull();
    expect(r.requests).toBe(10);
    expect(r.quotes).toHaveLength(10);
    expect(r.paused).toBe(false);
    expect(urls).toHaveLength(10);
    expect(urls.every((u) => u.startsWith(QUOTE_CHART_URL) && u.includes(".AX?"))).toBe(true);
  });

  it("never exceeds concurrency 4 and spaces each worker by 250 ms", async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps, sleeps } = harness();
    const inner = deps.fetch;
    deps.fetch = async (u, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      const r = await inner(u, i);
      inFlight -= 1;
      return r;
    };
    const r = await fetchDelayedQuotes(deps, codes(20), BUDGET);
    expect(r.requests).toBe(20);
    expect(peak).toBeLessThanOrEqual(QUOTE_CONCURRENCY);
    expect(sleeps).toHaveLength(20 - QUOTE_CONCURRENCY);
    expect(sleeps.every((s) => s === QUOTE_SPACING_MS)).toBe(true);
  });

  it("stops starting requests after the 20 s call budget", async () => {
    const { deps } = harness();
    const r = await fetchDelayedQuotes(deps, codes(100), { ...BUDGET, perRunMax: 1000 });
    expect(r.cut).toBe(true);
    expect(r.requests).toBeLessThan(100);
    expect(r.requests).toBeLessThanOrEqual(
      QUOTE_CALL_BUDGET_MS / QUOTE_SPACING_MS + QUOTE_CONCURRENCY,
    );
  });

  it("stops at the run cap and at the day's remainder", async () => {
    const a = await fetchDelayedQuotes(harness().deps, codes(30), { ...BUDGET, perRunMax: 7 });
    expect(a.requests).toBe(7);
    expect(a.cut).toBe(true);
    const b = await fetchDelayedQuotes(harness().deps, codes(30), { ...BUDGET, usedToday: 1995 });
    expect(b.requests).toBe(5);
    const c = await fetchDelayedQuotes(harness().deps, codes(30), { ...BUDGET, usedToday: 2000 });
    expect(c.requests).toBe(0);
  });

  it.each([
    ["not accepted (pending)", { ...OK, register: "pending" }, "source_not_accepted"],
    ["no register row", { ...OK, register: null }, "source_not_accepted"],
    ["disabled", { ...OK, register: "disabled" }, "source_not_accepted"],
    ["source off", { ...OK, mode: "off" }, "source_off"],
    ["tripped", { ...OK, mode: "tripped" }, "source_off"],
    ["dispatch off", { ...OK, dispatchEnabled: false }, "dispatch_off"],
  ] as const)("refuses without any request when %s", async (_n, state, refused) => {
    const { deps, urls } = harness({ sourceState: async () => state });
    deps.fetch = async (u) => {
      throw new Error(`must not be called: ${u}`);
    };
    const r = await fetchDelayedQuotes(deps, codes(5), BUDGET);
    expect(r).toMatchObject({ refused, requests: 0, quotes: [] });
    expect(urls).toHaveLength(0);
  });

  it("refuses when the status read fails (fail-closed)", async () => {
    const { deps } = harness({
      sourceState: async () => {
        throw new Error("db down");
      },
    });
    deps.fetch = async () => {
      throw new Error("must not be called");
    };
    const r = await fetchDelayedQuotes(deps, codes(3), BUDGET);
    expect(r).toMatchObject({ refused: "gate_error", requests: 0 });
  });

  it.each([429, 500, 503])("status %i pauses the run", async (status) => {
    const { deps } = harness();
    deps.fetch = async () => ({ ok: false, status, json: async () => ({}) });
    const r = await fetchDelayedQuotes(deps, codes(20), BUDGET);
    expect(r.paused).toBe(true);
    expect(r.quotes).toEqual([]);
    expect(r.requests).toBeLessThanOrEqual(QUOTE_CONCURRENCY);
  });

  it("a network error pauses; a 404 or bad payload is counted rejected", async () => {
    const net = harness();
    net.deps.fetch = async () => {
      throw new Error("network");
    };
    expect((await fetchDelayedQuotes(net.deps, codes(8), BUDGET)).paused).toBe(true);

    const bad = new Map<string, unknown>([
      ["ZZ00", syntheticChart({ price: 10, timeS: NOW_S - 30, volume: 5, prevClose: null })],
      ["ZZ01", { nope: true }],
    ]);
    const h = harness({}, bad);
    const r = await fetchDelayedQuotes(h.deps, codes(4), BUDGET);
    expect(r.rejected).toBe(2);
    expect(r.quotes.map((q) => q.code).sort()).toEqual(["ZZ02", "ZZ03"]);
    expect(r.paused).toBe(false);
  });

  it("serves a synthetic session and contacts no unexpected host", async () => {
    const session = syntheticSession(codes(3), NOW_S - 600, 3);
    const first = new Map([...session].map(([c, s]) => [c, s[2]]));
    const h = harness({}, first);
    const r = await fetchDelayedQuotes(h.deps, codes(3), BUDGET);
    expect(r.quotes).toHaveLength(3);
    expect(
      h.urls.every((u) => u.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")),
    ).toBe(true);
  });
});
