// The US nightly fetch step (M20 US1; D-1092, D-1093, D-1094, D-1132, D-1180). Runs in the production workflow job right
// before the database step, BEHIND the same gates as every US write: the market must be enabled (the EDGAR client
// asserts it before any request, AT-70), each source must be `enabled` in the register (the polite client's gate) and
// EDGAR needs the declared contact (`PRAXIS_EDGAR_CONTACT`, never defaulted). Nothing here writes to the database.
// It fills the feeds file the database step reads (`feeds.mjs`):
//   - EDGAR: the ticker -> CIK map, the daily form index (who filed today), the submissions of the covered companies
//     that filed, and the Form 4 and 13D/G documents of those filings. Skipped with the word `contact_missing` when the
//     contact is unset;
//   - FINRA: the daily short-sale volume file of the target date;
//   - Nasdaq: the trade-halt RSS; the SEC trading-suspension feed (EDGAR contact, D-1142);
//   - the index CSVs are a manual upload (register row us_sp_dji_russell_manual), read from `--index-dir` when given;
//   - bars: NO source (D-1132). The bars file comes from the seam the Owner enables later; this step does not make it.
// Every source is isolated: a refusal or an error is one fixed word in the log and the feed is left out; the output is
// counts and words only, never a URL, a code list or a body.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createEdgarClient,
  edgarUserAgent,
  EdgarContactMissing,
  submissionsUrl,
} from "../../../src/lib/data/sources/us/edgar.mjs";
import {
  createPoliteFetch,
  isPoliteFetchRefused,
} from "../../../src/lib/data/sources/politeFetch.mjs";
import { assertMarketEnabled } from "../../../src/lib/market/guard.mjs";
import { staticProfile } from "../../../src/lib/market/staticProfile.mjs";
import { parseSubmissions } from "../../../src/lib/data/sources/us/submissions.mjs";
import { isSchedule13 } from "../../../src/lib/data/sources/us/schedule13.mjs";
import { buildFeeds } from "./feeds.mjs";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUSPENSIONS_URL = "https://www.sec.gov/rss/litigation/suspensions.xml";
const HALTS_URL = "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts";
const finraUrl = (d) =>
  `https://cdn.finra.org/equity/regsho/daily/CNMSshvol${d.replaceAll("-", "")}.txt`;
const MAX_FILERS = 600;

/** The daily form index: fixed columns, `Form Type  Company Name  CIK  Date Filed  File Name`. @param {string} text */
export function parseDailyIndex(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+(?: \S+)?)\s{2,}.+?\s{2,}(\d{1,10})\s+(\d{8})\s+(edgar\/data\/\S+)\s*$/.exec(
      line,
    );
    if (m) rows.push({ form: m[1], cik: m[2], filed: m[3], file: m[4] });
  }
  return rows;
}

/** `edgar/data/<cik>/<accession>.txt` -> the accession number, or null. @param {string} file */
const accessionOfFile = (file) => {
  const m = /\/(\d{10}-\d{2}-\d{6})\.txt$/.exec(file);
  return m ? m[1] : null;
};

