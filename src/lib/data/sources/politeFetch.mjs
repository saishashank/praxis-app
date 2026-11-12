// The polite fetcher of the IN and US sources (M20 A3; D-1093, D-1095, D-1096, D-1128, DAT-101, DAT-123).
// Every request to a market source goes through `createPoliteFetch(...).fetch(url, { source, ... })`:
//   1. the host must belong to a registered market source (src/lib/market/seed/sourceSites.mjs) and the call must
//      name the register id of one of that host's sources;
//   2. the gate refuses it unless the market is enabled and the source's register row is `enabled` and its
//      `source_status` is not off or tripped (`dbGate`, or an injected `gate`); nothing is requested, and the
//      refusal is a typed `PoliteFetchRefused` with a fixed reason word (no URL, no host in the message);
//   3. a source that needs the declared contact (EDGAR, D-1094) is refused with `contact_missing` unless the
//      caller passes its own `userAgent`;
//   4. the recorded-day host guard still applies (PRAXIS_ENV=recorded refuses every non-loopback host);
//   5. robots.txt of the host is read once (6 hours) and obeyed: a disallowed path is refused with
//      `robots_disallowed`, a Crawl-delay raises the host's interval, an unreachable file (5xx, network) means
//      "disallow all" (RFC 9309), a 4xx or an HTML page means "no robots";
//      (a 429 on robots.txt is treated as disallow-all on purpose: a host that is rate-limiting us is not asked again);
//   5b. redirects are never followed by the platform (`redirect: "manual"`): a 3xx re-enters this function for its
//      target, so the host table, the gate and robots run again, at most 3 hops, and a target off the host table is
//      refused with `redirect_off_list` (the same rule applies to the robots.txt read);
//   6. requests to one host are serialised and spaced by the source's `intervalMs` (and the Crawl-delay);
//   7. 429 and 5xx answers (and network errors) are retried with backoff, at most 4 times, honouring Retry-After
//      (capped at 60 s); the last answer is returned.
// The declared User-Agent names the product and says it is private research, with no contact value in code.
// No database write, no secret, no body is ever logged: the optional `log` hook gets host and status only.
import { assertAllowedRequest } from "../recorded/hostGuard.mjs";
import { siteOfHost, sourceById } from "../../market/seed/sourceSites.mjs";

export const DEFAULT_USER_AGENT = "Praxis/1.0 (private research; single owner)";
export const ROBOTS_TOKEN = "praxis";
export const MAX_RETRIES = 4;
export const BACKOFF_BASE_MS = 2000;
export const RETRY_AFTER_CAP_MS = 60_000;
export const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_INTERVAL_MS = 1500;

/** The fixed refusal words. */
export const REFUSALS = Object.freeze([
  "bad_url",
  "host_not_registered",
  "source_required",
  "source_host_mismatch",
  "no_gate",
  "market_not_enabled",
  "source_not_registered",
  "source_not_enabled",
  "source_off",
  "contact_missing",
  "robots_disallowed",
  "robots_unavailable",
  "redirect_off_list",
]);
export const MAX_REDIRECTS = 3;

export class PoliteFetchRefused extends Error {
  /** @param {string} reason one of REFUSALS */
  constructor(reason) {
    super(`polite fetch refused: ${reason}`);
    this.name = "PoliteFetchRefused";
    this.reason = reason;
  }
}

/** True for a PoliteFetchRefused (also across module copies). @param {unknown} e */
export function isPoliteFetchRefused(e) {
  return e instanceof PoliteFetchRefused || (e instanceof Error && e.name === "PoliteFetchRefused");
}

// ---- robots.txt ----

