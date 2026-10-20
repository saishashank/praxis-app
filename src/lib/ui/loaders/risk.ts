// Loader of the risk overview (M7 T7; docs/M7_design.md 3 row 14; UX-050, UX-051, UXN-150, UXN-152;
// D-128, D-129, D-135 draft): the open positions of the live strategies, how concentrated they are, the
// thesis-breakers that are amber or red, the pause and kill state, and the price-shock ladder written
// by batch 3 (replay_stat `shock:<cohort>`, D-132). For a masked viewer a position is a letter with its
// weight and its distance to the stop in ppm; the amounts, closing prices and stop levels are not
// returned. Strategy-level figures (value, shocks) carry no code and stay visible.
import "server-only";
import { loadControls, type ControlState } from "./strategies";
import {
  loaded,
  maxDate,
  money,
  num,
  openViewer,
  PPM,
  ratioPpm,
  str,
  strategyNames,
  type Loaded,
  type LoaderDeps,
  type Money,
} from "./common";

const MAX_BREAKERS = 50; // threshold-ok: bound of the breaker list
const TOP_CONCENTRATION = 10; // threshold-ok: concentration bars shown
const SHOCK_PCTS = [-30, -20, -10, 10, 20, 30] as const; // threshold-ok: UXN-152 shock ladder

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export type RiskPosition = {
  stock: string;
  qty: number;
  /** Share of the strategy's liquidation value, ppm. */
  weightPpm: number | null;
  /** (close - stop) / close, ppm; null when there is no stop. */
  stopDistancePpm: number | null;
  held: boolean;
  /** Value of the position; null for a masked viewer. */
  value: Money | null;
};

export type RiskStrategy = {
  execution: string;
  name: string;
  d: string;
  nav: Money;
  /** Invested share of the value, ppm. */
  investedPpm: number | null;
  positions: RiskPosition[];
};

export type RiskBreaker = {
  stock: string;
  execution: string | null;
  breaker: string;
  status: "amber" | "red";
  day: string | null;
  value: string;
  trigger: string;
};

export type RiskView = {
  d: string | null;
  strategies: RiskStrategy[];
  /** Largest stocks by weight across all live strategies. */
  concentration: Array<{ stock: string; weightPpm: number; strategies: number }>;
  breakers: RiskBreaker[];
  /** Everything that is not enabled; empty means all running. */
  controls: Array<{ scope: "market" | "family" | "execution"; key: string; state: ControlState }>;
  /** Sum over the live strategies of the value change under a uniform price move. */
  shocks: Array<{ pct: number; pnl: Money }>;
};

const EMPTY: RiskView = {
  d: null,
  strategies: [],
  concentration: [],
  breakers: [],
  controls: [],
  shocks: [],
};

