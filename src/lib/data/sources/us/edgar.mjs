// The SEC EDGAR client (M20 US1; D-1094, D-1093, D-1142, DAT-101). The SEC answers a request without a declared
// contact with a rate-limit block page, and fair access asks for a User-Agent that names the requester, so:
//   - the contact is the Owner-store value PRAXIS_EDGAR_CONTACT (never in code, never defaulted): unset or blank,
//     `edgarUserAgent` throws `EdgarContactMissing` (a fixed word, no value) and no request is made;
//   - every call asserts the market is enabled FIRST (the write guard's own check), so under the production seed
//     (the market off) a client call refuses before any contact is read and before any request (AT-70: 0 requests);
//   - only the SEC hosts are asked (data.sec.gov, efts.sec.gov, www.sec.gov), at most 2 requests a second (the
//     register row's 500 ms interval; the fair-access line is 10), through the polite client (robots, backoff, the
//     register gate); the declared UA is handed to it, so its `contact_missing` refusal never fires on a real call.
// The body is returned to the caller and never logged; nothing here writes to the database.
import { assertMarketEnabled } from "../../../market/guard.mjs";
import { createPoliteFetch } from "../politeFetch.mjs";

export const EDGAR_SOURCE = "us_edgar";
export const EDGAR_HOSTS = Object.freeze(["data.sec.gov", "efts.sec.gov", "www.sec.gov"]);
/** The Owner-store name of the contact (a name only; `scripts/ci/env-names.mjs`, `.env.example`). */
export const EDGAR_CONTACT_ENV = "PRAXIS_EDGAR_CONTACT";
/** The product token of the declared User-Agent. */
export const EDGAR_PRODUCT = "Praxis";

export class EdgarContactMissing extends Error {
  constructor() {
    super("EdgarContactMissing");
    this.name = "EdgarContactMissing";
  }
}
export class EdgarHostRefused extends Error {
  constructor() {
    super("EdgarHostRefused");
    this.name = "EdgarHostRefused";
  }
}
export class EdgarHttpError extends Error {
  /** @param {number} status */
  constructor(status) {
    super(`EdgarHttpError ${status}`);
    this.name = "EdgarHttpError";
    this.status = status;
  }
}

/**
 * The declared User-Agent: `Praxis/<version> (<contact>)`. Throws `EdgarContactMissing` when the contact is unset or blank.
 * @param {Record<string, string | undefined>} env @param {string} [version]
 */
export function edgarUserAgent(env, version = "1") {
  const c = env[EDGAR_CONTACT_ENV];
  if (typeof c !== "string" || c.trim() === "") throw new EdgarContactMissing();
  return `${EDGAR_PRODUCT}/${version} (${c.trim()})`;
}

/**
 * @param {{
 *   db: { execute: Function },
 *   market: string,
 *   env?: Record<string, string | undefined>,
 *   version?: string,
 *   fetchImpl?: typeof fetch,
 *   gate?: Function, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   siteOf?: Function, sourceOf?: Function,
 *   log?: (e: { host: string, status: number | string }) => void,
 * }} o
 */
export function createEdgarClient(o) {
  const env = o.env ?? process.env;
  const polite = createPoliteFetch({
    db: o.db,
    gate: o.gate,
    fetchImpl: o.fetchImpl,
    sleep: o.sleep,
    now: o.now,
    siteOf: o.siteOf,
    sourceOf: o.sourceOf,
    log: o.log,
  });
  /** @param {string} url */
  async function get(url) {
    // 1. the write guard's own check, before anything else: a market that is off makes no request (AT-70)
    await assertMarketEnabled(o.db, o.market);
    // 2. the contact (throws EdgarContactMissing, no request)
    const userAgent = edgarUserAgent(env, o.version);
    // 3. only the SEC hosts
    let host;
    try {
      host = new URL(url).host;
    } catch {
      throw new EdgarHostRefused();
    }
    if (!EDGAR_HOSTS.includes(host)) throw new EdgarHostRefused();
    const res = await polite.fetch(url, { source: EDGAR_SOURCE, userAgent });
    if (res.status < 200 || res.status >= 300) throw new EdgarHttpError(res.status);
    return res;
  }
  return {
    /** @param {string} url */
    async getText(url) {
      return (await get(url)).text();
    },
    /** @param {string} url */
    async getJson(url) {
      return JSON.parse(await (await get(url)).text());
    },
  };
}

const pad10 = (cik) => String(cik).replace(/\D/g, "").padStart(10, "0");
/** @param {string | number} cik */
export const submissionsUrl = (cik) => `https://data.sec.gov/submissions/CIK${pad10(cik)}.json`;
/** @param {string | number} cik */
export const companyFactsUrl = (cik) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${pad10(cik)}.json`;
/** The filing index page of an accession (a link target, never fetched by the app). @param {string | number} cik @param {string} accession */
export const filingIndexUrl = (cik, accession) =>
  `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/\D/g, "").replace(/^0+/, "")}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
