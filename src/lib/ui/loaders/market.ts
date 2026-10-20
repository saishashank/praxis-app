// Market loaders: movers / sectors / all-companies, the "i" overview and instant search (UXN-270..273,
// design decisions 21, 48, 49; D-136 draft). End-of-day data only.
// Masking (DAT-124, decision 21): a masked user sees DERIVED numbers only (day change, volume) for the
// stocks of the day's active set, as "Stock A" with an opaque slug ("stock-a"); no code, company name,
// price or link. Real codes are never accepted from a masked user (so the route cannot be used to test
// whether a code exists or is in the active set) and search is off for them.
// The unmasked per-day aggregate is memoised per database, market and latest bar date (10-minute
// ceiling, design 2.9); masking is applied AFTER the memo, per request.
import { getConfig } from "@/lib/config/store";
import { AI_SUMMARY_NOTICE } from "@/lib/view/honesty";
import { isoWeek, MISSING } from "@/lib/view/format";
import { dateStaleness } from "@/lib/view/staleness";
import { maskText, normCode, type StockAliases } from "@/lib/view/mask";
import {
  intParam,
  isDateParam,
  marketOf,
  maskKit,
  priceMicro,
  textParam,
  todayD,
  type Db,
  type LoaderEnv,
  type LoaderState,
  type MoneyView,
} from "./shell";

const MEMO_MS = 600_000; // threshold-ok: design 2.9, 10-minute ceiling
const UNIVERSE_ROWS = 5000; // threshold-ok: bounded read of one day of bars
const MOVERS = 10; // threshold-ok: rows in each movers list
const SEARCH_MAX = 20; // threshold-ok: decision 49
const NEWS_ROWS = 5; // threshold-ok: UXN-272 last 5 announcements
const STALE_DAYS = 4; // threshold-ok: end-of-day bars; a long weekend is 3 days
const PPM = 1_000_000; // threshold-ok: parts per million
const TABS = ["movers", "sectors", "all"] as const;
export type MarketTab = (typeof TABS)[number];
const CODE_RE = /^[A-Za-z0-9]{1,8}$/;
const SLUG_RE = /^stock-([a-z]{1,4})$/;
export const SUMMARY_PENDING = "Summary not written yet";

// ---- the memoised, unmasked day --------------------------------------------------------------------

type DayRow = {
  code: string;
  name: string;
  sector: string | null;
  close: number;
  prev: number;
  volume: number;
};
type Day = { d: string; rows: DayRow[]; builtAt: number };
const MEMO = new WeakMap<Db, Map<string, Day>>();

async function loadDay(env: LoaderEnv): Promise<Day | null> {
  const market = marketOf(env);
  const last = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ?",
    args: [market],
  });
  const d = last.rows[0]?.d ? String(last.rows[0].d) : null;
  if (d === null) return null;
  const memo = MEMO.get(env.main) ?? new Map<string, Day>();
  MEMO.set(env.main, memo);
  const key = `${market}|${d}`;
  const hit = memo.get(key);
  if (hit && env.now.getTime() - hit.builtAt < MEMO_MS && env.now.getTime() >= hit.builtAt) {
    return hit;
  }
  const r = await env.main.execute({
    sql: `SELECT b.code, i.name, i.sector, b.c, b.volume,
                 (SELECT p.c FROM price_bar p WHERE p.market = b.market AND p.code = b.code AND p.d < b.d
                  ORDER BY p.d DESC LIMIT 1) AS prev
          FROM price_bar b JOIN instrument i ON i.market = b.market AND i.code = b.code
          WHERE b.market = ? AND b.d = ? AND i.delisted_on IS NULL ORDER BY b.code LIMIT ?`,
    args: [market, d, UNIVERSE_ROWS],
  });
  const rows: DayRow[] = r.rows
    .filter((x) => x.prev !== null && Number(x.prev) > 0)
    .map((x) => ({
      code: String(x.code),
      name: String(x.name),
      sector: x.sector === null ? null : String(x.sector),
      close: Number(x.c), // money-float-ok: stored REAL bar price
      prev: Number(x.prev), // money-float-ok: stored REAL bar price
      volume: Number(x.volume), // money-float-ok: stored volume
    }));
  const day: Day = { d, rows, builtAt: env.now.getTime() };
  memo.set(key, day);
  return day;
}

