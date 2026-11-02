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
import { listInbox } from "@/lib/alerts/api";
import { addDays, isWeekend, marketDate } from "@/lib/data/calendar";
import { maskAlertViews } from "@/lib/view/alerts";
import { formatDate, plural } from "@/lib/view/format";
import { loadIdeas } from "./ideas";
import { pickRef } from "./picks";
import { loadAlertHomeFacts, loadIntraday, type IntradayModel } from "./pickAlerts";
import type { LoaderEnv } from "./shell";
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
  strategyNames,
  type Loaded,
  type LoaderDeps,
  type Money,
  type StrategyName,
} from "./common";

const PICKS_PER_PROFILE = 3; // threshold-ok: picks shown per profile on Home
const MAX_HOME_PICKS = 30; // threshold-ok: bound of the picks read
const MAX_IDEAS = 5; // threshold-ok: UX-011 ideas on Home
const MAX_WATCH = 50; // threshold-ok: bound of the watchlist read
const MAX_NEWS = 3; // threshold-ok: UX-011 news items on Home
const PRICE_WINDOW_DAYS = 10; // threshold-ok: calendar days that hold the two newest closes
const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const SPARK_DAYS = 30; // threshold-ok: sessions in the Home sparkline
const MAX_NEEDS = 3; // threshold-ok: UXR-020 items in Needs you
const RUN_HHMM = "18:10"; // threshold-ok: Batch 2 slot shown as the next run (controlRoom.ts A2)
const RUN_MINUTES = 18 * 60 + 10; // threshold-ok: same slot in minutes of the Melbourne day
const MEL_TZ = "Australia/Melbourne";
const MEL_PARTS = new Intl.DateTimeFormat("en-AU", {
  timeZone: MEL_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Tue 21 Oct, 16:45" in Melbourne time, or null when the instant cannot be read. */
export function melbourneStamp(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  const p = Object.fromEntries(MEL_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
}

/** UXR-020: "tonight 18:10", "tomorrow 18:10" or "Mon 18:10"; weekends skipped (holidays not known here). */
export function nextRunLabel(now: Date): string {
  const p = Object.fromEntries(MEL_PARTS.formatToParts(now).map((x) => [x.type, x.value]));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const today = marketDate(now, MEL_TZ);
  for (let off = minutes < RUN_MINUTES ? 0 : 1; off < 8; off++) {
    const d = addDays(today, off);
    if (isWeekend(d)) continue;
    if (off === 0) return `tonight ${RUN_HHMM}`;
    if (off === 1) return `tomorrow ${RUN_HHMM}`;
    return `${new Date(`${d}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" })} ${RUN_HHMM}`;
  }
  return `tonight ${RUN_HHMM}`;
}

export type SinceKind =
  "picks" | "ideas" | "fills" | "alerts" | "pickhits" | "candidates" | "breakers" | "system";
export type HomeSinceRow = { key: SinceKind; text: string; href: string };
export type HomeNeed = {
  key: string;
  tier: "P0" | "P1" | "P2";
  text: string;
  href: string;
  action: string;
};

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
  /** Link to the pick detail ("Why this pick"); the id is opaque for a masked viewer. */
  whyHref: string;
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

export type StrategyTile = {
  /** Execution id (E01, E03, ...). */
  id: string;
  name: string;
  /** What it started with and what it is worth now (liquidation value). */
  seed: Money;
  value: Money;
  sinceStart: Money;
  sinceStartPpm: number | null;
  dayChange: Money | null;
  startD: string;
};

export type HomeHeadline = {
  currency: "AUD";
  /** Combined result since the strategies started, as a share of what they started with (not a sum of amounts). */
  sinceStartPpm: number | null;
  /** The same ratio for the last session only. */
  dayChangePpm: number | null;
  /** Share since the start per session, oldest first (for the sparkline). */
  series: number[];
};

export type HomeView = {
  /** UXR-020 status strip: value and change per currency, freshness, next run, data-only mode. */
  headline: HomeHeadline[];
  /** Data finished at (ISO), shown as Melbourne time; null before the first run. */
  dataAtLabel: string | null;
  nextRun: string;
  /** True while a market runs in data-only mode (BLD-024): the one line in the strip on Home. */
  dataOnly: boolean;
  since: HomeSinceRow[];
  needs: HomeNeed[];
  picksTotal: number;
  /**
   * D-192: one tile per live strategy (its own pretend money, never added up across strategies,
   * Owner 2026-10-26), unlevered strategies only (D-191).
   */
  summary: {
    strategies: number;
    d: string | null;
    tiles: StrategyTile[];
  };
  day: {
    regime: string | null;
    regimeD: string | null;
    quality: Array<{ tier: string; score: number; gatePass: boolean }>;
    openFlags: number;
  };
  picks: { d: string | null; items: HomePick[] };
  /** UXN-301: the Intraday watch section (shadow, unrated); null when it could not be read. */
  intraday: IntradayModel | null;
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
    headline: [],
    dataAtLabel: null,
    nextRun: "",
    dataOnly: false,
    since: [],
    needs: [],
    picksTotal: 0,
    summary: { strategies: 0, d: null, tiles: [] },
    day: { regime: null, regimeD: null, quality: [], openFlags: 0 },
    picks: { d: null, items: [] },
    intraday: null,
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

  // Summary (D-192): one tile per live unlevered strategy, latest liquidation value against its
  // seed and against the session before; nothing is added across strategies.
  const nav = await deps.mainDb.execute(
    `SELECT c.execution_id, e.family, c.seed_micro, c.start_d, n.d, n.liq_nav_micro,
            (SELECT p.liq_nav_micro FROM nav_daily p WHERE p.cohort_id = n.cohort_id AND p.d < n.d
             ORDER BY p.d DESC LIMIT 1) AS prev
     FROM nav_daily n JOIN cohort c ON c.id = n.cohort_id JOIN execution e ON e.id = c.execution_id
     WHERE e.kind = 'E' AND e.variant = 'U' AND c.terminal_kind IS NULL AND c.control_idx IS NULL
       AND n.d = (SELECT MAX(x.d) FROM nav_daily x WHERE x.cohort_id = n.cohort_id)
     ORDER BY c.execution_id, c.start_d`,
  );
  const names = await soft(() => strategyNames(deps.mainDb), {} as Record<string, StrategyName>);
  const tiles: StrategyTile[] = nav.rows.map((r) => {
    const seed = num(r.seed_micro);
    const value = num(r.liq_nav_micro);
    const prev = r.prev === null || r.prev === undefined ? null : num(r.prev);
    const family = str(r.family);
    return {
      id: str(r.execution_id),
      name: names[family]?.name ?? family,
      seed: money(seed),
      value: money(value),
      sinceStart: money(value - seed),
      sinceStartPpm: ratioPpm(value - seed, seed),
      dayChange: prev === null ? null : money(value - prev),
      startD: str(r.start_d),
    };
  });
  const navD = maxDate(...nav.rows.map((r) => str(r.d)));
  if (tiles.length > 0) {
    view.summary = {
      strategies: tiles.length,
      d: navD,
      tiles,
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
      whyHref: `/picks/${encodeURIComponent(masked ? pickRef(`${pickD}.${str(r.profile)}.${num(r.rank)}`) : `${pickD}.${str(r.profile)}.${num(r.rank)}`)}`,
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

  // ---- UXR-020 status strip: freshness, next run, data-only mode, value and change ----------------
  view.nextRun = nextRunLabel(v.now);
  view.dataAtLabel = dataD
    ? melbourneStamp(
        await soft(
          async () =>
            strOrNull(
              (
                await deps.mainDb.execute({
                  sql: "SELECT at FROM completion_marker WHERE market = ? AND d = ? AND kind = 'data'",
                  args: [v.market, dataD],
                })
              ).rows[0]?.at,
            ),
          null,
        ),
      )
    : null;
  view.dataOnly = await soft(async () => {
    const r = await deps.mainDb.execute(
      "SELECT SUM(mode = 'data_only') AS d, SUM(mode = 'full') AS f FROM market",
    );
    return num(r.rows[0]?.d ?? 0) > 0 && num(r.rows[0]?.f ?? 0) === 0;
  }, false);
  if (tiles.length > 0) {
    // One ratio over all live strategies (result against what they started with); amounts are never added.
    const hist = await soft(
      async () =>
        (
          await deps.mainDb.execute({
            sql: `SELECT n.d AS d, SUM(n.liq_nav_micro) AS v, SUM(c.seed_micro) AS s
                  FROM nav_daily n JOIN cohort c ON c.id = n.cohort_id JOIN execution e ON e.id = c.execution_id
                  WHERE e.kind = 'E' AND e.variant = 'U' AND c.terminal_kind IS NULL AND c.control_idx IS NULL
                    AND n.d IN (SELECT DISTINCT d FROM nav_daily ORDER BY d DESC LIMIT ?)
                  GROUP BY n.d ORDER BY n.d`,
            args: [SPARK_DAYS],
          })
        ).rows,
      [] as Row[],
    );
    const series = hist.flatMap((r) => {
      const p = ratioPpm(num(r.v) - num(r.s), num(r.s));
      return p === null ? [] : [p];
    });
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    view.headline = [
      {
        currency: "AUD",
        sinceStartPpm: series.length > 0 ? series[series.length - 1]! : null,
        dayChangePpm:
          last && prev && num(last.s) === num(prev.s)
            ? ratioPpm(num(last.v) - num(prev.v), num(prev.v))
            : null,
        series,
      },
    ];
  }

  // ---- UXR-020 Since yesterday: counts and one link each; no code, name or price ----------------
  const count = (sql: string, args: Array<string | number>) =>
    soft(async () => num((await deps.mainDb.execute({ sql, args })).rows[0]?.n), 0);
  view.picksTotal = pickD
    ? await count("SELECT COUNT(*) AS n FROM pick WHERE market = ? AND d = ?", [v.market, pickD])
    : 0;
  const since: HomeSinceRow[] = [];
  if (view.picksTotal > 0) {
    since.push({
      key: "picks",
      text: `${view.picksTotal} new ${plural(view.picksTotal, "pick")} for the next session`,
      href: "/picks",
    });
  }
  if (view.ideas.signals > 0) {
    since.push({
      key: "ideas",
      text: `${view.ideas.signals} trade ${plural(view.ideas.signals, "idea")} tonight`,
      href: "/strategies/ideas",
    });
  }
  const fills = navD
    ? await count(
        `SELECT COUNT(*) AS n FROM fill f JOIN cohort c ON c.id = f.cohort_id JOIN execution e ON e.id = c.execution_id
         WHERE e.kind = 'E' AND e.variant = 'U' AND f.d = ?`,
        [navD],
      )
    : 0;
  if (fills > 0) {
    since.push({
      key: "fills",
      text: `${fills} practice ${plural(fills, "trade")} filled on ${formatDate(navD)}`,
      href: "/strategies",
    });
  }
  const alertsDay = await count(
    "SELECT COUNT(*) AS n FROM alert WHERE market = ? AND detected_at >= ?",
    [v.market, new Date(v.now.getTime() - DAY_MS).toISOString()],
  );
  if (alertsDay > 0) {
    since.push({
      key: "alerts",
      text: `${alertsDay} new ${plural(alertsDay, "alert")} in the last day`,
      href: "/news?chip=alerts",
    });
  }
  // M17 (UXN-305): alert hits and intraday candidates, from the same env a Picks page would use.
  const alertEnv: LoaderEnv = {
    main: deps.mainDb,
    auth: deps.authDb as LoaderEnv["auth"], // loaders only call execute()
    user: {
      id: typeof deps.user?.id === "number" ? deps.user.id : 0,
      role: deps.user?.role ?? null,
    },
    mask: { masked },
    now: v.now,
    market: v.market,
  };
  const alertFacts = await loadAlertHomeFacts(
    alertEnv,
    new Date(v.now.getTime() - 2 * DAY_MS).toISOString(),
  );
  view.intraday = await soft(() => loadIntraday(alertEnv), null);
  if (alertFacts.hits > 0) {
    since.push({
      key: "pickhits",
      text: `${alertFacts.hits} buy-price ${plural(alertFacts.hits, "alert")} reached the limit`,
      href: "/alerts",
    });
  }
  if (alertFacts.candidates > 0) {
    since.push({
      key: "candidates",
      text: `${alertFacts.candidates} intraday ${plural(alertFacts.candidates, "candidate")} found, unrated`,
      href: "/picks#intraday-h",
    });
  }
  const moved = await count(
    `SELECT COUNT(DISTINCT t.subject_id || '/' || t.breaker_id) AS n FROM thesis_breaker_eval t
     WHERE t.market = ? AND t.d = (SELECT MAX(d) FROM thesis_breaker_eval WHERE market = ?)
       AND t.status <> COALESCE((SELECT p.status FROM thesis_breaker_eval p
         WHERE p.subject_id = t.subject_id AND p.breaker_id = t.breaker_id AND p.d < t.d
         ORDER BY p.d DESC, p.seq DESC LIMIT 1), 'green')`,
    [v.market, v.market],
  );
  if (moved > 0) {
    since.push({
      key: "breakers",
      text: `${moved} warning ${plural(moved, "sign")} changed colour`,
      href: "/strategies",
    });
  }
  const attention = view.attentionCount ?? 0;
  const allPass = view.day.quality.length > 0 && view.day.quality.every((q) => q.gatePass);
  since.push({
    key: "system",
    text:
      attention > 0
        ? `${attention} ${plural(attention, "thing")} in system health need a look`
        : view.day.quality.length === 0
          ? "Price checks have not run yet"
          : allPass
            ? "Today's prices passed their checks"
            : "Some of today's prices are still being checked",
    href: "/health",
  });
  // threshold-ok: UXR-020 shows 3 to 5 rows; the system row always stays.
  view.since = [
    ...since.filter((r) => r.key !== "system").slice(0, 4),
    ...since.filter((r) => r.key === "system"),
  ];

  // ---- UXR-020 Needs you: open urgent and important alerts, then a health item for the Owner ----
  const needs: HomeNeed[] = [];
  if (typeof userId === "number") {
    const open = await soft(async () => {
      const inbox = await listInbox(
        { mainDb: deps.mainDb, authDb: deps.authDb },
        userId,
        {},
        v.now,
      );
      const rows = masked ? await maskAlertViews(deps.mainDb, inbox.alerts) : inbox.alerts;
      const nowIso = v.now.toISOString();
      return rows.filter(
        (a) =>
          a.ackedAt === null &&
          (a.snoozedUntil === null || a.snoozedUntil <= nowIso) &&
          (a.tier === "P0" || a.tier === "P1"),
      );
    }, []);
    open.sort((x, y) => (x.tier === y.tier ? 0 : x.tier === "P0" ? -1 : 1));
    for (const a of open.slice(0, MAX_NEEDS)) {
      needs.push({
        key: `alert-${needs.length}`,
        tier: a.tier,
        text: a.text,
        href: "/news?chip=alerts",
        action: "Open alert",
      });
    }
  }
  if (alertFacts.suppressed > 0 && needs.length < MAX_NEEDS) {
    needs.push({
      key: "candidates-held",
      tier: "P2",
      text: `${alertFacts.suppressed} intraday ${plural(alertFacts.suppressed, "candidate")} found; the e-mail was held back by the daily limit`,
      href: "/picks#intraday-h",
      action: "Open Intraday watch",
    });
  }
  if (attention > 0 && needs.length < MAX_NEEDS) {
    needs.push({
      key: "health",
      tier: "P1",
      text: `${attention} ${plural(attention, "thing")} in system health need a look`,
      href: "/health",
      action: "Open System Health",
    });
  }
  view.needs = needs;

  return loaded(
    maxDate(dataD, navD, ideas.data.d, pickD),
    v.now,
    masked,
    view,
    "No data yet — the strategies make their first trades after tonight's run.",
  );
}
