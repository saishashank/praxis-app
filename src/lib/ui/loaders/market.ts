// Market loaders: movers / sectors / all-companies, the "i" overview and instant search (UXN-270..273,
// design decisions 21, 48, 49; D-136 draft). End-of-day data only.
// Masking (DAT-124, decision 21): a masked user sees DERIVED numbers only (day change, volume) for the
// stocks of the day's active set, as "Stock A" with an opaque slug ("stock-a"); no code, company name,
// price or link. Real codes are never accepted from a masked user (so the route cannot be used to test
// whether a code exists or is in the active set) and search is off for them.
// The unmasked per-day aggregate is memoised per database, market and latest bar date (10-minute
// ceiling, design 2.9); masking is applied AFTER the memo, per request.
import { getConfig } from "@/lib/config/store";
import { assignTiers, medianMicro, TIER_RULES } from "@/lib/data/universe/tiers.mjs";
import { safeSourceUrl } from "@/lib/http/safeLink";
import { buildSwot, type Swot } from "@/lib/view/swot";
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
const SIZE_GROUP: Record<string, string> = { U1: "Large", U2: "Mid", U3: "Small" };
/** D-193: the size switch of the Market page (Owner 2026-10-26), Large by default. */
export const SIZES = ["large", "mid", "small"] as const;
export type MarketSize = (typeof SIZES)[number];
const TIER_OF_SIZE: Record<MarketSize, string> = { large: "U1", mid: "U2", small: "U3" };
const CODE_RE = /^[A-Za-z0-9]{1,8}$/;
const SLUG_RE = /^stock-([a-z]{1,4})$/;
export const SUMMARY_PENDING = "Summary not written yet";
/** D-196: what the SWOT is and is not. */
export const SWOT_NOTICE =
  "Worked out by fixed rules from our end-of-day prices, short-selling data and announcements, not by AI. Not financial advice.";
export const NO_PROFILE =
  "A description of the business needs a company-profile source the app does not have yet.";

// ---- the memoised, unmasked day --------------------------------------------------------------------

type DayRow = {
  code: string;
  name: string;
  sector: string | null;
  close: number;
  prev: number;
  volume: number;
  /** U1/U2/U3 computed from the bars before this day (ARN-010, D-189), or null. */
  tier: string | null;
  /** False below the ARN-010 floor (penny or barely traded): never listed (D-193). */
  active: boolean;
  /** Mean volume of the sessions in the 30 calendar days before this day, or null. */
  usualVolume: number | null;
  /** A split, consolidation or bonus issue goes ex on this day: the price move is not a real one. */
  reshaped: boolean;
};
/** `sized`: false while the history is too short for the ARN-010 size groups (D-193). */
type Day = { d: string; rows: DayRow[]; builtAt: number; sized: boolean };
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
  // D-201: the four reads do not depend on each other, so they run together
  const [r, usual, tiers, ca] = await Promise.all([
    env.main.execute({
      sql: `SELECT b.code, i.name, i.sector, b.c, b.volume,
                   (SELECT p.c FROM price_bar p WHERE p.market = b.market AND p.code = b.code AND p.d < b.d
                    ORDER BY p.d DESC LIMIT 1) AS prev
            FROM price_bar b JOIN instrument i ON i.market = b.market AND i.code = b.code
            WHERE b.market = ? AND b.d = ? AND i.delisted_on IS NULL ORDER BY b.code LIMIT ?`,
      args: [market, d, UNIVERSE_ROWS],
    }),
    env.main.execute({
      sql: `SELECT code, AVG(volume) AS v FROM price_bar
            WHERE market = ? AND d < ? AND d >= date(?, '-30 days') GROUP BY code LIMIT ?`,
      args: [market, d, d, UNIVERSE_ROWS],
    }),
    tiersBefore(env, market, d),
    env.main
      .execute({
        sql: `SELECT DISTINCT code FROM corporate_action
              WHERE market = ? AND ex_date = ? AND type IN ('split', 'consolidation', 'bonus_issue')`,
        args: [market, d],
      })
      .catch(() => ({ rows: [] as Record<string, unknown>[] })), // an unreadable table leaves the lists as they are
  ]);
  const usualBy = new Map(usual.rows.map((x) => [String(x.code), Number(x.v)]));
  const reshaped = new Set<string>();
  for (const x of ca.rows) reshaped.add(normCode(String(x.code)));
  const rows: DayRow[] = r.rows
    .filter((x) => x.prev !== null && Number(x.prev) > 0)
    .map((x) => ({
      code: String(x.code),
      name: String(x.name),
      sector: sectorName(x.sector),
      close: Number(x.c), // money-float-ok: stored REAL bar price
      prev: Number(x.prev), // money-float-ok: stored REAL bar price
      volume: Number(x.volume), // money-float-ok: stored volume
      tier: tiers === null ? null : (tiers.get(String(x.code))?.tier ?? null),
      active: tiers === null || tiers.get(String(x.code))?.status === "active",
      usualVolume: usualBy.get(String(x.code)) ?? null,
      reshaped: reshaped.has(normCode(String(x.code))),
    }));
  const day: Day = { d, rows, builtAt: env.now.getTime(), sized: tiers !== null };
  memo.set(key, day);
  return day;
}

