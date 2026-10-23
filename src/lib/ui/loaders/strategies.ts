// Loaders of the strategy pages: the list (tiles), one strategy (execution detail) and the leaderboard
// (M7 T7; docs/M7_design.md 3 rows 11 to 13; UXN-039, UXN-046, UX-020, UX-030; D-128, D-129, D-135
// draft). Tiles and the leaderboard carry no stock code at all. The detail page lists trades: for a
// masked viewer the stock is a letter of the entry date's active set, dates are ISO weeks and no price,
// stop or amount of a single trade is returned (the return of a trade, in ppm, is). Money leaves as
// `{micro, currency, simulated}`. Bounded: the tiles take one query per table for all twelve strategies,
// the detail takes at most 500 NAV rows and 50 trades.
import "server-only";
import { controlStates } from "@/lib/agents/controls";
import { parseCohortParams } from "@/lib/arena/cohort";
import { RECOST_KEYS } from "@/lib/arena/recost";
import { terminalThresholds } from "@/lib/arena/terminal";
import {
  configInt,
  latestRegime,
  loaded,
  maxDate,
  money,
  num,
  numOrNull,
  openViewer,
  PPM,
  ratioPpm,
  str,
  strategyNames,
  strOrNull,
  type Loaded,
  type LoaderDeps,
  type Money,
} from "./common";

const SPARK_POINTS = 60; // threshold-ok: sparkline length
const SPARK_WINDOW_DAYS = 120; // threshold-ok: calendar days that hold SPARK_POINTS sessions
const MAX_NAV_ROWS = 500; // threshold-ok: DAT-140 date window
const MAX_TRADES = 50; // threshold-ok: trade strip length
const MAX_ROUNDS = 50; // threshold-ok: past rounds listed
const DAY_MS = 86_400_000; // threshold-ok: unit conversion
const DEFAULT_NEAR_LIMIT_PCT = 15; // threshold-ok: registry default of attention_near_limit_pct

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export const STRATEGY_SORTS = ["best", "closest", "risk", "az"] as const;
export type StrategySort = (typeof STRATEGY_SORTS)[number];
export const parseSort = (s: string | null | undefined): StrategySort =>
  (STRATEGY_SORTS as readonly string[]).includes(s ?? "") ? (s as StrategySort) : "best";

export type ControlState = "enabled" | "paused" | "killed";
export type Stage = "seed" | "stall" | "bust" | "target";

type CohortRow = {
  id: string;
  execution: string;
  startD: string;
  seed: number;
  paramsJson: string;
  terminalKind: string | null;
  terminalD: string | null;
  live: boolean;
};

/**
 * The cohort columns this page reads. Never `SELECT *`: cohort.rng_seed is a full 64-bit integer and
 * the UI client reads integers as JS numbers, so selecting it throws a RangeError (production
 * 2026-10-23, D-172).
 */
const COHORT_COLS =
  "id, execution_id, start_d, seed_micro, params_json, terminal_kind, terminal_d, live";

const cohortFrom = (r: Record<string, unknown>): CohortRow => ({
  id: str(r.id),
  execution: str(r.execution_id),
  startD: str(r.start_d),
  seed: num(r.seed_micro),
  paramsJson: str(r.params_json),
  terminalKind: strOrNull(r.terminal_kind),
  terminalD: strOrNull(r.terminal_d),
  live: num(r.live) === 1,
});

/** Target and bust levels of a cohort from its stored parameters; null if they cannot be read. */
function limitsOf(c: CohortRow): { target: number; bust: number } | null {
  try {
    const t = terminalThresholds(parseCohortParams(c.paramsJson).terminal);
    return { target: Number(t.targetMicro), bust: Number(t.bustMicro) };
  } catch {
    return null;
  }
}

