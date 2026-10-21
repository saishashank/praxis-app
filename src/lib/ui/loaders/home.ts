// Loader of the Home page (M7 T7; docs/M7_design.md 3 row 4; UX-010 to UX-017, UXN-034, 041, 044, 046,
// 047, 050, 057; D-128, D-129, D-135 draft): the summary card, the day line, today's picks (one line
// each), the first trade ideas, the viewer's own watchlist, the top company news, the latest Evening
// Review and, for the Owner, the number of items that need attention.
//
// Masking: the summary and the day line carry no code. Picks, ideas and the watchlist use letters for a
// masked viewer and drop prices; company news is returned only to an unmasked viewer (UX-009); the review
// date is shown as an ISO week. Every list is bounded and ordered; before any data is written the page is
// "empty" and every list is empty.
import "server-only";
import type { Row } from "@libsql/client";
import { loadAttentionItems } from "@/lib/health/attention";
import { loadIdeas } from "./ideas";
import {
  latestDataDate,
  latestRegime,
  loaded,
  maxDate,
  money,
  num,
  numOrNull,
  openViewer,
  PPM,
  ratioPpm,
  soft,
  str,
  strOrNull,
  type Loaded,
  type LoaderDeps,
  type Money,
} from "./common";

const PICKS_PER_PROFILE = 3; // threshold-ok: picks shown per profile on Home
const MAX_HOME_PICKS = 30; // threshold-ok: bound of the picks read
const MAX_IDEAS = 5; // threshold-ok: UX-011 ideas on Home
const MAX_WATCH = 50; // threshold-ok: bound of the watchlist read
const MAX_NEWS = 3; // threshold-ok: UX-011 news items on Home
const PRICE_WINDOW_DAYS = 10; // threshold-ok: calendar days that hold the two newest closes
const DAY_MS = 86_400_000; // threshold-ok: unit conversion

export type HomePick = {
  profile: string;
  rank: number;
  stock: string;
  family: string;
  tier: string;
  label: string;
  /** Prices in micro-AUD; null for a masked viewer. */
  referenceMicro: number | null;
  stopMicro: number | null;
  aimMicro: number | null;
  aimReachPpm: number | null;
  timeFrameSessions: number | null;
  /** Last day the pick can be bought: exact, or the ISO week for a masked viewer. */
  validUntil: string | null;
};

export type HomeIdea = {
  stock: string;
  strategy: string;
  taken: number;
  notTaken: number;
  href: string | null;
};

export type HomeWatch = {
  stock: string;
  /** Latest close in micro-AUD-free dollars as stored; null for a masked viewer. */
  close: number | null;
  changePpm: number | null;
};

export type HomeView = {
  /** Total liquidation value of the live strategies, with the change since the previous session. */
  summary: {
    value: Money | null;
    dayChange: Money | null;
    dayChangePpm: number | null;
    strategies: number;
    d: string | null;
  };
  day: {
    regime: string | null;
    regimeD: string | null;
    quality: Array<{ tier: string; score: number; gatePass: boolean }>;
    openFlags: number;
  };
  picks: { d: string | null; items: HomePick[] };
  ideas: { d: string | null; items: HomeIdea[]; signals: number };
  watchlist: HomeWatch[];
  news: {
    hidden: boolean;
    items: Array<{ stock: string; title: string; publishedAt: string; materiality: number }>;
  };
  review: { d: string; day: string | null; kind: string } | null;
  /** Owner only: items that need attention in the Control Room; null for everyone else. */
  attentionCount: number | null;
};

function emptyView(): HomeView {
  return {
    summary: { value: null, dayChange: null, dayChangePpm: null, strategies: 0, d: null },
    day: { regime: null, regimeD: null, quality: [], openFlags: 0 },
    picks: { d: null, items: [] },
    ideas: { d: null, items: [], signals: 0 },
    watchlist: [],
    news: { hidden: false, items: [] },
    review: null,
    attentionCount: null,
  };
}

