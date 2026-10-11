// @vitest-environment node
// Polite ASIC fetcher (M2 T9; DAT-125a, external-source politeness). Fake fetch, no network.
import { describe, expect, it } from "vitest";
import { fetchAsicMonths, validUserAgent } from "@/lib/data/backfill/asicFetch.mjs";
import { ASIC_HOST, ASIC_MIN_GAP_MS } from "@/lib/data/backfill/rules.mjs";
import { asicCsv } from "./helpers";

const UA = "praxis-test-backfill (synthetic)";
const months = [{ month: "2026-09", dates: ["2026-09-29", "2026-09-30"] }];

type Reply = Response | Error;
function harness(replies: (Reply | ((url: string) => Reply))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)];
    const v = typeof r === "function" ? r(url) : r;
    if (v instanceof Error) throw v;
    return v;
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { calls, sleeps, fetchImpl, sleep };
}
const csv = (text = asicCsv(), headers: Record<string, string> = {}) =>
  new Response(text, { status: 200, headers: { "content-type": "text/csv", ...headers } });

describe("user agent", () => {
  it("must identify the client, never imitate a browser", () => {
    expect(validUserAgent(UA)).toBe(UA);
    expect(validUserAgent("  x  ")).toBe("x");
    for (const bad of ["", "   ", "Mozilla/5.0 (X11)", "a\nb", "x".repeat(201), 5, null]) {
      expect(validUserAgent(bad)).toBeNull();
    }
  });

  it("refuses to run without one", async () => {
    const h = harness([csv()]);
    await expect(
      fetchAsicMonths({ months, userAgent: "Mozilla/5.0", fetchImpl: h.fetchImpl, sleep: h.sleep }),
    ).rejects.toThrow();
    expect(h.calls).toHaveLength(0);
  });
});

describe("a normal run", () => {
  it("fetches serially with a gap, a fixed host and no redirects or cookies", async () => {
    const h = harness([csv(), csv()]);
    const r = await fetchAsicMonths({
      months,
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
    });
    expect(r.stopped).toBeNull();
    expect(r.months[0]).toMatchObject({ month: "2026-09", complete: true, absent: 0, skipped: 0 });
    expect(r.months[0].rows).toHaveLength(4); // two codes on two dates
    expect(h.calls).toHaveLength(2);
    for (const c of h.calls) {
      expect(new URL(c.url).hostname).toBe(ASIC_HOST);
      expect(c.init).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      });
      expect((c.init.headers as Record<string, string>)["User-Agent"]).toBe(UA);
    }
    expect(h.sleeps).toEqual([ASIC_MIN_GAP_MS]); // one gap between two requests, none before the first
  });

  it("never goes faster than the minimum gap, even if asked", async () => {
    const h = harness([csv(), csv()]);
    await fetchAsicMonths({
      months,
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
      minGapMs: 1,
    });
    expect(h.sleeps).toEqual([ASIC_MIN_GAP_MS]);
    const slower = harness([csv(), csv()]);
    await fetchAsicMonths({
      months,
      userAgent: UA,
      fetchImpl: slower.fetchImpl,
      sleep: slower.sleep,
      minGapMs: 9000,
    });
    expect(slower.sleeps).toEqual([9000]);
  });

  it("uses the real timer when no sleep is injected (smoke, tiny gap not possible)", async () => {
    const h = harness([csv()]);
    const r = await fetchAsicMonths({
      months: [{ month: "2026-09", dates: ["2026-09-30"] }],
      userAgent: UA,
      fetchImpl: h.fetchImpl,
    });
    expect(r.stopped).toBeNull(); // a single request needs no gap
  });

  it("404 means no file that day; an all-404 month is complete with no rows", async () => {
    const h = harness([() => new Response("", { status: 404 })]);
    const r = await fetchAsicMonths({
      months,
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
    });
    expect(r.stopped).toBeNull();
    expect(r.months[0]).toMatchObject({ complete: true, absent: 2, rows: [] });
  });

  it("walks several months in order and counts skipped rows", async () => {
    const text = asicCsv() + "\r\nBad,bad!,1,1";
    const h = harness([() => csv(text)]);
    const r = await fetchAsicMonths({
      months: [
        { month: "2026-09", dates: ["2026-09-30"] },
        { month: "2026-08", dates: ["2026-08-31"] },
      ],
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
    });
    expect(r.months.map((m) => [m.month, m.complete, m.skipped])).toEqual([
      ["2026-09", true, 1],
      ["2026-08", true, 1],
    ]);
  });
});

describe("stops at the first sign of trouble, without retrying", () => {
  const stop = async (reply: Reply) => {
    const h = harness([csv(), reply, csv()]);
    const r = await fetchAsicMonths({
      months: [{ month: "2026-09", dates: ["2026-09-28", "2026-09-29", "2026-09-30"] }],
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
    });
    return { r, calls: h.calls.length };
  };
  it.each([
    ["rate_limited", new Response("", { status: 429 })],
    ["blocked", new Response("", { status: 403 })],
    ["http_error", new Response("", { status: 500 })],
    [
      "http_error",
      new Response("", { status: 301, headers: { location: "https://elsewhere.invalid/" } }),
    ],
    ["network", new Error("boom")],
    [
      "blocked",
      new Response("<html><title>Just a moment...</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    ],
    ["malformed", new Response("a,b\n1,2", { status: 200 })],
    ["malformed", new Response("x".repeat(8 * 1024 * 1024 + 1), { status: 200 })],
  ] as const)("%s", async (why, reply) => {
    const { r, calls } = await stop(reply as Reply);
    expect(r.stopped).toBe(why);
    expect(calls).toBe(2); // the failing request is the last one
    expect(r.months[0].complete).toBe(false);
  });

  it("a body that cannot be read counts as a network failure", async () => {
    const broken = {
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => {
        throw new Error("reset");
      },
    } as unknown as Response;
    const { r } = await stop(broken);
    expect(r.stopped).toBe("network");
  });

  it("keeps the months finished before the stop", async () => {
    const h = harness([csv(), new Response("", { status: 429 })]);
    const r = await fetchAsicMonths({
      months: [
        { month: "2026-09", dates: ["2026-09-30"] },
        { month: "2026-08", dates: ["2026-08-31"] },
      ],
      userAgent: UA,
      fetchImpl: h.fetchImpl,
      sleep: h.sleep,
    });
    expect(r.stopped).toBe("rate_limited");
    expect(r.months.map((m) => m.complete)).toEqual([true, false]);
  });
});