/**
 * D-193: the ARN-010 tiers (D-189) of the day from the bars of the 60 sessions before it, the same
 * rule the night uses, so the page is right the moment new code is deployed (the stored snapshot of a
 * night cannot be rewritten). Memoised with the day.
 */
async function tiersBefore(env: LoaderEnv, market: string, d: string) {
  const days = await env.main.execute({
    sql: "SELECT DISTINCT d FROM price_bar WHERE market = ? AND d < ? ORDER BY d DESC LIMIT ?",
    args: [market, d, TIER_RULES.windowSessions],
  });
  // a young database: size groups cannot be computed yet (the page says so and lists everything)
  if (days.rows.length < TIER_RULES.windowSessions) return null;
  const from = String(days.rows[days.rows.length - 1]!.d);
  const bars = await env.main.execute({
    sql: "SELECT code, c, volume FROM price_bar WHERE market = ? AND d >= ? AND d < ? ORDER BY code, d",
    args: [market, from, d],
  });
  const traded = new Map<string, bigint[]>();
  const last = new Map<string, bigint>();
  for (const b of bars.rows) {
    const code = String(b.code);
    const price = BigInt(priceMicro(Number(b.c))); // money-float-ok: stored REAL bar price to micro
    const list = traded.get(code) ?? [];
    list.push(price * BigInt(Number(b.volume))); // money-float-ok: stored volume
    traded.set(code, list);
    last.set(code, price);
  }
  // D-201: the first bar of every candidate in ONE round trip (one query per code took seconds)
  const candidates = [...traded].filter(([, t]) => medianMicro(t) >= TIER_RULES.u2.advMicro);
  const listed = new Map<string, string | null>();
  const first = await env.main.execute({
    sql: `SELECT j.value AS code,
                 (SELECT p.d FROM price_bar p WHERE p.market = ? AND p.code = j.value
                  ORDER BY p.d LIMIT 1) AS d
            FROM json_each(?) j`,
    args: [market, JSON.stringify(candidates.map(([code]) => code))],
  });
  for (const x of first.rows) listed.set(String(x.code), String(x.d)); // every candidate has a bar
  return assignTiers(
    [...traded.keys()].map((code) => ({
      code,
      priceMicro: last.get(code) ?? 0n,
      tradedMicro: traded.get(code) ?? [],
      listedSince: listed.get(code) ?? null,
      mcapMicro: null,
    })),
    d,
  );
}

/**
 * D-200 (Owner 2026-10-28: "show real stocks"): while the history is too short for the size groups,
 * the movers lists keep to established companies, at least A$1 a share and A$1m traded on the day
 * (stricter than the U3 floor of D-199). Once sized, the Large/Mid/Small groups do this job.
 */
const INTERIM_PRICE_MICRO = 1_000_000n; // threshold-ok: A$1 a share
const INTERIM_TRADED_MICRO = 1_000_000_000_000n; // threshold-ok: A$1m traded on the day
const mainstream = (r: DayRow): boolean => {
  if (!(r.prev > 0 && r.volume > 0)) return false;
  const price = BigInt(priceMicro(r.close));
  return (
    price >= INTERIM_PRICE_MICRO && price * BigInt(Math.round(r.volume)) >= INTERIM_TRADED_MICRO // money-float-ok: stored volume
  );
};

/** ASX placeholders for "no sector yet" ("Class Pend", "Not Applic") read as one plain label. */
const SECTOR_PLACEHOLDER = /^(class pend|not applic)/i;
export const UNCLASSIFIED = "Not classified yet";
export const sectorName = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : SECTOR_PLACEHOLDER.test(String(v))
      ? UNCLASSIFIED
      : String(v);

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