/** The position of a NAV between bust (0) and target (1,000,000) in ppm, and the stage glyph. */
function glyphOf(
  nav: number | null,
  seed: number,
  lim: { target: number; bust: number } | null,
  terminalKind: string | null,
): { stage: Stage; positionPpm: number | null } {
  let stage: Stage = "seed";
  if (terminalKind === "target") stage = "target";
  else if (terminalKind === "bust") stage = "bust";
  else if (terminalKind === "stalled" || terminalKind === "timeout") stage = "stall";
  if (nav === null || lim === null || lim.target <= lim.bust) return { stage, positionPpm: null };
  const p = Math.round(((nav - lim.bust) * PPM) / (lim.target - lim.bust));
  void seed;
  return { stage, positionPpm: Math.max(0, Math.min(PPM, p)) };
}

// ---- control state -------------------------------------------------------------------------------

export type Controls = {
  market: ControlState;
  family: Map<string, ControlState>;
  execution: Map<string, ControlState>;
};

export async function loadControls(deps: LoaderDeps): Promise<Controls> {
  // The same reading batch 2b uses (controlStates): latest row wins per scope, but a kill is sticky
  // against a later pause, so the page never shows "paused" for a family the arena treats as killed.
  const r = await deps.mainDb.execute(
    "SELECT scope, scope_key, state FROM arena_control ORDER BY id",
  );
  const states = controlStates(
    r.rows.map((x) => ({ scope: str(x.scope), scopeKey: str(x.scope_key), state: str(x.state) })),
  );
  const out: Controls = { market: "enabled", family: new Map(), execution: new Map() };
  for (const [k, state] of states) {
    const i = k.indexOf("|");
    const scope = k.slice(0, i);
    const key = k.slice(i + 1);
    if (scope === "market") out.market = state;
    else if (scope === "family") out.family.set(key, state);
    else out.execution.set(key, state);
  }
  return out;
}

const worst = (...s: ControlState[]): ControlState =>
  s.includes("killed") ? "killed" : s.includes("paused") ? "paused" : "enabled";

// ---- the list ------------------------------------------------------------------------------------

export type StrategyTile = {
  execution: string;
  family: string;
  variant: string;
  name: string;
  oneLiner: string;
  /** "Plain shares" (U) or "With leverage sleeve" (L). */
  moneyType: string;
  hasCohort: boolean;
  /** Round number (1 for the first cohort of the strategy). */
  round: number;
  startD: string | null;
  sessions: number;
  live: boolean;
  seed: Money | null;
  nav: Money | null;
  returnPpm: number | null;
  /** Progress from bust (0) to target (1,000,000). */
  positionPpm: number | null;
  bust: Money | null;
  target: Money | null;
  stage: Stage;
  /** Share of NAV above the bust level, ppm; the smaller it is the closer the strategy is to busting. */
  bustDistancePpm: number | null;
  label: string | null;
  regime: string | null;
  control: ControlState;
  needsAttention: boolean;
  attention: string[];
  /** Up to 60 NAV values (micro-AUD), oldest first. */
  spark: number[];
};

export type StrategiesView = {
  sort: StrategySort;
  /** Needs-attention tiles first, then the rest, each part in the chosen order. */
  tiles: StrategyTile[];
  attentionCount: number;
  market: { control: ControlState };
};

