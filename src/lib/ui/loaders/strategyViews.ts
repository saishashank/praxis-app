// Extra reads of the Strategies pages (M7 T12; docs/M7_design.md 3 rows 11 to 13; UX-011, UX-020 to
// UX-023, UX-030 to UX-032, UXN-046a, UXN-051, UXN-053 to UXN-055, UXN-068; ARN-049, ARN-050, ARN-071,
// ARN-078). They sit beside `strategies.ts` (T7) and use its masker, so the same rules hold: a masked
// viewer gets letters instead of codes, ISO weeks instead of dates, no prices, and opaque `ck:` card
// links. Everything is read from stored rows (UX-005, no compute in the request): the replay figures
// come from `replay_stat` rows of the newest batch 3 run. A figure that is not stored is `null`, and the
// page says "Not measured yet" (REV-003).
import "server-only";
import { lineageId } from "@/lib/stats/splits";
import { cardHref } from "./cards";
import {
  money,
  num,
  numOrNull,
  openViewer,
  PPM,
  ratioPpm,
  str,
  strOrNull,
  type Db,
  type LoaderDeps,
  type Money,
} from "./common";
import type { StrategyTile, StrategySort } from "./strategies";

const MAX_TRADES = 50; // threshold-ok: trade strip length
const MAX_CONTROL_ROWS = 1500; // threshold-ok: three controls x 500 sessions
const MAX_VERSIONS = 30; // threshold-ok: versions listed per family
const MAX_PENDING = 10; // threshold-ok: pending challengers and ledger rows listed
const SESSIONS_PER_MONTH = 21; // threshold-ok: CIF horizons are in sessions (63 / 126 / 252)

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

export const REGIME_STATES = ["SHOCK", "RISK-OFF", "RISK-ON", "NEUTRAL"] as const;
export type RegimeState = (typeof REGIME_STATES)[number];
export const parseRegime = (s: string | null | undefined): RegimeState | null =>
  (REGIME_STATES as readonly string[]).includes(s ?? "") ? (s as RegimeState) : null;

/** UX-020 (s13): CONSISTENT-FORWARD first, FAILED last; anything else (no label yet) after FAILED. */
export const LABEL_ORDER = [
  "CONSISTENT-FORWARD",
  "PASSED-BACKTEST",
  "UNVALIDATED",
  "NOT-DEMONSTRATED",
  "UNVALIDATABLE",
  "FAILED",
] as const;
export const labelRank = (label: string | null): number => {
  const i = (LABEL_ORDER as readonly string[]).indexOf(label ?? "");
  return i < 0 ? LABEL_ORDER.length : i;
};

// ---- list: sorting and tile extras --------------------------------------------------------------------

/** Ascending key of a tile for a sort chip; a missing figure sorts last. */
function sortKey(t: StrategyTile, sort: StrategySort): number {
  const miss = Number.POSITIVE_INFINITY;
  if (sort === "best") return t.returnPpm === null ? miss : -t.returnPpm;
  if (sort === "closest") return t.positionPpm === null ? miss : -t.positionPpm;
  if (sort === "risk") return t.bustDistancePpm === null ? miss : t.bustDistancePpm;
  return 0;
}

/**
 * UXN-046a: the two versions of a strategy (plain and with the leverage sleeve) stay together; strategies
 * are ordered by the better of their two versions, the versions within one by their own key.
 */
export function sortTiles(tiles: readonly StrategyTile[], sort: StrategySort): StrategyTile[] {
  const byFamily = new Map<string, StrategyTile[]>();
  for (const t of tiles) byFamily.set(t.family, [...(byFamily.get(t.family) ?? []), t]);
  const inner = (a: StrategyTile, b: StrategyTile): number => {
    if (sort === "az") return cmp(b.variant, a.variant) || cmp(a.execution, b.execution);
    const ka = sortKey(a, sort);
    const kb = sortKey(b, sort);
    return (ka === kb ? 0 : ka < kb ? -1 : 1) || cmp(a.execution, b.execution);
  };
  const groups = [...byFamily.values()].map((g) => [...g].sort(inner));
  groups.sort((x, y) => {
    if (sort === "az") return cmp(x[0]!.name.toLowerCase(), y[0]!.name.toLowerCase());
    const kx = sortKey(x[0]!, sort);
    const ky = sortKey(y[0]!, sort);
    return (kx === ky ? 0 : kx < ky ? -1 : 1) || cmp(x[0]!.family, y[0]!.family);
  });
  return groups.flat();
}

