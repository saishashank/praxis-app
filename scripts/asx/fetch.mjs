// ASX fetch step (D-194), run on a GitHub runner WITHOUT any secret: asx.com.au answers GitHub's
// runners but blocks the Cloudflare Worker (asx_block_trip, 403/challenge). Writes into --out-dir:
//   feed.json      the market-wide announcements of the last ~48 h (paged, newest first)
//   companies.csv  the ASX listed-companies file (the universe import reads it once a day)
//   history-NNN.json with --history: each listed company's latest announcements (a one-off
//                  fill), in chunks of HISTORY_CHUNK items
//   fetch-status.json  per-request causes for the store step (DAT-251 a, D-972): counts and codes only
//   companies-wikidata.csv  only when the listed-companies file failed 3 runs in a row AND the
//                  `wikidata_asx` register row is enabled (DAT-252, D-974); one request
// Politeness (DAT-122): one request at a time, MIN_GAP_MS between requests, an identifying
// User-Agent (vars.ASX_USER_AGENT), metadata only (no PDF is fetched). A failed request is counted,
// never retried in a loop; the commit step stores what arrived.
//
// DAT-251 a (D-972): every request gets a cause: ok | not_found (404) | rate_limited (429) |
// server_error (5xx and every other refusal, 401/403 included: a block must never look like a
// delisting) | network (no answer) | parse (the body is not the JSON we expect). A 429 widens the gap
// (Retry-After, capped at MAX_RETRY_AFTER_MS, else doubled) and the history loop stops when the run
// budget (ASX_FETCH_BUDGET_MS, default 8 minutes) is spent; the codes left over wait for the next run.
// A parse failure records the SHA-256 of the body, never the body.
//   node scripts/asx/fetch.mjs --out-dir <dir> [--history] [--state <state.json>]
// state.json (written by the store step's `--write-state`, read-only): { delisted: string[],
// consecutiveFailures: number, wikidataEnabled: boolean }. Absent = no skip list, no fallback.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyFeedUrl, marketFeedUrl } from "../../src/lib/data/sources/asxMarkit.mjs";
import { convert } from "../data/universe-from-wikidata.mjs";

export const COMPANIES_URL = "https://www.asx.com.au/asx/research/ASXListedCompanies.csv";
// DAT-252 (D-974): one fixed SPARQL query against Wikidata's public endpoint. Q732670 is the
// Australian Securities Exchange (Wikidata search, 2026-11-11); the P414 statement with a P249
// (ticker symbol) qualifier is the standard shape. [VERIFY] the result shape on the first enabled run.
export const WIKIDATA_QUERY =
  "SELECT ?code ?companyLabel ?industryLabel WHERE { ?company p:P414 ?s . ?s ps:P414 wd:Q732670 ; pq:P249 ?code . " +
  "OPTIONAL { ?company wdt:P452 ?industry . } SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\" . } }";