export async function loadHome(deps: LoaderDeps): Promise<Loaded<HomeView>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const view = emptyView();

  const dataD = await latestDataDate(deps.mainDb, v.market);

  // Summary: live strategies only, latest liquidation value against the one before it.
  const nav = await deps.mainDb.execute(
    `SELECT n.cohort_id, n.d, n.liq_nav_micro,
            (SELECT p.liq_nav_micro FROM nav_daily p WHERE p.cohort_id = n.cohort_id AND p.d < n.d
             ORDER BY p.d DESC LIMIT 1) AS prev
     FROM nav_daily n
     WHERE n.cohort_id IN (SELECT c.id FROM cohort c JOIN execution e ON e.id = c.execution_id
                           WHERE e.kind = 'E' AND c.terminal_kind IS NULL AND c.control_idx IS NULL)
       AND n.d = (SELECT MAX(x.d) FROM nav_daily x WHERE x.cohort_id = n.cohort_id)`,
  );
  let value = 0;
  let before = 0;
  let withPrev = 0;
  for (const r of nav.rows) {
    value += num(r.liq_nav_micro);
    if (r.prev !== null && r.prev !== undefined) {
      before += num(r.prev);
      withPrev += num(r.liq_nav_micro);
    }
  }
  const navD = maxDate(...nav.rows.map((r) => str(r.d)));
  if (nav.rows.length > 0) {
    view.summary = {
      value: money(value),
      dayChange: before > 0 ? money(withPrev - before) : null,
      dayChangePpm: before > 0 ? ratioPpm(withPrev - before, before) : null,
      strategies: nav.rows.length,
      d: navD,
    };
  }

  // Day line.
  const regime = await latestRegime(deps.mainDb, v.market);
  const quality = dataD
    ? await deps.mainDb.execute({
        sql: "SELECT tier, score, gate_pass FROM quality_score WHERE market = ? AND d = ? ORDER BY tier",
        args: [v.market, dataD],
      })
    : { rows: [] };
  const flags = await deps.mainDb.execute({
    sql: "SELECT COUNT(*) AS n FROM data_quality_flag WHERE market = ? AND cleared_at IS NULL",
    args: [v.market],
  });
  view.day = {
    regime: regime?.state ?? null,
    regimeD: regime?.d ?? null,
    quality: quality.rows.map((r) => ({
      tier: str(r.tier),
      score: num(r.score),
      gatePass: num(r.gate_pass) === 1,
    })),
    openFlags: num(flags.rows[0]?.n),
  };

  // Picks of the newest published day: the first ranks of each profile.
  const pd = await deps.mainDb.execute({
    sql: "SELECT MAX(d) AS d FROM pick WHERE market = ?",
    args: [v.market],
  });
  const pickD = strOrNull(pd.rows[0]?.d);
  const pickRows = pickD
    ? await deps.mainDb.execute({
        sql: `SELECT profile, rank, code, family, tier, label, reference_micro, stop_micro, aim_micro,
                     aim_reach_ppm, time_frame_sessions, valid_until_d
              FROM pick WHERE market = ? AND d = ? AND rank <= ? ORDER BY profile, rank LIMIT ?`,
        args: [v.market, pickD, PICKS_PER_PROFILE, MAX_HOME_PICKS],
      })
    : { rows: [] };

  // Watchlist of the signed-in user (personal list, Owner and Editor).
  const userId = deps.user?.id;
  const wlRows: Row[] =
    typeof userId === "number"
      ? await soft(
          async () =>
            (
              await deps.authDb.execute({
                sql: "SELECT code FROM user_watchlist WHERE user_id = ? AND market = ? ORDER BY added_at, code LIMIT ?",
                args: [userId, v.market, MAX_WATCH],
              })
            ).rows,
          [] as Row[],
        )
      : [];
  const wlCodes = wlRows.map((r) => str(r.code));
  const closes = new Map<string, Array<{ d: string; c: number }>>();
  if (wlCodes.length > 0 && dataD) {
    const since = new Date(Date.parse(`${dataD}T00:00:00Z`) - PRICE_WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const pr = await deps.mainDb.execute({
      sql: `SELECT code, d, c FROM price_bar WHERE market = ? AND d >= ? AND d <= ?
            AND code IN (${wlCodes.map(() => "?").join(",")}) ORDER BY code, d`,
      args: [v.market, since, dataD, ...wlCodes],
    });
    for (const r of pr.rows)
      closes.set(str(r.code), [...(closes.get(str(r.code)) ?? []), { d: str(r.d), c: num(r.c) }]);
  }

  // Letters: one scope for the picks, the watchlist and the news, built after all codes are known.
  const scopeD = pickD ?? dataD ?? navD;
  const scope = scopeD
    ? await v.masker.scope(scopeD, [...pickRows.rows.map((r) => str(r.code)), ...wlCodes])
    : null;
  const label = (c: string) => (scope ? scope.label(c) : masked ? "Another stock" : c);

  view.picks = {
    d: pickD,
    items: pickRows.rows.map((r) => ({
      profile: str(r.profile),
      rank: num(r.rank),
      stock: label(str(r.code)),
      family: str(r.family),
      tier: str(r.tier),
      label: scope ? scope.text(str(r.label)) : str(r.label),
      referenceMicro: masked ? null : num(r.reference_micro),
      stopMicro: masked ? null : num(r.stop_micro),
      aimMicro: masked ? null : num(r.aim_micro),
      aimReachPpm: numOrNull(r.aim_reach_ppm),
      timeFrameSessions: numOrNull(r.time_frame_sessions),
      validUntil: scope ? scope.day(str(r.valid_until_d)) : str(r.valid_until_d),
    })),
  };

  view.watchlist = wlCodes.map((code) => {
    const series = closes.get(code) ?? [];
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    return {
      stock: label(code),
      close: masked || !last ? null : last.c,
      changePpm: last && prev && prev.c > 0 ? Math.round(((last.c - prev.c) * PPM) / prev.c) : null,
    };
  });

  // Ideas: the first ones of the newest session, in the order of the Ideas page.
  const ideas = await loadIdeas(deps);
  view.ideas = {
    d: ideas.data.d,
    signals: ideas.data.tally.signals,
    items: ideas.data.groups
      .flatMap((g) =>
        g.ideas.map((i) => ({
          stock: i.stock,
          strategy: g.strategy,
          taken: i.taken,
          notTaken: i.notTaken,
          href: i.cards[0]?.href ?? null,
        })),
      )
      .slice(0, MAX_IDEAS),
  };

  // News: company items are for unmasked viewers only (UX-009).
  if (masked) {
    view.news = { hidden: true, items: [] };
  } else {
    const nr = await deps.mainDb.execute({
      sql: `SELECT a.code, a.title, a.published_at, COALESCE(i.materiality, 0) AS m
            FROM announcement a LEFT JOIN item_assessment i ON i.source = a.source AND i.ann_id = a.ann_id
            WHERE a.market = ? ORDER BY m DESC, a.published_at DESC, a.id DESC LIMIT ?`,
      args: [v.market, MAX_NEWS],
    });
    view.news = {
      hidden: false,
      items: nr.rows.map((r) => ({
        stock: str(r.code),
        title: str(r.title),
        publishedAt: str(r.published_at),
        materiality: num(r.m),
      })),
    };
  }

  // Latest Evening Review.
  const rv = await deps.mainDb.execute(
    "SELECT d, kind FROM evening_review ORDER BY d DESC, version DESC LIMIT 1",
  );
  if (rv.rows[0]) {
    const d = str(rv.rows[0].d);
    view.review = { d, day: scope ? scope.day(d) : d, kind: str(rv.rows[0].kind) };
  }

  // Owner only: attention items from the latest health snapshot.
  if (deps.user?.role === "owner") {
    view.attentionCount = (await soft(() => loadAttentionItems(deps.mainDb), [])).length;
  }

  return loaded(
    maxDate(dataD, navD, ideas.data.d, pickD),
    v.now,
    masked,
    view,
    "No data yet — the strategies start when the market is switched on.",
  );
}