/** Plain-words reasons, most urgent first (UXN-046): the loader's reasons, reworded and ranked. */
export function attentionReasons(
  attention: readonly string[],
): Array<{ rank: number; text: string }> {
  const out = attention.map((a) => {
    if (a === "Busted") return { rank: 1, text: "Hit its loss limit today and restarts" };
    if (a.startsWith("Within"))
      return { rank: 2, text: a.replace("the bust level", "its loss limit") };
    if (a === "Paused") return { rank: 6, text: "Paused by the Owner" };
    if (a.startsWith("Stopped")) return { rank: 6, text: "Stopped by the Owner's kill switch" };
    return { rank: 7, text: a };
  });
  return out.sort((x, y) => x.rank - y.rank || cmp(x.text, y.text));
}

/** The "Needs attention" group: urgency first, then the distance to the loss limit (closest first). */
export function attentionOrder(tiles: readonly StrategyTile[]): StrategyTile[] {
  const urgency = (t: StrategyTile): number => attentionReasons(t.attention)[0]?.rank ?? 99;
  return tiles
    .filter((t) => t.needsAttention)
    .sort((a, b) => {
      const d = urgency(a) - urgency(b);
      if (d !== 0) return d;
      const da = a.bustDistancePpm ?? Number.POSITIVE_INFINITY;
      const db = b.bustDistancePpm ?? Number.POSITIVE_INFINITY;
      return (da === db ? 0 : da < db ? -1 : 1) || cmp(a.execution, b.execution);
    });
}

export type TileExtra = {
  openPositions: number | null;
  sleeve: "locked" | "unlocked" | null;
  /** Worst warning-sign status among the open trades on the newest check; null when none was recorded. */
  breaker: "green" | "amber" | "red" | null;
};

/** Open positions, sleeve lock state and warning-sign status of each strategy (UX-011, UXN-104). */
export async function loadTileExtras(
  deps: LoaderDeps,
  executionIds: readonly string[],
): Promise<Record<string, TileExtra>> {
  const out: Record<string, TileExtra> = {};
  for (const id of executionIds) out[id] = { openPositions: null, sleeve: null, breaker: null };
  if (executionIds.length === 0) return out;
  const inList = placeholders(executionIds.length);
  const cohorts = await deps.mainDb.execute({
    sql: `SELECT c.execution_id, c.id FROM cohort c
          WHERE c.control_idx IS NULL AND c.execution_id IN (${inList})
            AND c.id = (SELECT c2.id FROM cohort c2 WHERE c2.execution_id = c.execution_id
                        AND c2.control_idx IS NULL ORDER BY c2.start_d DESC, c2.id DESC LIMIT 1)`,
    args: [...executionIds],
  });
  const execOf = new Map(cohorts.rows.map((r) => [str(r.id), str(r.execution_id)]));
  const ids = [...execOf.keys()];
  if (ids.length > 0) {
    const cin = placeholders(ids.length);
    const nav = await deps.mainDb.execute({
      sql: `SELECT cohort_id, open_positions FROM nav_daily n WHERE cohort_id IN (${cin})
            AND d = (SELECT MAX(d) FROM nav_daily WHERE cohort_id = n.cohort_id)`,
      args: ids,
    });
    for (const r of nav.rows)
      out[execOf.get(str(r.cohort_id))!]!.openPositions = num(r.open_positions);
    const sl = await deps.mainDb.execute({
      sql: `SELECT cohort_id, state FROM sleeve_state s WHERE cohort_id IN (${cin})
            AND seq = (SELECT MAX(seq) FROM sleeve_state WHERE cohort_id = s.cohort_id)`,
      args: ids,
    });
    for (const r of sl.rows) {
      out[execOf.get(str(r.cohort_id))!]!.sleeve =
        str(r.state) === "locked" ? "locked" : "unlocked";
    }
  }
  const br = await deps.mainDb.execute({
    sql: `SELECT dc.execution_id AS ex, e.status AS status FROM thesis_breaker_eval e
          JOIN decision_card dc ON dc.id = e.card_id
          WHERE e.subject_kind = 'trade' AND dc.execution_id IN (${inList})
            AND e.d = (SELECT MAX(d) FROM thesis_breaker_eval WHERE subject_kind = 'trade')`,
    args: [...executionIds],
  });
  const rank = { green: 0, amber: 1, red: 2 } as const;
  for (const r of br.rows) {
    const s = str(r.status) as keyof typeof rank;
    const cur = out[str(r.ex)];
    if (cur && s in rank && (cur.breaker === null || rank[s] > rank[cur.breaker])) cur.breaker = s;
  }
  return out;
}