export const WIKIDATA_URL = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(WIKIDATA_QUERY)}`;
export const FALLBACK_AFTER_RUNS = 3; // threshold-ok: DAT-252 "three failed runs"
const MIN_GAP_MS = 700;
const MAX_GAP_MS = 60_000; // threshold-ok: a doubled gap never exceeds a minute
export const MAX_RETRY_AFTER_MS = 60_000; // threshold-ok: DAT-251 a, Retry-After capped at 60 s
export const DEFAULT_BUDGET_MS = 8 * 60_000; // threshold-ok: 8 of the 30 minutes between runs
const PER_PAGE = 100;
const MAX_PAGES = 20;
export const HISTORY_CHUNK = 2000;
const WINDOW_MS = 48 * 3_600_000;
const TIMEOUT_MS = 20_000;
const DEFAULT_UA = "praxis-research/1.0 (personal, non-commercial; end-of-day research)";

export const CAUSES = ["ok", "not_found", "rate_limited", "server_error", "network", "parse"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The cause of a finished request (before any parsing). */
export function causeOf(status) {
  if (status === 0) return "network";
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "server_error";
}

/** Retry-After in whole seconds as milliseconds, capped; anything else is null. */
export function retryAfterMs(v) {
  if (typeof v !== "string" || !/^\d{1,6}$/.test(v.trim())) return null;
  return Math.min(Number(v.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

/** One polite GET: status, cause, the body as text when ok, and the Retry-After wait. */
async function get(url, ua, fetchImpl = fetch, accept) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const headers = { "user-agent": ua };
    if (accept) headers.accept = accept;
    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    const status = res.status ?? (res.ok ? 200 : 0);
    const cause = causeOf(status);
    return {
      status,
      cause,
      body: cause === "ok" ? await res.text() : null,
      retryAfter: retryAfterMs(res.headers?.get?.("retry-after") ?? undefined),
    };
  } catch {
    return { status: 0, cause: "network", body: null, retryAfter: null };
  } finally {
    clearTimeout(t);
  }
}

/** Codes of the listed-companies CSV (header rows skipped). */
export function codesOf(csv) {
  const out = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = /^"[^"]*","([A-Z0-9]{1,6})",/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

export async function fetchAll(o) {
  const ua = o.ua || DEFAULT_UA;
  const wait = o.sleep ?? sleep;
  const clock = o.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs = o.budgetMs ?? DEFAULT_BUDGET_MS;
  const state = o.state ?? { delisted: [], consecutiveFailures: 0, wikidataEnabled: false };
  const skip = new Set(state.delisted ?? []);
  const stats = {
    requests: 0,
    failed: 0,
    feedItems: 0,
    companies: 0,
    historyItems: 0,
    causes: Object.fromEntries(CAUSES.map((c) => [c, 0])),
    parseFailures: [],
    notFound: [],
    attempted: [],
    skippedDelisted: 0,
    historyAttempted: 0,
    historyLeft: 0,
    budgetStop: false,
    companiesCause: null,
    fallback: "off",
  };
  let gap = MIN_GAP_MS;
  const note = (cause) => {
    stats.causes[cause] += 1;
    if (cause !== "ok") stats.failed += 1;
  };
  const call = async (url, accept) => {
    if (stats.requests > 0) await wait(gap);
    stats.requests += 1;
    const r = await get(url, ua, o.fetchImpl, accept);
    if (r.cause === "rate_limited") gap = r.retryAfter ?? Math.min(gap * 2, MAX_GAP_MS);
    return r;
  };
  /** A JSON body that must hold `data.items`: a parse failure is recorded by hash only. */
  const json = (r, label, pick) => {
    try {
      return pick(JSON.parse(r.body));
    } catch {
      note("parse");
      stats.parseFailures.push({ code: label, sha256: sha256(r.body) });
      return undefined;
    }
  };

  // market-wide feed: pages until the window is covered
  const items = [];
  const since = o.nowMs - WINDOW_MS;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await call(marketFeedUrl(page, PER_PAGE));
    if (r.body === null) {
      note(r.cause);
      break;
    }
    const list = json(r, "feed", (j) => {
      const l = j?.data?.items;
      if (!Array.isArray(l)) throw new Error("shape");
      return l;
    });
    if (list === undefined) break;
    note("ok");
    if (list.length === 0) break;
    items.push(...list);
    const oldest = Date.parse(list[list.length - 1]?.date ?? "");
    if (!(oldest > since)) break;
  }
  stats.feedItems = items.length;
  const files = { "feed.json": JSON.stringify({ data: { items } }) };

  const c = await call(COMPANIES_URL);
  stats.companiesCause = c.cause;
  note(c.cause);
  const csv = c.body;
  if (csv !== null) {
    files["companies.csv"] = csv;
    stats.companies = codesOf(csv).length;
  }

  // DAT-252 (D-974): the third failed run in a row, and only when the Owner enabled the register row.
  if (csv === null && (state.consecutiveFailures ?? 0) + 1 >= FALLBACK_AFTER_RUNS) {
    if (state.wikidataEnabled === true) {
      const w = await call(WIKIDATA_URL, "application/sparql-results+json");
      stats.fallback = "requested";
      if (w.body === null) {
        note(w.cause);
        stats.fallback = "failed";
      } else {
        const conv = json(w, "wikidata", (j) => {
          const r = convert(j);
          if (!r.ok) throw new Error("shape");
          return r;
        });
        if (conv !== undefined) {
          note("ok");
          files["companies-wikidata.csv"] = conv.csv;
          stats.companies = conv.stats.written;
          stats.fallback = "ok";
        } else stats.fallback = "failed";
      }
    } else stats.fallback = "disabled";
  }

  if (o.history && csv !== null) {
    const hist = [];
    const all = codesOf(csv);
    const codes = all.filter((x) => !skip.has(x));
    stats.skippedDelisted = all.length - codes.length;
    for (let i = 0; i < codes.length; i += 1) {
      if (clock() - startedAt >= budgetMs) {
        stats.budgetStop = true;
        stats.historyLeft = codes.length - i;
        break;
      }
      const code = codes[i];
      const r = await call(companyFeedUrl(code));
      stats.historyAttempted += 1;
      stats.attempted.push(code);
      if (r.body === null) {
        note(r.cause);
        if (r.cause === "not_found") stats.notFound.push(code);
        continue;
      }
      const list = json(r, code, (j) => {
        const l = j?.data?.items;
        if (!Array.isArray(l)) throw new Error("shape");
        return l;
      });
      if (list === undefined) continue;
      note("ok");
      for (const it of list) hist.push({ ...it, symbol: code });
    }
    stats.historyItems = hist.length;
    // Chunks: the feed parser takes at most MAX_FEED_ITEMS (5000) per file (D-197).
    for (let i = 0; i * HISTORY_CHUNK < hist.length; i++) {
      const chunk = hist.slice(i * HISTORY_CHUNK, (i + 1) * HISTORY_CHUNK);
      files[`history-${String(i + 1).padStart(3, "0")}.json`] = JSON.stringify({
        data: { items: chunk },
      });
    }
  }
  // Counts and codes only: what the store step needs for code_history and source_fetch_status.
  files["fetch-status.json"] = JSON.stringify({
    companiesCause: stats.companiesCause,
    causes: stats.causes,
    notFound: stats.notFound,
    attempted: stats.attempted,
    historyAttempted: stats.historyAttempted,
    historyRan: o.history === true && csv !== null,
    fallback: stats.fallback,
  });
  return { files, stats };
}

function readState(file) {
  if (!file || !existsSync(file)) return undefined;
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return {
      delisted: Array.isArray(j.delisted) ? j.delisted.filter((x) => typeof x === "string") : [],
      consecutiveFailures: Number.isInteger(j.consecutiveFailures) ? j.consecutiveFailures : 0,
      wikidataEnabled: j.wikidataEnabled === true,
    };
  } catch {
    return undefined;
  }
}

async function main(argv) {
  const i = argv.indexOf("--out-dir");
  const dir = i >= 0 ? argv[i + 1] : null;
  if (!dir) {
    console.log("asx-fetch: failed (usage: --out-dir <dir> [--history] [--state <file>])");
    return 2;
  }
  const s = argv.indexOf("--state");
  const budget = Number(process.env.ASX_FETCH_BUDGET_MS);
  const { files, stats } = await fetchAll({
    nowMs: Date.now(),
    history: argv.includes("--history"),
    ua: process.env.ASX_USER_AGENT,
    state: readState(s >= 0 ? argv[s + 1] : undefined),
    budgetMs: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  const c = stats.causes;
  console.log(
    `asx-fetch: requests=${stats.requests} failed=${stats.failed} feed_items=${stats.feedItems}` +
      ` companies=${stats.companies} history_items=${stats.historyItems}` +
      ` causes=ok:${c.ok},not_found:${c.not_found},rate_limited:${c.rate_limited},` +
      `server_error:${c.server_error},network:${c.network},parse:${c.parse}` +
      ` skipped_delisted=${stats.skippedDelisted} budget_stop=${stats.budgetStop}` +
      ` history_left=${stats.historyLeft} fallback=${stats.fallback}`,
  );
  if (stats.parseFailures.length > 0) {
    console.log(`asx-fetch: parse_failures=${JSON.stringify(stats.parseFailures)}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
