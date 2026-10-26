// ASX fetch step (D-194), run on a GitHub runner WITHOUT any secret: asx.com.au answers GitHub's
// runners but blocks the Cloudflare Worker (asx_block_trip, 403/challenge). Writes into --out-dir:
//   feed.json      the market-wide announcements of the last ~48 h (paged, newest first)
//   companies.csv  the ASX listed-companies file (the universe import reads it once a day)
//   history-NNN.json with --history: each listed company's latest announcements (a one-off
//                  fill), in chunks of HISTORY_CHUNK items
// Politeness (DAT-122): one request at a time, MIN_GAP_MS between requests, an identifying
// User-Agent (vars.ASX_USER_AGENT), metadata only (no PDF is fetched). A failed request is counted,
// never retried in a loop; the commit step stores what arrived. Output: counts only.
//   node scripts/asx/fetch.mjs --out-dir <dir> [--history]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyFeedUrl, marketFeedUrl } from "../../src/lib/data/sources/asxMarkit.mjs";

export const COMPANIES_URL = "https://www.asx.com.au/asx/research/ASXListedCompanies.csv";
const MIN_GAP_MS = 700;
const PER_PAGE = 100;
const MAX_PAGES = 20;
export const HISTORY_CHUNK = 2000;
const WINDOW_MS = 48 * 3_600_000;
const TIMEOUT_MS = 20_000;
const DEFAULT_UA = "praxis-research/1.0 (personal, non-commercial; end-of-day research)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One polite GET: the body as text, or null with the status counted by the caller. */
async function get(url, ua, fetchImpl = fetch) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { "user-agent": ua }, signal: ctl.signal });
    return { status: res.status, body: res.ok ? await res.text() : null };
  } catch {
    return { status: 0, body: null };
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
  const stats = { requests: 0, failed: 0, feedItems: 0, companies: 0, historyItems: 0 };
  const call = async (url) => {
    if (stats.requests > 0) await wait(MIN_GAP_MS);
    stats.requests += 1;
    const r = await get(url, ua, o.fetchImpl);
    if (r.body === null) stats.failed += 1;
    return r.body;
  };

  // market-wide feed: pages until the window is covered
  const items = [];
  const since = o.nowMs - WINDOW_MS;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await call(marketFeedUrl(page, PER_PAGE));
    if (body === null) break;
    let list;
    try {
      list = JSON.parse(body)?.data?.items;
    } catch {
      break;
    }
    if (!Array.isArray(list) || list.length === 0) break;
    items.push(...list);
    const oldest = Date.parse(list[list.length - 1]?.date ?? "");
    if (!(oldest > since)) break;
  }
  stats.feedItems = items.length;
  const files = { "feed.json": JSON.stringify({ data: { items } }) };

  const csv = await call(COMPANIES_URL);
  if (csv !== null) {
    files["companies.csv"] = csv;
    stats.companies = codesOf(csv).length;
  }

  if (o.history && csv !== null) {
    const hist = [];
    for (const code of codesOf(csv)) {
      const body = await call(companyFeedUrl(code));
      if (body === null) continue;
      try {
        const list = JSON.parse(body)?.data?.items;
        if (Array.isArray(list)) for (const it of list) hist.push({ ...it, symbol: code });
      } catch {
        stats.failed += 1;
      }
    }
    stats.historyItems = hist.length;
    // Chunks: the feed parser takes at most MAX_FEED_ITEMS (5000) per file (D-197).
    for (let i = 0; i * HISTORY_CHUNK < hist.length; i++) {
      const items = hist.slice(i * HISTORY_CHUNK, (i + 1) * HISTORY_CHUNK);
      files[`history-${String(i + 1).padStart(3, "0")}.json`] = JSON.stringify({ data: { items } });
    }
  }
  return { files, stats };
}

async function main(argv) {
  const i = argv.indexOf("--out-dir");
  const dir = i >= 0 ? argv[i + 1] : null;
  if (!dir) {
    console.log("asx-fetch: failed (usage: --out-dir <dir> [--history])");
    return 2;
  }
  const { files, stats } = await fetchAll({
    nowMs: Date.now(),
    history: argv.includes("--history"),
    ua: process.env.ASX_USER_AGENT,
  });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  console.log(
    `asx-fetch: requests=${stats.requests} failed=${stats.failed} feed_items=${stats.feedItems}` +
      ` companies=${stats.companies} history_items=${stats.historyItems}`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
