// The licence check engine (M22 E1; KB-083, D-1430, D-1431). Plain .mjs so that the build-machine script
// (scripts/experts/licence-check.mjs) and the app share one implementation; policy.ts, check.ts and store.ts are the
// typed faces. No database, no clock and no network of its own: `fetch` and `sleep` are passed in.
//   - which sources an expert has (`sourcesOf`): `platform:handle` for a handle, the https origin for a home URL;
//     manual-only platforms (X, Instagram, TikTok, Facebook, LinkedIn) are never fetched (D-522);
//   - what one source's check reads (`checkSource`): robots.txt (once), then at most five standard terms paths, each
//     only if robots allows it; redirects are followed only within the same site, at most three hops;
//   - what the terms say about automated summarising (`readTerms`): a conservative phrase reader, "unknown" unless a
//     clause clearly forbids or permits; the Owner reads every result (marked [VERIFY] in the register);
//   - the status from those facts (`decideStatus`, D-1430).
// Robots rules come from the same RFC 9309 reader as the polite fetcher (`parseRobots`, token "praxis"): the
// TypeScript reader of the feed rules (src/lib/kb/fetchRules.ts) cannot be loaded by a Node script, and
// tests/experts/licence/engine.test.ts proves both readers agree on the fixture files (D-1470).
import { DEFAULT_USER_AGENT, parseRobots, ROBOTS_TOKEN } from "../../data/sources/politeFetch.mjs";

export const LICENCE_AGENT = DEFAULT_USER_AGENT;
/** Platforms whose terms restrict automated access: the Owner pastes a link by hand, nothing is fetched (D-522). */
export const MANUAL_ONLY_PLATFORMS = Object.freeze([
  "x",
  "twitter",
  "instagram",
  "tiktok",
  "facebook",
  "linkedin",
]);
const MANUAL_HOSTS = Object.freeze([
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "linkedin.com",
]);
/** Platforms with a public feed: where the feed lives and where its terms are. */
export const PLATFORM_SITES = Object.freeze({
  youtube: {
    origin: "https://www.youtube.com",
    path: "/feeds/videos.xml",
    termsPaths: ["/t/terms"],
  },
});
/** Standard places a site keeps its terms. */
export const TERMS_PATHS = Object.freeze([
  "/terms",
  "/terms-of-service",
  "/terms-of-use",
  "/tos",
  "/legal",
]);
export const LIMITS = Object.freeze({
  keyChars: 64, // threshold-ok: expert_source_licence.source_key length cap (0039)
  maxRedirects: 3, // threshold-ok: same cap as the polite fetcher
  maxTermsChars: 300_000, // threshold-ok: a terms page is read up to this many characters, then cut
  maxSourcesPerExpert: 10, // threshold-ok: five home URLs and the handles, both capped by the seed format
  spacingMs: 1000, // threshold-ok: one second between two requests of the check
  maxRunRequests: 3000, // threshold-ok: about 150 tracked experts, up to six requests a source, with room
});

const isHttps = (u) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};
const hostOf = (u) => new URL(u).hostname.toLowerCase();
const bare = (h) => h.replace(/^www\./, "");
const isManualHost = (h) => MANUAL_HOSTS.some((m) => bare(h) === m || h.endsWith(`.${m}`));

/**
 * The sources of one expert. `manual` sources and sources with no known origin are listed (the page shows them)
 * but never fetched.
 * @param {{ platforms?: string[], handles?: Record<string, string>, homeUrls?: string[] }} expert
 */
export function sourcesOf(expert) {
  /** @type {{ key: string, kind: "platform"|"site", manual: boolean, origin: string|null, path: string, termsPaths: string[] }[]} */
  const out = [];
  const seen = new Set();
  const add = (s) => {
    if (s.key.length > LIMITS.keyChars || seen.has(s.key)) return;
    if (out.length >= LIMITS.maxSourcesPerExpert) return;
    seen.add(s.key);
    out.push(s);
  };
  for (const [platform, handle] of Object.entries(expert.handles ?? {})) {
    if (typeof handle !== "string" || handle === "") continue;
    const p = platform.toLowerCase();
    const site = Object.hasOwn(PLATFORM_SITES, p) ? PLATFORM_SITES[p] : null;
    add({
      key: `${p}:${handle}`,
      kind: "platform",
      manual: MANUAL_ONLY_PLATFORMS.includes(p),
      origin: site ? site.origin : null,
      path: site ? site.path : "/",
      termsPaths: site ? [...site.termsPaths] : [],
    });
  }
  for (const url of expert.homeUrls ?? []) {
    if (!isHttps(url)) continue;
    const u = new URL(url);
    add({
      key: u.origin,
      kind: "site",
      manual: isManualHost(u.hostname),
      origin: u.origin,
      path: `${u.pathname || "/"}${u.search}`,
      termsPaths: [],
    });
  }
  return out;
}

