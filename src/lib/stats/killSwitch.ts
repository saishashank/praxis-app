// Kill switch (M4 T15; docs/M4_design.md 4.10, decisions 28 and 29; ARN-093, ARN-101 neighbour).
//
// ARN-093, verbatim (spec 05 l.127): "Kill switch per family, checked at 20, 40, 60 ... forward
// trades up to K = `killswitch_max_looks_per_year` (set each year from the measured trade rate);
// each of the 3 criteria uses alpha = 0.05 / 3 spent as alpha/2^k across its looks (overall
// false-trigger rate <= 5% per year): forward per-trade expectancy vs backtest; forward win rate vs
// the backtest distribution; forward CIF below the backtest 90% lower bound once estimable. (No
// slippage trigger ...)"
// The spec names no test and no consequence of a trip. Decisions D-093 (proposed):
//   - look k is made on the FIRST 20 k closed forward trades of a (lineage, rule version), in exit
//     order, at alpha_k = (alpha_total / criteria) / 2^k (`killswitch_*` keys);
//   - expectancy: studentised circular block bootstrap (ARN-081, lineage block) of
//     mean(backtest development mean - forward net) > 0, i.e. forward below backtest, one-sided;
//     fewer than 15 independent blocks is "not estimable" and writes no look;
//   - win rate: exact binomial lower tail of the forward wins against the development win rate;
//   - CIF: once forward effective N >= `progress_min_neff`, exact binomial lower tail of the forward
//     cohorts that reached the target within t_max against the backtest 90 % lower bound of
//     CIF_target(t_max); one look per k, taken when first estimable;
//   - a look is written only when its criterion is estimable (a missing baseline, too few blocks or
//     a CIF below effective N 3 writes nothing and is retried on a later night);
//   - a trip only RECOMMENDS: it writes `killswitch_look.triggered = 1` and an append-only
//     `arena_control` (family, killed) state row with the reason; nothing in this module pauses a
//     cohort, cancels an order or edits a position, and batch 2b reads `arena_control` since D-094 and stops NEW entries,
//     never exits, so open positions still close by their rules;
//   - K = max(1, ceil(expected forward trades per year / 20)) is computed once per calendar year
//     (and at the first evaluation) from the development entry rate and stored as a config version.
import type { Client } from "@libsql/client";
import { cifProportions } from "@/lib/replay/cif";
import { setConfig } from "@/lib/config/store";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { binomialLowerTail } from "./binomial";
import { MIN_INDEPENDENT_BLOCKS, bootstrapSeries } from "./bootstrap";
import { bootstrapReplications } from "./gates";
import { scopedPrng } from "./rng";

export type KillCriterion = "expectancy" | "win_rate" | "cif";
export const KILL_CRITERIA: readonly KillCriterion[] = ["expectancy", "win_rate", "cif"];

/** Trading sessions in a year: the ARN-071 t_max of 252 sessions is 12 months. */
export const SESSIONS_PER_YEAR = 252;

export type KillSwitchParams = {
  readonly tradesPerLook: number;
  readonly alphaTotal: number;
  readonly criteria: number;
  readonly maxLooksPerYear: number;
  readonly bootstrapReplicationsMin: number;
  readonly bootstrapBlockMinSessions: number;
  readonly progressMinNeff: number;
};

/** Level of look k (k >= 1): (alpha_total / criteria) / 2^k. Equals `killSwitchLevel(k)` at 0.05 / 3. */
export function lookLevel(k: number, alphaTotal: number, criteria: number): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError("look index must be a positive integer");
  return alphaTotal / criteria / 2 ** k;
}

/** Looks reached with `closed` forward trades: floor(closed / perLook), at most K. */
export function looksReached(closed: number, perLook: number, maxLooks: number): number {
  return Math.min(maxLooks, Math.floor(closed / perLook));
}

/** K = max(1, ceil(expected forward trades per year / trades per look)), clamped to the key's range. */
export function looksPerYear(expectedTradesPerYear: number, perLook: number): number {
  const range = (CONFIG_KEYS.killswitch_max_looks_per_year as { range?: readonly [number, number] })
    .range ?? [1, 52]; // threshold-ok: the key's own range, 1 to 52 looks
  const raw = Math.max(1, Math.ceil(expectedTradesPerYear / perLook - 1e-9));
  return Math.min(range[1], Math.max(range[0], raw));
}

export type ForwardTrade = {
  /** Entry session index (0-based, any origin: only differences matter). */
  readonly entrySession: number;
  /** Net return as a plain number. */
  readonly net: number;
};

export type Baseline = {
  /** Development-split mean net return per trade; null = not available. */
  readonly meanNet: number | null;
  /** Development-split net win rate. */
  readonly winRate: number | null;
  /** Backtest 90 % lower bound of CIF_target(t_max). */
  readonly cifTargetLower90: number | null;
};

