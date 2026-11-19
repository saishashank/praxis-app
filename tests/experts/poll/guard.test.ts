// @vitest-environment node
// The fetch guard (M22 E2; KB-082, D-1478): own origin only, no private address, in-origin redirects only, bounded body.
// Pure: a fake fetch, no network.
import { describe, expect, it } from "vitest";
import {
  FetchRefused,
  guardedFetch,
  isPrivateAddress,
  isPrivateHost,
  originOf,
  type Refusal,
} from "@/lib/experts/poll/guard";
import { noSleep, recordingFetch, type Reply } from "./helpers";

const A = "https://zz1.example.test";

describe("isPrivateAddress and isPrivateHost", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "not-an-address",
  ])("%s is refused", (a) => expect(isPrivateAddress(a)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"])(
    "%s is public",
    (a) => expect(isPrivateAddress(a)).toBe(false),
  );

  it.each([
    "localhost",
    "app.localhost",
    "printer.local",
    "db.internal",
    "intranet",
    "127.0.0.1",
    "[::1]",
    "10.0.0.5",
    "",
  ])("host %s is refused", (h) => expect(isPrivateHost(h)).toBe(true));

  it.each(["www.youtube.com", "zz1.example.test", "93.184.216.34"])("host %s is allowed", (h) =>
    expect(isPrivateHost(h)).toBe(false),
  );

  it("the URL parser's own normalisation of numeric hosts is caught", () => {
    for (const u of ["https://2130706433/", "https://0x7f.1/", "https://017700000001/"]) {
      expect(isPrivateHost(new URL(u).hostname)).toBe(true);
    }
  });
});

describe("originOf", () => {
  it("https only", () => {
    expect(originOf("https://zz1.example.test/x?y=1")).toBe(A);
    expect(originOf("http://zz1.example.test/")).toBeNull();
    expect(originOf("nope")).toBeNull();
  });
});

function guard(
  table: Record<string, Reply>,
  over: { resolve?: (h: string) => Promise<string[]> } = {},
) {
  const f = recordingFetch(table);
  const refused: Refusal[] = [];
  const fetch = guardedFetch({
    fetch: f.fetch,
    origins: new Set([A]),
    sleep: noSleep,
    onRefused: (r) => refused.push(r),
    ...over,
  });
  return { fetch, asked: f.asked, refused };
}
const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FetchRefused);
    return (e as FetchRefused).reason;
  }
  return "none";
};

