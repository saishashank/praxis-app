// @vitest-environment node
// M20 A3 (D-1093, D-1095, D-1096, DAT-101, DAT-123, AT-70): the polite fetcher. No network: a recorded fetch table.
// It refuses an unregistered host, a market that is not enabled, a source whose register row is not enabled or whose kill
// switch is off, a source that needs the declared contact, a robots-disallowed path; it spaces requests per host and backs
// off on 429 and 5xx.
import { afterEach, describe, expect, it } from "vitest";
import { BlockedHostError } from "@/lib/data/recorded/hostGuard.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import {
  MAX_RETRIES,
  PoliteFetchRefused,
  createPoliteFetch,
  dbGate,
  isPoliteFetchRefused,
  parseRobots,
} from "@/lib/data/sources/politeFetch.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A recorded fetch: url -> replies (the last one repeats). Records every call. */
function recorded(table: Record<string, Reply | Reply[]>) {
  const calls: { url: string; ua: string; method: string }[] = [];
  const idx = new Map<string, number>();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, ua: headers["user-agent"] ?? "", method: init?.method ?? "GET" });
    const entry = table[url];
    if (entry === undefined) return new Response("", { status: 404 });
    const list = Array.isArray(entry) ? entry : [entry];
    const i = Math.min(idx.get(url) ?? 0, list.length - 1);
    idx.set(url, (idx.get(url) ?? 0) + 1);
    const r = list[i];
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const OPEN = (): string => "User-agent: *\nAllow: /\n";
const NSE_HOLIDAYS = "https://www.nseindia.com/api/holiday-master?type=trading";
const open = () => null;

