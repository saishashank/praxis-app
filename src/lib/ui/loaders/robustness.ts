// Strategies > one strategy > Robustness (M14 WP8, D-251; docs/M14_design.md 2.8). Reads the newest
// stored `replay_stat` rows of the six M14 metrics (src/lib/stats/robustnessTypes.ts) for ONE
// strategy and returns a plain, serialisable, already masked view model. Everything here is
// descriptive: it is never a finding and never changes a rule.
//
// Scopes (the writers, WP3 robustness stage and WP4 rank-quality / MinBTL / error-budget stages, use
// the same):
//   exit_ablation, slip_one_tick, stability  `<market>:<family>:<rule_version>`  (the version in use)
//   rank_ic                                  `<market>:<family>:<rank_variant>`  (every variant)
//   min_btl, error_budget                    `<market>:<family>`                 (the lineage)
// Net returns are fractions (0.012 = 1.2 %), hit rates are fractions, IC is in [-1, 1].
// Masking (AT-02, O-54): a masked viewer's model holds no execution id, family, rule version, lineage,
// setting name or ranking name; settings and rankings are numbered instead. Roles: the page shows
// the section to the Owner and the Editor only (D-251); `visible` here says the same.
import "server-only";
import { openViewer, str, type Db, type LoaderDeps } from "./common";
import type {
  ErrorBudgetStat,
  ExitAblationStat,
  MinBtlStat,
  RankIcStat,
  ReturnSummary,
  SlipOneTickStat,
  StabilityStat,
} from "@/lib/stats/robustnessTypes";

/** Roles that may see the section (D-251). */
export const ROBUSTNESS_ROLES: readonly string[] = ["owner", "editor"];
export const ROBUSTNESS_LABEL = "descriptive — not a finding";

export type ReturnSummaryView = ReturnSummary;
export type ExitAblationView = { rule: ReturnSummary; timeStopOnly: ReturnSummary };
export type SlipView = {
  base: ReturnSummary;
  oneTick: ReturnSummary;
  stressMeanNet: number | null;
};
export type NeighbourView = {
  /** The setting name for an unmasked viewer, else "Setting N". */
  setting: string;
  direction: "down" | "up";
  value: number;
  n: number;
  meanNet: number | null;
  netLower90: number | null;
  passes: boolean;
};
export type StabilityView = {
  passesAbsoluteGate: boolean;
  fragile: boolean;
  neighbours: NeighbourView[];
};
export type RankQualityRow = {
  /** The ranking name for an unmasked viewer, else "Ranking N". */
  ranking: string;
  nDays: number;
  medianIc: number | null;
  lower90: number | null;
  upper90: number | null;
};
export type MinBtlView = {
  trials: number;
  targetSharpe: number;
  minYears: number | null;
  availableYears: number;
  label: "too short" | "long enough";
};
export type ErrorBudgetView = {
  mode: "fixed" | "alpha_spending";
  testsSoFar: number;
  nextLevel: number;
  lessonPool: "open" | "exhausted";
};

export type RobustnessView = {
  /** False for a role that may not see the section (the model is then empty). */
  visible: boolean;
  /** True when at least one metric has a stored row. */
  measured: boolean;
  exitAblation: ExitAblationView | null;
  slip: SlipView | null;
  stability: StabilityView | null;
  rankQuality: RankQualityRow[];
  minBtl: MinBtlView | null;
  errorBudget: ErrorBudgetView | null;
  /** Unmasked viewers only: the version the first three tables are about. */
  ruleVersion: string | null;
  label: typeof ROBUSTNESS_LABEL;
};

const EMPTY: RobustnessView = {
  visible: false,
  measured: false,
  exitAblation: null,
  slip: null,
  stability: null,
  rankQuality: [],
  minBtl: null,
  errorBudget: null,
  ruleVersion: null,
  label: ROBUSTNESS_LABEL,
};

const MAX_NEIGHBOURS = 40; // threshold-ok: +-1 step of every numeric key, display cap
const MAX_RANKINGS = 10; // threshold-ok: rank variants listed

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => {
  const n = fin(v);
  return n !== null && n >= 0 ? Math.floor(n) : 0;
};
const parse = (s: unknown): unknown => {
  try {
    return JSON.parse(str(s));
  } catch {
    return null;
  }
};

function summary(v: unknown): ReturnSummary | null {
  const o = obj(v);
  if (!o) return null;
  return {
    n: count(o.n),
    mean_net: fin(o.mean_net),
    median_net: fin(o.median_net),
    hit_rate: fin(o.hit_rate),
    mean_sessions_held: fin(o.mean_sessions_held),
  };
}

function exitAblation(v: unknown): ExitAblationView | null {
  const o = obj(v) as Partial<Record<keyof ExitAblationStat, unknown>> | null;
  const rule = summary(o?.rule);
  const tso = summary(o?.time_stop_only);
  return rule && tso ? { rule, timeStopOnly: tso } : null;
}

function slip(v: unknown): SlipView | null {
  const o = obj(v) as Partial<Record<keyof SlipOneTickStat, unknown>> | null;
  const base = summary(o?.base);
  const one = summary(o?.one_tick);
  return base && one ? { base, oneTick: one, stressMeanNet: fin(o?.stress_mean_net) } : null;
}