export async function loadStrategies(
  deps: LoaderDeps,
  params: { sort?: string | null } = {},
): Promise<Loaded<StrategiesView>> {
  const v = await openViewer(deps);
  const sort = parseSort(params.sort);
  const execs = await deps.mainDb.execute(
    "SELECT id, family, variant FROM execution WHERE kind = 'E' ORDER BY id",
  );
  const ids = execs.rows.map((r) => str(r.id));
  const names = await strategyNames(deps.mainDb);
  const nearPct = await configInt(deps.mainDb, "attention_near_limit_pct", DEFAULT_NEAR_LIMIT_PCT);
  const controls = await loadControls(deps);
  const regime = await latestRegime(deps.mainDb, v.market);

  const latest = new Map<string, CohortRow>();
  const rounds = new Map<string, number>();
  if (ids.length > 0) {
    const inList = placeholders(ids.length);
    const cs = await deps.mainDb.execute({
      sql: `SELECT ${COHORT_COLS} FROM cohort c WHERE c.control_idx IS NULL AND c.execution_id IN (${inList})
              AND c.id = (SELECT c2.id FROM cohort c2 WHERE c2.execution_id = c.execution_id
                          AND c2.control_idx IS NULL ORDER BY c2.start_d DESC, c2.id DESC LIMIT 1)
            ORDER BY c.execution_id`,
      args: ids,
    });
    for (const r of cs.rows) latest.set(str(r.execution_id), cohortFrom(r));
    const rc = await deps.mainDb.execute({
      sql: `SELECT execution_id, COUNT(*) AS n FROM cohort
            WHERE control_idx IS NULL AND execution_id IN (${inList}) GROUP BY execution_id`,
      args: ids,
    });
    for (const r of rc.rows) rounds.set(str(r.execution_id), num(r.n));
  }

  const cohortIds = [...latest.values()].map((c) => c.id);
  const navs = new Map<string, Array<{ d: string; nav: number }>>();
  const sessions = new Map<string, number>();
  let newest: string | null = null;
  if (cohortIds.length > 0) {
    const inList = placeholders(cohortIds.length);
    const lastD = await deps.mainDb.execute({
      sql: `SELECT MAX(d) AS d FROM nav_daily WHERE cohort_id IN (${inList})`,
      args: cohortIds,
    });
    newest = strOrNull(lastD.rows[0]?.d);
    if (newest !== null) {
      const rows = await deps.mainDb.execute({
        sql: `SELECT cohort_id, d, liq_nav_micro FROM nav_daily
              WHERE cohort_id IN (${inList}) AND d >= ? ORDER BY cohort_id, d`,
        args: [...cohortIds, addDays(newest, -SPARK_WINDOW_DAYS)],
      });
      for (const r of rows.rows) {
        const k = str(r.cohort_id);
        navs.set(k, [...(navs.get(k) ?? []), { d: str(r.d), nav: num(r.liq_nav_micro) }]);
      }
    }
    const sc = await deps.mainDb.execute({
      sql: `SELECT cohort_id, COUNT(*) AS n FROM nav_daily WHERE cohort_id IN (${inList}) GROUP BY cohort_id`,
      args: cohortIds,
    });
    for (const r of sc.rows) sessions.set(str(r.cohort_id), num(r.n));
  }

  const labels = new Map<string, string>();
  if (ids.length > 0) {
    const lr = await deps.mainDb.execute({
      sql: `SELECT execution_id, label FROM (
              SELECT execution_id, label,
                     ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY d DESC, id DESC) AS rn
              FROM label WHERE execution_id IN (${placeholders(ids.length)})) WHERE rn = 1`,
      args: ids,
    });
    for (const r of lr.rows) labels.set(str(r.execution_id), str(r.label));
  }

  const tiles: StrategyTile[] = execs.rows.map((e) => {
    const id = str(e.id);
    const family = str(e.family);
    const c = latest.get(id) ?? null;
    const series = c ? (navs.get(c.id) ?? []) : [];
    const last = series.length > 0 ? series[series.length - 1]!.nav : null;
    const lim = c ? limitsOf(c) : null;
    const g = glyphOf(last, c?.seed ?? 0, lim, c?.terminalKind ?? null);
    const control = worst(
      controls.market,
      controls.family.get(family) ?? "enabled",
      controls.execution.get(id) ?? "enabled",
    );
    const bustDist =
      last !== null && lim !== null && last > 0 ? ratioPpm(last - lim.bust, last) : null;
    const attention: string[] = [];
    if (control === "killed") attention.push("Stopped by the kill switch");
    else if (control === "paused") attention.push("Paused");
    if (c?.terminalKind === "bust") attention.push("Busted");
    else if (
      c !== null &&
      c.terminalKind === null &&
      bustDist !== null &&
      bustDist <= (nearPct * PPM) / 100 // threshold-ok: percent to ppm
    ) {
      attention.push(`Within ${nearPct}% of the bust level`);
    }
    return {
      execution: id,
      family,
      variant: str(e.variant),
      name: names[family]?.name ?? family,
      oneLiner: names[family]?.one_liner ?? "",
      moneyType: str(e.variant) === "L" ? "With leverage sleeve" : "Plain shares",
      hasCohort: c !== null,
      round: rounds.get(id) ?? 0,
      startD: c?.startD ?? null,
      sessions: c ? (sessions.get(c.id) ?? 0) : 0,
      live: c !== null && c.terminalKind === null,
      seed: c ? money(c.seed) : null,
      nav: last === null ? null : money(last),
      returnPpm: last !== null && c ? ratioPpm(last - c.seed, c.seed) : null,
      positionPpm: g.positionPpm,
      bust: lim ? money(lim.bust) : null,
      target: lim ? money(lim.target) : null,
      stage: g.stage,
      bustDistancePpm: bustDist,
      label: labels.get(id) ?? null,
      regime: regime?.state ?? null,
      control,
      needsAttention: attention.length > 0,
      attention,
      spark: series.slice(-SPARK_POINTS).map((p) => p.nav),
    };
  });

  const key = (t: StrategyTile): number => {
    // Ascending sort key; a missing figure sorts last.
    const miss = Number.POSITIVE_INFINITY;
    if (sort === "best") return t.returnPpm === null ? miss : -t.returnPpm;
    if (sort === "closest") return t.positionPpm === null ? miss : -t.positionPpm;
    if (sort === "risk") return t.bustDistancePpm === null ? miss : t.bustDistancePpm;
    return 0;
  };
  tiles.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    if (sort === "az")
      return cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.execution, b.execution);
    const ka = key(a);
    const kb = key(b);
    return (ka === kb ? 0 : ka < kb ? -1 : 1) || cmp(a.execution, b.execution);
  });

  return loaded(
    newest,
    v.now,
    v.masker.masked,
    {
      sort,
      tiles,
      attentionCount: tiles.filter((t) => t.needsAttention).length,
      market: { control: controls.market },
    },
    "No rounds yet — the strategies start when the market is switched on.",
  );
}

