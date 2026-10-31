// M17 WP1: delayed quote fetcher (design "Quote source"). One request per code to the chart
// endpoint of the host already used for end-of-day bars; fetch, clock and sleep are injected.
// HARD RULE (D-398): nothing is requested unless `yahoo_delayed` is accepted (register 'enabled',
// source mode 'on', dispatch on). Any gate error refuses (fail-closed).
// Concurrency 4, 250 ms spacing per worker, 20 s per-call budget (D-400). 429/5xx/network error ->
// `paused` set, the run ends and remaining codes keep no quote.
import { requestsAllowed } from "./budget";
import { isRejected, parseChartMeta } from "./parse";
import type { DelayedQuote, QuoteBudget, QuoteRefusal, QuoteSourceState } from "./types";

export const QUOTE_CONCURRENCY = 4; // threshold-ok: fetch concurrency, D-400
export const QUOTE_SPACING_MS = 250; // threshold-ok: per-worker spacing, D-400
export const QUOTE_CALL_BUDGET_MS = 20_000; // threshold-ok: per-call time budget, D-400
export const QUOTE_USER_AGENT = "Mozilla/5.0 (compatible; praxis-quotes/1.0)";
/** [VERIFY at build] same chart endpoint as scripts/fixtures/record-day.mjs. */
export const QUOTE_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const SERVER_ERROR_MIN = 500; // threshold-ok: HTTP status class
const TOO_MANY = 429; // threshold-ok: HTTP status

export type QuoteFetchDeps = {
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Reads `source_register`, `source_status` and `dispatch_enabled` through the existing API. */
  sourceState: () => Promise<QuoteSourceState>;
};

export type QuotePause = false | "rate_limited" | "server_error" | "network";

export type QuoteFetchResult = {
  quotes: DelayedQuote[];
  requests: number;
  rejected: number;
  paused: QuotePause;
  /** Codes not fetched (budget, time or pause), in input order. */
  unfetched: string[];
  /** Set when nothing was requested because the source is not accepted/on. */
  refused: QuoteRefusal | null;
  /** True when codes were left unfetched for budget or time reasons. */
  cut: boolean;
};

/** `degraded` counts as off for this high-risk source (stricter than EOD on purpose). */
export function refusalFor(s: QuoteSourceState): QuoteRefusal | null {
  if (s.register !== "enabled") return "source_not_accepted";
  if (s.mode !== "on") return "source_off";
  if (!s.dispatchEnabled) return "dispatch_off";
  return null;
}

/**
 * Input order is priority order: callers pass armed picks first, then the watch list, then held
 * codes (scan: tier 1 before tier 2). Codes cut by budget, time or a pause are in `unfetched`.
 */
export async function fetchDelayedQuotes(
  deps: QuoteFetchDeps,
  codes: readonly string[],
  budget: QuoteBudget,
): Promise<QuoteFetchResult> {
  const out: QuoteFetchResult = {
    quotes: [],
    requests: 0,
    rejected: 0,
    paused: false,
    unfetched: [],
    refused: null,
    cut: false,
  };
  try {
    out.refused = refusalFor(await deps.sourceState());
  } catch {
    out.refused = "gate_error";
  }
  if (out.refused !== null) return out;

  const allowed = requestsAllowed(budget);
  const queue = [...new Set(codes)];
  const deadline = deps.now().getTime() + QUOTE_CALL_BUDGET_MS;
  let next = 0;

  const worker = async (): Promise<void> => {
    let first = true;
    for (;;) {
      if (out.paused || next >= queue.length) return;
      if (out.requests >= allowed || deps.now().getTime() >= deadline) {
        out.cut = true;
        return;
      }
      if (!first) {
        await deps.sleep(QUOTE_SPACING_MS);
        if (out.paused || next >= queue.length) return;
        if (out.requests >= allowed || deps.now().getTime() >= deadline) {
          out.cut = true;
          return;
        }
      }
      first = false;
      const code = queue[next++];
      out.requests += 1; // counted when issued, before the response
      const url = `${QUOTE_CHART_URL}${encodeURIComponent(`${code}.AX`)}?interval=1m&range=1d`;
      let res;
      try {
        res = await deps.fetch(url, {
          headers: { "User-Agent": QUOTE_USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.timeout(Math.max(1, deadline - deps.now().getTime())),
        });
      } catch {
        out.paused ||= "network"; // includes the 20 s abort
        return;
      }
      if (res.status === TOO_MANY || res.status >= SERVER_ERROR_MIN) {
        out.paused ||= res.status === TOO_MANY ? "rate_limited" : "server_error";
        return;
      }
      if (!res.ok) {
        out.rejected += 1;
        continue;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        out.rejected += 1;
        continue;
      }
      const parsed = parseChartMeta(body, code, deps.now());
      if (isRejected(parsed)) out.rejected += 1;
      else out.quotes.push(parsed);
    }
  };

  await Promise.all(Array.from({ length: QUOTE_CONCURRENCY }, worker));
  out.unfetched = queue.slice(next);
  if (next < queue.length) out.cut = true;
  return out;
}
