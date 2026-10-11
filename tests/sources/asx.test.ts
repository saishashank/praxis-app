// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASX_ANNOUNCEMENTS_URL,
  AsxRequestError,
  AsxSourceError,
  buildAnnouncementsRequest,
  handleAnnouncementsResponse,
  isBlockSignal,
  looksLikeChallenge,
  parseAnnouncementList,
  validateUserAgent,
  type AsxResponse,
} from "@/lib/data/sources/asx";
import { syntheticDir } from "@/lib/data/sources/fixtures";

const UA = "praxis-app/0.1 (+https://example.test/contact)";
const env = (n: string): AsxResponse =>
  JSON.parse(fs.readFileSync(path.join(syntheticDir(), n), "utf8"));
const caught = (fn: () => unknown): AsxSourceError => {
  try {
    fn();
  } catch (e) {
    return e as AsxSourceError;
  }
  throw new Error("did not throw");
};

describe("buildAnnouncementsRequest (DAT-122)", () => {
  it("builds a plain GET with an identifying User-Agent and no cookies", () => {
    const r = buildAnnouncementsRequest({ userAgent: UA });
    expect(r.url).toBe(new URL(ASX_ANNOUNCEMENTS_URL).toString());
    expect(r.init.method).toBe("GET");
    expect(r.init.headers["User-Agent"]).toBe(UA);
    expect(Object.keys(r.init.headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(r.init.credentials).toBe("omit");
    expect(r.init.redirect).toBe("manual");
    expect(r.init.cache).toBe("no-store");
    expect(r.init.headers["If-None-Match"]).toBeUndefined();
  });

  it("adds conditional headers when validators are known", () => {
    const r = buildAnnouncementsRequest({
      userAgent: UA,
      etag: '"abc"',
      lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    });
    expect(r.init.headers["If-None-Match"]).toBe('"abc"');
    expect(r.init.headers["If-Modified-Since"]).toBe("Mon, 01 Jan 2024 00:00:00 GMT");
  });

  it("refuses a missing, blank, browser-like or control-char User-Agent", () => {
    for (const ua of ["", "   ", undefined, 5, "Mozilla/5.0 (X11)", "a\r\nb", "x".repeat(201)]) {
      expect(() => validateUserAgent(ua)).toThrow(AsxRequestError);
    }
    expect(validateUserAgent(`  ${UA}  `)).toBe(UA);
  });

  it("accepts a custom https base URL and refuses others", () => {
    expect(
      buildAnnouncementsRequest({ userAgent: UA, baseUrl: "https://example.test/x" }).url,
    ).toBe("https://example.test/x");
    expect(() =>
      buildAnnouncementsRequest({ userAgent: UA, baseUrl: "http://example.test" }),
    ).toThrow(/https/);
    expect(() => buildAnnouncementsRequest({ userAgent: UA, baseUrl: "not a url" })).toThrow(
      /valid URL/,
    );
  });

  it("refuses control characters in validators", () => {
    expect(() => buildAnnouncementsRequest({ userAgent: UA, etag: "a\nb" })).toThrow(
      AsxRequestError,
    );
  });
});

describe("handleAnnouncementsResponse", () => {
  it("parses the synthetic list", () => {
    const r = handleAnnouncementsResponse(env("asx-list-ok.json"));
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(5);
    expect(r.skipped).toBe(0);
    expect(r.etag).toBe('"syn-1"');
    expect(r.lastModified).toBeNull();
    const first = r.items[0];
    expect(first).toMatchObject({
      code: "ZZZ",
      type: "Synthetic Notice",
      priceSensitive: true,
      title: "Synthetic announcement number 0",
      publishedAt: "2020-01-05T23:10:00.000Z",
      pdfUrl: "https://example.test/synthetic/0.pdf",
    });
    expect(first.annId).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(r.items.map((i) => i.annId)).size).toBe(5);
  });

  it("annId is stable across parses", () => {
    const a = handleAnnouncementsResponse(env("asx-list-ok.json"));
    const b = handleAnnouncementsResponse(env("asx-list-ok.json"));
    expect(a).toEqual(b);
  });

  it("skips malformed and duplicate items and counts them", () => {
    const r = handleAnnouncementsResponse(env("asx-list-mixed.json"));
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(2);
    expect(r.skipped).toBe(2);
  });

  it("returns not_modified on 304", () => {
    expect(handleAnnouncementsResponse(env("asx-304.json"))).toEqual({ kind: "not_modified" });
  });

  it("429 is a rate_limited error with Retry-After, not a block signal", () => {
    const e = caught(() => handleAnnouncementsResponse(env("asx-429.json")));
    expect(e).toBeInstanceOf(AsxSourceError);
    expect(e).toMatchObject({ kind: "rate_limited", status: 429, retryAfterS: 120 });
    expect(isBlockSignal(e)).toBe(false);
  });

  it("429 without or with a bad Retry-After gives null and caps large values", () => {
    const base = { status: 429, body: "" };
    expect(caught(() => handleAnnouncementsResponse({ ...base, headers: {} })).retryAfterS).toBe(
      null,
    );
    expect(
      caught(() => handleAnnouncementsResponse({ ...base, headers: { "Retry-After": "soon" } }))
        .retryAfterS,
    ).toBe(null);
    expect(
      caught(() => handleAnnouncementsResponse({ ...base, headers: { "Retry-After": "999999" } }))
        .retryAfterS,
    ).toBe(86_400);
  });

  it("403 is a blocked error and counts as a block signal (asx_block_trip)", () => {
    const e = caught(() => handleAnnouncementsResponse(env("asx-403.json")));
    expect(e).toMatchObject({ kind: "blocked", status: 403 });
    expect(isBlockSignal(e)).toBe(true);
  });

  it("a challenge page served with 200 is detected", () => {
    const r = env("asx-challenge.json");
    expect(looksLikeChallenge(r)).toBe(true);
    const e = caught(() => handleAnnouncementsResponse(r));
    expect(e).toMatchObject({ kind: "challenge", status: 200 });
    expect(isBlockSignal(e)).toBe(true);
  });

  it("an HTML page without challenge markers is not a challenge; JSON is never one", () => {
    expect(
      looksLikeChallenge({ status: 200, headers: {}, body: "<html>plain synthetic</html>" }),
    ).toBe(false);
    expect(
      looksLikeChallenge({
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: '{"title":"captcha"}',
      }),
    ).toBe(false);
  });

  it("other non-2xx statuses are http_error", () => {
    const e = caught(() => handleAnnouncementsResponse({ status: 503, headers: {}, body: "" }));
    expect(e).toMatchObject({ kind: "http_error", status: 503 });
    expect(isBlockSignal(e)).toBe(false);
    expect(isBlockSignal(new Error("x"))).toBe(false);
  });

  it("malformed bodies are typed errors", () => {
    expect(caught(() => handleAnnouncementsResponse(env("asx-list-not-json.json"))).kind).toBe(
      "malformed",
    );
    expect(caught(() => parseAnnouncementList('{"nope":1}')).kind).toBe("malformed");
    expect(caught(() => parseAnnouncementList("null")).kind).toBe("malformed");
  });
});

describe("parseAnnouncementList item rules", () => {
  const item = {
    id: "SYN-1",
    code: "ZZZ",
    time: "2020-01-06T10:00:00Z",
    type: "Synthetic Notice",
    price_sensitive: false,
    title: "  Synthetic title  ",
    url: "https://example.test/a.pdf",
  };
  const parse = (over: Record<string, unknown>) =>
    parseAnnouncementList(JSON.stringify({ data: [{ ...item, ...over }] }));

  it("normalises time to UTC and trims the title", () => {
    const { items } = parse({ time: "2020-01-06T10:00:00+11:00" });
    expect(items[0].publishedAt).toBe("2020-01-05T23:00:00.000Z");
    expect(items[0].title).toBe("Synthetic title");
    expect(parse({ time: "2020-01-06T10:00Z" }).items).toHaveLength(1);
  });

  it.each([
    { code: "zzz" },
    { code: 1 },
    { time: "yesterday" },
    { time: "2020-13-45T10:00:00Z" },
    { time: 5 },
    { title: "   " },
    { title: 5 },
    { type: null },
    { price_sensitive: "yes" },
  ])("skips an item with %j", (over) => {
    const r = parse(over);
    expect(r.items).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("drops non-https or invalid links but keeps the metadata", () => {
    expect(parse({ url: "http://example.test/a.pdf" }).items[0].pdfUrl).toBeNull();
    expect(parse({ url: "not a url" }).items[0].pdfUrl).toBeNull();
    expect(parse({ url: undefined }).items[0].pdfUrl).toBeNull();
  });

  it("tolerates a missing id and skips non-object entries", () => {
    expect(parse({ id: undefined }).items).toHaveLength(1);
    expect(parseAnnouncementList('{"data":[1,null,"x"]}')).toEqual({ items: [], skipped: 3 });
  });
});