const changePpm = (r: DayRow): number => Math.round(((r.close - r.prev) / r.prev) * PPM); // money-float-ok: derived ratio, not a price

// ---- slugs for masked users ------------------------------------------------------------------------

export const slugOf = (stock: string): string => stock.toLowerCase().replace(/ /g, "-");

/** The code behind "stock-a" for this request's active set; null when it is not a slug of the set. */
export function codeFromSlug(slug: string, aliases: StockAliases): string | null {
  const m = SLUG_RE.exec(slug.toLowerCase());
  if (!m) return null;
  const want = `Stock ${m[1]!.toUpperCase()}`;
  return aliases.codes().find((c) => aliases.label(c) === want) ?? null;
}

// ---- stars -----------------------------------------------------------------------------------------

async function starredCodes(env: LoaderEnv): Promise<Set<string>> {
  const market = marketOf(env);
  try {
    if (env.user.role === "owner") {
      const r = await env.main.execute({
        sql: "SELECT code FROM watch_list_owner WHERE market = ? AND removed_at IS NULL AND expires_d >= ?",
        args: [market, todayD(env)],
      });
      return new Set(r.rows.map((x) => normCode(String(x.code))));
    }
    if (env.user.role === "editor") {
      const r = await env.auth.execute({
        sql: "SELECT code FROM user_watchlist WHERE user_id = ? AND market = ?",
        args: [env.user.id, market],
      });
      return new Set(r.rows.map((x) => normCode(String(x.code))));
    }
  } catch {
    // no stars rather than a wrong star
  }
  return new Set();
}

// ---- the market page -------------------------------------------------------------------------------

export type MarketQuery = { tab: MarketTab; sector?: string; page: number };

export function parseMarketQuery(sp: URLSearchParams): MarketQuery | null {
  const tab = sp.get("tab") ?? "movers";
  if (!(TABS as readonly string[]).includes(tab)) return null;
  const sector = textParam(sp.get("sector"), 60);
  const page = intParam(sp.get("page"), 1, 1000);
  if (sector === null || page === null) return null;
  return { tab: tab as MarketTab, sector, page };
}

export type MarketRow = {
  /** Code, or "Stock A" for a masked user. */
  stock: string;
  /** Path segment for the company page and the overview route. */
  slug: string;
  name: string | null;
  sector: string | null;
  close: MoneyView | null;
  changePpm: number;
  volume: number;
  starred: boolean;
};
export type SectorRow = { sector: string; count: number; avgChangePpm: number };
export type MarketModel = {
  state: LoaderState;
  masked: boolean;
  tab: MarketTab;
  d: string | null;
  staleText: string | null;
  up: MarketRow[];
  down: MarketRow[];
  sectors: SectorRow[];
  rows: MarketRow[];
  page: { number: number; size: number; total: number };
  /** Shown to masked users in place of search. */
  note: string | null;
};

const MASKED_NOTE = "Company names and prices are hidden for your access level.";