// ---- terms ---------------------------------------------------------------------------------------------

const FORBID = [
  /\byou\s+(?:may|shall|will|agree|must)\s+not\b[^.]{0,140}\b(?:scrap\w*|crawl\w*|spider\w*|summari[sz]\w*|automated\s+(?:means|access|collection|extraction|tools?)|data\s+mining|machine\s+learning|train\w*\s+(?:an?\s+)?(?:ai|model|language\s+model))/,
  /\b(?:scraping|crawling|data\s+mining|automated\s+(?:access|collection|extraction)|summari[sz]ing|summari[sz]ation)\b[^.]{0,80}\b(?:is|are)\s+(?:strictly\s+)?(?:prohibited|forbidden|not\s+(?:permitted|allowed))/,
  /\b(?:prohibit\w*|forbid\w*)\b[^.]{0,100}\b(?:scrap\w*|crawl\w*|automated|summari[sz]\w*)/,
];
const PERMIT = [
  /\byou\s+may\b[^.]{0,100}\b(?:summari[sz]e|quote|excerpt)/,
  /\b(?:summari[sz]\w*|excerpt\w*|quoting)\b[^.]{0,80}\b(?:is|are)\s+(?:permitted|allowed|welcome)/,
  /\bcreative\s+commons\b/,
];

/**
 * What a terms page says about automated summarising: "no" if a clause forbids (a forbidding clause wins), "yes"
 * if one clearly permits, otherwise "unknown" (which means headline and link only).
 * @param {string} text @returns {"yes"|"no"|"unknown"}
 */
export function readTerms(text) {
  const t = String(text)
    .slice(0, LIMITS.maxTermsChars)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (FORBID.some((r) => r.test(t))) return "no";
  if (PERMIT.some((r) => r.test(t))) return "yes";
  return "unknown";
}

// ---- status (D-1430) -----------------------------------------------------------------------------------

/**
 * Robots disallows, or the terms forbid, gives `no`. Robots allowing (or absent) gives `enabled`, whatever the terms
 * say about summarising (unknown means title and link only, never a summary). Unreachable leaves the status as it
 * was. Only the Owner sets `owner-accepted-risk`; the job never lowers one to `enabled` (the acceptance covers an
 * unknown summarising clause) but a robots disallowance or a forbidding clause still gives `no` (D-1471).
 * @param {{ robots: "allows"|"disallows"|"absent"|"unreachable", summarisation: "yes"|"no"|"unknown",
 *   previous: "unchecked"|"enabled"|"owner-accepted-risk"|"no"|null }} i
 * @returns {"unchecked"|"enabled"|"owner-accepted-risk"|"no"}
 */
export function decideStatus(i) {
  if (i.robots === "unreachable") return i.previous ?? "unchecked";
  if (i.robots === "disallows" || i.summarisation === "no") return "no";
  if (i.previous === "owner-accepted-risk") return "owner-accepted-risk";
  return "enabled";
}

// ---- one source ----------------------------------------------------------------------------------------

const sameSite = (a, b) => bare(hostOf(a)) === bare(hostOf(b));

/**
 * One GET with manual redirects inside the same site. Returns null on a network error, an off-site redirect or
 * when the request budget is spent.
 */
async function get(fetchFn, url, agent, ctx) {
  let target = url;
  for (let hop = 0; hop <= LIMITS.maxRedirects; hop += 1) {
    if (ctx.left <= 0) return null;
    ctx.left -= 1;
    if (ctx.requests > 0) await ctx.sleep(LIMITS.spacingMs);
    ctx.requests += 1;
    let r;
    try {
      r = await fetchFn(target, { headers: { "user-agent": agent }, redirect: "manual" });
    } catch {
      return null;
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return null;
      let next;
      try {
        next = new URL(loc, target).href;
      } catch {
        return null;
      }
      if (!isHttps(next) || !sameSite(next, url)) return null;
      target = next;
      continue;
    }
    return { status: r.status, text: r.status >= 200 && r.status < 300 ? await r.text() : "" };
  }
  return null;
}

const looksHtml = (t) => /^\s*<(?:!doctype|html|head|body)/i.test(t);

/**
 * Reads robots.txt and (when robots allows) the first terms page of one fetchable source.
 * @param {ReturnType<typeof sourcesOf>[number]} source
 * @param {{ fetch: Function, agent?: string, sleep?: (ms: number) => Promise<void>, maxRequests?: number }} deps
 * @returns {Promise<{ robots: "allows"|"disallows"|"absent"|"unreachable", summarisation: "yes"|"no"|"unknown", termsUrl: string|null, requests: number }>}
 */
