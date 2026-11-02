// Company page and index strip loaders (UXN-270/271, M7 T15; D-128 decisions 21, 47, 53).
// Stored data only: every read is a bounded SQL read of the nightly tables (UXN-273), no source call.
// Masking (DAT-124, D-129, D-136): a masked user (Editor/Viewer without a live unmask grant) addresses a
// company by its opaque slug ("stock-a"), gets DERIVED numbers only (day change, 52-week position,
// volume against usual, moving-average relation), no code, name, price, candle, link or "Our activity".
// A real code from a masked user is "not found", like an unknown one (no oracle for which codes exist).
// Unmasked users get the candles (integer micro prices), key numbers, markers and our activity.
import { isoWeek, MISSING } from "@/lib/view/format";
import { safeSourceUrl } from "@/lib/http/safeLink";
import { dateStaleness } from "@/lib/view/staleness";
import { maskText, normCode } from "@/lib/view/mask";
import { strategyNames } from "./common";
import { TIER_RULES } from "@/lib/data/universe/tiers.mjs";
import { codeFromSlug, sectorName, slugOf, starredCodes } from "./market";
import { marketOf, maskKit, priceMicro, todayD, type LoaderEnv, type LoaderState } from "./shell";
import { displayTitle } from "@/lib/view/displayText";

const PPM = 1_000_000; // threshold-ok: parts per million
const BAR_ROWS = 520; // threshold-ok: about two years of sessions (the store keeps 500, DAT-140)
const YEAR_SESSIONS = 252; // threshold-ok: trading sessions in a 52-week range
const USUAL_SESSIONS = 20; // threshold-ok: sessions behind "usual volume"
const MA_SHORT = 50; // threshold-ok: UXN-271 50-day moving average
const MA_LONG = 200; // threshold-ok: UXN-271 200-day moving average
const NEWS_ROWS = 20; // threshold-ok: announcements shown on the page
const ACTIVITY_ROWS = 10; // threshold-ok: rows in each "Our activity" list
const MARKER_ROWS = 100; // threshold-ok: trade markers on the chart
const INDEX_ROWS = 31; // threshold-ok: one month of index sessions for the strip
const STALE_DAYS = 4; // threshold-ok: end-of-day bars; a long weekend is 3 days
const CODE_RE = /^[A-Za-z0-9]{1,8}$/;
const SIZE_GROUP: Record<string, string> = { U1: "Large", U2: "Mid", U3: "Small" };

export type CandleBar = {
  /** YYYY-MM-DD */
  time: string;
  /** Integer micro prices (display only). */
  o: number;
  h: number;
  l: number;
  c: number;
  volume: number;
};
export type ChartMarker = { time: string; kind: "buy" | "sell" | "pick" | "news"; text: string };
export type MaRelation = { days: number; above: boolean; gapPpm: number } | null;

export type Announcement = {
  id: number;
  title: string;
  /** Full timestamp, or an ISO week for a masked user. */
  published: string;
  url: string | null;
  priceSensitive: boolean;
};

export type CompanyModel = {
  state: LoaderState;
  masked: boolean;
  /** Code, or "Stock A" for a masked user. */
  stock: string;
  slug: string;
  /** On the person's watchlist (always false for a masked user, who cannot star). */
  starred: boolean;
  name: string | null;
  sector: string | null;
  sizeGroup: string | null;
  listedOn: string | null;
  delisted: { on: string; reason: string | null } | null;
  /** Date of the last bar and the text for a stale one. */
  d: string | null;
  staleText: string | null;
  closeMicro: string | null;
  changePpm: number | null;
  /** 0 = at the 52-week low, 1,000,000 = at the high; null when there is no range. */
  rangePositionPpm: number | null;
  rangeLowMicro: string | null;
  rangeHighMicro: string | null;
  volume: number | null;
  usualVolume: number | null;
  volumeVsUsualPpm: number | null;
  ma: { short: MaRelation; long: MaRelation };
  /** Candles for the chart (empty for a masked user). */
  bars: CandleBar[];
  markers: ChartMarker[];
  announcements: Announcement[];
  /** Hidden (null) for a masked user (UXN-270 s13). */
  activity: {
    holders: Array<{ execution: string; family: string; name: string }>;
    picks: Array<{ d: string; profile: string; state: string }>;
    ideas: Array<{ family: string; name: string }>;
  } | null;
};