export type CifEvidence = { readonly effectiveN: number; readonly targets: number };

export type LookResult = {
  readonly criterion: KillCriterion;
  /** false = not estimable now: nothing is written. */
  readonly estimable: boolean;
  readonly stat: number | null;
  readonly p: number | null;
  readonly triggered: boolean;
};

const notEstimable = (criterion: KillCriterion): LookResult => ({
  criterion,
  estimable: false,
  stat: null,
  p: null,
  triggered: false,
});

export type LookInput = {
  readonly k: number;
  readonly alpha: number;
  /** The first 20 k closed forward trades, exit order. */
  readonly trades: readonly ForwardTrade[];
  readonly baseline: Baseline;
  readonly cif: CifEvidence | null;
  readonly block: number;
  readonly params: Pick<KillSwitchParams, "bootstrapReplicationsMin" | "progressMinNeff">;
  /** Seed scope, e.g. `ks:AU:F1:F1.v1:1`. */
  readonly scope: string;
};

/** Criterion 1: forward mean net below the development mean (block bootstrap, one-sided). */
export function evaluateExpectancy(i: LookInput): LookResult {
  const base = i.baseline.meanNet;
  if (base === null || i.trades.length === 0) return notEstimable("expectancy");
  const first = Math.min(...i.trades.map((t) => t.entrySession));
  const last = Math.max(...i.trades.map((t) => t.entrySession));
  const sessions = i.trades.map((t) => t.entrySession - first);
  const shortfall = i.trades.map((t) => base - t.net);
  const B = bootstrapReplications(i.alpha, i.params.bootstrapReplicationsMin);
  const s = bootstrapSeries(
    sessions,
    shortfall,
    last - first + 1,
    Math.max(1, i.block),
    B,
    scopedPrng(i.scope),
  );
  if (s.blocks < MIN_INDEPENDENT_BLOCKS) return notEstimable("expectancy");
  const forwardMean = i.trades.reduce((a, t) => a + t.net, 0) / i.trades.length;
  return {
    criterion: "expectancy",
    estimable: true,
    stat: forwardMean - base,
    p: s.test.p,
    triggered: s.test.p <= i.alpha,
  };
}

/** Criterion 2: exact binomial lower tail of the forward wins against the development win rate. */
export function evaluateWinRate(i: LookInput): LookResult {
  const p0 = i.baseline.winRate;
  if (p0 === null || i.trades.length === 0) return notEstimable("win_rate");
  const wins = i.trades.filter((t) => t.net > 0).length;
  const p = binomialLowerTail(wins, i.trades.length, p0);
  return {
    criterion: "win_rate",
    estimable: true,
    stat: wins / i.trades.length,
    p,
    triggered: p <= i.alpha,
  };
}

/** Criterion 3: forward CIF_target(t_max) below the backtest 90 % lower bound, once effective N >= 3. */
export function evaluateCif(i: LookInput): LookResult {
  const lower = i.baseline.cifTargetLower90;
  const c = i.cif;
  if (lower === null || c === null || c.effectiveN < i.params.progressMinNeff) {
    return notEstimable("cif");
  }
  const p = binomialLowerTail(c.targets, c.effectiveN, lower);
  return {
    criterion: "cif",
    estimable: true,
    stat: c.targets / c.effectiveN,
    p,
    triggered: p <= i.alpha,
  };
}

/** All three criteria of one look. */
export function evaluateLook(i: LookInput): LookResult[] {
  return [evaluateExpectancy(i), evaluateWinRate(i), evaluateCif(i)];
}

// ---- database side --------------------------------------------------------------------------------------------

