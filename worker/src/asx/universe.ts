// ASX listed-companies import, Worker side (M2 T11, D-067). HIGH-RISK: contacts asx.com.au and
// posts a signed file to the app. Opus reviews every line.
//
// What it does: once per trading day, at the `universe` slot (07:30 Sydney, an even minute that is
// never a poll minute: polls are due at 07:28 and 07:32), it fetches ASX's listed-companies CSV
// through the shared rate token at priority 3 and POSTs the raw text (at most 1 MB) to the app's
// signed route `POST /api/internal/universe-import`, which parses and applies it. The Worker does
// not parse the file; the app does (src/lib/data/universe/).
//
// Spec / decision text: DAT-122 (slots, priorities, token), DAT-123 (kill switch), DAT-120 / O-23
// (the Owner's acceptance also covers this file), DAT-130 (universe, delisted kept forever), D-067.
//
// Switches, cheapest first, and NO database work until the local ones pass (identical in spirit to
// the poll in slots.ts):
//   1. the slot is due this minute (weekday, 07:30 Sydney);
//   2. ASX_LIVE is "1";                         log "universe: skipped (ASX_LIVE off)"
//   3. PRAXIS_ENV is production;                log "universe: skipped (not production)"
//   4. database configured;
//   5. identifying ASX_USER_AGENT;
//   6. APP_BASE_URL (https) and WORKER_HMAC_SECRET set (no token is spent on a file that could not
//      be delivered).
//   Then ONE read: asx_enabled, market mode, holiday, source_register for BOTH `asx_announcements`
//   and `asx_listed_companies` (both must be `enabled`), then the token (which re-checks the kill
//   switch and the source status), then the fetch, then the outcome record, then the POST.
//   Worst case 4 of 50 database subrequests (5 when the trip fires) plus the ASX fetch and the POST.
// Logs carry fixed words and numbers only: never a URL, a header, a secret or file content.
import { dbConfigured, pipeline } from "../db";
import { isWeekend, sydneyLocal, type Local } from "../localtime";
import { randomHex, signHeaders } from "../selfcheck";
import {
  ASX_ENABLED_KEY,
  classifyResponse,
  parseOn,
  parseRetryAfter,
  type Outcome,
} from "./policy";
import { buildListedCompaniesRequest } from "./request";
import type { AsxDeps, AsxEnv } from "./slots";
import { acquire, recordOutcome } from "./token";

export const UNIVERSE_SLOT_MIN = 7 * 60 + 30;
export const UNIVERSE_PRIORITY = 3;
export const UNIVERSE_ROUTE = "/api/internal/universe-import";
export const UNIVERSE_PURPOSE = "universe-import";
/** The CSV must be at most 1 MB (the app enforces the same cap). */
export const MAX_CSV_BYTES = 1_048_576;
export const POST_TIMEOUT_MS = 25_000;
const ANNOUNCEMENTS_SOURCE = "asx_announcements";
const LISTED_SOURCE = "asx_listed_companies";
const KNOWN_ERRORS = new Set(["unrecognised_format", "suspicious_shrink"]);

export type UniverseEnv = AsxEnv & { APP_BASE_URL?: string; WORKER_HMAC_SECRET?: string };

/** Pure: is the universe import wanted at this Sydney minute? (Weekday, 07:30.) */
export function universeDue(local: Local): boolean {
  return !isWeekend(local) && local.minute === UNIVERSE_SLOT_MIN;
}

export type UniverseSummary = {
  /** Why nothing was requested (fixed words), or null when the file was requested. */
  skipped: string | null;
  outcome: Outcome | null;
  tripped: boolean;
  /** Database requests made (subrequests, not counting the ASX fetch or the POST). */
  requests: number;
  fetched: number;
  /** HTTP status of the app's answer, or null when nothing was posted / no answer. */
  delivered: number | null;
};

function routeUrl(base: string | undefined): string | null {
  if (typeof base !== "string" || base.trim() === "") return null;
  try {
    const u = new URL(base.trim());
    if (u.protocol !== "https:") return null;
    return new URL(UNIVERSE_ROUTE, u.origin).toString();
  } catch {
    return null;
  }
}

const str = (v: string | number | null | undefined): string | null =>
  typeof v === "string" ? v : null;

