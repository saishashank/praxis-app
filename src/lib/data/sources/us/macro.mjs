// FRED macro series (M20 US1; DAT-243, D-1094, D-1189). FRED needs the Owner's free API key (the Owner-store name
// FRED_API_KEY, a name only in code): without it the client throws `FredKeyMissing` and makes no request, like the EDGAR
// client without its contact. The market must be enabled first (the write guard's own check), only the FRED host is
// asked, through the polite client (register row `us_fred`, `pending` until the Owner accepts it). The key travels
// only in the request query the polite client sends; it is never logged and never returned.
//
// STORAGE IS NOT BUILT HERE: `macro_series.source` is constrained to ('rba','abs') by migration 0033, so a FRED row
// cannot be stored until a migration widens that CHECK. This module fetches and parses the observations (`{ d,
// valueMicro }`, a "." gap skipped) and stops there; the hand-off to the orchestrator is in D-1189.
import { assertMarketEnabled } from "../../../market/guard.mjs";
import { createPoliteFetch } from "../politeFetch.mjs";

export const FRED_SOURCE = "us_fred";
export const FRED_KEY_ENV = "FRED_API_KEY";
export const FRED_HOST = "api.stlouisfed.org";

export class FredKeyMissing extends Error {
  constructor() {
    super("FredKeyMissing");
    this.name = "FredKeyMissing";
  }
}

/** @param {Record<string, string | undefined>} env */
export function fredKey(env) {
  const k = env[FRED_KEY_ENV];
  if (typeof k !== "string" || k.trim() === "") throw new FredKeyMissing();
  return k.trim();
}

/** Decimal text -> micro as bigint, or null for a gap (".") or garbage. @param {unknown} v */
function microOf(v) {
  const m = /^\s*(-?)(\d+)(?:\.(\d{1,12}))?\s*$/.exec(String(v));
  if (!m) return null;
  const n = BigInt(m[2]) * 1_000_000n + BigInt((m[3] ?? "").padEnd(6, "0").slice(0, 6));
  return m[1] === "-" ? -n : n;
}

/** @param {any} json @returns {{ d: string, valueMicro: bigint }[]} */
export function parseFredObservations(json) {
  const obs = Array.isArray(json?.observations) ? json.observations : [];
  const out = [];
  for (const o of obs) {
    const v = microOf(o?.value);
    if (typeof o?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || v === null) continue;
    out.push({ d: o.date, valueMicro: v });
  }
  return out;
}

/**
 * @param {{ db: { execute: Function }, market: string, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *           gate?: Function, sleep?: (ms: number) => Promise<void>, now?: () => number, siteOf?: Function, sourceOf?: Function }} o
 */
export function createFredClient(o) {
  const env = o.env ?? process.env;
  const polite = createPoliteFetch({
    db: o.db,
    gate: o.gate,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    now: o.now,
    siteOf: o.siteOf,
    sourceOf: o.sourceOf,
  });
  return {
    /** @param {string} seriesId @param {string} [start] YYYY-MM-DD */
    async observations(seriesId, start) {
      await assertMarketEnabled(o.db, o.market);
      const key = fredKey(env);
      if (!/^[A-Za-z0-9_]{1,32}$/.test(seriesId)) throw new RangeError("bad series id");
      const q = new URLSearchParams({ series_id: seriesId, api_key: key, file_type: "json" });
      if (start !== undefined) q.set("observation_start", start);
      const res = await polite.fetch(
        `https://${FRED_HOST}/fred/series/observations?${q.toString()}`,
        { source: FRED_SOURCE },
      );
      if (res.status < 200 || res.status >= 300) throw new Error(`FredHttpError ${res.status}`);
      return parseFredObservations(JSON.parse(await res.text()));
    },
  };
}
