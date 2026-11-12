// The registered source sites (DAT-253, D-975; M20 A3, D-1095): the hosts a stored link may point at, and the public
// page each is shown against. The AU entries are written here; the India and US hosts come from the per-market
// source rows (src/lib/market/seed/{in,us}/sources.mjs), so a host is named once. A host is a domain: a subdomain
// of it is registered too.
// M18 stores no document text from asic.gov.au or ssrn.com: they are link targets only (register rows pending,
// terms [VERIFY]). Link allow-listing (AT-81) is unchanged by the market hosts; FETCHING from one is a separate
// gate (src/lib/data/sources/politeFetch.mjs: the register row enabled and the market enabled).
import { MARKET_SITES } from "@/lib/market/seed/sourceSites.mjs";

const AU_SITES = {
  "asx.com.au": "https://www.asx.com.au/",
  "asic.gov.au": "https://asic.gov.au/",
  "ssrn.com": "https://www.ssrn.com/",
} as const;

/** host -> the public page it is shown against. */
export const SOURCE_SITES: Readonly<Record<string, string>> = Object.freeze({
  ...AU_SITES,
  ...Object.fromEntries(Object.entries(MARKET_SITES).map(([host, s]) => [host, s.url])),
});

/** The markets and register ids a host serves (market hosts only; the AU entries are link targets, no register id). */
export const SOURCE_SITE_TAGS: Readonly<
  Record<string, { markets: readonly string[]; sources: readonly string[] }>
> = MARKET_SITES;