// ---- stored replay figures ----------------------------------------------------------------------------

/** The newest batch 3 run id of a market (`arena-3:<market>:<d>`), or null before the first run. */
export async function latestStatRun(db: Db, market: string): Promise<string | null> {
  const r = await db.execute({
    sql: "SELECT run_id FROM replay_stat WHERE run_id LIKE ? ORDER BY d DESC, run_id DESC LIMIT 1",
    args: [`arena-3:${market}:%`],
  });
  return strOrNull(r.rows[0]?.run_id);
}

function json(v: unknown): Record<string, unknown> | null {
  try {
    const x = JSON.parse(str(v)) as unknown;
    return typeof x === "object" && x !== null && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export type CifPoint = { p: number; lo?: number; hi?: number };
export type CifRowView = {
  month: number;
  n: number;
  target: CifPoint;
  bust: CifPoint;
  stalled: CifPoint;
};

function pointOf(
  cif: Record<string, unknown>,
  interval: Record<string, unknown>,
  k: string,
): CifPoint {
  const iv = asObj(interval[k]);
  const lo = finite(iv?.lower);
  const hi = finite(iv?.upper);
  return { p: finite(cif[k]) ?? 0, ...(lo !== null && hi !== null ? { lo, hi } : {}) };
}

/** Wilson-interval proportions at the stored horizons (63 / 126 / 252 sessions = 3 / 6 / 12 months). */
function cifRows(v: Record<string, unknown> | null): CifRowView[] {
  const list = Array.isArray(v?.proportions) ? (v!.proportions as unknown[]) : [];
  const out: CifRowView[] = [];
  for (const x of list) {
    const o = asObj(x);
    const cif = asObj(o?.cif);
    const iv = asObj(o?.interval);
    const h = finite(o?.horizon);
    if (!o || !cif || !iv || h === null) continue;
    out.push({
      month: Math.round(h / SESSIONS_PER_MONTH),
      n: finite(o.n) ?? 0,
      target: pointOf(cif, iv, "target"),
      bust: pointOf(cif, iv, "bust"),
      stalled: pointOf(cif, iv, "stalled"),
    });
  }
  return out.sort((a, b) => a.month - b.month);
}

export type NavFigureView = {
  n: number;
  meanMicro: number;
  lowerMicro: number;
  upperMicro: number;
};
export type EvidenceRow = {
  scope: string;
  effectiveN: number | null;
  cohorts: number | null;
  resolved: number | null;
  censored: number | null;
  cif: CifRowView[];
  navMinusSeed: NavFigureView | null;
  /** Versus the matched C2 control, in micro-AUD and as a share (CIF of target, 12 months). */
  minusC2Micro: number | null;
  cifTargetMinusC2: number | null;
  comparator: string | null;
};

const EMPTY_EVIDENCE = (scope: string): EvidenceRow => ({
  scope,
  effectiveN: null,
  cohorts: null,
  resolved: null,
  censored: null,
  cif: [],
  navMinusSeed: null,
  minusC2Micro: null,
  cifTargetMinusC2: null,
  comparator: null,
});

function applyMetric(row: EvidenceRow, metric: string, v: Record<string, unknown> | null): void {
  if (!v) return;
  if (metric === "cif") row.cif = cifRows(v);
  else if (metric === "effective_n") {
    row.effectiveN = finite(v.n);
    row.cohorts = finite(v.cohorts);
    row.resolved = finite(v.resolved);
    row.censored = finite(v.censored);
  } else if (metric === "nav_minus_seed") {
    const iv = asObj(v.interval);
    const mean = finite(v.meanMicro);
    const lo = finite(iv?.lower);
    const hi = finite(iv?.upper);
    if (mean !== null && lo !== null && hi !== null) {
      row.navMinusSeed = {
        n: finite(v.n) ?? 0,
        meanMicro: Math.round(mean),
        lowerMicro: Math.round(lo),
        upperMicro: Math.round(hi),
      };
    }
  } else if (metric === "headline") {
    row.minusC2Micro =
      finite(v.navMinusC2Micro) === null ? null : Math.round(finite(v.navMinusC2Micro)!);
    row.cifTargetMinusC2 = finite(v.cifTargetMinusC2);
    row.comparator = strOrNull(v.comparator);
  }
}

export type ZeroEdgeView = { target: number; trials: number; meanNavMinusSeedMicro: number | null };

function zeroEdgeOf(v: Record<string, unknown> | null): ZeroEdgeView | null {
  const p = asObj(v?.probability);
  const t = finite(p?.target);
  if (!v || t === null) return null;
  const m = finite(v.meanNavMinusSeedMicro);
  return {
    target: t,
    trials: finite(v.trials) ?? 0,
    meanNavMinusSeedMicro: m === null ? null : Math.round(m),
  };
}

// ---- one strategy -------------------------------------------------------------------------------------

export type StripTrade = {
  /** Position in the strip; never the stored trade id. */
  key: string;
  stock: string;
  /** Exact dates, unmasked viewers only (they place the chart markers). */
  entryDate: string | null;
  exitDate: string | null;
  /** Dates as shown: exact, or the ISO week for a masked viewer. */
  entryDay: string | null;
  exitDay: string | null;
  qty: number;
  open: boolean;
  exitType: string | null;
  returnPpm: number | null;
  /** Profit or loss of a closed trade before costs; null while open and for a masked viewer. */
  pnl: Money | null;
  entryPrice: Money | null;
  exitPrice: Money | null;
  /** Link to the Decision Card; opaque for a masked viewer; null when no card is stored. */
  cardHref: string | null;
};

export type ControlSeries = {
  id: string;
  label: string;
  points: Array<{ d: string; nav: number }>;
};

export type VersionRow = {
  id: string;
  n: number;
  origin: string;
  registeredD: string;
  status: string;
  live: boolean;
  /** VAL-110 holdout outcome as stored, or null when none was run. */
  validation: string | null;
  /** An earlier version that was live once: the Owner may roll back to it. */
  revertable: boolean;
};

export type SleeveLegView = {
  leverage: number;
  sleeveTrades: number;
  shadowTrades: number;
  closeouts: number;
  locks: number;
  netPl: Money | null;
  navMinusSeed: NavFigureView | null;
};

export type LabelView = {
  label: string;
  n: number;
  mde: number | null;
  possibleLuck: boolean;
  costInfeasible: boolean;
};

export type StrategyExtras = {
  /** Market mood on each NAV date (aligned to the NAV series of the detail loader); null when unknown. */
  regimes: Array<string | null>;
  trades: StripTrade[];
  controls: ControlSeries[];
  zeroEdge: ZeroEdgeView | null;
  evidence: EvidenceRow | null;
  label: LabelView | null;
  sleeve: {
    hypotheticalLabel: string;
    levered: SleeveLegView | null;
    reality: SleeveLegView | null;
  } | null;
  family: string | null;
  versions: VersionRow[];
  pendingChallengers: Array<{ id: string; state: string }>;
  ledger: Array<{ kind: string; effectiveD: string }>;
};

const NO_EXTRAS: StrategyExtras = {
  regimes: [],
  trades: [],
  controls: [],
  zeroEdge: null,
  evidence: null,
  label: null,
  sleeve: null,
  family: null,
  versions: [],
  pendingChallengers: [],
  ledger: [],
};

const CONTROL_LABEL: Record<string, string> = {
  C1: "Matched control C1",
  C2: "Matched control C2",
  C3: "Matched control C3",
};

function labelOf(r: Record<string, unknown> | undefined): LabelView | null {
  if (!r) return null;
  let luck = str(r.label) === "possible luck";
  try {
    luck = luck || (JSON.parse(str(r.qualifiers_json)) as unknown[]).includes("possible luck");
  } catch {
    // an unreadable list adds no flag
  }
  return {
    label: str(r.label),
    n: num(r.n),
    mde: numOrNull(r.mde),
    possibleLuck: luck,
    costInfeasible: num(r.cost_infeasible) === 1,
  };
}

function legOf(v: unknown): SleeveLegView | null {
  const o = asObj(v);
  if (!o) return null;
  const fig = asObj(o.figure);
  const nms = asObj(fig?.navMinusSeed);
  const iv = asObj(nms?.interval);
  const mean = finite(nms?.meanMicro);
  const lo = finite(iv?.lower);
  const hi = finite(iv?.upper);
  let net: Money | null = null;
  try {
    net = money(Number(BigInt(str(o.netPlMicro))));
  } catch {
    net = null;
  }
  return {
    leverage: finite(o.leverage) ?? 0,
    sleeveTrades: finite(o.sleeveTrades) ?? 0,
    shadowTrades: finite(o.shadowTrades) ?? 0,
    closeouts: finite(o.closeouts) ?? 0,
    locks: finite(o.locks) ?? 0,
    netPl: net,
    navMinusSeed:
      mean !== null && lo !== null && hi !== null
        ? {
            n: finite(nms?.n) ?? 0,
            meanMicro: Math.round(mean),
            lowerMicro: Math.round(lo),
            upperMicro: Math.round(hi),
          }
        : null,
  };
}

export async function loadStrategyExtras(
  deps: LoaderDeps,
  executionId: string,
  navDates: readonly string[],
): Promise<StrategyExtras> {
  const v = await openViewer(deps);
  const masked = v.masker.masked;
  const ex = await deps.mainDb.execute({
    sql: "SELECT id, family, variant, rule_version FROM execution WHERE id = ? AND kind = 'E'",
    args: [executionId],
  });
  const e = ex.rows[0];
  if (!e) return NO_EXTRAS;
  const family = str(e.family);

  // Market mood on each NAV date (UXN-051): the newest version of each day.
  const regimes: Array<string | null> = [];
  if (navDates.length > 0) {
    const rs = await deps.mainDb.execute({
      sql: `SELECT d, state FROM regime_daily r WHERE market = ? AND d >= ? AND d <= ?
            AND version = (SELECT MAX(version) FROM regime_daily WHERE market = r.market AND d = r.d)`,
      args: [v.market, navDates[0]!, navDates[navDates.length - 1]!],
    });
    const byD = new Map(rs.rows.map((r) => [str(r.d), str(r.state)]));
    for (const d of navDates) regimes.push(byD.get(d) ?? null);
  }

  const cur = await deps.mainDb.execute({
    sql: `SELECT id, start_d FROM cohort WHERE execution_id = ? AND control_idx IS NULL
          ORDER BY start_d DESC, id DESC LIMIT 1`,
    args: [executionId],
  });
  const cohortId = strOrNull(cur.rows[0]?.id);
  const startD = strOrNull(cur.rows[0]?.start_d);

  // Trades of the current round, newest first, with the Decision Card of the entry order.
  const trades: StripTrade[] = [];
  if (cohortId !== null) {
    const tr = await deps.mainDb.execute({
      sql: `SELECT t.code, t.exit_type, ef.d AS entry_d, ef.qty AS qty, ef.fill_price_micro AS entry_price,
                   xf.d AS exit_d, xf.fill_price_micro AS exit_price, dc.id AS card_id
            FROM trade t JOIN fill ef ON ef.id = t.entry_fill_id
            LEFT JOIN fill xf ON xf.id = t.exit_fill_id
            LEFT JOIN arena_order o ON o.id = ef.order_id
            LEFT JOIN decision_card dc ON dc.id = o.card_id
            WHERE t.cohort_id = ? ORDER BY ef.d DESC, t.id LIMIT ?`,
      args: [cohortId, MAX_TRADES],
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
    tr.rows.forEach((r, i) => {
      const sc = scopeOf(str(r.entry_d));
      const ep = num(r.entry_price);
      const xp = numOrNull(r.exit_price);
      const qty = num(r.qty);
      const closed = xp !== null;
      trades.push({
        key: `t${i + 1}`,
        stock: sc.label(str(r.code)),
        entryDate: masked ? null : str(r.entry_d),
        exitDate: masked || r.exit_d === null || r.exit_d === undefined ? null : str(r.exit_d),
        entryDay: sc.day(str(r.entry_d)),
        exitDay: r.exit_d === null || r.exit_d === undefined ? null : sc.day(str(r.exit_d)),
        qty,
        open: r.exit_type === null || r.exit_type === undefined,
        exitType: strOrNull(r.exit_type),
        returnPpm: closed && ep > 0 ? Math.round(((xp - ep) * PPM) / ep) : null,
        pnl: masked || !closed ? null : money(Number((BigInt(xp) - BigInt(ep)) * BigInt(qty))),
        entryPrice: masked ? null : money(ep),
        exitPrice: masked || xp === null ? null : money(xp),
        cardHref:
          r.card_id === null || r.card_id === undefined ? null : cardHref(str(r.card_id), masked),
      });
    });
  }

  // Matched controls (UXN-068): the mean value of the control slots that started with this round.
  const controls: ControlSeries[] = [];
  if (startD !== null && navDates.length > 0) {
    const cs = await deps.mainDb.execute({
      sql: `SELECT e.kind AS kind, e.id AS ex, n.d AS d, SUM(n.liq_nav_micro) AS s, COUNT(*) AS c
            FROM cohort c JOIN execution e ON e.id = c.execution_id
            JOIN nav_daily n ON n.cohort_id = c.id
            WHERE e.kind IN ('C1','C2','C3') AND (e.family IS NULL OR e.family = ?) AND c.start_d = ?
            GROUP BY e.kind, e.id, n.d ORDER BY e.kind, e.id, n.d LIMIT ?`,
      args: [family, startD, MAX_CONTROL_ROWS],
    });
    const byKind = new Map<string, Map<string, { s: number; c: number }>>();
    for (const r of cs.rows) {
      const m = byKind.get(str(r.kind)) ?? new Map<string, { s: number; c: number }>();
      const d = str(r.d);
      const prev = m.get(d) ?? { s: 0, c: 0 };
      m.set(d, { s: prev.s + num(r.s), c: prev.c + num(r.c) });
      byKind.set(str(r.kind), m);
    }
    for (const kind of ["C1", "C2", "C3"]) {
      const m = byKind.get(kind);
      if (!m) continue;
      controls.push({
        id: kind,
        label: CONTROL_LABEL[kind]!,
        points: [...m.entries()]
          .sort((a, b) => cmp(a[0], b[0]))
          .map(([d, x]) => ({ d, nav: Math.round(x.s / x.c) })),
      });
    }
  }

  // Stored replay figures of the newest batch 3 run.
  const run = await latestStatRun(deps.mainDb, v.market);
  let evidence: EvidenceRow | null = null;
  if (run !== null) {
    const rs = await deps.mainDb.execute({
      sql: `SELECT metric, value_json FROM replay_stat WHERE run_id = ? AND scope = ?
            AND metric IN ('cif','effective_n','nav_minus_seed','headline')`,
      args: [run, executionId],
    });
    if (rs.rows.length > 0) {
      evidence = EMPTY_EVIDENCE(executionId);
      for (const r of rs.rows) applyMetric(evidence, str(r.metric), json(r.value_json));
    }
  }
  const ze = await deps.mainDb.execute({
    sql: "SELECT value_json FROM replay_stat WHERE metric = 'zero_edge' AND scope = ? ORDER BY d DESC, run_id DESC LIMIT 1",
    args: [`${v.market}:${family}:${str(e.rule_version)}`],
  });
  const zeroEdge = zeroEdgeOf(json(ze.rows[0]?.value_json));

  const lb = await deps.mainDb.execute({
    sql: "SELECT label, qualifiers_json, cost_infeasible, n, mde FROM label WHERE execution_id = ? ORDER BY d DESC, id DESC LIMIT 1",
    args: [executionId],
  });
  const label = labelOf(lb.rows[0]);

  // Leverage sleeve at 10x and at the reality-adjusted 5x (ARN-049), labelled as hypothetical.
  let sleeve: StrategyExtras["sleeve"] = null;
  if (str(e.variant) === "L") {
    const sr = await deps.mainDb.execute({
      sql: "SELECT value_json FROM replay_stat WHERE metric = 'sleeve_leverage' AND scope = ? ORDER BY d DESC, run_id DESC LIMIT 1",
      args: [`sleeve:${family}`],
    });
    const sv = json(sr.rows[0]?.value_json);
    sleeve = {
      hypotheticalLabel: "hypothetical leverage",
      levered: legOf(sv?.levered),
      reality: legOf(sv?.reality),
    };
  }

  // Version history (UX-032): date, action, VAL-110 result; the Owner may roll back to an earlier live version.
  const vs = await deps.mainDb.execute({
    sql: `SELECT r.id AS id, r.n AS n, r.origin AS origin, r.registered_d AS registered_d,
                 (SELECT s.status FROM rule_version_status s WHERE s.rule_version_id = r.id
                  ORDER BY s.seq DESC LIMIT 1) AS status,
                 EXISTS (SELECT 1 FROM rule_version_status s WHERE s.rule_version_id = r.id
                         AND s.status = 'live') AS was_live
          FROM rule_version r WHERE r.market = ? AND r.family = ? ORDER BY r.n DESC LIMIT ?`,
    args: [v.market, family, MAX_VERSIONS],
  });
  const verIds = vs.rows.map((r) => str(r.id));
  const outcomes = new Map<string, string>();
  if (verIds.length > 0) {
    const vr = await deps.mainDb.execute({
      sql: `SELECT rule_version, outcome FROM validation_result
            WHERE test = 'holdout' AND rule_version IN (${placeholders(verIds.length)})
            ORDER BY split_version DESC, id DESC`,
      args: verIds,
    });
    for (const r of vr.rows)
      if (!outcomes.has(str(r.rule_version))) outcomes.set(str(r.rule_version), str(r.outcome));
  }
  const liveRow = vs.rows.find((r) => str(r.status) === "live");
  const liveN = liveRow ? num(liveRow.n) : null;
  const versions: VersionRow[] = vs.rows.map((r) => ({
    id: str(r.id),
    n: num(r.n),
    origin: str(r.origin),
    registeredD: str(r.registered_d),
    status: strOrNull(r.status) ?? "registered",
    live: str(r.status) === "live",
    validation: outcomes.get(str(r.id)) ?? null,
    revertable:
      liveN !== null && num(r.n) < liveN && num(r.was_live) === 1 && str(r.status) !== "live",
  }));

  const pc = await deps.mainDb.execute({
    sql: `SELECT id, state FROM challenger WHERE lineage_id = ?
          AND state IN ('proposed','replay','shakedown','review','approved') ORDER BY id LIMIT ?`,
    args: [lineageId(v.market, family), MAX_PENDING],
  });
  const lg = await deps.mainDb.execute({
    sql: `SELECT kind, effective_d FROM change_ledger WHERE market = ?
          AND (target LIKE ? OR target LIKE ?) ORDER BY id DESC LIMIT ?`,
    args: [v.market, `${family}.%`, `${family}/%`, MAX_PENDING],
  });

  return {
    regimes,
    trades,
    controls,
    zeroEdge,
    evidence,
    label,
    sleeve,
    family,
    versions,
    pendingChallengers: pc.rows.map((r) => ({ id: str(r.id), state: str(r.state) })),
    ledger: lg.rows.map((r) => ({ kind: str(r.kind), effectiveD: str(r.effective_d) })),
  };
}

// ---- drawdown (UXN-055) -------------------------------------------------------------------------------

/** Distance below the highest value so far, in ppm of that value (0 at a new high, never positive). */
export function drawdownPpm(navs: readonly number[]): number[] {
  let peak = 0;
  return navs.map((n) => {
    if (n > peak) peak = n;
    const r = ratioPpm(n - peak, peak);
    return peak > 0 && r !== null ? Math.min(0, r) : 0;
  });
}

// ---- leaderboard evidence -----------------------------------------------------------------------------

export type RankGroupView = { rank: number; tied: boolean; members: string[] };

export type LeaderEvidence = {
  runId: string | null;
  /** Evidence by scope: an execution id, or a control's id. */
  rows: Record<string, EvidenceRow>;
  /** ARN-078 groups from the stored ranking; null before the first run. */
  groups: RankGroupView[] | null;
  insufficient: string[];
  labels: Record<string, LabelView>;
  zeroEdge: Record<string, ZeroEdgeView>;
  /** Rounds that started under the chosen market mood, by execution; null when no mood is chosen. */
  regimeRounds: Record<
    string,
    { rounds: number; target: number; bust: number; stalled: number; timeout: number }
  > | null;
};

export async function loadLeaderEvidence(
  deps: LoaderDeps,
  params: { regime?: RegimeState | null } = {},
): Promise<LeaderEvidence> {
  const v = await openViewer(deps);
  const run = await latestStatRun(deps.mainDb, v.market);
  const rows: Record<string, EvidenceRow> = {};
  let groups: RankGroupView[] | null = null;
  let insufficient: string[] = [];
  if (run !== null) {
    const rs = await deps.mainDb.execute({
      sql: `SELECT scope, metric, value_json FROM replay_stat WHERE run_id = ?
            AND metric IN ('cif','effective_n','nav_minus_seed','headline')
            AND (scope GLOB 'E[0-9]*' OR scope GLOB 'C[0-9]*') AND scope NOT LIKE '%~reality'
            ORDER BY scope, metric`,
      args: [run],
    });
    for (const r of rs.rows) {
      const scope = str(r.scope);
      rows[scope] ??= EMPTY_EVIDENCE(scope);
      applyMetric(rows[scope]!, str(r.metric), json(r.value_json));
    }
    const rk = await deps.mainDb.execute({
      sql: "SELECT value_json FROM replay_stat WHERE run_id = ? AND scope = 'all' AND metric = 'ranking'",
      args: [run],
    });
    const rv = json(rk.rows[0]?.value_json);
    if (rv) {
      groups = [];
      for (const g of Array.isArray(rv.groups) ? (rv.groups as unknown[]) : []) {
        const go = asObj(g);
        const members = (Array.isArray(go?.members) ? (go!.members as unknown[]) : [])
          .map((m) => strOrNull(asObj(m)?.scope))
          .filter((s): s is string => s !== null);
        groups.push({
          rank: finite(go?.rank) ?? groups.length + 1,
          tied: go?.tied === true,
          members,
        });
      }
      insufficient = (Array.isArray(rv.insufficient) ? (rv.insufficient as unknown[]) : [])
        .map((m) => strOrNull(asObj(m)?.scope))
        .filter((s): s is string => s !== null);
    }
  }

  const labels: Record<string, LabelView> = {};
  const lr = await deps.mainDb.execute(
    `SELECT execution_id, label, qualifiers_json, cost_infeasible, n, mde FROM (
       SELECT execution_id, label, qualifiers_json, cost_infeasible, n, mde,
              ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY d DESC, id DESC) AS rn FROM label
     ) WHERE rn = 1`,
  );
  for (const r of lr.rows) {
    const l = labelOf(r);
    if (l) labels[str(r.execution_id)] = l;
  }

  const zeroEdge: Record<string, ZeroEdgeView> = {};
  const ex = await deps.mainDb.execute(
    // D-191: no leverage: the L twins are not shown
    "SELECT id, family, rule_version FROM execution WHERE kind = 'E' AND variant = 'U' ORDER BY id",
  );
  // D-204: the newest zero-edge row of every strategy in one batch (it was one round trip each)
  const scopes = ex.rows.map((r) => `${v.market}:${str(r.family)}:${str(r.rule_version)}`);
  const zs = await deps.mainDb.batch(
    scopes.map((scope) => ({
      sql: "SELECT value_json FROM replay_stat WHERE metric = 'zero_edge' AND scope = ? ORDER BY d DESC, run_id DESC LIMIT 1",
      args: [scope],
    })),
    "read",
  );
  for (const [i, r] of ex.rows.entries()) {
    const zv = zeroEdgeOf(json(zs[i]?.rows[0]?.value_json));
    if (zv) zeroEdge[str(r.id)] = zv;
  }

  let regimeRounds: LeaderEvidence["regimeRounds"] = null;
  if (params.regime) {
    regimeRounds = {};
    const rr = await deps.mainDb.execute({
      sql: `SELECT c.execution_id AS ex, c.terminal_kind AS tk, COUNT(*) AS n
            FROM cohort c JOIN execution e ON e.id = c.execution_id
            JOIN regime_daily r ON r.market = ? AND r.d = c.start_d
              AND r.version = (SELECT MAX(version) FROM regime_daily WHERE market = r.market AND d = r.d)
            WHERE e.kind = 'E' AND c.control_idx IS NULL AND r.state = ?
            GROUP BY c.execution_id, c.terminal_kind ORDER BY c.execution_id`,
      args: [v.market, params.regime],
    });
    for (const r of rr.rows) {
      const a = (regimeRounds[str(r.ex)] ??= {
        rounds: 0,
        target: 0,
        bust: 0,
        stalled: 0,
        timeout: 0,
      });
      const n = num(r.n);
      a.rounds += n;
      const tk = strOrNull(r.tk);
      if (tk === "target") a.target += n;
      else if (tk === "bust") a.bust += n;
      else if (tk === "stalled") a.stalled += n;
      else if (tk === "timeout") a.timeout += n;
    }
  }
  return { runId: run, rows, groups, insufficient, labels, zeroEdge, regimeRounds };
}
