// The delayed-quote source of the CI recorded day (M18 OPS-107 / D-965, PLT-077). On the recorded day no
// request leaves the machine, so the quote chart endpoint is answered IN PROCESS with a synthetic chart
// (src/lib/data/quotes/fixture.ts, SEC-110: invented ZZ-style values, never a real capture). Installed by
// src/instrumentation.ts only when PRAXIS_ENV=recorded, in front of the host guard; every other URL goes to
// the wrapped fetch, which is the guard (a non-loopback host is refused there and counted).
import { syntheticChart } from "./fixture";

const DELAY_S = 15 * 60; // threshold-ok: the delayed-quote age the synthetic chart reports

/** Deterministic price from the symbol, so a re-run reads the same quote. */
export function syntheticPrice(symbol: string): number {
  let sum = 0;
  for (const ch of symbol) sum += ch.charCodeAt(0);
  return 10 + (sum % 90) / 10; // threshold-ok: 10.0 .. 18.9
}

export function recordedQuoteFetch(
  inner: typeof fetch,
  chartUrl: string,
  nowMs: () => number = () => Date.now(),
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (!url.startsWith(chartUrl)) return inner(input, init);
    const symbol = decodeURIComponent(url.slice(chartUrl.length).split("?")[0] ?? "");
    const price = syntheticPrice(symbol);
    return Response.json(
      syntheticChart({
        price,
        timeS: Math.floor(nowMs() / 1000) - DELAY_S,
        volume: 1000, // threshold-ok: synthetic volume
        prevClose: Math.round((price - 0.1) * 100) / 100,
        symbol,
      }),
    );
  }) as typeof fetch;
}