describe("parseRobots", () => {
  it("the longest matching rule wins and Allow wins a tie", () => {
    const r = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /a/b/c\n");
    expect(r.allows("/x")).toBe(true);
    expect(r.allows("/a/z")).toBe(false);
    expect(r.allows("/a/b/z")).toBe(true);
    expect(r.allows("/a/b/c/d")).toBe(false);
    expect(parseRobots("User-agent: *\nDisallow: /p\nAllow: /p\n").allows("/p")).toBe(true);
  });

  it("a group is matched by the whole product token, case-insensitively, and a dollar sign inside a rule is literal", () => {
    const text = "User-agent: Pra\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(parseRobots(text, "praxis").allows("/x")).toBe(true); // "pra" is not "praxis"
    expect(parseRobots("User-agent: PRAXIS\nDisallow: /\n", "praxis").allows("/x")).toBe(false);
    const d = parseRobots("User-agent: *\nDisallow: /a$b\nDisallow: /end$\n");
    expect(d.allows("/a$b")).toBe(false);
    expect(d.allows("/axb")).toBe(true);
    expect(d.allows("/end")).toBe(false);
    expect(d.allows("/endx")).toBe(true);
  });

  it("wildcards, end anchors, empty Disallow and comments", () => {
    const r = parseRobots("# c\nUser-agent: *\nDisallow: /*.json$\nDisallow: /tmp*/x # note\n");
    expect(r.allows("/data.json")).toBe(false);
    expect(r.allows("/data.json?x=1")).toBe(true);
    expect(r.allows("/tmp1/x")).toBe(false);
    expect(parseRobots("User-agent: *\nDisallow:\n").allows("/anything")).toBe(true);
  });

  it("a group naming the agent beats the star group; Crawl-delay is read in milliseconds", () => {
    const text =
      "User-agent: *\nDisallow: /\nCrawl-delay: 5\n\nUser-agent: Praxis\nUser-agent: other\nAllow: /\nCrawl-delay: 2\n";
    const r = parseRobots(text, "praxis");
    expect(r.allows("/x")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
    const star = parseRobots(text, "somebody");
    expect(star.allows("/x")).toBe(false);
    expect(star.crawlDelayMs).toBe(5000);
  });
});

describe("refusals before any request", () => {
  it("an unregistered host, a bad URL and a non-https URL are refused and nothing is requested", async () => {
    const { fetchImpl, calls } = recorded({});
    const c = createPoliteFetch({ fetchImpl, gate: open });
    for (const [u, reason] of [
      ["https://example.com/x", "host_not_registered"],
      ["https://www.asx.com.au/x", "host_not_registered"],
      ["not a url", "bad_url"],
      ["http://www.nseindia.com/x", "bad_url"],
      ["https://user:pw@www.nseindia.com/x", "bad_url"],
    ] as const) {
      await expect(c.fetch(u, { source: "in_nse_holidays" })).rejects.toMatchObject({ reason });
    }
    expect(calls).toHaveLength(0);
  });

  it("a host with several sources needs the source; a source of another host is a mismatch; no gate means no request", async () => {
    const { fetchImpl, calls } = recorded({});
    const c = createPoliteFetch({ fetchImpl, gate: open });
    await expect(c.fetch(NSE_HOLIDAYS)).rejects.toMatchObject({ reason: "source_required" });
    await expect(c.fetch(NSE_HOLIDAYS, { source: "us_edgar" })).rejects.toMatchObject({
      reason: "source_host_mismatch",
    });
    await expect(c.fetch(NSE_HOLIDAYS, { source: "nope" })).rejects.toMatchObject({
      reason: "source_host_mismatch",
    });
    await expect(
      createPoliteFetch({ fetchImpl }).fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" }),
    ).rejects.toMatchObject({ reason: "no_gate" });
    expect(calls).toHaveLength(0);
  });

  it("the refusal is typed, with a fixed message that carries no host or URL", async () => {
    const c = createPoliteFetch({ fetchImpl: recorded({}).fetchImpl, gate: open });
    const err = await c.fetch("https://example.com/secret?k=v").catch((e) => e);
    expect(err).toBeInstanceOf(PoliteFetchRefused);
    expect(isPoliteFetchRefused(err)).toBe(true);
    expect(err.message).toBe("polite fetch refused: host_not_registered");
  });

  it("an injected gate's refusal word is passed through", async () => {
    const { fetchImpl, calls } = recorded({});
    const c = createPoliteFetch({ fetchImpl, gate: () => "source_off" });
    await expect(c.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "source_off",
    });
    expect(calls).toHaveLength(0);
  });

  it("the recorded-day host guard still applies: no request leaves under PRAXIS_ENV=recorded", async () => {
    const { fetchImpl, calls } = recorded({});
    const c = createPoliteFetch({ fetchImpl, gate: open, env: { PRAXIS_ENV: "recorded" } });
    await expect(c.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toBeInstanceOf(
      BlockedHostError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("the register gate (D-1128)", () => {
  it("refuses every IN host while IN is off, then follows the register status and the kill switch", async () => {
    const db = await freshDb("main");
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [NSE_HOLIDAYS]: { body: "{}" },
      "https://nsearchives.nseindia.com/robots.txt": { status: 404 },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, db, now: k.now, sleep: k.sleep });

    // IN is off and no register row exists: market_not_enabled, before anything else.
    await expect(c.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "market_not_enabled",
    });
    expect(calls).toHaveLength(0);

    // Enabled but the register rows are not written yet: not registered (the cached refusal lasts a minute).
    await allowMarket(db, "IN");
    const gate = dbGate(db, { ttlMs: 0 });
    const c2 = createPoliteFetch({ fetchImpl, gate, now: k.now, sleep: k.sleep });
    await expect(c2.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "source_not_registered",
    });

    await ensureMarketSources(db, "IN");
    const ok = await c2.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" }); // enabled row
    expect(ok.status).toBe(200);
    // a pending row is never fetched, an enabled row of a tripped source is not either
    await expect(
      c2.fetch("https://nsearchives.nseindia.com/x.csv", { source: "in_nse_bhavcopy" }),
    ).rejects.toMatchObject({ reason: "source_not_enabled" });
    await db.execute("UPDATE source_status SET mode = 'tripped' WHERE source = 'in_nse_holidays'");
    await expect(c2.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "source_off",
    });
    await db.execute("UPDATE source_status SET mode = 'on' WHERE source = 'in_nse_holidays'");
    await db.execute(
      "UPDATE source_register SET status = 'disabled' WHERE source = 'in_nse_holidays'",
    );
    await expect(c2.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "source_not_enabled",
    });
  });

  it("the gate caches its answer for the TTL", async () => {
    const db = await freshDb("main");
    await allowMarket(db, "IN");
    await ensureMarketSources(db, "IN");
    let t = 0;
    const gate = dbGate(db, { ttlMs: 1000, now: () => t });
    const row = { id: "in_nse_holidays", market: "IN" };
    expect(await gate(row)).toBeNull();
    await db.execute(
      "UPDATE source_register SET status = 'disabled' WHERE source = 'in_nse_holidays'",
    );
    expect(await gate(row)).toBeNull(); // cached
    t = 2000;
    expect(await gate(row)).toBe("source_not_enabled");
  });
});

