// Public prediction-market odds (DAT-248, M22 E5, D-1439): one probability per source, event and day for the shadow regime
// reading. Two parsers over fixture-shaped payloads and one fetcher. The fetcher does nothing unless the source's register row
// is `enabled` (both rows are `pending` until the Owner accepts the terms, so production never requests anything). No host is
// written in this file: the Owner supplies each event's address when a row is accepted, and a call that names none is refused.
// Derived numbers only (a probability in parts per million), never a page or a comment. Append-only, insert-or-ignore.
const SOURCE_OF = Object.freeze({ polymarket_public: "polymarket", kalshi_public: "kalshi" });
const EVENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PPM = 1_000_000;
const MAX_BODY_CHARS = 200_000;
const MAX_EVENTS = 20;
const REQUEST_TIMEOUT_MS = 10_000;

/** A probability between 0 and 1 as parts per million; null when it is not one. */
export function ppmOf(p) {
  const x = typeof p === "string" ? Number(p) : p;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > 1) return null;
  return Math.round(x * PPM);
}

/**
 * A Polymarket market payload: `outcomePrices` is a JSON text (or list) of prices, the first being "Yes".
 * @returns {number | null} parts per million
 */
export function parsePolymarket(payload) {
  if (payload === null || typeof payload !== "object") return null;
  let prices = payload.outcomePrices;
  if (typeof prices === "string") {
    try {
      prices = JSON.parse(prices);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(prices) || prices.length < 1) return null;
  return ppmOf(prices[0]);
}

/**
 * A Kalshi market payload: `last_price` in whole cents (0..100), else the middle of `yes_bid` and `yes_ask` in cents.
 * @returns {number | null} parts per million
 */
export function parseKalshi(payload) {
  const m = payload !== null && typeof payload === "object" ? (payload.market ?? payload) : null;
  if (m === null || typeof m !== "object") return null;
  const cents = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
  const last = cents(m.last_price);
  if (last !== null && last > 0) return ppmOf(last / 100);
  const bid = cents(m.yes_bid);
  const ask = cents(m.yes_ask);
  if (bid !== null && ask !== null && ask >= bid) return ppmOf((bid + ask) / 200);
  return null;
}

const PARSERS = Object.freeze({ polymarket: parsePolymarket, kalshi: parseKalshi });

/** True when the source's register row exists and is `enabled`. A failed read is false (fails closed). */
export async function sourceEnabled(db, registerId) {
  try {
    // rows-ok: source_register primary key probe
    const r = await db.execute({
      sql: "SELECT status FROM source_register WHERE source = ?",
      args: [registerId],
    });
    return r.rows.length === 1 && String(r.rows[0].status) === "enabled";
  } catch {
    return false;
  }
}

/**
 * Fetches and stores today's probabilities of the named events.
 * @param {{ execute: Function }} db
 * @param {{ fetch: Function, now: () => Date, d: string, events: Array<{ registerId: string, eventKey: string, url: string }> }} deps
 * @returns {Promise<{ status: 'not_enabled' | 'done', stored: number, skipped: number }>}
 */
export async function fetchPredictionMarkets(db, deps) {
  if (!DAY_RE.test(deps.d)) throw new RangeError("d must be YYYY-MM-DD");
  const stored = { stored: 0, skipped: 0 };
  const events = (deps.events ?? []).slice(0, MAX_EVENTS);
  let attempted = 0;
  for (const e of events) {
    const source = Object.hasOwn(SOURCE_OF, e.registerId) ? SOURCE_OF[e.registerId] : undefined;
    if (
      source === undefined ||
      !EVENT_RE.test(e.eventKey) ||
      typeof e.url !== "string" ||
      !e.url.startsWith("https://")
    ) {
      stored.skipped += 1;
      continue;
    }
    if (!(await sourceEnabled(db, e.registerId))) continue; // the register decides, per source, before any request
    attempted += 1;
    let ppm = null;
    try {
      const res = await deps.fetch(e.url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const text = await res.text();
        if (text.length <= MAX_BODY_CHARS) ppm = PARSERS[source](JSON.parse(text));
      }
    } catch {
      ppm = null;
    }
    if (ppm === null) {
      stored.skipped += 1;
      continue;
    }
    // rows-ok: one insert on the primary key (source, event_key, d); a repeat is ignored
    const w = await db.execute({
      sql: `INSERT INTO alt_input_point (source, event_key, d, prob_ppm, fetched_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      args: [source, e.eventKey, deps.d, ppm, deps.now().toISOString()],
    });
    if (w.rowsAffected > 0) stored.stored += 1;
  }
  return { status: attempted === 0 ? "not_enabled" : "done", ...stored };
}
