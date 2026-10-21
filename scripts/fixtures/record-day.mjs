// Record one AU trading day for the private fixtures repo (M8 T9, D-155, decision O-26).
// OWNER-RUN, on the Owner's own machine, for personal non-commercial use (Yahoo terms accepted
// 2026-10-21). It fetches daily bars from the same Yahoo source and fields as
// scripts/ingest/yahoo_fetch.py (symbol <CODE>.AX, unadjusted OHLCV plus adj_close, index ^AXJO
// stored as AXJO) and writes
//   <out>/recorded/au/<date>/bars.json   and   <out>/recorded/au/<date>/index.json
// in the row shape src/lib/data/recorded/reader.mjs and scripts/ingest/recorded_day.mjs read.
//   node scripts/fixtures/record-day.mjs --out <fixtures-dir> [--date YYYY-MM-DD]
//        [--codes CODE,CODE] [--limit N] [--sessions N]
// The folder holds a WINDOW of sessions ending at --date (the staging redate step keeps the newest
// sessions that fit the run and drops the oldest). Default window: 260 sessions, which covers the
// longest indicator the nightly needs (F1 250-session high; SMA200; 126-session return).
// SEC-110: the data is written only into the fixtures checkout; --out inside this repo is refused.
// Prints counts and the folder only, never a row. Exit 0 ok, 2 usage/fetch error, 3 rate limited.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SESSIONS = 260;
export const DEFAULT_MIN_GAP_S = 5;
const GAP_BOUNDS = [1, 60];
const MAX_RETRIES = 2;
const BACKOFF_FACTOR = 4;
const USER_AGENT = "Mozilla/5.0 (compatible; praxis-record-day/1.0)";
const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/";
const INDEX_SYMBOL = "^AXJO";
const CODE_RE = /^[A-Z0-9]{2,6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A small fixed sample of large ASX codes (sorted). */
export const DEFAULT_CODES = Object.freeze(
  [
    "ANZ",
    "BHP",
    "BXB",
    "CBA",
    "COH",
    "COL",
    "CSL",
    "FMG",
    "GMG",
    "IAG",
    "JBH",
    "MQG",
    "NAB",
    "NCM",
    "ORG",
    "QAN",
    "QBE",
    "RIO",
    "S32",
    "SCG",
    "SHL",
    "STO",
    "SUN",
    "TCL",
    "TLS",
    "WBC",
    "WDS",
    "WES",
    "WOW",
    "XRO",
  ].sort(),
);

export class UsageError extends Error {}
export class RateLimitedError extends Error {}
export class FetchFailedError extends Error {}

const isIsoDate = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const shiftDate = (s, n) =>
  new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isWeekend = (s) => [0, 6].includes(new Date(`${s}T00:00:00Z`).getUTCDay());

const sydneyParts = (instant) => {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};

/** Holiday dates ('AU' kind 'holiday') from the repo's calendar seed; empty set if unreadable. */
export function readSeedHolidays(root = REPO_ROOT) {
  const out = new Set();
  try {
    const dir = path.join(root, "db", "migrations", "main");
    for (const f of fs.readdirSync(dir).filter((n) => /calendar_seed\.sql$/.test(n))) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/'AU',\s*'(\d{4}-\d{2}-\d{2})',\s*'holiday'/g)) out.add(m[1]);
    }
  } catch {
    /* fall back to weekdays only */
  }
  return out;
}

/** Most recent completed AU session: today only after 18:00 Sydney, else strictly before today. */
export function defaultDate(now, holidays) {
  const { date, hour } = sydneyParts(now);
  let d = hour >= 18 ? date : shiftDate(date, -1);
  while (isWeekend(d) || holidays.has(d)) d = shiftDate(d, -1);
  return d;
}

/** True when `out` is the repo or inside it (also through an existing symlinked ancestor). */
export function isInsideRepo(out, root = REPO_ROOT) {
  const real = (p) => {
    let cur = path.resolve(p);
    const tail = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...tail.reverse());
      } catch {
        const up = path.dirname(cur);
        if (up === cur) return path.resolve(p);
        tail.push(path.basename(cur));
        cur = up;
      }
    }
  };
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const rel = path.relative(norm(real(root)), norm(real(out)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const clean = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const vol = (v) => {
  const f = clean(v);
  return f !== null && Number.isInteger(f) ? f : null;
};

/** Rows from a Yahoo v8 chart payload (no repair; all-null days skipped). */
export function rowsFromChart(json, code, isIndex, fetchedAt) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const adj = r.indicators.adjclose?.[0]?.adjclose ?? [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]].map(clean);
    const a = clean(adj[i]);
    if ([o, h, l, c].every((x) => x === null) && (isIndex || a === null)) continue;
    const row = {
      code,
      date: sydneyParts(new Date(ts[i] * 1000)).date,
      open: o,
      high: h,
      low: l,
      close: c,
    };
    if (!isIndex) Object.assign(row, { volume: vol(q.volume?.[i]), adj_close: a });
    out.push({ ...row, source: "yahoo", published_at: null, fetched_at: fetchedAt });
  }
  return out;
}