export async function checkSource(source, deps) {
  const agent = deps.agent ?? LICENCE_AGENT;
  const ctx = {
    left: deps.maxRequests ?? 12, // threshold-ok: robots, a platform terms path, five standard paths and a few redirect hops
    requests: 0,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const done = (robots, summarisation, termsUrl) => ({
    robots,
    summarisation,
    termsUrl,
    requests: ctx.requests,
  });
  if (source.origin === null || source.manual) return done("unreachable", "unknown", null);
  const r = await get(deps.fetch, `${source.origin}/robots.txt`, agent, ctx);
  if (r === null || r.status === 429 || r.status >= 500)
    return done("unreachable", "unknown", null);
  let rules = null;
  if (r.status >= 200 && r.status < 300 && !looksHtml(r.text)) {
    rules = parseRobots(r.text, ROBOTS_TOKEN);
    if (!rules.allows(source.path)) return done("disallows", "unknown", null);
  }
  const robots = rules === null ? "absent" : "allows";
  for (const p of [...source.termsPaths, ...TERMS_PATHS]) {
    if (rules !== null && !rules.allows(p)) continue;
    const url = `${source.origin}${p}`;
    const t = await get(deps.fetch, url, agent, ctx);
    if (t === null || t.status < 200 || t.status >= 300 || t.text.trim() === "") continue;
    return done(robots, readTerms(t.text), url.slice(0, 500));
  }
  return done(robots, "unknown", null);
}

// ---- a whole run ---------------------------------------------------------------------------------------

/**
 * Checks every fetchable source of the given experts once (a shared origin is read once) and returns the rows to
 * append and the counts. A reference author (`noFeed`) is skipped; a manual-only source or one with no feed address
 * is counted as not fetched and gets no row. `previous` is the latest status per expert and source key.
 * @param {{ experts: { id: string, platforms?: string[], handles?: Record<string, string>, homeUrls?: string[], noFeed?: boolean }[],
 *   previous?: (expertId: string, key: string) => "unchecked"|"enabled"|"owner-accepted-risk"|"no"|null,
 *   fetch: Function, sleep?: (ms: number) => Promise<void>, agent?: string, now?: () => Date, maxRequests?: number }} i
 */
export async function checkExperts(i) {
  const now = i.now ?? (() => new Date());
  const cap = i.maxRequests ?? LIMITS.maxRunRequests;
  const rep = {
    sources: 0,
    checked: 0,
    enabled: 0,
    acceptedRisk: 0,
    no: 0,
    unreachable: 0,
    notFetched: 0,
    capped: 0,
    requests: 0,
  };
  /** @type {{ expertId: string, sourceKey: string, checkedAt: string, termsUrl: string|null, robots: string, summarisation: string, status: string, note: string|null }[]} */
  const rows = [];
  const cache = new Map();
  for (const e of i.experts) {
    if (e.noFeed) continue; // a reference author: nothing is followed, so nothing is checked
    for (const s of sourcesOf(e)) {
      rep.sources += 1;
      if (s.manual || s.origin === null) {
        rep.notFetched += 1;
        continue;
      }
      const ck = `${s.origin}|${s.path}|${s.termsPaths.join(",")}`;
      let res = cache.get(ck);
      if (res === undefined) {
        if (rep.requests >= cap) {
          rep.capped += 1;
          continue;
        }
        res = await checkSource(s, {
          fetch: i.fetch,
          sleep: i.sleep,
          agent: i.agent,
          maxRequests: Math.min(12, cap - rep.requests), // threshold-ok: the per-source cap of checkSource
        });
        rep.requests += res.requests;
        cache.set(ck, res);
      }
      const status = decideStatus({
        robots: res.robots,
        summarisation: res.summarisation,
        previous: i.previous ? i.previous(e.id, s.key) : null,
      });
      rows.push({
        expertId: e.id,
        sourceKey: s.key,
        checkedAt: now().toISOString(),
        termsUrl: res.termsUrl,
        robots: res.robots,
        summarisation: res.summarisation,
        status,
        note:
          res.robots === "unreachable"
            ? "could not be reached; status kept"
            : status === "enabled" && res.summarisation !== "yes"
              ? "terms silent on summarising; titles and links only"
              : null,
      });
      rep.checked += 1;
      if (res.robots === "unreachable") rep.unreachable += 1;
      else if (status === "no") rep.no += 1;
      else if (status === "owner-accepted-risk") rep.acceptedRisk += 1;
      else rep.enabled += 1;
    }
  }
  return { rows, report: rep };
}