describe("guardedFetch", () => {
  it("reads its own origin with manual redirects and the headers it was given", async () => {
    const g = guard({ [`${A}/home`]: { status: 200, text: "ok", etag: "e1" } });
    const r = await g.fetch(`${A}/home`, { headers: { "user-agent": "t" } });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
    expect(r.headers.get("etag")).toBe("e1");
    expect(g.asked).toEqual([
      { url: `${A}/home`, headers: { "user-agent": "t" }, redirect: "manual" },
    ]);
  });

  it("refuses another host, plain http, credentials in the URL and an unlisted origin of the same site", async () => {
    const g = guard({});
    expect(await reason(g.fetch("https://other.example.test/x", { headers: {} }))).toBe(
      "off_origin",
    );
    expect(await reason(g.fetch("https://www.zz1.example.test/x", { headers: {} }))).toBe(
      "off_origin",
    );
    expect(await reason(g.fetch("http://zz1.example.test/x", { headers: {} }))).toBe("not_https");
    const withCredentials = new URL("https://zz1.example.test/x");
    withCredentials.username = "u";
    expect(await reason(g.fetch(withCredentials.href, { headers: {} }))).toBe("off_origin");
    expect(g.asked).toEqual([]);
    expect(g.refused).toEqual(["off_origin", "off_origin", "not_https", "off_origin"]);
  });

  it("refuses a registered origin that is itself a private address", async () => {
    const f = recordingFetch({});
    const fetch = guardedFetch({
      fetch: f.fetch,
      origins: new Set(["https://127.0.0.1"]),
      sleep: noSleep,
    });
    expect(await reason(fetch("https://127.0.0.1/feed", { headers: {} }))).toBe("private_address");
    expect(f.asked).toEqual([]);
  });

  it("refuses a host whose DNS answer is a private address, before any request", async () => {
    const g = guard({}, { resolve: async () => ["93.184.216.34", "10.0.0.7"] });
    expect(await reason(g.fetch(`${A}/home`, { headers: {} }))).toBe("private_address");
    expect(g.asked).toEqual([]);
  });

  it("accepts a host whose DNS answers are public, and treats a failed lookup as no answer", async () => {
    const ok = guard(
      { [`${A}/home`]: { status: 200 } },
      { resolve: async () => ["93.184.216.34"] },
    );
    expect((await ok.fetch(`${A}/home`, { headers: {} })).status).toBe(200);
    const fail = guard(
      { [`${A}/home`]: { status: 200 } },
      { resolve: async () => Promise.reject(new Error("dns")) },
    );
    expect((await fail.fetch(`${A}/home`, { headers: {} })).status).toBe(200);
  });

  it("follows a redirect inside the origin, at most three hops", async () => {
    const g = guard({
      [`${A}/a`]: { status: 301, location: "/b" },
      [`${A}/b`]: { status: 302, location: `${A}/c` },
      [`${A}/c`]: { status: 200, text: "end" },
    });
    expect(await (await g.fetch(`${A}/a`, { headers: {} })).text()).toBe("end");
    expect(g.asked.map((x) => x.url)).toEqual([`${A}/a`, `${A}/b`, `${A}/c`]);
    expect(g.asked.every((x) => x.redirect === "manual")).toBe(true);

    const loop = guard({
      [`${A}/1`]: { status: 302, location: "/2" },
      [`${A}/2`]: { status: 302, location: "/3" },
      [`${A}/3`]: { status: 302, location: "/4" },
      [`${A}/4`]: { status: 302, location: "/5" },
      [`${A}/5`]: { status: 200 },
    });
    expect(await reason(loop.fetch(`${A}/1`, { headers: {} }))).toBe("too_many_redirects");
  });

  it("refuses a redirect to another host, a private address, plain http or no location, and never requests the target", async () => {
    for (const location of [
      "https://evil.example.test/x",
      "https://127.0.0.1/x",
      "https://169.254.169.254/latest/meta-data",
      "http://zz1.example.test/x",
      "//evil.example.test/x",
    ]) {
      const g = guard({ [`${A}/a`]: { status: 302, location } });
      expect(await reason(g.fetch(`${A}/a`, { headers: {} }))).toBe("redirect_off_origin");
      expect(g.asked.map((x) => x.url)).toEqual([`${A}/a`]);
    }
    const none = guard({ [`${A}/a`]: { status: 302 } });
    expect(await reason(none.fetch(`${A}/a`, { headers: {} }))).toBe("redirect_off_origin");
  });

  it("a 304 is returned as it is (conditional request), not treated as a redirect", async () => {
    const g = guard({ [`${A}/home`]: { status: 304 } });
    expect((await g.fetch(`${A}/home`, { headers: { "if-none-match": "e1" } })).status).toBe(304);
  });

  it("cuts a very large body", async () => {
    const g = guard({ [`${A}/home`]: { status: 200, text: "x".repeat(2_000_000) } });
    const r = await g.fetch(`${A}/home`, { headers: {} });
    expect((await r.text()).length).toBe(1_000_000);
  });

  it("waits between two requests to one host", async () => {
    const waits: number[] = [];
    const f = recordingFetch({
      [`${A}/robots.txt`]: { status: 200 },
      [`${A}/home`]: { status: 200 },
    });
    const fetch = guardedFetch({
      fetch: f.fetch,
      origins: new Set([A]),
      sleep: async (ms) => void waits.push(ms),
    });
    await fetch(`${A}/robots.txt`, { headers: {} });
    await fetch(`${A}/home`, { headers: {} });
    expect(waits).toEqual([1000]);
  });
});