function stability(v: unknown, masked: boolean): StabilityView | null {
  const o = obj(v) as Partial<Record<keyof StabilityStat, unknown>> | null;
  if (!o || !Array.isArray(o.neighbours)) return null;
  const neighbours: NeighbourView[] = [];
  for (const raw of o.neighbours.slice(0, MAX_NEIGHBOURS)) {
    const n = obj(raw);
    const value = fin(n?.value);
    if (!n || value === null || (n.direction !== "down" && n.direction !== "up")) continue;
    neighbours.push({
      setting: masked ? `Setting ${neighbours.length + 1}` : str(n.key),
      direction: n.direction,
      value,
      n: count(n.n),
      meanNet: fin(n.mean_net),
      netLower90: fin(n.net_lower90),
      passes: n.passes_absolute_gate === true,
    });
  }
  return {
    passesAbsoluteGate: o.passes_absolute_gate === true,
    fragile: o.fragile === true,
    neighbours,
  };
}

function minBtl(v: unknown): MinBtlView | null {
  const o = obj(v) as Partial<Record<keyof MinBtlStat, unknown>> | null;
  const avail = fin(o?.available_years);
  if (!o || avail === null) return null;
  return {
    trials: count(o.trials),
    targetSharpe: fin(o.target_sharpe) ?? 0,
    minYears: fin(o.min_years),
    availableYears: avail,
    label: o.label === "long enough" ? "long enough" : "too short",
  };
}

function errorBudget(v: unknown): ErrorBudgetView | null {
  const o = obj(v) as Partial<Record<keyof ErrorBudgetStat, unknown>> | null;
  const level = fin(o?.next_level);
  if (!o || level === null) return null;
  return {
    mode: o.mode === "alpha_spending" ? "alpha_spending" : "fixed",
    testsSoFar: count(o.tests_so_far),
    nextLevel: level,
    lessonPool: o.lesson_pool === "exhausted" ? "exhausted" : "open",
  };
}

/** The newest stored value of one metric and scope (newest date, then newest run). */
async function newest(db: Db, metric: string, scope: string): Promise<unknown> {
  const r = await db.execute({
    sql: "SELECT value_json FROM replay_stat WHERE metric = ? AND scope = ? ORDER BY d DESC, run_id DESC LIMIT 1",
    args: [metric, scope],
  });
  return r.rows[0] ? parse(r.rows[0].value_json) : null;
}

/**
 * The Robustness section of one strategy. `executionId` is an E execution; any other id, or a role
 * that may not see the section, gives the empty model (no read is made for a hidden role).
 */
export async function loadRobustness(
  deps: LoaderDeps,
  executionId: string,
): Promise<RobustnessView> {
  const role = deps.user?.role;
  if (!role || !ROBUSTNESS_ROLES.includes(role)) return EMPTY;
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const ex = await deps.mainDb.execute({
    sql: "SELECT family, rule_version FROM execution WHERE id = ? AND kind = 'E'",
    args: [executionId],
  });
  const e = ex.rows[0];
  const visible: RobustnessView = { ...EMPTY, visible: true };
  if (!e) return visible;
  const family = str(e.family);
  const version = str(e.rule_version);
  const exScope = `${v.market}:${family}:${version}`;
  const lineage = `${v.market}:${family}`;

  const [ab, sl, st, bt, eb] = await Promise.all([
    newest(deps.mainDb, "exit_ablation", exScope),
    newest(deps.mainDb, "slip_one_tick", exScope),
    newest(deps.mainDb, "stability", exScope),
    newest(deps.mainDb, "min_btl", lineage),
    newest(deps.mainDb, "error_budget", lineage),
  ]);

  // One row per rank variant: the newest row of each scope `<lineage>:<variant>`.
  const prefix = `${lineage}:`;
  const rr = await deps.mainDb.execute({
    sql: `SELECT scope, value_json FROM replay_stat
          WHERE metric = 'rank_ic' AND substr(scope, 1, ?) = ?
          ORDER BY scope, d DESC, run_id DESC`,
    args: [prefix.length, prefix],
  });
  const seen = new Set<string>();
  const rankQuality: RankQualityRow[] = [];
  for (const r of rr.rows) {
    const scope = str(r.scope);
    if (seen.has(scope) || rankQuality.length >= MAX_RANKINGS) continue;
    seen.add(scope);
    const o = obj(parse(r.value_json)) as Partial<Record<keyof RankIcStat, unknown>> | null;
    if (!o) continue;
    rankQuality.push({
      ranking: masked ? `Ranking ${rankQuality.length + 1}` : scope.slice(prefix.length),
      nDays: count(o.n_days),
      medianIc: fin(o.median_ic),
      lower90: fin(o.lower90),
      upper90: fin(o.upper90),
    });
  }

  const view: RobustnessView = {
    visible: true,
    measured: false,
    exitAblation: exitAblation(ab),
    slip: slip(sl),
    stability: stability(st, masked),
    rankQuality,
    minBtl: minBtl(bt),
    errorBudget: errorBudget(eb),
    ruleVersion: masked ? null : version,
    label: ROBUSTNESS_LABEL,
  };
  view.measured =
    view.exitAblation !== null ||
    view.slip !== null ||
    view.stability !== null ||
    view.rankQuality.length > 0 ||
    view.minBtl !== null ||
    view.errorBudget !== null;
  return view;
}