describe("the declared contact (D-1094)", () => {
  const EDGAR = "https://data.sec.gov/submissions/CIK0000320193.json";
  it("EDGAR is refused without the caller's own User-Agent and goes out with it", async () => {
    const { fetchImpl, calls } = recorded({
      "https://data.sec.gov/robots.txt": { status: 404 },
      [EDGAR]: { body: "{}" },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(EDGAR, { source: "us_edgar" })).rejects.toMatchObject({
      reason: "contact_missing",
    });
    await expect(c.fetch(EDGAR, { source: "us_edgar", userAgent: "  " })).rejects.toMatchObject({
      reason: "contact_missing",
    });
    expect(calls).toHaveLength(0);
    const res = await c.fetch(EDGAR, { source: "us_edgar", userAgent: "Praxis/1.0 (dummy value)" });
    expect(res.status).toBe(200);
    expect(calls.map((x) => x.ua)).toEqual([
      "Praxis/1.0 (dummy value)",
      "Praxis/1.0 (dummy value)",
    ]);
  });

  it("other sources send the declared product User-Agent with no contact", async () => {
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [NSE_HOLIDAYS]: { body: "{}" },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await c.fetch(NSE_HOLIDAYS, { source: "in_nse_holidays" });
    for (const x of calls) {
      expect(x.ua).toBe("Praxis/1.0 (private research; single owner)");
      expect(x.ua).not.toMatch(/@/);
    }
  });
});

describe("robots.txt", () => {
  const PATH = "https://www.nseindia.com/api/holiday-master?type=trading";
  const make = (robots: Reply) => {
    const r = recorded({ "https://www.nseindia.com/robots.txt": robots, [PATH]: { body: "{}" } });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl: r.fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    return { ...r, k, c };
  };

  it("a disallowed path is refused after the one robots read; the page is not requested", async () => {
    const { c, calls } = make({ body: "User-agent: *\nDisallow: /api/\n" });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "robots_disallowed",
    });
    expect(calls.map((x) => x.url)).toEqual(["https://www.nseindia.com/robots.txt"]);
  });

  it("robots.txt is read once per host and the answer is reused", async () => {
    const { c, calls } = make({ body: OPEN() });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(calls.filter((x) => x.url.endsWith("/robots.txt"))).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("a missing robots.txt (404) or an HTML page in its place means no restriction", async () => {
    for (const robots of [{ status: 404 }, { body: "<!DOCTYPE html><html></html>" }]) {
      const { c } = make(robots);
      expect((await c.fetch(PATH, { source: "in_nse_holidays" })).status).toBe(200);
    }
  });

  it("an unreachable robots.txt (5xx) means disallow all", async () => {
    const { c, calls } = make({ status: 503 });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "robots_unavailable",
    });
    expect(calls.some((x) => x.url === PATH)).toBe(false);
  });

  it("a Crawl-delay above the source interval sets the spacing", async () => {
    const { c, k } = make({ body: "User-agent: *\nCrawl-delay: 4\n" });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(k.sleeps).toContain(1500); // the robots read used the row interval
    expect(Math.max(...k.sleeps)).toBeGreaterThanOrEqual(1500);
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(k.sleeps.at(-1)).toBe(4000);
  });
});