/** A robots path pattern (`*` any run, `$` end) as a RegExp anchored at the start. @param {string} p */
function patternOf(p) {
  const end = p.endsWith("$");
  const body = end ? p.slice(0, -1) : p;
  // `$` is an anchor only as the final character of the rule; anywhere else it is a literal
  const esc = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}${end ? "$" : ""}`);
}

/**
 * Parse a robots.txt for one agent token. The group naming the token wins over `*`; within a group the longest
 * matching rule wins and `Allow` wins a tie; an empty `Disallow:` allows everything.
 * @param {string} text @param {string} [token]
 * @returns {{ allows: (pathAndQuery: string) => boolean, crawlDelayMs: number }}
 */
export function parseRobots(text, token = ROBOTS_TOKEN) {
  /** @type {{ agents: string[], rules: { allow: boolean, path: string }[], delay: number | null }[]} */
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || cur === null) {
        cur = { agents: [], rules: [], delay: null };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur === null) continue;
    if (key === "allow") cur.rules.push({ allow: true, path: val });
    else if (key === "disallow") cur.rules.push({ allow: false, path: val });
    else if (key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) cur.delay = n;
    }
  }
  const t = token.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && a === t));
  const pick = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  const rules = pick.flatMap((g) => g.rules);
  const delay = pick.map((g) => g.delay).find((d) => d !== null) ?? 0;
  const compiled = rules
    .filter((r) => !(r.allow === false && r.path === ""))
    .map((r) => ({ allow: r.allow, re: patternOf(r.path), len: r.path.length }));
  return {
    crawlDelayMs: Math.round(delay * 1000),
    allows(pathAndQuery) {
      let best = null;
      for (const r of compiled) {
        if (!r.re.test(pathAndQuery)) continue;
        if (best === null || r.len > best.len || (r.len === best.len && r.allow)) best = r;
      }
      return best === null ? true : best.allow;
    },
  };
}

const NO_ROBOTS = Object.freeze({ allows: () => true, crawlDelayMs: 0 });

// ---- the gate ----

/**
 * The register gate over a database: the market is enabled, the register row exists and is `enabled`, and the
 * source_status row (when there is one) is not off or tripped. Three primary-key reads, cached `ttlMs`.
 * @param {{ execute: Function }} db
 * @param {{ ttlMs?: number, now?: () => number }} [o]
 * @returns {(row: { id: string, market: string }) => Promise<string | null>} a refusal word or null
 */
export function dbGate(db, o = {}) {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  /** @type {Map<string, { at: number, reason: string | null }>} */
  const cache = new Map();
  return async (row) => {
    const hit = cache.get(row.id);
    if (hit && now() - hit.at < ttl) return hit.reason;
    let reason = null;
    // rows-ok: primary-key read of one market row
    const m = await db.execute({
      sql: "SELECT enabled FROM market WHERE code = ?",
      args: [row.market],
    });
    if (m.rows.length === 0 || Number(m.rows[0].enabled) !== 1) reason = "market_not_enabled";
    else {
      // rows-ok: primary-key read of one source_register row
      const r = await db.execute({
        sql: "SELECT status FROM source_register WHERE source = ?",
        args: [row.id],
      });
      if (r.rows.length === 0) reason = "source_not_registered";
      else if (String(r.rows[0].status) !== "enabled") reason = "source_not_enabled";
      else {
        // rows-ok: primary-key read of one source_status row
        const s = await db.execute({
          sql: "SELECT mode FROM source_status WHERE source = ?",
          args: [row.id],
        });
        const mode = s.rows.length === 0 ? "on" : String(s.rows[0].mode);
        if (mode === "off" || mode === "tripped") reason = "source_off";
      }
    }
    cache.set(row.id, { at: now(), reason });
    return reason;
  };
}

// ---- the client ----

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   db?: { execute: Function },
 *   gate?: (row: any) => Promise<string | null> | string | null,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   userAgent?: string,
 *   env?: Record<string, string | undefined>,
 *   log?: (e: { host: string, status: number | string }) => void,
 *   siteOf?: typeof siteOfHost,
 *   sourceOf?: typeof sourceById,
 *   backoffBaseMs?: number,
 *   timeoutMs?: number,
 * }} [o]
 */
export function createPoliteFetch(o = {}) {
  const fetchImpl = o.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const sleep = o.sleep ?? sleepReal;
  const now = o.now ?? Date.now;
  const env = o.env ?? process.env;
  const base = o.backoffBaseMs ?? BACKOFF_BASE_MS;
  const gate = o.gate ?? (o.db ? dbGate(o.db) : null);
  const log = o.log ?? (() => {});
  const siteOf = o.siteOf ?? siteOfHost; // the source report widens both lookups to its own probe hosts
  const sourceOf = o.sourceOf ?? sourceById;
  /** @type {Map<string, number>} next allowed start per host */
  const nextAt = new Map();
  /** @type {Map<string, Promise<unknown>>} per-host queue */
  const queue = new Map();
  /** @type {Map<string, { at: number, robots: ReturnType<typeof parseRobots> | "unavailable" }>} */
  const robotsCache = new Map();

  /** Run `job` after the host's previous job, spaced `interval` ms from the previous start. */
  async function paced(host, interval, job) {
    const prev = queue.get(host) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (nextAt.get(host) ?? 0) - now();
      if (wait > 0) await sleep(wait);
      nextAt.set(host, now() + interval);
      return job();
    });
    queue.set(
      host,
      run.catch(() => {}),
    );
    return run;
  }

  /** One request with the retry rule. */
  async function attempt(host, interval, url, init, ua) {
    let last = null;
    for (let n = 0; n <= MAX_RETRIES; n += 1) {
      let res = null;
      let failed = false;
      try {
        res = await paced(host, interval, () =>
          fetchImpl(url, {
            ...init,
            headers: { ...(init.headers ?? {}), "user-agent": ua },
            redirect: "manual", // a redirect re-enters the gate, the host table and robots (below)
            signal: init.signal ?? AbortSignal.timeout(o.timeoutMs ?? 30_000),
          }),
        );
      } catch (e) {
        failed = true;
        last = e;
      }
      if (res !== null) {
        log({ host, status: res.status });
        last = res;
        if (res.status !== 429 && res.status < 500) return res;
      } else log({ host, status: "error" });
      if (n === MAX_RETRIES) break;
      let wait = base * 2 ** n;
      const ra = res === null || failed ? null : Number(res.headers.get("retry-after"));
      if (ra !== null && Number.isFinite(ra) && ra > 0)
        wait = Math.min(ra * 1000, RETRY_AFTER_CAP_MS);
      await sleep(wait);
    }
    if (last instanceof Error) throw last;
    return last;
  }

  const isRedirect = (res) => res.status >= 300 && res.status < 400 && res.headers.get("location");

  /** The robots.txt read; a redirect is followed only to a registered host, at most MAX_REDIRECTS times. */
  async function followRobots(origin, host, interval, ua) {
    let url = `${origin}/robots.txt`;
    let h = host;
    for (let hop = 0; ; hop += 1) {
      const res = await attempt(h, interval, url, {}, ua);
      if (!isRedirect(res)) return res;
      let t;
      try {
        t = new URL(res.headers.get("location"), url);
      } catch {
        throw new PoliteFetchRefused("redirect_off_list");
      }
      if (hop >= MAX_REDIRECTS || t.protocol !== "https:" || siteOf(t.hostname) === null) {
        throw new PoliteFetchRefused("redirect_off_list");
      }
      url = t.toString();
      h = t.hostname;
    }
  }

  async function robotsOf(origin, host, interval, ua) {
    const hit = robotsCache.get(origin);
    if (hit && now() - hit.at < ROBOTS_TTL_MS) return hit.robots;
    let robots;
    try {
      const res = await followRobots(origin, host, interval, ua);
      const ct = String(res.headers.get("content-type") ?? "");
      if (res.status >= 500 || res.status === 429) robots = "unavailable";
      else if (res.status >= 400) robots = NO_ROBOTS;
      else {
        const text = await res.text();
        robots = ct.includes("html") || /^\s*</.test(text) ? NO_ROBOTS : parseRobots(text);
      }
    } catch (e) {
      if (isPoliteFetchRefused(e)) throw e;
      robots = "unavailable";
    }
    robotsCache.set(origin, { at: now(), robots });
    return robots;
  }

  return {
    /**
     * @param {string | URL} input
     * @param {RequestInit & { source?: string, userAgent?: string }} [init]
     * @returns {Promise<Response>}
     */
    async fetch(input, init = {}) {
      return go(input, init, 0);
    },
  };

  async function go(input, init, hop) {
    {
      const { source, userAgent, ...rest } = init;
      let u;
      try {
        u = new URL(String(input));
      } catch {
        throw new PoliteFetchRefused("bad_url");
      }
      if (u.protocol !== "https:" || u.username !== "" || u.password !== "") {
        throw new PoliteFetchRefused("bad_url");
      }
      const site = siteOf(u.hostname);
      if (site === null) throw new PoliteFetchRefused("host_not_registered");
      let id = source;
      if (id === undefined) {
        if (site.sources.length !== 1) throw new PoliteFetchRefused("source_required");
        id = site.sources[0];
      }
      const row = sourceOf(id);
      if (row === undefined || !site.sources.includes(id)) {
        throw new PoliteFetchRefused("source_host_mismatch");
      }
      if (gate === null) throw new PoliteFetchRefused("no_gate");
      const refusal = await gate(row);
      if (refusal !== null) throw new PoliteFetchRefused(refusal);
      if (row.contact === true && (typeof userAgent !== "string" || userAgent.trim() === "")) {
        throw new PoliteFetchRefused("contact_missing");
      }
      assertAllowedRequest(u, env);
      const ua = userAgent ?? o.userAgent ?? DEFAULT_USER_AGENT;
      const interval0 = Number.isFinite(row.intervalMs) ? row.intervalMs : DEFAULT_INTERVAL_MS;
      const robots = await robotsOf(u.origin, u.hostname, interval0, ua);
      if (robots === "unavailable") throw new PoliteFetchRefused("robots_unavailable");
      if (!robots.allows(`${u.pathname}${u.search}`))
        throw new PoliteFetchRefused("robots_disallowed");
      const res = await attempt(
        u.hostname,
        Math.max(interval0, robots.crawlDelayMs),
        u.toString(),
        rest,
        ua,
      );
      if (!isRedirect(res)) return res;
      // a redirect is a new request: host table, gate and robots run again for its target (same source)
      let t;
      try {
        t = new URL(res.headers.get("location"), u);
      } catch {
        throw new PoliteFetchRefused("redirect_off_list");
      }
      if (hop >= MAX_REDIRECTS || siteOf(t.hostname) === null) {
        throw new PoliteFetchRefused("redirect_off_list");
      }
      return go(t.toString(), { ...init, source: id }, hop + 1);
    }
  }
}