// ---- one strategy --------------------------------------------------------------------------------

export type TradeRow = {
  /** Letter or code. */
  stock: string;
  /** Entry and exit dates: exact, or ISO weeks for a masked viewer. */
  entryDay: string | null;
  exitDay: string | null;
  qty: number;
  open: boolean;
  exitType: string | null;
  /** Return of the trade between its two fills, ppm; null while open. */
  returnPpm: number | null;
  /** Entry and exit prices in micro-AUD; always null for a masked viewer. */
  entryPriceMicro: number | null;
  exitPriceMicro: number | null;
};

export type PastRound = {
  round: number;
  startD: string;
  terminalKind: string | null;
  terminalD: string | null;
  sessions: number | null;
  outcome: Money | null;
};

export type StrategyDetail = {
  found: boolean;
  execution: string | null;
  family: string | null;
  variant: string | null;
  name: string | null;
  oneLiner: string | null;
  tile: StrategyTile | null;
  ruleVersion: string | null;
  costProfile: string | null;
  /** Up to 500 sessions of NAV (micro-AUD), oldest first. */
  navSeries: Array<{ d: string; nav: number }>;
  trades: TradeRow[];
  pastRounds: PastRound[];
  /** Leverage sleeve state (variant L only). */
  sleeve: {
    state: string;
    mode: string;
    sinceD: string;
    lossToRecover: Money;
    openTrades: number;
  } | null;
};

const NO_DETAIL: StrategyDetail = {
  found: false,
  execution: null,
  family: null,
  variant: null,
  name: null,
  oneLiner: null,
  tile: null,
  ruleVersion: null,
  costProfile: null,
  navSeries: [],
  trades: [],
  pastRounds: [],
  sleeve: null,
};

const EXECUTION_RE = /^[A-Za-z0-9._-]{1,40}$/;

