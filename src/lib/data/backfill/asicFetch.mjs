// Polite ASIC short-position fetcher for the backfill (M2 T9; DAT-125a). Runs in a workflow step
// that has NO secrets (no database, no data-repo token). It is the only code of the backfill that
// contacts an external source. ASIC is a public, non-ASX source, so it does not use the ASX rate
// token (DAT-122 covers asx.com.au only); it still behaves politely:
//  - one request at a time, at least ASIC_MIN_GAP_MS between requests (default 1.5 s);
//  - an identifying User-Agent (never a browser string), GET only, no cookies, no redirects;
//  - the host is fixed (ASIC_HOST); a 403, 429, a challenge page or any other error stops the whole
//    run at once (no retry loop, no hammering); 404 means "no file that day" (weekend, holiday,
//    before the archive began);
//  - body size and time are bounded; nothing but counts and statuses is ever logged.
import { ASIC_HOST, ASIC_MIN_GAP_MS, asicUrl, parseAsicCsv } from "./rules.mjs";

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const UA_MAX = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CHALLENGE = ["just a moment", "cf-chl", "captcha", "access denied", "attention required"];

/** An identifying User-Agent (printable, not a browser string) or null. @param {unknown} ua */
export function validUserAgent(ua) {
  if (typeof ua !== "string") return null;
  const t = ua.trim();
  if (t === "" || t.length > UA_MAX || CONTROL_RE.test(t) || /^Mozilla\/5\.0/i.test(t)) return null;
  return t;
}

/**
 * @param {{ months: { month: string, dates: string[] }[], userAgent: string,
 *   fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, minGapMs?: number }} o
 * @returns {Promise<{ months: { month: string, complete: boolean, dates: number, absent: number,
 *   skipped: number, rows: object[] }[], stopped: null | "blocked" | "rate_limited" | "http_error" | "malformed" | "network" }>}
 */
/**
 * Decode by byte-order mark: ASIC files up to mid-2022 are UTF-16LE with a BOM, later ones UTF-8.
 * @param {Uint8Array} buf
 */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buf.subarray(2));
  }
  return new TextDecoder("utf-8").decode(buf);
}

export async function fetchAsicMonths(o) {
  const ua = validUserAgent(o.userAgent);
  if (ua === null) throw new Error("an identifying User-Agent is required");
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const gap = Math.max(ASIC_MIN_GAP_MS, o.minGapMs ?? ASIC_MIN_GAP_MS);
  const out = [];
  let first = true;
  for (const m of o.months) {
    const rec = {
      month: m.month,
      complete: false,
      dates: m.dates.length,
      absent: 0,
      skipped: 0,
      rows: [],
    };
    out.push(rec);
    for (const date of m.dates) {
      if (!first) await sleep(gap);
      first = false;
      const url = asicUrl(date);
      if (new URL(url).hostname !== ASIC_HOST) throw new Error("host not allowed");
      let res;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          headers: { "User-Agent": ua, Accept: "text/csv, text/plain;q=0.8" },
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return { months: out, stopped: "network" };
      }
      if (res.status === 404) {
        rec.absent++;
        continue;
      }
      if (res.status === 429) return { months: out, stopped: "rate_limited" };
      if (res.status === 403) return { months: out, stopped: "blocked" };
      if (res.status !== 200) return { months: out, stopped: "http_error" };
      let text;
      try {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length > MAX_BODY_BYTES) return { months: out, stopped: "malformed" };
        text = decodeText(buf);
      } catch {
        return { months: out, stopped: "network" };
      }
      const ct = (res.headers.get("content-type") ?? "").toLowerCase();
      const head = text.slice(0, 2000).toLowerCase();
      if (ct.includes("text/html") && CHALLENGE.some((c) => head.includes(c))) {
        return { months: out, stopped: "blocked" };
      }
      const parsed = parseAsicCsv(text, date);
      if ("error" in parsed) return { months: out, stopped: "malformed" };
      rec.skipped += parsed.skipped;
      rec.rows.push(...parsed.rows);
    }
    rec.complete = true;
  }
  return { months: out, stopped: null };
}