function parseArgs(argv) {
  const known = new Set(["--out", "--date", "--codes", "--limit", "--sessions"]);
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || typeof argv[i + 1] !== "string" || argv[i + 1] === "") {
      throw new UsageError("unknown or incomplete option (see the usage line in record-day.mjs)");
    }
    o[argv[i].slice(2)] = argv[i + 1];
  }
  if (!o.out) throw new UsageError("--out <fixtures-dir> is required");
  if (o.date !== undefined && !isIsoDate(o.date)) throw new UsageError("--date must be YYYY-MM-DD");
  const int = (n, v, lo, hi) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < lo || x > hi) {
      throw new UsageError(`--${n} must be ${lo} to ${hi}`);
    }
    return x;
  };
  let codes = DEFAULT_CODES;
  if (o.codes !== undefined) {
    codes = [...new Set(o.codes.split(",").map((c) => c.trim().toUpperCase()))].sort();
    if (!codes.every((c) => CODE_RE.test(c))) {
      throw new UsageError("every code must be 2 to 6 letters or digits");
    }
  }
  if (o.limit !== undefined) codes = codes.slice(0, int("limit", o.limit, 1, 500));
  const sessions =
    o.sessions === undefined ? DEFAULT_SESSIONS : int("sessions", o.sessions, 1, 1300);
  return { out: o.out, date: o.date, codes, sessions };
}

function minGap(env) {
  const raw = env.YAHOO_MIN_GAP_S;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_GAP_S;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < GAP_BOUNDS[0] || n > GAP_BOUNDS[1]) {
    throw new UsageError(`YAHOO_MIN_GAP_S must be ${GAP_BOUNDS[0]} to ${GAP_BOUNDS[1]}`);
  }
  return n;
}

const writeJson = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
};

/**
 * @param {string[]} argv @param {Record<string, string | undefined>} env
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => Date,
 *   out?: (s: string) => void, err?: (s: string) => void }} [deps]
 */
export async function run(argv, env, deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  try {
    const a = parseArgs(argv);
    const gap = minGap(env) * 1000;
    const outDir = path.resolve(a.out);
    if (isInsideRepo(outDir)) {
      throw new UsageError(
        "--out must be a fixtures checkout outside the praxis-app repo (SEC-110)",
      );
    }
    const date = a.date ?? defaultDate(now(), readSeedHolidays());
    if (date > sydneyParts(now()).date) throw new UsageError("--date is in the future");
    const from = shiftDate(date, -Math.ceil(a.sessions * 1.5) - 14);
    const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    const period2 = Math.floor(Date.parse(`${shiftDate(date, 2)}T00:00:00Z`) / 1000);
    const fetchedAt = now().toISOString();

    let lastAt = null;
    let requests = 0;
    let retries = 0;
    const getChart = async (symbol) => {
      const url = `${CHART_URL}${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
      for (let attempt = 0; ; attempt++) {
        if (lastAt !== null) {
          const backoff = attempt > 0 ? gap * BACKOFF_FACTOR ** attempt : 0;
          const wait = Math.max(gap - (Date.now() - lastAt), backoff);
          if (wait > 0) await sleep(wait);
        }
        lastAt = Date.now();
        requests++;
        let res;
        try {
          res = await doFetch(url, {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          });
        } catch {
          if (attempt >= MAX_RETRIES) {
            throw new FetchFailedError(
              "could not reach Yahoo (network error). Nothing was written.",
            );
          }
          retries++;
          continue;
        }
        if (res.status === 429 || res.status === 401 || res.status === 403) {
          if (attempt >= MAX_RETRIES) {
            throw new RateLimitedError(
              `Yahoo refused the request (HTTP ${res.status}) after ${MAX_RETRIES + 1} tries. Wait a while (an hour is safe), raise YAHOO_MIN_GAP_S, and run again. Nothing was written.`,
            );
          }
          retries++;
          continue;
        }
        if (res.status === 404) return null; // unknown symbol: counted as missing
        if (!res.ok) {
          if (res.status >= 500 && attempt < MAX_RETRIES) {
            retries++;
            continue;
          }
          throw new FetchFailedError(`Yahoo answered HTTP ${res.status}. Nothing was written.`);
        }
        try {
          return await res.json();
        } catch {
          throw new FetchFailedError(
            "Yahoo answered with something that is not JSON. Nothing was written.",
          );
        }
      }
    };

    const keep = (rows) =>
      rows
        .filter((r) => r.date <= date)
        .sort((x, y) => (x.date < y.date ? -1 : 1))
        .slice(-a.sessions);
    const bars = [];
    let missing = 0;
    for (const code of a.codes) {
      const json = await getChart(`${code}.AX`);
      const rows = json === null ? [] : keep(rowsFromChart(json, code, false, fetchedAt));
      if (rows.length === 0) missing++;
      bars.push(...rows);
    }
    const indexJson = await getChart(INDEX_SYMBOL);
    const index =
      indexJson === null
        ? []
        : keep(rowsFromChart(indexJson, INDEX_SYMBOL.slice(1), true, fetchedAt));

    if (!bars.some((r) => r.date === date)) {
      throw new FetchFailedError(
        `Yahoo returned no bars for ${date} (not a trading day, or not published yet). Nothing was written.`,
      );
    }
    const folder = path.join(outDir, "recorded", "au", date);
    fs.mkdirSync(folder, { recursive: true });
    writeJson(path.join(folder, "bars.json"), bars);
    writeJson(path.join(folder, "index.json"), index);
    const sessionCount = new Set(bars.map((r) => r.date)).size;
    out(
      `record-day: bars=${bars.length} index=${index.length} codes=${a.codes.length} missing_codes=${missing} sessions=${sessionCount} requests=${requests} retries=${retries}`,
    );
    out(`record-day: wrote ${folder}`);
    return 0;
  } catch (e) {
    if (e instanceof RateLimitedError) {
      err(`record-day: ${e.message}`);
      return 3;
    }
    if (e instanceof UsageError || e instanceof FetchFailedError) {
      err(`record-day: ${e.message}`);
      return 2;
    }
    err("record-day: unexpected error");
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await run(process.argv.slice(2), process.env));
}