export async function loadStrategyDetail(
  deps: LoaderDeps,
  executionId: string,
): Promise<Loaded<StrategyDetail>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const absent = () =>
    loaded<StrategyDetail>(null, v.now, masked, NO_DETAIL, "This strategy was not found.");
  if (!EXECUTION_RE.test(executionId)) return absent();
  const ex = await deps.mainDb.execute({
    sql: "SELECT id, kind, family, variant, rule_version, cost_profile FROM execution WHERE id = ? AND kind = 'E'",
    args: [executionId],
  });
  if (ex.rows.length === 0) return absent();
  const e = ex.rows[0]!;
  const family = str(e.family);
  const names = await strategyNames(deps.mainDb);

  const list = await loadStrategies(deps);
  const tile = list.data.tiles.find((t) => t.execution === executionId) ?? null;

  const cs = await deps.mainDb.execute({
    sql: `SELECT ${COHORT_COLS} FROM cohort WHERE execution_id = ? AND control_idx IS NULL
          ORDER BY start_d DESC, id DESC LIMIT ?`,
    args: [executionId, MAX_ROUNDS],
  });
  const cohorts = cs.rows.map(cohortFrom);
  const current = cohorts[0] ?? null;

  let navSeries: Array<{ d: string; nav: number }> = [];
  const trades: TradeRow[] = [];
  let sleeve: StrategyDetail["sleeve"] = null;
  const sessionsOf = new Map<string, number>();
  if (cohorts.length > 0) {
    const sc = await deps.mainDb.execute({
      sql: `SELECT cohort_id, COUNT(*) AS n FROM nav_daily WHERE cohort_id IN (${placeholders(cohorts.length)}) GROUP BY cohort_id`,
      args: cohorts.map((c) => c.id),
    });
    for (const r of sc.rows) sessionsOf.set(str(r.cohort_id), num(r.n));
  }
  if (current) {
    const nr = await deps.mainDb.execute({
      sql: "SELECT d, liq_nav_micro FROM nav_daily WHERE cohort_id = ? ORDER BY d DESC LIMIT ?",
      args: [current.id, MAX_NAV_ROWS],
    });
    navSeries = nr.rows.map((r) => ({ d: str(r.d), nav: num(r.liq_nav_micro) })).reverse();

    const tr = await deps.mainDb.execute({
      sql: `SELECT t.id, t.code, t.exit_type, ef.d AS entry_d, ef.qty AS qty,
                   ef.fill_price_micro AS entry_price, xf.d AS exit_d, xf.fill_price_micro AS exit_price
            FROM trade t JOIN fill ef ON ef.id = t.entry_fill_id
            LEFT JOIN fill xf ON xf.id = t.exit_fill_id
            WHERE t.cohort_id = ? ORDER BY ef.d DESC, t.id LIMIT ?`,
      args: [current.id, MAX_TRADES],
    });
    const codesByDate = new Map<string, string[]>();
    let lo = "9999-12-31";
    let hi = "0000-01-01";
    for (const r of tr.rows) {
      const d = str(r.entry_d);
      codesByDate.set(d, [...(codesByDate.get(d) ?? []), str(r.code)]);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const scopeOf = await v.masker.scopes(lo, hi, codesByDate);
    for (const r of tr.rows) {
      const sc = scopeOf(str(r.entry_d));
      const ep = num(r.entry_price);
      const xp = numOrNull(r.exit_price);
      trades.push({
        stock: sc.label(str(r.code)),
        entryDay: sc.day(str(r.entry_d)),
        exitDay: r.exit_d === null || r.exit_d === undefined ? null : sc.day(str(r.exit_d)),
        qty: num(r.qty),
        open: r.exit_type === null,
        exitType: strOrNull(r.exit_type),
        returnPpm: xp === null || ep <= 0 ? null : Math.round(((xp - ep) * PPM) / ep),
        entryPriceMicro: masked ? null : ep,
        exitPriceMicro: masked ? null : xp,
      });
    }

    if (str(e.variant) === "L") {
      const ss = await deps.mainDb.execute({
        sql: "SELECT state, mode, d, loss_to_recover_micro FROM sleeve_state WHERE cohort_id = ? ORDER BY seq DESC LIMIT 1",
        args: [current.id],
      });
      const open = await deps.mainDb.execute({
        sql: "SELECT COUNT(*) AS n FROM sleeve_trade WHERE cohort_id = ? AND closed_by IS NULL AND shadow = 0",
        args: [current.id],
      });
      const s0 = ss.rows[0];
      sleeve = s0
        ? {
            state: str(s0.state),
            mode: str(s0.mode),
            sinceD: str(s0.d),
            lossToRecover: money(num(s0.loss_to_recover_micro)),
            openTrades: num(open.rows[0]?.n),
          }
        : null;
    }
  }

  const total = cohorts.length;
  const pastRounds: PastRound[] = cohorts.map((c, i) => ({
    round: total - i,
    startD: c.startD,
    terminalKind: c.terminalKind,
    terminalD: c.terminalD,
    sessions: sessionsOf.get(c.id) ?? null,
    outcome: null,
  }));
  if (cohorts.length > 0) {
    const oc = await deps.mainDb.execute({
      sql: `SELECT id, outcome_micro FROM cohort WHERE execution_id = ? AND control_idx IS NULL
            AND outcome_micro IS NOT NULL ORDER BY start_d DESC, id DESC LIMIT ?`,
      args: [executionId, MAX_ROUNDS],
    });
    const byId = new Map(oc.rows.map((r) => [str(r.id), num(r.outcome_micro)]));
    cohorts.forEach((c, i) => {
      const o = byId.get(c.id);
      if (o !== undefined) pastRounds[i]!.outcome = money(o);
    });
  }

  return loaded(
    maxDate(navSeries[navSeries.length - 1]?.d, null),
    v.now,
    masked,
    {
      found: true,
      execution: executionId,
      family,
      variant: str(e.variant),
      name: names[family]?.name ?? family,
      oneLiner: names[family]?.one_liner ?? null,
      tile,
      ruleVersion: str(e.rule_version),
      costProfile: str(e.cost_profile),
      navSeries,
      trades,
      pastRounds,
      sleeve,
    },
    "No rounds yet — this strategy starts when the market is switched on.",
  );
}