const text = (v: unknown): string => String(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type KillSwitchOptions = {
  readonly market: string;
  readonly d: string;
  readonly params: KillSwitchParams;
  /** Stamps the arena_control row only. */
  readonly now: () => string;
  /** Sessions of the market, oldest first, up to d (entry-session indexes). */
  readonly sessions: readonly string[];
};

export type KillSwitchOutcome = {
  readonly looksWritten: number;
  readonly triggered: number;
  readonly recommended: readonly string[];
};

type Closed = {
  readonly id: string;
  readonly entryD: string;
  readonly exitD: string;
  readonly family: string;
  readonly ruleVersion: string;
  readonly net: number;
};

async function closedForward(db: Client, market: string): Promise<Closed[]> {
  const rs = await db.execute({
    sql: `SELECT lr.id, lr.entry_d, lr.exit_d, lr.qty, lr.qty_out, lr.fill_in_micro, lr.fill_out_micro,
                 lr.brok_in_micro, lr.brok_out_micro, lr.dividend_micro, s.family, s.rule_version, s.variant
          FROM ledger_row lr JOIN signal s ON s.id = lr.signal_id
          WHERE lr.forward = 1 AND lr.exit_d IS NOT NULL AND s.market = ? AND s.variant = s.family
          ORDER BY lr.exit_d, lr.id`,
    args: [market],
  });
  return rs.rows.map((r) => {
    const cost =
      BigInt(r.qty as bigint) * BigInt(r.fill_in_micro as bigint) +
      BigInt(r.brok_in_micro as bigint);
    const proceeds =
      BigInt(r.qty_out as bigint) * BigInt(r.fill_out_micro as bigint) -
      BigInt(r.brok_out_micro as bigint) +
      BigInt(r.dividend_micro as bigint);
    return {
      id: text(r.id),
      entryD: text(r.entry_d),
      exitD: text(r.exit_d),
      family: text(r.family),
      ruleVersion: text(r.rule_version),
      net: Number(proceeds - cost) / Number(cost),
    };
  });
}

async function latestReplayStat(
  db: Client,
  market: string,
  scope: string,
  metric: string,
): Promise<Record<string, unknown> | null> {
  const rs = await db.execute({
    sql: `SELECT value_json FROM replay_stat
          WHERE scope = ? AND metric = ?
            AND run_id IN (SELECT id FROM replay_run WHERE kind IN ('light','full') AND market = ?)
          ORDER BY d DESC, run_id DESC LIMIT 1`,
    args: [scope, metric, market],
  });
  return rs.rows.length === 0
    ? null
    : (JSON.parse(text(rs.rows[0]!.value_json)) as Record<string, unknown>);
}

/** The development baseline of a (lineage, rule version, variant) from the latest replay summaries. */
export async function loadBaseline(
  db: Client,
  market: string,
  family: string,
  ruleVersion: string,
): Promise<Baseline> {
  const card = await latestReplayStat(
    db,
    market,
    `${market}:${family}|${ruleVersion}|${family}`,
    "scorecard",
  );
  let meanNet: number | null = null;
  let winRate: number | null = null;
  if (card !== null && card.insufficient === false) {
    meanNet = (card.expectancy as { value: number | null }).value;
    winRate = (card.winRate as { value: number }).value;
  }
  let cifLower: number | null = null;
  const ex = await db.execute({
    sql: "SELECT id FROM execution WHERE kind = 'E' AND family = ? AND variant = 'U' ORDER BY id LIMIT 1",
    args: [family],
  });
  if (ex.rows.length > 0) {
    const cif = await latestReplayStat(db, market, text(ex.rows[0]!.id), "cif");
    const props = cif === null ? null : (cif.proportions as readonly Record<string, unknown>[]);
    const last = props === null || props.length === 0 ? undefined : props[props.length - 1];
    if (last !== undefined && Number(last.n) > 0) {
      cifLower = (last.interval as { target: { lower: number } }).target.lower;
    }
  }
  return { meanNet, winRate, cifTargetLower90: cifLower };
}

/** Forward effective N and targets reached by t_max for a family's E (variant U) cohorts. */
export async function loadForwardCif(
  db: Client,
  family: string,
  horizon: number,
): Promise<CifEvidence | null> {
  const rs = await db.execute({
    sql: `SELECT c.id, c.execution_id, c.start_d, c.terminal_kind, c.terminal_d, c.ttd_sessions
          FROM cohort c JOIN execution e ON e.id = c.execution_id
          WHERE e.kind = 'E' AND e.family = ? AND e.variant = 'U' AND c.terminal_kind IS NOT NULL
          ORDER BY c.start_d, c.id`,
    args: [family],
  });
  if (rs.rows.length === 0) return null;
  const cohorts = rs.rows.map((r) => ({
    id: text(r.id),
    executionId: text(r.execution_id),
    startD: text(r.start_d),
    terminalD: text(r.terminal_d),
    terminalKind: text(r.terminal_kind) as "target" | "bust" | "stalled" | "timeout",
    ttdSessions: Number(r.ttd_sessions as bigint),
  }));
  const p = cifProportions(cohorts, [horizon])[0]!;
  return { effectiveN: p.n, targets: p.counts.target };
}

async function lineageBlock(db: Client, lineage: string, fallback: number): Promise<number> {
  const rs = await db.execute({
    sql: "SELECT block_sessions FROM lineage_split WHERE lineage_id = ? ORDER BY version DESC LIMIT 1",
    args: [lineage],
  });
  return rs.rows.length === 0 ? fallback : Number(rs.rows[0]!.block_sessions as bigint);
}

async function familyState(db: Client, family: string): Promise<string | null> {
  const rs = await db.execute({
    sql: "SELECT state FROM arena_control WHERE scope = 'family' AND scope_key = ? ORDER BY id DESC LIMIT 1",
    args: [family],
  });
  return rs.rows.length === 0 ? null : text(rs.rows[0]!.state);
}

/**
 * Evaluate every look that is due and not yet recorded, per (family, rule version) and criterion.
 * Idempotent: a recorded (lineage, rule version, criterion, k) is never recomputed. A trip writes the
 * look (triggered = 1) and, once per family, an `arena_control` killed state with the reason: a
 * recommendation, see the header.
 */
export async function evaluateKillSwitch(
  db: Client,
  o: KillSwitchOptions,
): Promise<KillSwitchOutcome> {
  const closed = await closedForward(db, o.market);
  const groups = new Map<string, Closed[]>();
  for (const c of closed) {
    const key = `${c.family}|${c.ruleVersion}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const index = new Map<string, number>();
  o.sessions.forEach((s, i) => index.set(s, i));
  let written = 0;
  const tripped: string[] = [];
  for (const [key, list] of [...groups.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const [family, ruleVersion] = key.split("|") as [string, string];
    const lineage = `${o.market}:${family}`;
    const reached = looksReached(list.length, o.params.tradesPerLook, o.params.maxLooksPerYear);
    if (reached < 1) continue;
    const baseline = await loadBaseline(db, o.market, family, ruleVersion);
    const block = await lineageBlock(db, lineage, o.params.bootstrapBlockMinSessions);
    const cif = await loadForwardCif(db, family, SESSIONS_PER_YEAR);
    for (let k = 1; k <= reached; k += 1) {
      const trades = list
        .slice(0, k * o.params.tradesPerLook)
        .map((c): ForwardTrade => ({ entrySession: index.get(c.entryD) ?? 0, net: c.net }));
      const alpha = lookLevel(k, o.params.alphaTotal, o.params.criteria);
      const results = evaluateLook({
        k,
        alpha,
        trades,
        baseline,
        cif,
        block,
        params: o.params,
        scope: `ks:${lineage}:${ruleVersion}:${k}`,
      });
      for (const r of results) {
        if (!r.estimable) continue;
        const res = await db.execute({
          sql: `INSERT INTO killswitch_look
                  (lineage_id, rule_version, criterion, look_k, d, trades, stat, p, alpha_k, triggered)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [
            lineage,
            ruleVersion,
            r.criterion,
            k,
            o.d,
            trades.length,
            r.stat,
            r.p,
            alpha,
            r.triggered ? 1 : 0,
          ],
        });
        if (res.rowsAffected === 0) continue;
        written += 1;
        if (r.triggered && (await familyState(db, family)) !== "killed") {
          await db.execute({
            sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
                  VALUES ('family', ?, 'killed', ?, 'killswitch', ?)`,
            args: [
              family,
              o.now(),
              `ARN-093 recommendation: ${r.criterion} look ${k} (${trades.length} forward trades) p=${r.p} <= alpha=${alpha}; nothing was paused automatically`,
            ],
          });
          tripped.push(family);
        }
      }
    }
  }
  return {
    looksWritten: written,
    triggered: tripped.length,
    recommended: [...new Set(tripped)].sort(),
  };
}

// ---- K, computed yearly (decision 28) ------------------------------------------------------------------------

/** Expected forward trades per year per family from the development entry rate (family_flow). */
export async function expectedTradesPerYear(db: Client, market: string): Promise<number | null> {
  const flows = await latestReplayStat(db, market, "all", "family_flow");
  const list =
    (flows as unknown as readonly { family: string; entryRate: number }[] | null) ?? null;
  if (list === null || list.length === 0) return null;
  return Math.max(...list.map((f) => f.entryRate * SESSIONS_PER_YEAR));
}

export type YearlyK = { readonly computed: boolean; readonly k: number | null };

/**
 * Store K for the calendar year of `d` unless a version computed for that year exists. The config
 * version's reason carries `computed:<year>`; with no development rate nothing is stored.
 */
export async function ensureLooksPerYear(
  db: Client,
  o: {
    readonly market: string;
    readonly d: string;
    readonly perLook: number;
    readonly now: string;
  },
): Promise<YearlyK> {
  const year = o.d.slice(0, 4);
  // a version computed for this year exists (an Owner edit made after it is kept, not overwritten)
  const cur = await db.execute({
    sql: `SELECT 1 FROM config_version WHERE key = 'killswitch_max_looks_per_year' AND scope = 'global'
          AND reason LIKE ? LIMIT 1`,
    args: [`computed:${year}%`],
  });
  if (cur.rows.length > 0) return { computed: false, k: null };
  const rate = await expectedTradesPerYear(db, o.market);
  if (rate === null) return { computed: false, k: null };
  const k = looksPerYear(rate, o.perLook);
  await setConfig(db, {
    key: "killswitch_max_looks_per_year",
    value: k,
    userId: null,
    reason: `computed:${year} ARN-093 from the development entry rate ${rate.toFixed(2)} trades a year`,
    now: o.now,
  });
  return { computed: true, k };
}
