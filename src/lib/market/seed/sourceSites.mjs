// The per-market source registry and the host table (M20 A3; D-1095, D-1096, D-1128). Everything is derived from
// the `sources.mjs` row lists of the markets that have one, so a source is written once.
//   MARKET_SOURCES   market code -> its register rows (a market without rows, AU today, has no entry)
//   marketSourcesOf  the rows of one market, or []
//   sourceById       a row by register id, or undefined
//   MARKET_SITES     host -> { url, markets, sources } for every host a row names (the domain; a subdomain
//                    matches it too, as in SOURCE_SITES)
//   siteOfHost       the MARKET_SITES entry a host belongs to (exact or subdomain), or null
import { SOURCES as IN_SOURCES } from "./in/sources.mjs";
import { SOURCES as US_SOURCES } from "./us/sources.mjs";

/** @type {Readonly<Record<string, readonly Readonly<Record<string, any>>[]>>} */
export const MARKET_SOURCES = Object.freeze({ IN: IN_SOURCES, US: US_SOURCES });

/** @param {string} market */
export function marketSourcesOf(market) {
  return Object.hasOwn(MARKET_SOURCES, market) ? MARKET_SOURCES[market] : [];
}

/** @param {string} id */
export function sourceById(id) {
  for (const rows of Object.values(MARKET_SOURCES)) {
    const hit = rows.find((r) => r.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function buildSites() {
  /** @type {Record<string, { url: string, markets: string[], sources: string[] }>} */
  const sites = {};
  for (const [market, rows] of Object.entries(MARKET_SOURCES)) {
    for (const row of rows) {
      for (const host of row.hosts) {
        const s = (sites[host] ??= { url: `https://${host}/`, markets: [], sources: [] });
        if (!s.markets.includes(market)) s.markets.push(market);
        s.sources.push(row.id);
      }
    }
  }
  for (const s of Object.values(sites)) {
    s.markets.sort();
    s.sources.sort();
    Object.freeze(s.markets);
    Object.freeze(s.sources);
    Object.freeze(s);
  }
  return Object.freeze(sites);
}

export const MARKET_SITES = buildSites();

/** @param {string} host */
export function siteOfHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  const key = Object.keys(MARKET_SITES)
    .sort((a, b) => b.length - a.length)
    .find((k) => h === k || h.endsWith(`.${k}`));
  return key === undefined ? null : { host: key, ...MARKET_SITES[key] };
}