// ---- the leaderboard -----------------------------------------------------------------------------

export type LeaderRow = {
  execution: string;
  /** "E" for a strategy, else the control kind (C1, C2, C3). */
  kind: string;
  family: string | null;
  variant: string | null;
  name: string;
  label: string | null;
  rounds: number;
  finished: number;
  live: number;
  reachedTarget: number;
  busted: number;
  stalled: number;
  timedOut: number;
  /** Mean final value of the finished rounds minus the seed, in ppm of the seed; null before one finishes. */
  meanReturnPpm: number | null;
  /** Value of the live round under the chosen cost profile (re-cost rows), when one was asked for. */
  recostNav: Money | null;
};

export type LeaderboardView = {
  cost: string | null;
  costKeys: string[];
  strategies: LeaderRow[];
  controls: LeaderRow[];
};

export async function loadLeaderboard(
  deps: LoaderDeps,
  params: { cost?: string | null } = {},
): Promise<Loaded<LeaderboardView>> {
  const v = await openViewer(deps);
  const keys = [...RECOST_KEYS] as string[];
  const cost = params.cost && keys.includes(params.cost) ? params.cost : null;
  const names = await strategyNames(deps.mainDb);

  const g = await deps.mainDb.execute(
    `SELECT e.id, e.kind, e.family, e.variant, c.terminal_kind AS tk, COUNT(*) AS n,
            SUM(c.outcome_micro) AS out_sum, SUM(c.seed_micro) AS seed_sum
     FROM cohort c JOIN execution e ON e.id = c.execution_id
     GROUP BY e.id, e.kind, e.family, e.variant, c.terminal_kind ORDER BY e.id, c.terminal_kind`,
  );
  type Acc = {
    kind: string;
    family: string | null;
    variant: string | null;
    ids: Set<string>;
    row: LeaderRow;
    out: number;
    seed: number;
  };
  const accs = new Map<string, Acc>();
  for (const r of g.rows) {
    const kind = str(r.kind);
    const family = strOrNull(r.family);
    const key = kind === "E" ? str(r.id) : `${kind}:${family ?? ""}`;
    let a = accs.get(key);
    if (!a) {
      const fname = family !== null ? (names[family]?.name ?? family) : null;
      a = {
        kind,
        family,
        variant: kind === "E" ? strOrNull(r.variant) : null,
        ids: new Set(),
        out: 0,
        seed: 0,
        row: {
          execution: kind === "E" ? str(r.id) : key,
          kind,
          family,
          variant: kind === "E" ? strOrNull(r.variant) : null,
          name:
            kind === "E"
              ? `${fname ?? str(r.id)}${str(r.variant) === "L" ? " (with leverage sleeve)" : ""}`
              : `Control ${kind}${fname ? `: ${fname}` : ""}`,
          label: null,
          rounds: 0,
          finished: 0,
          live: 0,
          reachedTarget: 0,
          busted: 0,
          stalled: 0,
          timedOut: 0,
          meanReturnPpm: null,
          recostNav: null,
        },
      };
      accs.set(key, a);
    }
    a.ids.add(str(r.id));
    const n = num(r.n);
    const tk = strOrNull(r.tk);
    a.row.rounds += n;
    if (tk === null) a.row.live += n;
    else {
      a.row.finished += n;
      a.out += num(r.out_sum);
      a.seed += num(r.seed_sum);
      if (tk === "target") a.row.reachedTarget += n;
      else if (tk === "bust") a.row.busted += n;
      else if (tk === "stalled") a.row.stalled += n;
      else if (tk === "timeout") a.row.timedOut += n;
    }
  }
  for (const a of accs.values()) {
    a.row.meanReturnPpm =
      a.row.finished > 0 && a.seed > 0 ? ratioPpm(a.out - a.seed, a.seed) : null;
  }

  // Labels of the strategies (latest per execution).
  const lr = await deps.mainDb.execute(
    `SELECT execution_id, label FROM (
       SELECT execution_id, label,
              ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY d DESC, id DESC) AS rn FROM label
     ) WHERE rn = 1`,
  );
  const labelOf = new Map(lr.rows.map((r) => [str(r.execution_id), str(r.label)]));
  for (const a of accs.values())
    if (a.kind === "E") a.row.label = labelOf.get(a.row.execution) ?? null;

  // Re-cost rows of the live round of each strategy (replay_stat scope cost:<cohort>).
  if (cost !== null) {
    const live = await deps.mainDb.execute(
      `SELECT c.id, c.execution_id FROM cohort c JOIN execution e ON e.id = c.execution_id
       WHERE e.kind = 'E' AND c.terminal_kind IS NULL AND c.control_idx IS NULL ORDER BY c.id`,
    );
    const byCohort = new Map(live.rows.map((r) => [`cost:${str(r.id)}`, str(r.execution_id)]));
    if (byCohort.size > 0) {
      const rs = await deps.mainDb.execute({
        sql: `SELECT scope, d, value_json FROM replay_stat
              WHERE metric = ? AND scope IN (${placeholders(byCohort.size)}) ORDER BY scope, d`,
        args: [`recost:${cost}`, ...byCohort.keys()],
      });
      for (const r of rs.rows) {
        const exId = byCohort.get(str(r.scope));
        const a = exId ? accs.get(exId) : undefined;
        if (!a) continue;
        try {
          const nav = Number(
            (JSON.parse(str(r.value_json)) as { liq_nav_micro?: string }).liq_nav_micro,
          );
          if (Number.isFinite(nav)) a.row.recostNav = money(nav);
        } catch {
          // an unreadable row leaves the cell empty
        }
      }
    }
  }

  const rank = (x: LeaderRow, y: LeaderRow): number => {
    const a = x.meanReturnPpm;
    const b = y.meanReturnPpm;
    if (a !== b) {
      if (a === null) return 1;
      if (b === null) return -1;
      return b - a;
    }
    return cmp(x.execution, y.execution);
  };
  const all = [...accs.values()].map((a) => a.row);
  const strategies = all.filter((r) => r.kind === "E").sort(rank);
  const controls = all.filter((r) => r.kind !== "E").sort(rank);
  const newest = await deps.mainDb.execute("SELECT MAX(d) AS d FROM nav_daily");

  return loaded(
    strOrNull(newest.rows[0]?.d),
    v.now,
    v.masker.masked,
    { cost, costKeys: keys, strategies, controls },
    "No rounds yet — the leaderboard fills as rounds finish.",
  );
}
