// M18 OPS-107 / D-965: the quote chart endpoint is answered in process on the recorded day.
import { describe, expect, it } from "vitest";
import { QUOTE_CHART_URL } from "@/lib/data/quotes/fetch";
import { parseChartMeta } from "@/lib/data/quotes/parse";
import { recordedQuoteFetch, syntheticPrice } from "@/lib/data/quotes/recordedFetch";

describe("recordedQuoteFetch", () => {
  it("answers the chart endpoint with a synthetic chart that the real parser accepts, without calling the inner fetch", async () => {
    let inner = 0;
    const f = recordedQuoteFetch(
      (async () => {
        inner += 1;
        return new Response("no");
      }) as typeof fetch,
      QUOTE_CHART_URL,
      () => Date.parse("2026-11-12T00:32:00Z"),
    );
    const res = await f(`${QUOTE_CHART_URL}ZZA.AX?interval=1m&range=1d`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(inner).toBe(0);
    const meta = parseChartMeta(json, "ZZA", new Date("2026-11-12T00:32:00Z"));
    expect(meta).not.toHaveProperty("reject");
    expect(JSON.stringify(json)).toContain("ZZA.AX");
  });

  it("is deterministic per symbol and in a plausible range", () => {
    expect(syntheticPrice("ZZA.AX")).toBe(syntheticPrice("ZZA.AX"));
    for (const s of ["A", "BHP.AX", "ZZB.AX", "X".repeat(40)]) {
      const p = syntheticPrice(s);
      expect(p).toBeGreaterThanOrEqual(10);
      expect(p).toBeLessThan(19);
    }
  });

  it("passes every other URL to the wrapped fetch (the host guard), untouched", async () => {
    const seen: string[] = [];
    const f = recordedQuoteFetch(
      (async (u: RequestInfo | URL) => {
        seen.push(String(u));
        return new Response("inner");
      }) as typeof fetch,
      QUOTE_CHART_URL,
    );
    expect(await (await f("https://example.com/a")).text()).toBe("inner");
    expect(await (await f(new URL("http://127.0.0.1:3100/api/health"))).text()).toBe("inner");
    expect(seen).toEqual(["https://example.com/a", "http://127.0.0.1:3100/api/health"]);
  });
});