const slugKey = (s: string): boolean => /^stock-[a-z]{1,4}$/.test(s.toLowerCase());

async function latestBarDay(env: LoaderEnv): Promise<string | null> {
  const r = await env.main.execute({
    sql: "SELECT MAX(d) AS d FROM price_bar WHERE market = ?",
    args: [marketOf(env)],
  });
  return r.rows[0]?.d ? String(r.rows[0].d) : null;
}

async function soft<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length; // money-float-ok: statistic of stored prices, display only

function maOf(closes: number[], days: number): MaRelation {
  if (closes.length < days) return null;
  const ma = mean(closes.slice(-days));
  const last = closes[closes.length - 1]!;
  if (!(ma > 0)) return null;
  return { days, above: last >= ma, gapPpm: Math.round(((last - ma) / ma) * PPM) }; // money-float-ok: derived ratio
}

/** `key` is the real code (unmasked users) or the opaque slug (masked users); null = unknown to this user. */
export async function loadCompany(env: LoaderEnv, key: string): Promise<CompanyModel | null> {
  const masked = env.mask.masked;
  const market = marketOf(env);
  const barDay = await latestBarDay(env);
  let code: string | null;
  let kit: Awaited<ReturnType<typeof maskKit>> | null = null;
  if (masked) {
    if (!slugKey(key)) return null;
    kit = await maskKit(env, barDay);
    code = codeFromSlug(key, kit.aliases);
  } else {
    code = CODE_RE.test(key) ? key.toUpperCase() : null;
  }
  if (code === null) return null;
  const inst = await env.main.execute({
    sql: `SELECT name, sector, listed_on, delisted_on, delist_reason FROM instrument
          WHERE market = ? AND code = ?`,
    args: [market, code],
  });
  const i = inst.rows[0];
  if (!i) return null;
  const barRows = await env.main.execute({
    sql: `SELECT d, o, h, l, c, volume FROM (
            SELECT d, o, h, l, c, volume FROM price_bar WHERE market = ? AND code = ?
            ORDER BY d DESC LIMIT ?) ORDER BY d`,
    args: [market, code, BAR_ROWS],
  });
  const bars = barRows.rows.map((x) => ({
    d: String(x.d),
    o: Number(x.o), // money-float-ok: stored REAL bar price
    h: Number(x.h), // money-float-ok: stored REAL bar price
    l: Number(x.l), // money-float-ok: stored REAL bar price
    c: Number(x.c), // money-float-ok: stored REAL bar price
    volume: Number(x.volume), // money-float-ok: stored volume
  }));
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const closes = bars.map((b) => b.c);
  const year = bars.slice(-YEAR_SESSIONS);
  const hi = year.length > 0 ? Math.max(...year.map((b) => b.h)) : null;
  const lo = year.length > 0 ? Math.min(...year.map((b) => b.l)) : null;
  const usualBars = bars.slice(-(USUAL_SESSIONS + 1), -1);
  const usual = usualBars.length > 0 ? mean(usualBars.map((b) => b.volume)) : null;

  const today = todayD(env);
  const stale = dateStaleness(last?.d ?? null, today, STALE_DAYS);

  const tier = await soft(async () => {
    // D-200: a night with under 60 sessions of history stores every code as U3, which would call
    // BHP a small company; the size is shown only once the history can support it (as on Market)
    const sessions = await env.main.execute({
      sql: "SELECT COUNT(*) AS n FROM (SELECT DISTINCT d FROM price_bar WHERE market = ? LIMIT ?)",
      args: [market, TIER_RULES.windowSessions],
    });
    if (Number(sessions.rows[0]?.n ?? 0) < TIER_RULES.windowSessions) return null; // money-float-ok: SQL count
    const r = await env.main.execute({
      sql: `SELECT tier FROM universe_snapshot WHERE market = ? AND code = ?
            ORDER BY d DESC LIMIT 1`,
      args: [market, code],
    });
    return r.rows[0] ? String(r.rows[0].tier) : null;
  }, null);

  const ann = await soft(
    () =>
      env.main.execute({
        sql: `SELECT id, title, published_at, url, price_sensitive FROM announcement
              WHERE market = ? AND code = ? ORDER BY published_at DESC LIMIT ?`,
        args: [market, code, NEWS_ROWS],
      }),
    null,
  );
  const announcements: Announcement[] = (ann?.rows ?? []).map((x) => ({
    id: Number(x.id), // money-float-ok: SQL integer key
    title: displayTitle(kit ? maskText(String(x.title), kit.aliases, kit.lookup) : String(x.title)),
    published: masked
      ? (isoWeek(String(x.published_at).slice(0, 10)) ?? MISSING)
      : String(x.published_at),
    url: masked || x.url === null ? null : safeSourceUrl(x.url), // SEC-016: https + registered host, else text only
    priceSensitive: Number(x.price_sensitive) === 1,
  }));

  const base = {
    state: (last ? (stale.state === "stale" ? "stale" : "ok") : "empty") as LoaderState,
    masked,
    stock: kit ? kit.aliases.label(code) : code,
    slug: masked ? slugOf(kit!.aliases.label(code)) : code,
    d: last?.d ?? null,
    staleText: stale.state === "stale" ? stale.text : null,
    changePpm: last && prev && prev.c > 0 ? Math.round(((last.c - prev.c) / prev.c) * PPM) : null, // money-float-ok: derived ratio
    rangePositionPpm:
      last && hi !== null && lo !== null && hi > lo
        ? Math.round(((last.c - lo) / (hi - lo)) * PPM) // money-float-ok: derived ratio
        : null,
    volume: last?.volume ?? null,
    usualVolume: usual === null ? null : Math.round(usual),
    volumeVsUsualPpm:
      last && usual !== null && usual > 0 ? Math.round((last.volume / usual) * PPM) : null, // money-float-ok: derived ratio
    ma: { short: maOf(closes, MA_SHORT), long: maOf(closes, MA_LONG) },
    announcements,
  };

  if (masked) {
    return {
      ...base,
      starred: false,
      name: null,
      sector: null,
      sizeGroup: null,
      listedOn: null,
      delisted: null,
      closeMicro: null,
      rangeLowMicro: null,
      rangeHighMicro: null,
      bars: [],
      markers: [],
      activity: null,
    };
  }

  const markers = await loadMarkers(env, code, bars[0]?.d ?? null, announcements);
  const activity = await loadActivity(env, code);
  return {
    ...base,
    starred: (await soft(() => starredCodes(env), new Set<string>())).has(normCode(code)),
    name: String(i.name),
    sector: sectorName(i.sector),
    sizeGroup: SIZE_GROUP[tier ?? ""] ?? null,
    listedOn: i.listed_on === null ? null : String(i.listed_on),
    delisted:
      i.delisted_on === null
        ? null
        : {
            on: String(i.delisted_on),
            reason: i.delist_reason === null ? null : String(i.delist_reason),
          },
    closeMicro: last ? priceMicro(last.c) : null,
    rangeLowMicro: lo === null ? null : priceMicro(lo),
    rangeHighMicro: hi === null ? null : priceMicro(hi),
    bars: bars.map((b) => ({
      time: b.d,
      o: Number(priceMicro(b.o)),
      h: Number(priceMicro(b.h)),
      l: Number(priceMicro(b.l)),
      c: Number(priceMicro(b.c)),
      volume: b.volume,
    })),
    markers,
    activity,
  };
}

