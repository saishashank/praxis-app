// @vitest-environment node
// M20 IN1 (DAT-243 a, D-1132, D-1093): the Yahoo .NS route exists only behind the polite client. With the register row
// `pending` (never enabled) the gate refuses and no request leaves; the symbol builder rejects anything but an NSE code.
import { describe, expect, it, vi } from "vitest";
import { createPoliteFetch, isPoliteFetchRefused } from "@/lib/data/sources/politeFetch.mjs";
import { fetchYahooNs, yahooNsSymbol } from "@/lib/data/sources/in/yahooNs.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

describe("yahooNs", () => {
  it("builds the .NS symbol from the profile suffix and refuses a bad code or suffix", () => {
    const suffix = staticProfile("IN").yahooSuffix as string;
    expect(suffix).toBe(".NS");
    expect(yahooNsSymbol("RELIANCE", suffix)).toBe("RELIANCE.NS");
    expect(yahooNsSymbol("M&M", suffix)).toBe("M&M.NS");
    expect(() => yahooNsSymbol("../x", suffix)).toThrow(RangeError);
    expect(() => yahooNsSymbol("TCS", "NS")).toThrow(RangeError);
  });

  it("through the polite client with the row not enabled: refused, nothing is sent", async () => {
    const fetchImpl = vi.fn();
    const client = createPoliteFetch({
      gate: () => "source_not_enabled",
      fetchImpl: fetchImpl as never,
    });
    let err: unknown;
    try {
      await fetchYahooNs(client, "TCS", ".NS");
    } catch (e) {
      err = e;
    }
    expect(isPoliteFetchRefused(err)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
