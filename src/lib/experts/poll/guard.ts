// The fetch guard of the expert polling job (M22 E2; KB-082, D-1432, D-1478). Every request of the job goes through
// `guardedFetch`: a host is refused unless it is one of the registered origins of the sources being read (the origin
// the expert's own record names), a private, loopback, link-local or otherwise non-public address is refused (as a
// literal in the URL, and as a DNS answer when a resolver is passed), and a redirect is followed only inside the same
// origin, at most three hops: an answer that points anywhere else is refused, never followed. The body is cut at a
// fixed size. A refusal is a thrown `FetchRefused` with a fixed reason word (no URL or host in the message) so the
// caller's own catch records "failed" and the job counts the reason.
import type { FetchFn, FetchResponse } from "@/lib/kb/fetchRules";

export const REFUSALS = [
  "not_https",
  "off_origin",
  "private_address",
  "redirect_off_origin",
  "too_many_redirects",
] as const;
export type Refusal = (typeof REFUSALS)[number];

export class FetchRefused extends Error {
  readonly reason: Refusal;
  constructor(reason: Refusal) {
    super(`fetch refused: ${reason}`);
    this.name = "FetchRefused";
    this.reason = reason;
  }
}

export const GUARD_LIMITS = Object.freeze({
  maxRedirects: 3, // threshold-ok: same cap as the polite fetcher and the licence check
  maxBodyChars: 1_000_000, // threshold-ok: a feed is cut here; nothing is stored from it but titles and links
  spacingMs: 1000, // threshold-ok: one second between two requests to one host
});

/** The platform fetch as the job uses it: manual redirects, so a 3xx comes back to this guard. */
export type RawFetch = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual" },
) => Promise<FetchResponse>;

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for an IPv4 address that is not a public one (private, loopback, link-local, shared, reserved, multicast). */
export function privateV4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // protocol assignments and documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  return a >= 224; // multicast, reserved, broadcast
}

/** True when `address` (an IPv4 or IPv6 literal, no brackets) is not a public address. Unknown shapes are refused. */
export function isPrivateAddress(address: string): boolean {
  const s = address.toLowerCase();
  const v4 = V4.exec(s);
  if (v4 !== null) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return true;
    return privateV4(n[0]!, n[1]!);
  }
  if (!s.includes(":")) return true;
  if (s === "::" || s === "::1") return true;
  const mapped = /^(?:0:0:0:0:0:ffff:|::ffff:)(.+)$/.exec(s);
  if (mapped !== null) {
    const rest = mapped[1]!;
    if (V4.test(rest)) return isPrivateAddress(rest);
    const h = rest.split(":").map((x) => Number.parseInt(x, 16));
    if (h.length === 2 && h.every(Number.isFinite)) return privateV4(h[0]! >> 8, h[0]! & 0xff);
    return true;
  }
  const first = Number.parseInt(s.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when a URL hostname is not an acceptable public host: a private literal, localhost or an internal name. */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "" || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local") || h.endsWith(".lan")) return true;
  if (h.includes(":") || V4.test(h)) return isPrivateAddress(h);
  return !h.includes("."); // a bare name resolves inside a network, not on the public web
}

/** The origin of a URL, or null when it is not an https URL. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export type GuardDeps = {
  fetch: RawFetch;
  /** The registered origins the job may read: the origins of the sources it is polling, nothing else. */
  origins: ReadonlySet<string>;
  /** DNS answers for a host; a private address among them refuses the request. Absent: literals only. */
  resolve?: (host: string) => Promise<readonly string[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Called with the reason word of every refusal. */
  onRefused?: (reason: Refusal) => void;
};

const real = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A fetch for `pollFeeds`: same-origin only, no private address, in-origin redirects, one second between requests to a host. */
export function guardedFetch(d: GuardDeps): FetchFn {
  const sleep = d.sleep ?? real;
  const lastHost = new Set<string>();
  const refuse = (reason: Refusal): never => {
    d.onRefused?.(reason);
    throw new FetchRefused(reason);
  };
  const check = async (url: string): Promise<URL> => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return refuse("not_https");
    }
    if (u.protocol !== "https:") return refuse("not_https");
    if (u.username !== "" || u.password !== "") return refuse("off_origin");
    if (!d.origins.has(u.origin)) return refuse("off_origin");
    if (isPrivateHost(u.hostname)) return refuse("private_address");
    if (d.resolve !== undefined) {
      let answers: readonly string[];
      try {
        answers = await d.resolve(u.hostname);
      } catch {
        answers = [];
      }
      if (answers.some(isPrivateAddress)) return refuse("private_address");
    }
    return u;
  };
  return async (url, init) => {
    let current = url;
    const first = await check(url);
    for (let hop = 0; ; hop++) {
      const u = hop === 0 ? first : await check(current);
      if (lastHost.has(u.origin)) await sleep(GUARD_LIMITS.spacingMs);
      lastHost.add(u.origin);
      const r = await d.fetch(current, { headers: init.headers, redirect: "manual" });
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        if (hop >= GUARD_LIMITS.maxRedirects) return refuse("too_many_redirects");
        const loc = r.headers.get("location");
        let next: URL | null = null;
        try {
          next = loc === null || loc === "" ? null : new URL(loc, current);
        } catch {
          next = null;
        }
        if (next === null || next.origin !== u.origin) return refuse("redirect_off_origin");
        current = next.href;
        continue;
      }
      return {
        status: r.status,
        headers: r.headers,
        text: async () => (await r.text()).slice(0, GUARD_LIMITS.maxBodyChars),
      };
    }
  };
}