async function loadMarkers(
  env: LoaderEnv,
  code: string,
  since: string | null,
  announcements: Announcement[],
): Promise<ChartMarker[]> {
  if (since === null) return [];
  const market = marketOf(env);
  const out: ChartMarker[] = [];
  const fills = await soft(
    () =>
      env.main.execute({
        sql: `SELECT f.d, f.side FROM fill f JOIN cohort c ON c.id = f.cohort_id
              JOIN execution e ON e.id = c.execution_id AND e.market = ?
              WHERE f.code = ? AND f.d >= ? ORDER BY f.d LIMIT ?`,
        args: [market, code, since, MARKER_ROWS],
      }),
    null,
  );
  for (const f of fills?.rows ?? []) {
    const side = String(f.side) === "sell" ? "sell" : "buy";
    out.push({
      time: String(f.d),
      kind: side,
      text: side === "buy" ? "Practice strategy bought" : "Practice strategy sold",
    });
  }
  const picks = await soft(
    () =>
      env.main.execute({
        sql: `SELECT d, profile FROM pick WHERE market = ? AND code = ? AND d >= ?
              ORDER BY d LIMIT ?`,
        args: [market, code, since, MARKER_ROWS],
      }),
    null,
  );
  for (const p of picks?.rows ?? []) {
    out.push({ time: String(p.d), kind: "pick", text: `Pick (${String(p.profile)})` });
  }
  for (const a of announcements) {
    const day = a.published.slice(0, 10);
    if (day >= since) out.push({ time: day, kind: "news", text: "Announcement" });
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

async function loadActivity(env: LoaderEnv, code: string): Promise<CompanyModel["activity"]> {
  const market = marketOf(env);
  const names = await soft(() => strategyNames(env.main), {});
  const nameOf = (fam: string): string => names[fam]?.name ?? fam;
  const holders = await soft(
    () =>
      env.main.execute({
        sql: `SELECT DISTINCT e.id, e.family FROM trade t
              JOIN cohort c ON c.id = t.cohort_id AND c.live = 1
              JOIN execution e ON e.id = c.execution_id AND e.kind = 'E' AND e.market = ?
              WHERE t.code = ? AND t.exit_type IS NULL ORDER BY e.id LIMIT ?`,
        args: [market, code, ACTIVITY_ROWS],
      }),
    null,
  );
  const picks = await soft(
    () =>
      env.main.execute({
        sql: `SELECT d, profile, state FROM pick_outcome
              WHERE market = ? AND code = ? AND kind = 'pick' AND state IN ('waiting','bought')
              ORDER BY d DESC LIMIT ?`,
        args: [market, code, ACTIVITY_ROWS],
      }),
    null,
  );
  const ideas = await soft(
    () =>
      env.main.execute({
        sql: `SELECT DISTINCT family FROM signal
              WHERE market = ? AND code = ? AND d = (SELECT MAX(d) FROM signal WHERE market = ?)
              ORDER BY family LIMIT ?`,
        args: [market, code, market, ACTIVITY_ROWS],
      }),
    null,
  );
  return {
    holders: (holders?.rows ?? []).map((x) => ({
      execution: String(x.id),
      family: String(x.family),
      name: nameOf(String(x.family)),
    })),
    picks: (picks?.rows ?? []).map((x) => ({
      d: String(x.d),
      profile: String(x.profile),
      state: String(x.state),
    })),
    ideas: (ideas?.rows ?? []).map((x) => ({
      family: String(x.family),
      name: nameOf(String(x.family)),
    })),
  };
}

// ---- the index strip ---------------------------------------------------------------------------------

export type IndexStrip = {
  code: string;
  d: string;
  changePpm: number | null;
  /** Closes (integer micro), oldest first, for the sparkline. */
  closes: number[];
} | null;

/** The market's main index: the index with the most stored bars (UXN-270). Public data, all roles. */
export async function loadIndexStrip(env: LoaderEnv): Promise<IndexStrip> {
  const market = marketOf(env);
  try {
    const main = await env.main.execute({
      sql: `SELECT index_code, COUNT(*) AS n FROM index_bar WHERE market = ?
            GROUP BY index_code ORDER BY n DESC, index_code LIMIT 1`,
      args: [market],
    });
    const code = main.rows[0]?.index_code;
    if (code === undefined) return null;
    const r = await env.main.execute({
      sql: `SELECT d, c_micro FROM index_bar WHERE market = ? AND index_code = ?
            ORDER BY d DESC LIMIT ?`,
      args: [market, String(code), INDEX_ROWS],
    });
    const rows = [...r.rows].reverse();
    const last = rows[rows.length - 1];
    if (!last) return null;
    const prev = rows[rows.length - 2];
    const lastC = Number(last.c_micro); // money-float-ok: index level in integer micro units
    const prevC = prev ? Number(prev.c_micro) : 0; // money-float-ok: index level in integer micro units
    return {
      code: String(code),
      d: String(last.d),
      changePpm: prev && prevC > 0 ? Math.round(((lastC - prevC) / prevC) * PPM) : null, // money-float-ok: derived ratio
      closes: rows.map((x) => Number(x.c_micro)), // money-float-ok: index level in integer micro units
    };
  } catch {
    return null;
  }
}