export async function loadRisk(deps: LoaderDeps): Promise<Loaded<RiskView>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const names = await strategyNames(deps.mainDb);

  const live = await deps.mainDb.execute(
    `SELECT c.id, c.execution_id, e.family FROM cohort c JOIN execution e ON e.id = c.execution_id
     WHERE e.kind = 'E' AND c.terminal_kind IS NULL AND c.control_idx IS NULL ORDER BY c.execution_id, c.id`,
  );
  const cohorts = live.rows.map((r) => ({
    id: str(r.id),
    execution: str(r.execution_id),
    family: str(r.family),
  }));
  const controls = await loadControls(deps);
  const controlRows: RiskView["controls"] = [];
  if (controls.market !== "enabled")
    controlRows.push({ scope: "market", key: v.market, state: controls.market });
  for (const [k, s] of [...controls.family].sort((a, b) => cmp(a[0], b[0]))) {
    if (s !== "enabled") controlRows.push({ scope: "family", key: k, state: s });
  }
  for (const [k, s] of [...controls.execution].sort((a, b) => cmp(a[0], b[0]))) {
    if (s !== "enabled") controlRows.push({ scope: "execution", key: k, state: s });
  }

  if (cohorts.length === 0) {
    return loaded(
      null,
      v.now,
      masked,
      { ...EMPTY, controls: controlRows },
      "No positions yet — the strategies start when the market is switched on.",
    );
  }
  const ids = cohorts.map((c) => c.id);
  const inList = placeholders(ids.length);

  const navRows = await deps.mainDb.execute({
    sql: `SELECT n.cohort_id, n.d, n.liq_nav_micro FROM nav_daily n
          WHERE n.cohort_id IN (${inList})
            AND n.d = (SELECT MAX(d) FROM nav_daily x WHERE x.cohort_id = n.cohort_id)`,
    args: ids,
  });
  const navOf = new Map(
    navRows.rows.map((r) => [str(r.cohort_id), { d: str(r.d), nav: num(r.liq_nav_micro) }]),
  );
  const posRows = await deps.mainDb.execute({
    sql: `SELECT p.cohort_id, p.d, p.code, p.qty, p.close_micro, p.value_micro, p.haircut
          FROM nav_daily_pos p WHERE p.cohort_id IN (${inList})
            AND p.d = (SELECT MAX(d) FROM nav_daily x WHERE x.cohort_id = p.cohort_id)
          ORDER BY p.cohort_id, p.code`,
    args: ids,
  });
  const stopRows = await deps.mainDb.execute({
    sql: `SELECT t.cohort_id, t.code, t.stop_micro,
                 (SELECT MAX(s.level_micro) FROM stop_level s WHERE s.trade_id = t.id
                    AND s.d = (SELECT MAX(s2.d) FROM stop_level s2 WHERE s2.trade_id = t.id)) AS level
          FROM trade t WHERE t.cohort_id IN (${inList}) AND t.exit_type IS NULL`,
    args: ids,
  });
  const stopOf = new Map<string, number>();
  for (const r of stopRows.rows) {
    const k = `${str(r.cohort_id)}|${str(r.code)}`;
    const eff = Math.max(num(r.stop_micro), r.level === null ? 0 : num(r.level));
    stopOf.set(k, Math.max(stopOf.get(k) ?? 0, eff));
  }

  const newest = maxDate(...[...navOf.values()].map((x) => x.d));
  if (newest === null) {
    return loaded(
      null,
      v.now,
      masked,
      { ...EMPTY, controls: controlRows },
      "No positions yet — the first closing values arrive after the first session.",
    );
  }

  // Breakers that need attention: latest evaluation date.
  const br = await deps.mainDb.execute({
    sql: `SELECT breaker_id, d, card_id, code, status, value_text, trigger_text FROM thesis_breaker_eval
          WHERE subject_kind = 'trade' AND status IN ('amber','red')
            AND d = (SELECT MAX(d) FROM thesis_breaker_eval WHERE subject_kind = 'trade')
          ORDER BY status DESC, code, breaker_id LIMIT ?`,
    args: [MAX_BREAKERS],
  });

  // Collect every code first, letter them afterwards (one active set per date).
  const codesByDate = new Map<string, string[]>();
  const push = (d: string, c: string) => codesByDate.set(d, [...(codesByDate.get(d) ?? []), c]);
  for (const r of posRows.rows) push(str(r.d), str(r.code));
  for (const r of br.rows) push(str(r.d), str(r.code));
  const dates = [...codesByDate.keys()].sort();
  const scopeOf = await v.masker.scopes(
    dates[0] ?? newest,
    dates[dates.length - 1] ?? newest,
    codesByDate,
  );

  const byCohort = new Map<string, typeof posRows.rows>();
  for (const r of posRows.rows)
    byCohort.set(str(r.cohort_id), [...(byCohort.get(str(r.cohort_id)) ?? []), r]);
  const weight = new Map<string, { sum: number; strategies: Set<string>; label: string }>();
  let totalNav = 0;
  const strategies: RiskStrategy[] = [];
  for (const c of cohorts) {
    const nav = navOf.get(c.id);
    if (!nav) continue;
    const sc = scopeOf(nav.d);
    totalNav += nav.nav;
    const rows = byCohort.get(c.id) ?? [];
    const positions: RiskPosition[] = rows.map((r) => {
      const close = num(r.close_micro);
      const stop = stopOf.get(`${c.id}|${str(r.code)}`);
      const value = num(r.value_micro);
      const label = sc.label(str(r.code));
      const w = weight.get(label) ?? { sum: 0, strategies: new Set<string>(), label };
      w.sum += value;
      w.strategies.add(c.execution);
      weight.set(label, w);
      return {
        stock: label,
        qty: num(r.qty),
        weightPpm: ratioPpm(value, nav.nav),
        stopDistancePpm:
          stop === undefined || close <= 0 ? null : Math.round(((close - stop) * PPM) / close),
        held: num(r.haircut) === 1,
        value: masked ? null : money(value),
      };
    });
    const invested = rows.reduce((s, r) => s + num(r.value_micro), 0);
    strategies.push({
      execution: c.execution,
      name: names[c.family]?.name ?? c.family,
      d: nav.d,
      nav: money(nav.nav),
      investedPpm: ratioPpm(invested, nav.nav),
      positions,
    });
  }
  strategies.sort((a, b) => cmp(a.execution, b.execution));

  const concentration = [...weight.values()]
    .map((w) => ({
      stock: w.label,
      weightPpm: ratioPpm(w.sum, totalNav) ?? 0,
      strategies: w.strategies.size,
    }))
    .sort((a, b) => b.weightPpm - a.weightPpm || cmp(a.stock, b.stock))
    .slice(0, TOP_CONCENTRATION);

  const breakers: RiskBreaker[] = br.rows.map((r) => {
    const sc = scopeOf(str(r.d));
    const card = str(r.card_id);
    return {
      stock: sc.label(str(r.code)),
      execution: card.includes(":") ? (card.split(":").pop() ?? null) : null,
      breaker: sc.text(str(r.breaker_id)),
      status: str(r.status) === "red" ? "red" : "amber",
      day: sc.day(str(r.d)),
      value: sc.text(str(r.value_text)),
      trigger: sc.text(str(r.trigger_text)),
    };
  });

  // Price-shock ladder: the newest row of each live cohort and each step, summed.
  const shockRows = await deps.mainDb.execute({
    sql: `SELECT scope, metric, value_json FROM replay_stat r
          WHERE scope IN (${inList}) AND metric LIKE 'shock:%'
            AND d = (SELECT MAX(d) FROM replay_stat x WHERE x.scope = r.scope AND x.metric = r.metric)
          ORDER BY scope, metric`,
    args: ids.map((id) => `shock:${id}`),
  });
  const pnl = new Map<number, number>();
  for (const r of shockRows.rows) {
    try {
      const j = JSON.parse(str(r.value_json)) as { pct?: number; pnl_micro?: string };
      const pct = Number(j.pct);
      const p = Number(j.pnl_micro);
      if ((SHOCK_PCTS as readonly number[]).includes(pct) && Number.isFinite(p)) {
        pnl.set(pct, (pnl.get(pct) ?? 0) + p);
      }
    } catch {
      // an unreadable row is skipped
    }
  }
  const shocks = SHOCK_PCTS.filter((p) => pnl.has(p)).map((p) => ({
    pct: p,
    pnl: money(pnl.get(p)!),
  }));

  return loaded(newest, v.now, masked, {
    d: newest,
    strategies,
    concentration,
    breakers,
    controls: controlRows,
    shocks,
  });
}
