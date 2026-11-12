// @vitest-environment node
// M20 US1 (D-1094, D-1142, AT-70, AT-38): the EDGAR client. It refuses without the declared contact, refuses while the
// market is off BEFORE reading the contact or making a request, asks only the SEC hosts, and a call with a dummy contact
// under the recorded-day host guard is refused before anything leaves the machine. No network: a recorded fetch table.
import { afterEach, describe, expect, it } from "vitest";
import { BlockedHostError } from "@/lib/data/recorded/hostGuard.mjs";
import { ensureMarketSources } from "@/lib/data/sources/marketSources.mjs";
import {
  EDGAR_CONTACT_ENV,
  EdgarContactMissing,
  EdgarHostRefused,
  createEdgarClient,
  edgarUserAgent,
  filingIndexUrl,
  submissionsUrl,
  companyFactsUrl,
} from "@/lib/data/sources/us/edgar.mjs";
import { isMarketNotEnabled } from "@/lib/market/guard.mjs";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);

const URL_SUBS = submissionsUrl(9990001);
const DUMMY = "fixture-contact-not-a-real-value";

function recorded(table: Record<string, { status?: number; body?: string }>) {
  const calls: { url: string; ua: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, ua: h["user-agent"] ?? "" });
    const r = table[url];
    return r === undefined
      ? new Response("", { status: 404 })
      : new Response(r.body ?? "", { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const clock = () => {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};
const ROBOTS = "User-agent: *\nAllow: /\n";

async function enabledDb() {
  const db = await freshDb("main");
  await allowMarket(db, "US");
  await db.execute({ sql: "UPDATE market SET mode = 'data_only' WHERE code = 'US'" });
  await ensureMarketSources(db, "US");
  return db;
}

describe("edgarUserAgent", () => {
  it("is Praxis/<version> (<contact>) and throws the fixed word without the contact", () => {
    expect(edgarUserAgent({ [EDGAR_CONTACT_ENV]: DUMMY }, "7")).toBe(`Praxis/7 (${DUMMY})`);
    expect(() => edgarUserAgent({})).toThrow(EdgarContactMissing);
    expect(() => edgarUserAgent({ [EDGAR_CONTACT_ENV]: "   " })).toThrow("EdgarContactMissing");
  });

  it("the error carries no value", () => {
    try {
      edgarUserAgent({ [EDGAR_CONTACT_ENV]: "" });
    } catch (e) {
      expect(String(e)).toBe("EdgarContactMissing: EdgarContactMissing");
    }
  });
});

describe("the client", () => {
  it("without the contact: EdgarContactMissing and NO request", async () => {
    const db = await enabledDb();
    const { fetchImpl, calls } = recorded({});
    const c = createEdgarClient({ db, market: "US", env: {}, fetchImpl, ...clock() });
    await expect(c.getJson(URL_SUBS)).rejects.toBeInstanceOf(EdgarContactMissing);
    expect(calls).toEqual([]);
  });

  it("with the contact it sends the declared User-Agent and returns the JSON", async () => {
    const db = await enabledDb();
    const { fetchImpl, calls } = recorded({
      "https://data.sec.gov/robots.txt": { body: ROBOTS },
      [URL_SUBS]: { body: '{"cik":9990001,"sic":"7372"}' },
    });
    const c = createEdgarClient({
      db,
      market: "US",
      env: { [EDGAR_CONTACT_ENV]: DUMMY },
      version: "9",
      fetchImpl,
      ...clock(),
    });
    expect(await c.getJson(URL_SUBS)).toEqual({ cik: 9990001, sic: "7372" });
    const req = calls.find((x) => x.url === URL_SUBS)!;
    expect(req.ua).toBe(`Praxis/9 (${DUMMY})`);
  });

  it("asks only the SEC hosts (EdgarHostRefused, no request)", async () => {
    const db = await enabledDb();
    const { fetchImpl, calls } = recorded({});
    const c = createEdgarClient({
      db,
      market: "US",
      env: { [EDGAR_CONTACT_ENV]: DUMMY },
      fetchImpl,
      ...clock(),
    });
    await expect(c.getText("https://example.com/x")).rejects.toBeInstanceOf(EdgarHostRefused);
    await expect(c.getText("not a url")).rejects.toBeInstanceOf(EdgarHostRefused);
    expect(calls).toEqual([]);
  });

  it("a non-2xx answer is an EdgarHttpError with the status only", async () => {
    const db = await enabledDb();
    const { fetchImpl } = recorded({
      "https://data.sec.gov/robots.txt": { body: ROBOTS },
      [URL_SUBS]: { status: 403, body: "blocked" },
    });
    const c = createEdgarClient({
      db,
      market: "US",
      env: { [EDGAR_CONTACT_ENV]: DUMMY },
      fetchImpl,
      ...clock(),
    });
    await expect(c.getJson(URL_SUBS)).rejects.toMatchObject({
      name: "EdgarHttpError",
      status: 403,
    });
  });

  it("a market that is off refuses first: MarketNotEnabled, the contact is never read, no request", async () => {
    const db = await freshDb("main"); // the production seed: the US is off
    const { fetchImpl, calls } = recorded({});
    const env = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error("the contact must not be read while the market is off");
      },
    });
    const c = createEdgarClient({ db, market: "US", env, fetchImpl, ...clock() });
    await expect(c.getJson(URL_SUBS)).rejects.toSatisfy(isMarketNotEnabled);
    expect(calls).toEqual([]);
  });

  it("under the recorded-day host guard a call with a dummy contact is refused before it leaves (BlockedHostError)", async () => {
    const db = await enabledDb();
    const before = process.env.PRAXIS_ENV;
    process.env.PRAXIS_ENV = "recorded";
    try {
      // the real fetch is replaced by the guard's installed one in the app; here the polite client's own guard fires
      const c = createEdgarClient({
        db,
        market: "US",
        env: { [EDGAR_CONTACT_ENV]: DUMMY },
        ...clock(),
      });
      await expect(c.getJson(URL_SUBS)).rejects.toBeInstanceOf(BlockedHostError);
    } finally {
      if (before === undefined) delete process.env.PRAXIS_ENV;
      else process.env.PRAXIS_ENV = before;
    }
  });
});

describe("urls", () => {
  it("pads the CIK to ten digits and builds the filing index link", () => {
    expect(submissionsUrl("9990001")).toBe("https://data.sec.gov/submissions/CIK0009990001.json");
    expect(companyFactsUrl(9990001)).toBe(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0009990001.json",
    );
    expect(filingIndexUrl("0009990001", "0009990000-26-000010")).toBe(
      "https://www.sec.gov/Archives/edgar/data/9990001/000999000026000010/0009990000-26-000010-index.htm",
    );
  });
});
