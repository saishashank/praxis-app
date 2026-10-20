// Loader of the risk overview (M7 T7; docs/M7_design.md 3 row 14; UX-050, UX-051, UXN-150, UXN-152;
// D-128, D-129, D-135 draft): the open positions of the live strategies, how concentrated they are, the
// thesis-breakers that are amber or red, the pause and kill state, and the price-shock ladder written
// by batch 3 (replay_stat `shock:<cohort>`, D-132). For a masked viewer a position is a letter with its
// weight and its distance to the stop in ppm; the amounts, closing prices and stop levels are not
// returned. Strategy-level figures (value, shocks) carry no code and stay visible.
import "server-only";
import { parseCohortParams } from "@/lib/arena/cohort";
import { terminalThresholds } from "@/lib/arena/terminal";
import { loadControls, type ControlState } from "./strategies";
import {
  configInt,
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

const DEFAULT_NEAR_LIMIT_PCT = 15; // threshold-ok: registry default of attention_near_limit_pct
const MAX_BREAKERS = 50; // threshold-ok: bound of the breaker list
const TOP_CONCENTRATION = 10; // threshold-ok: concentration bars shown
const SHOCK_PCTS = [-30, -20, -10, 10, 20, 30] as const; // threshold-ok: UXN-152 shock ladder

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The loss limit ("bust") of a round from its stored parameters; null if they cannot be read. */
function bustOf(paramsJson: string): number | null {
  try {
    return Number(terminalThresholds(parseCohortParams(paramsJson).terminal).bustMicro);
  } catch {
    return null;
  }
}
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export type RiskPosition = {
  execution: string;
  stock: string;
  /** Latest thesis-breaker result of the position (UXN-104); "unknown" before a nightly check exists. */
  breaker: "green" | "amber" | "red" | "unknown";
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
  /** Loss limit of the round (UXN-150, "bust"), micro; null if the round's parameters cannot be read. */
  bust: Money | null;
  /** Starting money of the round. */
  seed: Money;
  /** Within `attention_near_limit_pct` of the loss limit (or at it). */
  nearBust: boolean;
  /** Invested share of the value, ppm. */
  investedPpm: number | null;
  positions: RiskPosition[];
};

/** One strategy or family the Owner may pause or switch off, with its own state and the effective one. */
export type RiskSwitch = {
  key: string;
  name: string;
  /** Own state in the append-only log. */
  state: ControlState;
  /** Worst of the market, family and own state (family and market only for a strategy). */
  effective: ControlState;
};

export type StressFlag = "safe" | "caution" | "bust";

/** UXN-152 row: the summed change, a flag and how many strategies the flag is about. */
export type StressRow = { pct: number; pnl: Money; flag: StressFlag; affected: number };

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
  /** The same ladder with the safe / caution / bust flag (UXN-152): any strategy that would reach the loss limit. */
  stress: StressRow[];
  /** `attention_near_limit_pct`: how close to the loss limit counts as "near" (UXN-150). */
  nearPct: number;
  /** Whether a nightly thesis-breaker check exists for the newest day (green means "checked, none triggered"). */
  breakersChecked: boolean;
  /** The Owner's switches: one per strategy (pause / resume) and one per family (kill / lift). */
  executions: Array<RiskSwitch & { family: string }>;
  families: RiskSwitch[];
};

const EMPTY: RiskView = {
  d: null,
  strategies: [],
  concentration: [],
  breakers: [],
  controls: [],
  shocks: [],
  stress: [],
  nearPct: DEFAULT_NEAR_LIMIT_PCT,
  breakersChecked: false,
  executions: [],
  families: [],
};