/** One tick. Never throws. Does nothing, and logs nothing, off the universe slot. */
export async function runUniverse(
  env: UniverseEnv,
  scheduledTime: number,
  deps: AsxDeps,
): Promise<UniverseSummary> {
  const sum: UniverseSummary = {
    skipped: null,
    outcome: null,
    tripped: false,
    requests: 0,
    fetched: 0,
    delivered: null,
  };
  try {
    const local = sydneyLocal(scheduledTime);
    if (!universeDue(local)) return sum;
    const skip = (why: string, line: string): UniverseSummary => {
      sum.skipped = why;
      console.log(`universe: skipped (${line})`);
      return sum;
    };
    if (env.ASX_LIVE !== "1") return skip("live-off", "ASX_LIVE off");
    if (env.PRAXIS_ENV !== "production") return skip("not-production", "not production");
    if (!dbConfigured(env)) return skip("no-db", "database not configured");
    if (buildListedCompaniesRequest(env.ASX_USER_AGENT) === null) {
      return skip("no-user-agent", "no identifying user agent");
    }
    const url = routeUrl(env.APP_BASE_URL);
    const secret = (env.WORKER_HMAC_SECRET ?? "").trim();
    if (url === null || secret === "") return skip("no-app", "app not configured");

    // ---- request 1: kill switch, market mode, holiday, both source acceptances ----------------
    sum.requests++;
    try {
      const [state, mode, cal, reg] = await pipeline(
        env,
        [
          { sql: "SELECT value_json FROM worker_state WHERE key = ?", args: [ASX_ENABLED_KEY] },
          { sql: "SELECT mode FROM market WHERE code = 'AU'" },
          {
            sql: "SELECT kind FROM trading_calendar WHERE market = 'AU' AND d = ?",
            args: [local.date],
          },
          {
            sql: "SELECT source, status FROM source_register WHERE source IN (?, ?)",
            args: [ANNOUNCEMENTS_SOURCE, LISTED_SOURCE],
          },
        ],
        deps.fetch,
      );
      if (!parseOn(str(state.rows[0]?.[0]))) return skip("disabled", "asx_enabled off");
      const m = str(mode.rows[0]?.[0]);
      if (m === null || m === "off") return skip("market-off", "market off");
      if (str(cal.rows[0]?.[0]) === "holiday") return skip("holiday", "holiday");
      const status = new Map(reg.rows.map((r) => [str(r[0]), str(r[1])]));
      if (status.get(ANNOUNCEMENTS_SOURCE) !== "enabled") {
        return skip("source-not-accepted", "ASX source not accepted");
      }
      if (status.get(LISTED_SOURCE) !== "enabled") {
        return skip("listed-not-accepted", "listed-companies source not accepted");
      }
    } catch {
      return skip("db-error", "database error");
    }

    // ---- request 2: the token ---------------------------------------------------------------
    sum.requests++;
    const got = await acquire(env, deps.nowMs(), UNIVERSE_PRIORITY, deps.fetch);
    if (!got.granted) return skip(`denied-${got.reason}`, `denied: ${got.reason}`);

    // ---- the one ASX request ------------------------------------------------------------------
    const req = buildListedCompaniesRequest(env.ASX_USER_AGENT);
    let outcome: Outcome = "error";
    let retryAfterS: number | null = null;
    let csv: string | null = null;
    if (req !== null) {
      try {
        sum.fetched++;
        const res = await deps.fetch(req.url, req.init);
        const ct = res.headers.get("content-type");
        const declared = res.headers.get("content-length");
        if (declared !== null && Number(declared) > MAX_CSV_BYTES) {
          outcome = "error"; // too large: the body is not read
        } else {
          let body = "";
          try {
            body = await res.text();
          } catch {
            body = "";
          }
          outcome = classifyResponse(res.status, ct, body.slice(0, 4000));
          if (outcome === "rate_limited") {
            retryAfterS = parseRetryAfter(res.headers.get("retry-after"));
          }
          if (outcome === "ok") {
            // No If-None-Match is sent, so anything but a plain 200 CSV of acceptable size is not
            // forwarded and counts as an error.
            const isHtml = (ct ?? "").toLowerCase().includes("text/html");
            const size = new TextEncoder().encode(body).length;
            if (res.status !== 200 || isHtml || size === 0 || size > MAX_CSV_BYTES) {
              outcome = "error";
            } else csv = body;
          }
        }
      } catch {
        outcome = "error";
      }
    }
    sum.outcome = outcome;

    // ---- request 3 (and 4 only when the trip fires): record the outcome ---------------------
    sum.requests++;
    const rec = await recordOutcome(env, deps.nowMs(), outcome, deps.fetch, { retryAfterS });
    sum.tripped = rec.tripped;
    if (rec.tripped) sum.requests++;
    console.log(`universe: ${outcome}`);

    // ---- deliver to the app, signed ---------------------------------------------------------
    if (csv === null) return sum;
    try {
      const body = JSON.stringify({
        purpose: UNIVERSE_PURPOSE,
        env: env.PRAXIS_ENV,
        d: local.date,
        csv,
      });
      const headers = await signHeaders(
        secret,
        body,
        Math.floor(deps.nowMs() / 1000),
        randomHex(16),
      );
      const res = await deps.fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        redirect: "manual", // a redirect must never carry the signed request elsewhere
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      sum.delivered = res.status;
      if (res.status === 200) console.log("universe: import accepted");
      else {
        let why = "";
        try {
          const j = (await res.json()) as { error?: unknown };
          if (typeof j.error === "string" && KNOWN_ERRORS.has(j.error)) why = `, ${j.error}`;
        } catch {
          why = "";
        }
        console.log(`universe: import rejected (HTTP ${res.status}${why})`);
      }
    } catch {
      console.log("universe: import not delivered");
    }
  } catch {
    console.log("universe: error");
  }
  return sum;
}
