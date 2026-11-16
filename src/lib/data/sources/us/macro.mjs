// FRED macro series (M20 US1; DAT-243, D-1094, D-1189). FRED needs the Owner's free API key (the Owner-store name
// FRED_API_KEY, a name only in code): without it the client throws `FredKeyMissing` and makes no request, like the EDGAR
// client without its contact. The market must be enabled first (the write guard's own check), only the FRED host is
// asked, through the polite client (register row `us_fred`, `pending` until the Owner accepts it). The key travels
// only in the request query the polite client sends; it is never logged and never returned.
//
// Storage (migration 0037, D-1147, closing D-1189): the fetch step asks FRED for the series of `FRED_SERIES` and puts
// the observations into the feeds file (`feeds.macro`, values as decimal micro strings: JSON has no bigint); the day
// stage turns them into `macro_series` rows with source `fred` (`feedMacroRows`) and writes them through
// `writeMacroSeries` (src/lib/data/sources/macroStore.mjs; `assertMarketEnabled` first, the 0037 source guard refuses
// `fred` while the US is off). The three series are the US counterparts of the home RBA/ABS set (the policy rate, the
// ten-year yield, the CPI); an id outside the list in a feed is counted as skipped, never stored.
import { assertMarketEnabled } from "../../../market/guard.mjs";
import { createPoliteFetch } from "../politeFetch.mjs";

export const FRED_SOURCE = "us_fred";
export const FRED_KEY_ENV = "FRED_API_KEY";
export const FRED_HOST = "api.stlouisfed.org";
/** The `macro_series.source` word of FRED rows (migration 0037). */
export const MACRO_SOURCE = "fred";
/** The FRED series the US night stores: effective federal funds rate, 10-year constant maturity, CPI-U (SA). */
export const FRED_SERIES = Object.freeze(["FEDFUNDS", "DGS10", "CPIAUCSL"]);
/** How far back the fetch step asks (days before the session): covers a monthly series with a lag. */
export const FRED_BACK_DAYS = 45;
const SERIES_RE = /^[A-Za-z0-9_]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      if (!SERIES_RE.test(seriesId)) throw new RangeError("bad series id");
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

/**
 * The `feeds.macro` entry of one series, as the fetch step writes it (bigint -> decimal micro string, JSON-safe).
 * @param {string} seriesId @param {{ d: string, valueMicro: bigint }[]} observations
 */
export function feedMacroEntry(seriesId, observations) {
  return {
    seriesId,
    observations: observations.map((o) => ({ d: o.d, valueMicro: o.valueMicro.toString() })),
  };
}

/**
 * `feeds.macro` -> `macro_series` rows with source `fred`. A series outside `FRED_SERIES`, a malformed date or a
 * value that is not an integer string is skipped and counted (nothing is invented, DAT-004).
 * @param {unknown} list
 * @returns {{ rows: { source: string, seriesId: string, d: string, valueMicro: bigint }[], skipped: number }}
 */
export function feedMacroRows(list) {
  const rows = [];
  let skipped = 0;
  for (const e of Array.isArray(list) ? list : []) {
    const seriesId = e?.seriesId;
    if (typeof seriesId !== "string" || !FRED_SERIES.includes(seriesId)) {
      skipped += Array.isArray(e?.observations) ? e.observations.length : 1;
      continue;
    }
    for (const o of Array.isArray(e.observations) ? e.observations : []) {
      if (
        typeof o?.d !== "string" ||
        !DATE_RE.test(o.d) ||
        !/^-?\d{1,24}$/.test(String(o?.valueMicro))
      ) {
        skipped += 1;
        continue;
      }
      rows.push({
        source: MACRO_SOURCE,
        seriesId,
        d: o.d,
        valueMicro: BigInt(String(o.valueMicro)),
      });
    }
  }
  return { rows, skipped };
}