export async function loadMarket(env: LoaderEnv, q: MarketQuery): Promise<MarketModel> {
  const masked = env.mask.masked;
  const size = Number(await getConfig(env.main, "market_list_page_size"));
  const empty: MarketModel = {
    state: "empty",
    masked,
    tab: q.tab,
    d: null,
    staleText: null,
    up: [],
    down: [],
    sectors: [],
    rows: [],
    page: { number: q.page, size, total: 0 },
    note: masked ? MASKED_NOTE : null,
  };
  const day = await loadDay(env);
  if (day === null) return empty;
  let pool = day.rows;
  let label = (c: string): string => c;
  if (masked) {
    // Only the stocks of the day's active set exist for a masked user.
    const kit = await maskKit(env, day.d);
    const set = new Set(kit.aliases.codes());
    pool = pool.filter((r) => set.has(normCode(r.code)));
    label = (c) => kit.aliases.label(c);
  }
  const stars = masked ? new Set<string>() : await starredCodes(env);
  const toRow = (r: DayRow): MarketRow => ({
    stock: label(r.code),
    slug: masked ? slugOf(label(r.code)) : r.code,
    name: masked ? null : r.name,
    sector: masked ? null : r.sector,
    close: masked ? null : { micro: priceMicro(r.close), currency: "AUD", simulated: true },
    changePpm: changePpm(r),
    volume: r.volume,
    starred: stars.has(normCode(r.code)),
  });
  const sorted = [...pool].sort(
    (a, b) => changePpm(b) - changePpm(a) || (a.code < b.code ? -1 : 1),
  );
  const bySector = new Map<string, DayRow[]>();
  if (!masked) {
    for (const r of pool) {
      const k = r.sector ?? "Other";
      bySector.set(k, [...(bySector.get(k) ?? []), r]);
    }
  }
  const sectors: SectorRow[] = [...bySector.entries()]
    .map(([sector, rs]) => ({
      sector,
      count: rs.length,
      avgChangePpm: Math.round(rs.reduce((n, r) => n + changePpm(r), 0) / rs.length),
    }))
    .sort((a, b) => (a.sector < b.sector ? -1 : 1));
  const filtered =
    !masked && q.sector !== undefined
      ? pool.filter((r) => (r.sector ?? "Other") === q.sector)
      : pool;
  const total = filtered.length;
  const start = (q.page - 1) * size;
  const stale = dateStaleness(day.d, todayD(env), STALE_DAYS);
  return {
    ...empty,
    state: pool.length === 0 ? "empty" : stale.state === "stale" ? "stale" : "ok",
    d: day.d,
    staleText: stale.state === "stale" ? stale.text : null,
    up: sorted
      .filter((r) => changePpm(r) > 0)
      .slice(0, MOVERS)
      .map(toRow),
    down: sorted
      .filter((r) => changePpm(r) < 0)
      .reverse()
      .slice(0, MOVERS)
      .map(toRow),
    sectors: q.tab === "sectors" ? sectors : [],
    rows: q.tab === "all" ? filtered.slice(start, start + size).map(toRow) : [],
    page: { number: q.page, size, total },
  };
}

// ---- search ---------------------------------------------------------------------------------------

export type SearchModel = {
  state: LoaderState;
  masked: boolean;
  q: string;
  results: Array<{ code: string; name: string; sector: string | null; starred: boolean }>;
  note: string | null;
};