/** The raw ownership XML URL of a filing: the SEC's `primaryDocument` may carry an XSL folder that renders HTML. */
function documentUrl(cik, accession, primaryDocument) {
  const raw = (primaryDocument ?? "").replace(/^xsl[^/]*\//i, "");
  return `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, "")}/${accession.replaceAll("-", "")}/${raw}`;
}

const word = (e) =>
  e instanceof EdgarContactMissing
    ? "contact_missing"
    : isPoliteFetchRefused(e)
      ? `refused:${e.reason}`
      : e instanceof Error && e.name === "EdgarHttpError"
        ? `http_${e.status}`
        : e instanceof Error && e.name === "MarketNotEnabled"
          ? "market_not_enabled"
          : "error";

/**
 * @param {{ db: { execute: Function }, market: string, env: Record<string, string | undefined>, request: { codes: string[], end: string },
 *           fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number, indexCsv?: Record<string, string>,
 *           out?: (s: string) => void }} o
 * @returns {Promise<{ feeds: ReturnType<typeof buildFeeds>, outcome: Record<string, string> }>}
 */
export async function fetchNight(o) {
  const out = o.out ?? (() => {});
  const { db, market, env } = o;
  await assertMarketEnabled(db, market);
  /** @type {Record<string, string>} */
  const outcome = {};
  const covered = new Set(o.request.codes);
  const shared = { db, fetchImpl: o.fetchImpl, sleep: o.sleep, now: o.now };
  const edgar = createEdgarClient({ ...shared, market, env });
  const polite = createPoliteFetch(shared);
  const submissions = {};
  const documents = {};
  let suspensions = null;
  let finra = null;
  let halts = null;

  // ---- EDGAR ----
  try {
    edgarUserAgent(env); // the contact first: nothing is requested without it
    const tickers = await edgar.getJson(TICKERS_URL);
    const cikToCode = new Map();
    for (const v of Object.values(tickers ?? {})) {
      const code = String(v?.ticker ?? "").toUpperCase();
      if (covered.has(code)) cikToCode.set(String(v.cik_str).replace(/^0+/, ""), code);
    }
    const [y, m] = o.request.end.split("-");
    const idxUrl = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${Math.ceil(Number(m) / 3)}/form.${o.request.end.replaceAll("-", "")}.idx`;
    const filers = new Set();
    for (const r of parseDailyIndex(await edgar.getText(idxUrl))) {
      const cik = r.cik.replace(/^0+/, "");
      if (cikToCode.has(cik)) filers.add(cik);
    }
    let n = 0;
    for (const cik of [...filers].slice(0, MAX_FILERS)) {
      const code = cikToCode.get(cik);
      const json = await edgar.getJson(submissionsUrl(cik));
      submissions[code] = json;
      n += 1;
      for (const f of parseSubmissions(json).filings) {
        const isNotice = f.form === "4" || f.form === "4/A" || isSchedule13(f.form);
        if (!isNotice || f.filedDate !== o.request.end || f.primaryDocument === null) continue;
        try {
          documents[f.accession] = await edgar.getText(
            documentUrl(cik, f.accession, f.primaryDocument),
          );
        } catch {
          /* one unreadable document leaves that notice out, nothing else */
        }
      }
    }
    outcome.edgar = `ok:${n}`;
  } catch (e) {
    outcome.edgar = word(e);
  }

  // ---- the SEC suspension feed (needs the contact too, D-1142) ----
  try {
    const userAgent = edgarUserAgent(env);
    const res = await polite.fetch(SUSPENSIONS_URL, { source: "us_sec_suspensions", userAgent });
    suspensions = res.status === 200 ? await res.text() : null;
    outcome.suspensions = res.status === 200 ? "ok" : `http_${res.status}`;
  } catch (e) {
    outcome.suspensions = word(e);
  }

  // ---- FINRA and Nasdaq (public files, no contact) ----
  for (const [name, url, source] of [
    ["finra", finraUrl(o.request.end), "us_finra_short"],
    ["halts", HALTS_URL, "us_nasdaq_halts"],
  ]) {
    try {
      const res = await polite.fetch(url, { source });
      const text = res.status === 200 ? await res.text() : null;
      if (name === "finra") finra = text;
      else halts = text;
      outcome[name] = res.status === 200 ? "ok" : `http_${res.status}`;
    } catch (e) {
      outcome[name] = word(e);
    }
  }

  const feeds = buildFeeds({
    submissions,
    documents,
    finraDaily: finra,
    halts,
    suspensions,
    indexCsv: o.indexCsv,
  });
  out(
    `us_fetch: ${Object.entries(outcome)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  return { feeds, outcome };
}

const has = (v) => typeof v === "string" && v.trim() !== "";
const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 && has(args[i + 1]) ? args[i + 1] : null;
};

/** CLI: `node scripts/ingest/us/fetch.mjs --market US --request request.json --feeds-output feeds.json [--index-dir dir]` */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const [{ scriptDb }, { resolveScriptMarket, takeMarketFlag }] = await Promise.all([
    import("../../../src/lib/db/scriptClient.mjs"),
    import("../../../src/lib/market/scriptMarket.mjs"),
  ]);
  const mk = takeMarketFlag(argv);
  if (mk.error) {
    out(`us_fetch: failed (${mk.error})`);
    return 2;
  }
  const reqPath = flag(mk.argv, "--request");
  const outPath = flag(mk.argv, "--feeds-output");
  if (reqPath === null || outPath === null) {
    out("us_fetch: failed (--request <file> --feeds-output <file> are required)");
    return 2;
  }
  if (
    !has(env.TURSO_MAIN_URL) ||
    (!has(env.TURSO_MAIN_TOKEN) && !String(env.TURSO_MAIN_URL).startsWith("file:"))
  ) {
    out("us_fetch: failed (database not configured)");
    return 1;
  }
  const db =
    deps.openDb?.() ??
    scriptDb({
      url: env.TURSO_MAIN_URL,
      token: has(env.TURSO_MAIN_TOKEN) ? env.TURSO_MAIN_TOKEN : undefined,
    });
  try {
    const m = await resolveScriptMarket(db, mk.market);
    if (!m.ok) {
      out(`us_fetch: ${m.line}`);
      return m.exit;
    }
    const request = JSON.parse(readFileSync(reqPath, "utf8"));
    const indexDir = flag(mk.argv, "--index-dir");
    const indexCsv = {};
    if (indexDir !== null) {
      const prof = staticProfile(m.market);
      for (const f of [
        prof.fields.regime_index?.value?.code,
        prof.fields.volatility_index?.value?.code,
      ]) {
        if (typeof f !== "string") continue;
        try {
          indexCsv[f] = readFileSync(path.join(indexDir, `${f}.csv`), "utf8");
        } catch {
          /* an absent upload is no feed */
        }
      }
    }
    const { feeds } = await fetchNight({ db, market: m.market, env, request, indexCsv, out });
    writeFileSync(outPath, JSON.stringify(feeds));
    return 0;
  } catch {
    out("us_fetch: failed (unexpected error)");
    return 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
