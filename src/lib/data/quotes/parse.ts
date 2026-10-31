// M17 WP1: parser for the per-code chart `meta` (design "Quote source"). Fail-closed:
//  - price, time or previous close missing/invalid -> the quote is rejected (counted "rejected");
//  - cumulative volume missing, zero or invalid -> cumVolume null: no quote usable for hits (D-382);
//  - a stale quote is never a hit or a price clear (`isUsableForHit`, `isFresh`).
// Field names are [VERIFY at build]: result[0].meta.{regularMarketPrice, regularMarketTime (epoch s),
// regularMarketVolume (cumulative), chartPreviousClose | previousClose}.
import { type Micro, toMicroFromVendor } from "../../money/micro";
import type { DelayedQuote, QuoteReject } from "./types";

const CODE_RE = /^[A-Z0-9]{2,6}$/;
const MS_PER_S = 1000; // threshold-ok: unit conversion
const MS_PER_MIN = 60_000; // threshold-ok: unit conversion
/** A quote time further ahead of the clock than this is a bad payload. */
const FUTURE_SKEW_MS = 5 * MS_PER_MIN; // threshold-ok: clock-skew tolerance, D-400

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const positiveMicro = (v: unknown): Micro | null => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  try {
    const m = toMicroFromVendor(v);
    return m > 0n ? m : null;
  } catch {
    return null;
  }
};

export function parseChartMeta(json: unknown, code: string, now: Date): DelayedQuote | QuoteReject {
  if (!CODE_RE.test(code)) return { reject: "bad_code" };
  if (!isRecord(json) || !isRecord(json.chart)) return { reject: "bad_shape" };
  const result = json.chart.result;
  if (!Array.isArray(result) || result.length === 0 || !isRecord(result[0])) {
    return { reject: "no_result" };
  }
  const meta = result[0].meta;
  if (!isRecord(meta)) return { reject: "no_meta" };

  const last = positiveMicro(meta.regularMarketPrice);
  if (last === null) return { reject: "no_price" };

  const t = meta.regularMarketTime;
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return { reject: "no_time" };
  const quoteMs = t * MS_PER_S;
  if (quoteMs > now.getTime() + FUTURE_SKEW_MS) return { reject: "future_time" };

  const prev = positiveMicro(meta.chartPreviousClose ?? meta.previousClose);
  if (prev === null) return { reject: "no_prev_close" };

  const v = meta.regularMarketVolume;
  const cumVolume = typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;

  return {
    code,
    lastMicro: last,
    quoteAt: new Date(quoteMs).toISOString(),
    prevCloseMicro: prev,
    cumVolume,
    halted: null,
    fetchedAt: now.toISOString(),
  };
}

export const isRejected = (r: DelayedQuote | QuoteReject): r is QuoteReject => "reject" in r;

/** Age of the quote in minutes at `now` (never negative). */
export function quoteAgeMin(q: Pick<DelayedQuote, "quoteAt">, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(q.quoteAt)) / MS_PER_MIN);
}

/** Fresh = not older than `maxAgeMin` (callers pass 2 x `intraday_refresh_min`). */
export function isFresh(q: Pick<DelayedQuote, "quoteAt">, now: Date, maxAgeMin: number): boolean {
  const t = Date.parse(q.quoteAt);
  return Number.isFinite(t) && quoteAgeMin(q, now) <= maxAgeMin;
}

/** A quote may drive a hit or a price clear only if fresh and carrying cumulative volume. */
export function isUsableForHit(q: DelayedQuote, now: Date, maxAgeMin: number): boolean {
  return q.cumVolume !== null && isFresh(q, now, maxAgeMin);
}