/** `?q=`: the trimmed term (1..40 letters, digits, space, . & ' -), or null when it is not allowed. */
export function parseSearchQuery(sp: URLSearchParams): string | null {
  const q = textParam(sp.get("q"), 40);
  if (q === undefined || q === null) return null;
  return /^[A-Za-z0-9 .&'-]+$/.test(q) ? q : null;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchInstruments(env: LoaderEnv, q: string): Promise<SearchModel> {
  const masked = env.mask.masked;
  if (masked) {
    // Matching a typed code against masked rows would reveal which codes exist (DAT-124); the term is
    // not echoed either.
    return { state: "empty", masked, q: "", results: [], note: MASKED_NOTE };
  }
  const like = likeEscape(q);
  const r = await env.main.execute({
    sql: `SELECT code, name, sector FROM instrument
          WHERE market = ? AND delisted_on IS NULL
            AND (code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
          ORDER BY (code LIKE ? ESCAPE '\\') DESC, code LIMIT ?`,
    args: [marketOf(env), `${like}%`, `%${like}%`, `${like}%`, SEARCH_MAX],
  });
  const stars = await starredCodes(env);
  const results = r.rows.map((x) => ({
    code: String(x.code),
    name: String(x.name),
    sector: x.sector === null ? null : String(x.sector),
    starred: stars.has(normCode(String(x.code))),
  }));
  return { state: results.length === 0 ? "empty" : "ok", masked, q, results, note: null };
}

// ---- the "i" overview -------------------------------------------------------------------------------

export type OverviewModel = {
  masked: boolean;
  stock: string;
  slug: string;
  name: string | null;
  sector: string | null;
  d: string | null;
  close: MoneyView | null;
  changePpm: number | null;
  volume: number | null;
  announcements: Array<{ id: number; title: string; published: string; url: string | null }>;
  /** Facts only until the summary writer is live (decision 48). */
  summary: string;
  notice: string;
};

/** `code` is a real code (unmasked users) or an opaque slug (masked users); null = unknown to this user. */
export async function loadOverview(env: LoaderEnv, key: string): Promise<OverviewModel | null> {
  const masked = env.mask.masked;
  const market = marketOf(env);
  let code: string | null;
  let kit: Awaited<ReturnType<typeof maskKit>> | null = null;
  if (masked) {
    kit = await maskKit(env, todayDay(env, await latestBarDay(env)));
    code = codeFromSlug(key, kit.aliases);
  } else {
    code = CODE_RE.test(key) ? key.toUpperCase() : null;
  }
  if (code === null) return null;
  const inst = await env.main.execute({
    sql: "SELECT code, name, sector FROM instrument WHERE market = ? AND code = ?",
    args: [market, code],
  });
  const i = inst.rows[0];
  if (!i) return null;
  const bars = await env.main.execute({
    sql: "SELECT d, c, volume FROM price_bar WHERE market = ? AND code = ? ORDER BY d DESC LIMIT 2",
    args: [market, code],
  });
  const last = bars.rows[0];
  const prev = bars.rows[1];
  const chg =
    last && prev && Number(prev.c) > 0
      ? Math.round(((Number(last.c) - Number(prev.c)) / Number(prev.c)) * PPM) // money-float-ok: derived ratio
      : null;
  const ann = await env.main.execute({
    sql: `SELECT id, title, published_at, url FROM announcement WHERE market = ? AND code = ?
          ORDER BY published_at DESC LIMIT ?`,
    args: [market, code, NEWS_ROWS],
  });
  const stock = kit ? kit.aliases.label(code) : code;
  return {
    masked,
    stock,
    slug: masked ? slugOf(stock) : code,
    name: masked ? null : String(i.name),
    sector: masked || i.sector === null ? null : String(i.sector),
    d: last ? String(last.d) : null,
    close:
      masked || !last
        ? null
        : { micro: priceMicro(Number(last.c)), currency: "AUD", simulated: true },
    changePpm: chg,
    volume: last ? Number(last.volume) : null, // money-float-ok: stored volume
    announcements: ann.rows.map((x) => ({
      id: Number(x.id), // money-float-ok: SQL integer key
      title: kit ? maskText(String(x.title), kit.aliases, kit.lookup) : String(x.title),
      published: masked
        ? (isoWeek(String(x.published_at).slice(0, 10)) ?? MISSING)
        : String(x.published_at),
      url: masked || x.url === null ? null : String(x.url),
    })),
    summary: SUMMARY_PENDING,
    notice: AI_SUMMARY_NOTICE,
  };
}

async function latestBarDay(env: LoaderEnv): Promise<string | null> {
  const r = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ?",
    args: [marketOf(env)],
  });
  return r.rows[0]?.d ? String(r.rows[0].d) : null;
}

const todayDay = (env: LoaderEnv, bar: string | null): string | null => {
  const t = todayD(env);
  return bar !== null && isDateParam(bar) ? bar : isDateParam(t) ? t : null;
};