export async function starredCodes(env: LoaderEnv): Promise<Set<string>> {
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

export type MarketQuery = { tab: MarketTab; sector?: string; page: number; size?: MarketSize };

export function parseMarketQuery(sp: URLSearchParams): MarketQuery | null {
  const tab = sp.get("tab") ?? "movers";
  if (!(TABS as readonly string[]).includes(tab)) return null;
  const sector = textParam(sp.get("sector"), 60);
  const page = intParam(sp.get("page"), 1, 1000);
  const size = sp.get("size") ?? "large";
  if (sector === null || page === null || !(SIZES as readonly string[]).includes(size)) return null;
  return { tab: tab as MarketTab, sector, page, size: size as MarketSize };
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
  /** Today's volume against the 30-day mean, in parts per million (1,000,000 = as usual); null = no history. */
  volumeVsUsualPpm: number | null;
  /** Large / Mid / Small from the universe tier; null for masked users or when unknown. */
  sizeGroup: string | null;
  starred: boolean;
};
export type SectorRow = { sector: string; count: number; avgChangePpm: number };
export type MarketModel = {
  state: LoaderState;
  masked: boolean;
  tab: MarketTab;
  /** D-193: the size group shown (one at a time); `sized` false while history is too short. */
  size: MarketSize;
  sized: boolean;
  d: string | null;
  staleText: string | null;
  up: MarketRow[];
  down: MarketRow[];
  sectors: SectorRow[];
  /** Most traded today (by volume). */
  traded: MarketRow[];
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
    size: q.size ?? "large",
    sized: false,
    d: null,
    staleText: null,
    up: [],
    down: [],
    sectors: [],
    traded: [],
    rows: [],
    page: { number: q.page, size, total: 0 },
    note: masked ? MASKED_NOTE : null,
  };
  const day = await loadDay(env);
  if (day === null) return empty;
  // D-193: one size group at a time, and never a code below the ARN-010 floor (penny or barely traded)
  const wanted = TIER_OF_SIZE[q.size ?? "large"];
  // a masked user sees only the day's active set, as letters and without sizes, so no size filter
  let pool =
    day.sized && !masked ? day.rows.filter((r) => r.active && r.tier === wanted) : day.rows;
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
    volumeVsUsualPpm:
      r.usualVolume !== null && r.usualVolume > 0
        ? Math.round((r.volume / r.usualVolume) * PPM) // money-float-ok: derived ratio, not a price
        : null,
    sizeGroup: masked ? null : (SIZE_GROUP[r.tier ?? ""] ?? null),
    starred: stars.has(normCode(r.code)),
  });
  // D-200: a split or consolidation is not a rise or fall; while the history is too short for sizes,
  // the movers lists keep to established companies (A$1 a share, A$1m traded)
  const real = pool.filter((r) => !r.reshaped);
  const movers = day.sized || masked ? real : real.filter(mainstream);
  const sorted = [...movers].sort(
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
    sized: day.sized,
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
    traded:
      q.tab === "movers"
        ? [...movers]
            // by traded value (price x volume): a million shares at A$0.01 is not "most traded"
            .sort(
              (a, b) => b.volume * b.close - a.volume * a.close || (a.code < b.code ? -1 : 1), // money-float-ok: ordering only
            )
            .slice(0, MOVERS)
            .map(toRow)
        : [],
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
    sector: sectorName(x.sector),
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
  /** D-196: the rules-based SWOT, or null with too little history (under 200 sessions). */
  swot: Swot | null;
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
    sql: "SELECT d, c, volume FROM price_bar WHERE market = ? AND code = ? ORDER BY d DESC LIMIT ?",
    args: [market, code, SWOT_BARS],
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
      url: masked || x.url === null ? null : safeSourceUrl(x.url), // SEC-016: https + registered host, else text only
    })),
    summary: NO_PROFILE,
    notice: SWOT_NOTICE,
    swot: await swotOf(env, market, code, bars.rows),
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

const SWOT_BARS = 260; // threshold-ok: about a year of sessions for the SWOT (D-196)
const PS_WINDOW_DAYS = 30; // threshold-ok: "the last 30 days" of the SWOT text

/** D-196: the SWOT inputs of one code from the stored tables (bars newest first as read). */
async function swotOf(
  env: LoaderEnv,
  market: string,
  code: string,
  barsDesc: ReadonlyArray<Record<string, unknown>>,
): Promise<Swot | null> {
  const asc = [...barsDesc].reverse();
  const short = await env.main.execute({
    sql: "SELECT short_ppm FROM short_interest WHERE market = ? AND code = ? ORDER BY as_of DESC LIMIT 2",
    args: [market, code],
  });
  const since = new Date(env.now.getTime() - PS_WINDOW_DAYS * 86_400_000).toISOString();
  const ps = await env.main.execute({
    sql: `SELECT COUNT(*) AS n FROM announcement WHERE market = ? AND code = ? AND price_sensitive = 1
          AND published_at >= ?`,
    args: [market, code, since],
  });
  const day = await loadDay(env);
  const row = day?.rows.find((r) => r.code === code);
  return buildSwot({
    closes: asc.map((b) => Number(b.c)), // money-float-ok: stored REAL bar price, display ratios only
    volumes: asc.map((b) => Number(b.volume)), // money-float-ok: stored volume
    shortPpm: short.rows[0] ? Number(short.rows[0].short_ppm) : null, // money-float-ok: ppm integer
    shortPrevPpm: short.rows[1] ? Number(short.rows[1].short_ppm) : null, // money-float-ok: ppm integer
    priceSensitive30d: Number(ps.rows[0]?.n ?? 0), // money-float-ok: a count
    sizeGroup: day?.sized && row?.active ? (SIZE_GROUP[row.tier ?? ""] ?? null) : null,
  });
}