describe("redirects (the gate, host table and robots run again)", () => {
  const PATH = "https://www.nseindia.com/api/holiday-master?type=trading";
  const ROBOTS = { "https://www.nseindia.com/robots.txt": { body: OPEN() } };
  it("a 302 to an off-list host is refused and makes no second call", async () => {
    const { fetchImpl, calls } = recorded({
      ...ROBOTS,
      [PATH]: {
        status: 302,
        headers: { location: "https://query1.finance.yahoo.com/v8/finance/chart/X" },
      },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "redirect_off_list",
    });
    expect(calls.map((x) => x.url)).toEqual(["https://www.nseindia.com/robots.txt", PATH]);
    expect(calls.some((x) => x.url.includes("yahoo"))).toBe(false);
  });

  it("a redirect to a registered host is followed through the checks; robots applies to the target", async () => {
    const T = "https://www.nseindia.com/api/other";
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": { body: "User-agent: *\nDisallow: /api/other\n" },
      [PATH]: { status: 302, headers: { location: T } },
      [T]: { body: "x" },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "robots_disallowed",
    });
    expect(calls.some((x) => x.url === T)).toBe(false);
    const ok = recorded({
      ...ROBOTS,
      [PATH]: { status: 301, headers: { location: "/api/next" } },
      "https://www.nseindia.com/api/next": { body: "y" },
    });
    const c2 = createPoliteFetch({
      fetchImpl: ok.fetchImpl,
      gate: open,
      now: k.now,
      sleep: k.sleep,
    });
    expect((await c2.fetch(PATH, { source: "in_nse_holidays" })).status).toBe(200);
  });

  it("a redirect loop stops after three hops", async () => {
    const { fetchImpl, calls } = recorded({
      ...ROBOTS,
      [PATH]: { status: 302, headers: { location: PATH } },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "redirect_off_list",
    });
    expect(calls.filter((x) => x.url === PATH)).toHaveLength(4);
  });

  it("a robots.txt that redirects off the host table is refused", async () => {
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": {
        status: 302,
        headers: { location: "https://example.com/robots.txt" },
      },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toMatchObject({
      reason: "redirect_off_list",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("pacing and backoff", () => {
  const PATH = "https://www.nseindia.com/api/holiday-master?type=trading";

  it("requests to one host are spaced by the source interval", async () => {
    const { fetchImpl } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [PATH]: { body: "{}" },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(k.sleeps).toEqual([1500, 1500, 1500]);
  });

  it("a 429 is retried with the backoff and the later answer returned", async () => {
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [PATH]: [{ status: 429 }, { status: 503 }, { status: 200, body: "{}" }],
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    const res = await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(res.status).toBe(200);
    expect(calls.filter((x) => x.url === PATH)).toHaveLength(3);
    // the waits after the two failures: 2 s, then 4 s (the interval waits of 1.5 s sit between requests)
    expect(k.sleeps.filter((ms) => ms === 2000 || ms === 4000)).toEqual([2000, 4000]);
  });

  it("Retry-After is honoured and capped at 60 seconds", async () => {
    const { fetchImpl } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [PATH]: [
        { status: 429, headers: { "retry-after": "7" } },
        { status: 429, headers: { "retry-after": "999" } },
        { status: 200, body: "{}" },
      ],
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(k.sleeps).toContain(7000);
    expect(k.sleeps).toContain(60_000);
  });

  it("after four retries the last answer is returned, not thrown", async () => {
    const { fetchImpl, calls } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [PATH]: { status: 500 },
    });
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    const res = await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(res.status).toBe(500);
    expect(calls.filter((x) => x.url === PATH)).toHaveLength(MAX_RETRIES + 1);
  });

  it("a network error is retried, then thrown", async () => {
    let n = 0;
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith("/robots.txt")) return new Response(OPEN());
      n += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const k = clock();
    const c = createPoliteFetch({ fetchImpl, gate: open, now: k.now, sleep: k.sleep });
    await expect(c.fetch(PATH, { source: "in_nse_holidays" })).rejects.toThrow(TypeError);
    expect(n).toBe(MAX_RETRIES + 1);
  });

  it("the log hook gets host and status only", async () => {
    const seen: unknown[] = [];
    const { fetchImpl } = recorded({
      "https://www.nseindia.com/robots.txt": { body: OPEN() },
      [PATH]: { body: "{}" },
    });
    const k = clock();
    const c = createPoliteFetch({
      fetchImpl,
      gate: open,
      now: k.now,
      sleep: k.sleep,
      log: (e) => seen.push(e),
    });
    await c.fetch(PATH, { source: "in_nse_holidays" });
    expect(seen).toEqual([
      { host: "www.nseindia.com", status: 200 },
      { host: "www.nseindia.com", status: 200 },
    ]);
  });
});
