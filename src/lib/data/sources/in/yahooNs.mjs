// Yahoo Finance daily bars for NSE codes (M20 IN1; DAT-243 a, D-1132, D-1141): the `.NS` suffix on the chart endpoint, in
// INR. NOT the India price source: the endpoint's robots.txt disallows automated clients and the polite client respects
// it, so a request made through it is refused (`robots_disallowed`) and nothing is sent; the register row stays
// `pending` under the O-26 basis. The symbol builder is kept so a future robots-permitted route needs no other change.
// Every request goes through `createPoliteFetch`; there is no other way to reach the host from this module.
export const SOURCE = "in_yahoo_ns";
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const CODE_RE = /^[A-Z0-9&-]{1,20}$/;

/** The Yahoo symbol of an NSE code, from the profile's `yahoo_suffix` (".NS"). @param {string} code @param {string} suffix */
export function yahooNsSymbol(code, suffix) {
  if (!CODE_RE.test(code)) throw new RangeError("not an NSE code");
  if (!/^\.[A-Z]{1,3}$/.test(suffix)) throw new RangeError("not a Yahoo suffix");
  return `${code}${suffix}`;
}

/**
 * One chart request, through the polite client. Refusals surface as `PoliteFetchRefused` (the caller counts them).
 * @param {{ fetch: (url: string, init: any) => Promise<Response> }} client
 * @param {string} code @param {string} suffix @param {{ range?: string }} [o]
 */
export async function fetchYahooNs(client, code, suffix, o = {}) {
  const symbol = yahooNsSymbol(code, suffix);
  const url = `${CHART}${encodeURIComponent(symbol)}?range=${o.range ?? "1d"}&interval=1d`;
  return client.fetch(url, { source: SOURCE, method: "GET" });
}