export async function loadRisk(deps: LoaderDeps): Promise<Loaded<RiskView>> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const names = await strategyNames(deps.mainDb);

  const live = await deps.mainDb.execute(
    `SELECT c.id, c.execution_id, e.family, c.seed_micro, c.params_json
     FROM cohort c JOIN execution e ON e.id = c.execution_id
     WHERE e.kind = 'E' AND c.terminal_kind IS NULL AND c.control_idx IS NULL ORDER BY c.execution_id, c.id`,
  );
  const cohorts = live.rows.map((r) => ({
    id: str(r.id),
    execution: str(r.execution_id),
    family: str(r.family),
    seed: num(r.seed_micro),
    paramsJson: str(r.params_json),
  }));
  const controls = await loadControls(deps);
  const worstOf = (...s: ControlState[]): ControlState =>
    s.includes("killed") ? "killed" : s.includes("paused") ? "paused" : "enabled";
  const execRows = await deps.mainDb.execute({
    sql: "SELECT id, family FROM execution WHERE market = ? AND kind = 'E' ORDER BY id",
    args: [v.market],
  });
  const executions: RiskView["executions"] = execRows.rows.map((r) => {
    const family = str(r.family);
    const own = controls.execution.get(str(r.id)) ?? "enabled";
    return {
      key: str(r.id),
      family,
      name: names[family]?.name ?? family,
      state: own,
      effective: worstOf(controls.market, controls.family.get(family) ?? "enabled", own),
    };
  });
  const families: RiskView["families"] = Object.keys(names)
    .sort(cmp)
    .map((f) => {
      const own = controls.family.get(f) ?? "enabled";
      return {
        key: f,
        name: names[f]?.name ?? f,
        state: own,
        effective: worstOf(controls.market, own),
      };
    });
  const nearPct = await configInt(deps.mainDb, "attention_near_limit_pct", DEFAULT_NEAR_LIMIT_PCT);
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
      { ...EMPTY, controls: controlRows, executions, families },
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
      { ...EMPTY, controls: controlRows, executions, families },
      "No positions yet — the first closing values arrive after the first session.",
    );
  }

  // Is there a nightly check for the newest day? Without one, "green" would be a guess.
  const checked = await deps.mainDb.execute(
    "SELECT MAX(d) AS d FROM thesis_breaker_eval WHERE subject_kind = 'trade'",
  );
  const checkedD = checked.rows[0]?.d;
  const breakersChecked = typeof checkedD === "string" && checkedD >= newest;

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

  // Worst status per (strategy, real code); the key never leaves this module.
  const worstBreaker = new Map<string, "amber" | "red">();
  for (const r of br.rows) {
    const card = str(r.card_id);
    const ex = card.includes(":") ? (card.split(":").pop() ?? "") : "";
    const k = `${ex}|${str(r.code)}`;
    if (str(r.status) === "red" || worstBreaker.get(k) === undefined) {
      worstBreaker.set(k, str(r.status) === "red" ? "red" : "amber");
    }
  }

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
      const bs = worstBreaker.get(`${c.execution}|${str(r.code)}`);
      return {
        execution: c.execution,
        stock: label,
        breaker: bs ?? (breakersChecked ? "green" : "unknown"),
        qty: num(r.qty),
        weightPpm: ratioPpm(value, nav.nav),
        stopDistancePpm:
          stop === undefined || close <= 0 ? null : Math.round(((close - stop) * PPM) / close),
        held: num(r.haircut) === 1,
        value: masked ? null : money(value),
      };
    });
    const invested = rows.reduce((s, r) => s + num(r.value_micro), 0);
    const bust = bustOf(c.paramsJson);
    strategies.push({
      execution: c.execution,
      name: names[c.family]?.name ?? c.family,
      d: nav.d,
      nav: money(nav.nav),
      bust: bust === null ? null : money(bust),
      seed: money(c.seed),
      nearBust:
        bust !== null && nav.nav > bust && (nav.nav - bust) * 100 <= nearPct * (c.seed - bust), // threshold-ok: percent of the way from bust to seed
      // an at-or-below-bust value is its own state, shown by the bar as "Busted"
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
  const pnlOf = new Map<number, Map<string, number>>(); // pct -> cohort -> change
  for (const r of shockRows.rows) {
    try {
      const j = JSON.parse(str(r.value_json)) as { pct?: number; pnl_micro?: string };
      const pct = Number(j.pct);
      const p = Number(j.pnl_micro);
      if ((SHOCK_PCTS as readonly number[]).includes(pct) && Number.isFinite(p)) {
        pnl.set(pct, (pnl.get(pct) ?? 0) + p);
        const per = pnlOf.get(pct) ?? new Map<string, number>();
        per.set(str(r.scope).slice("shock:".length), p);
        pnlOf.set(pct, per);
      }
    } catch {
      // an unreadable row is skipped
    }
  }
  const shocks = SHOCK_PCTS.filter((p) => pnl.has(p)).map((p) => ({
    pct: p,
    pnl: money(pnl.get(p)!),
  }));
  // Flag (UXN-152): the value after the move against each round's own loss limit; the worst round decides.
  const cohortById = new Map(cohorts.map((c) => [c.id, c]));
  const stress: StressRow[] = shocks.map((sh) => {
    let flag: StressFlag = "safe";
    let affected = 0;
    for (const [cid, change] of pnlOf.get(sh.pct) ?? []) {
      const c = cohortById.get(cid);
      const n = navOf.get(cid);
      const bust = c ? bustOf(c.paramsJson) : null;
      if (!c || !n || bust === null) continue;
      const after = n.nav + change;
      const f: StressFlag =
        after <= bust
          ? "bust"
          : (after - bust) * 100 <= nearPct * (c.seed - bust) // threshold-ok: percent of the way from bust to seed
            ? "caution"
            : "safe";
      if (f !== "safe") affected += 1;
      if (f === "bust" || (f === "caution" && flag === "safe")) flag = f;
    }
    return { pct: sh.pct, pnl: sh.pnl, flag, affected };
  });

  return loaded(newest, v.now, masked, {
    d: newest,
    strategies,
    concentration,
    breakers,
    controls: controlRows,
    shocks,
    stress,
    nearPct,
    breakersChecked,
    executions,
    families,
  });
}
