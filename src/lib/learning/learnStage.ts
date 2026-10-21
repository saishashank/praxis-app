// The `learn` phase: A6's nightly deterministic stage (M6 T11; ARN-060..069, PLT-073, AGT-004/050;
// docs/M6_design.md 4.1 and 4.2; D-110 #1 #3 #41, D-113, D-118, D-119, D-120; D-123). HIGH-RISK only in
// that it writes the knowledge tables; it writes nothing a trade reads (KB-030) and NO LLM call is made
// anywhere in this module (the wording is the `words` phase).
//
// ONE run per session D, keyed `arena-learn:<market>:<D>`, back-to-back after batch 3. Steps, each
// idempotent on deterministic ids and each isolated (a failure in one never stops the others, AGT-004):
//   1. attribution of every trade, forward-ledger row and blocked signal: the forward ledger is synced
//      again with the `afterWrite` hook (D-113) so the gate-blocked candidates are walked in the very
//      world the ledger used, then `attributeNight` (trading days only);
//   2. nightly descriptive comparisons from the attributed excess (trading days only);
//   3. lesson staging: lessons graded or changed since the previous run (read-only; graded lessons come
//      from the weekly learning run, decision 41);
//   4. Critic gate: challengers in `review` get checks 4 and 6 re-checked, a new `critique` row only
//      when something changed; 5. Lane A: every playbook recomputed, injection events logged (KB-061);
//   6. challengers: shakedown sessions counted from the run history, `shakedown -> review`, the `ready`
//      mark (nothing promotes here); 7. yesterday's plan reviewed, tonight's plan written;
//   8. the KB version in force after the run (documents belong to T13).
// Variants. FULL on a trading day with batch 3 of D done. PARTIAL (status `degraded`, never touching
// orders) when batch 3 of D is missing: it runs on the latest complete inputs, without the ledger sync.
// REDUCED on a non-trading day: no attribution and no comparisons (nothing new to measure); Lane A,
// the Critic gate, challengers, plan and its review run as usual so section 4 of a non-trading review
// has A6 content (D-110 #3). The learning loop has a time budget (`learning_loop_minutes`): when it is
// spent the remaining steps are skipped and the run is `degraded`. Preconditions as batch 3: market mode
// `full` (or a replay against a non-production database, D-066 / BLD-024); anything else records a
// `skipped` run and touches no table.
import type { Client } from "@libsql/client";
import {
  addDays,
  isTradingDay,
  sessionsBetween,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import { hasSuccess, finishRun, startRun } from "@/lib/runs/runRecord";
import { ARENA_MASTER_SEED, loadCalendar } from "@/lib/arena/closeBooks";
import { loadAgentParams, type AgentParams } from "@/lib/agents/params";
import { syncForwardLedger } from "@/lib/agents/forwardLedger";
import { reviewKey } from "@/lib/agents/batch3";
import { signalsKey } from "@/lib/agents/batch2b";
import { FAMILY_ORDER } from "@/lib/agents/families/constants";
import { paramBounds } from "@/lib/agents/families/ruleSchema";
import {
  attributeBlockedCandidates,
  attributeNight,
  type AttributionResult,
  type BlockedCandidateResult,
} from "./attribution";
import {
  checkBounds,
  checkDataIssues,
  criticParams,
  statesOf,
  writeCritique,
  type CriticRow,
  type CheckResult,
  type Evaluation,
  type ParamBound,
} from "./critic";
import {
  nightlyComparisons,
  writeComparisonRows,
  type CompRow,
  type PairData,
} from "./comparisons";
import {
  CRITIC_CHECK_COUNT,
  reviewChallenger,
  syncShakedown,
  type ShakedownSession,
} from "./challengerLifecycle";
import { laneAParams, runLaneA, type LaneAResult } from "./laneA";
import { currentKbVersion } from "./kbVersion";
import { LEARN_JOB, learnKey, nextSessionAfter, previousLearnD } from "./learnFacts";
import { planCandidates, reviewPreviousPlan, selectPlan, writePlan } from "./plan";

export { LEARN_JOB, learnKey };

const LOG_MESSAGE_MAX = 500; // threshold-ok: app_log message length cap (as batch 2b and 3)
const MS_PER_MINUTE = 60_000; // threshold-ok: unit conversion for the loop budget
const EVENT_FAMILIES: readonly string[] = ["F2", "F3", "F5"];
const TECHNICAL_FAMILIES: readonly string[] = ["F1", "F4"];

export class LearnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LearnError";
    this.code = code;
  }
}

export type LearnOptions = {
  readonly market: string;
  readonly d: string;
  /** An explicit replay against a NON-production database (D-066 / BLD-024). */
  readonly replay?: boolean;
  /** Stamps run_record, app_log and change rows only; never a number. */
  readonly now: () => string;
  readonly commitSha?: string | null;
  readonly masterSeed?: bigint;
  readonly calendar?: CalendarRow[];
  readonly params?: AgentParams;
  /** Milliseconds clock for the loop budget only (default `Date.now`); never reaches a row. */
  readonly clockMs?: () => number;
};

export type LearnStatus = "success" | "degraded" | "failed" | "skipped" | "already_done";
export type LearnVariant = "full" | "partial" | "reduced";

export type CriticGateStats = {
  readonly challengers: number;
  readonly critiquesWritten: number;
  readonly readyChanged: number;
  readonly lessonsWithCritique: number;
};

export type LearnStats = {
  variant: LearnVariant | null;
  partialReason: string | null;
  attribution: AttributionResult | null;
  blocked: BlockedCandidateResult | null;
  comparisons: number;
  lessonsChanged: number;
  critic: CriticGateStats | null;
  laneA: { changes: number; adopted: number; injectionEvents: number } | null;
  shakedown: { synced: number; movedToReview: number } | null;
  planItems: number;
  planReviewed: number;
  kbVersion: string | null;
  stoppedForBudget: boolean;
  stepsFailed: string[];
};

export type LearnResult = {
  readonly market: string;
  readonly d: string;
  readonly status: LearnStatus;
  readonly reason: string | null;
  readonly runId: number | null;
  readonly stats: LearnStats;
};

const text = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v as bigint); // money-float-ok: a count read from SQL
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function emptyStats(): LearnStats {
  return {
    variant: null,
    partialReason: null,
    attribution: null,
    blocked: null,
    comparisons: 0,
    lessonsChanged: 0,
    critic: null,
    laneA: null,
    shakedown: null,
    planItems: 0,
    planReviewed: 0,
    kbVersion: null,
    stoppedForBudget: false,
    stepsFailed: [],
  };
}

const result = (
  o: LearnOptions,
  status: LearnStatus,
  reason: string | null,
  runId: number | null,
  stats = emptyStats(),
): LearnResult => ({ market: o.market, d: o.d, status, reason, runId, stats });

async function recordSkip(db: Client, o: LearnOptions, reason: string): Promise<LearnResult> {
  const runId = await startRun(db, {
    job: LEARN_JOB,
    market: o.market,
    concurrencyKey: learnKey(o.market, o.d),
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  await finishRun(db, runId, { status: "skipped", details: { reason }, now: o.now() });
  return result(o, "skipped", reason, runId);
}

async function runOk(db: Client, key: string): Promise<boolean> {
  const rs = await db.execute({
    sql: `SELECT 1 FROM run_record WHERE concurrency_key = ? AND status IN ('success', 'degraded') LIMIT 1`,
    args: [key],
  });
  return rs.rows.length > 0;
}

async function runExists(db: Client, key: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? LIMIT 1",
    args: [key],
  });
  return rs.rows.length > 0;
}

async function log(
  db: Client,
  o: LearnOptions,
  level: "warn" | "error",
  message: string,
  runId: number,
): Promise<void> {
  await db.execute({
    sql: "INSERT INTO app_log (at, level, source, message, run_id) VALUES (?, ?, ?, ?, ?)",
    args: [o.now(), level, LEARN_JOB, message.slice(0, LOG_MESSAGE_MAX), runId],
  });
}

// ---- step 2: nightly comparisons -----------------------------------------------------------------------------------

type AttrRow = {
  readonly family: string;
  readonly ruleVersion: string;
  readonly tier: string | null;
  readonly regime: string | null;
  readonly entryD: string;
  readonly value: number;
};

/** Latest attribution version (as of `d`) of every forward ledger row that has an excess figure. */
async function excessRows(db: Client, market: string, d: string): Promise<AttrRow[]> {
  const rs = await db.execute({
    sql: `SELECT a.tags_json, a.excess_ppm FROM attribution a
          WHERE a.subject_kind = 'ledger_row' AND a.market = ? AND a.d <= ? AND a.excess_ppm IS NOT NULL
            AND a.version = (SELECT MAX(x.version) FROM attribution x
                             WHERE x.subject_kind = a.subject_kind AND x.subject_id = a.subject_id AND x.d <= ?)
          ORDER BY a.subject_id`,
    args: [market, d, d],
  });
  const out: AttrRow[] = [];
  for (const r of rs.rows) {
    const t = JSON.parse(text(r.tags_json)) as Record<string, unknown>;
    const entryD = typeof t.entry_d === "string" ? t.entry_d : null;
    if (entryD === null || entryD > d) continue;
    // the family's own variant only: the tier / filter variants are not a family's result (cf. batch 3)
    if (t.variant !== t.family) continue;
    out.push({
      family: text(t.family),
      ruleVersion: text(t.rule_version),
      tier: typeof t.tier === "string" ? t.tier : null,
      regime: typeof t.regime === "string" ? t.regime : null,
      entryD,
      value: Number(r.excess_ppm),
    });
  }
  return out;
}

async function frozenBlock(
  db: Client,
  market: string,
  family: string,
  fallback: number,
): Promise<number> {
  const rs = await db.execute({
    sql: "SELECT block FROM lesson_window WHERE lineage_id = ? ORDER BY split_version DESC LIMIT 1",
    args: [`${market}:${family}`],
  });
  return rs.rows.length === 0 ? fallback : num(rs.rows[0]!.block);
}

/**
 * The v1 pairs list that the forward ledger can answer (design 2.5): family vs family, tier vs tier
 * inside a family, regime vs regime inside a family, event vs technical families. Rows are the forward
 * ledger's excess over the matched controls, by entry session. Both sides need at least one row. The
 * twins, filter taken-vs-blocked and cost-profile pairs need the live-trade and replay readers (T12).
 */
export async function comparisonPairs(
  db: Client,
  o: {
    market: string;
    d: string;
    calendar: readonly CalendarRow[];
    params: AgentParams;
    /** Only rows entered after this date (the NEW data of a confirmation look). */
    since?: string;
  },
): Promise<PairData[]> {
  const rows = (await excessRows(db, o.market, o.d)).filter(
    (r) => o.since === undefined || r.entryD > o.since,
  );
  if (rows.length === 0) return [];
  const first = rows.map((r) => r.entryD).sort(cmp)[0]!;
  const sessions = sessionsBetween(first, o.d, o.calendar);
  const at = new Map(sessions.map((s, i) => [s, i]));
  const asRows = (xs: readonly AttrRow[]): CompRow[] =>
    xs.flatMap((r) => {
      const session = at.get(r.entryD);
      return session === undefined ? [] : [{ session, value: r.value }];
    });
  const fallback = o.params.stats.bootstrapBlockMinSessions;
  const blocks = new Map<string, number>();
  for (const f of FAMILY_ORDER) blocks.set(f, await frozenBlock(db, o.market, f, fallback));
  const blockOf = (...families: string[]): number =>
    Math.max(...families.map((f) => blocks.get(f) ?? fallback));
  const pairs: PairData[] = [];
  const add = (
    pairId: string,
    a: readonly AttrRow[],
    b: readonly AttrRow[],
    families: string[],
  ): void => {
    const ra = asRows(a);
    const rb = asRows(b);
    if (ra.length === 0 || rb.length === 0) return;
    pairs.push({
      market: o.market,
      pairId,
      a: ra,
      b: rb,
      sessionCount: sessions.length,
      block: blockOf(...families),
    });
  };

  const keys = [...new Set(rows.map((r) => `${r.family}|${r.ruleVersion}`))].sort(cmp);
  const byKey = (k: string): AttrRow[] => rows.filter((r) => `${r.family}|${r.ruleVersion}` === k);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const [fa, va] = keys[i]!.split("|");
      const [fb, vb] = keys[j]!.split("|");
      add(`${va}|${vb}`, byKey(keys[i]!), byKey(keys[j]!), [fa!, fb!]);
    }
  }
  for (const k of keys) {
    const [family, version] = k.split("|");
    const own = byKey(k);
    const tiers = [...new Set(own.flatMap((r) => (r.tier === null ? [] : [r.tier])))].sort(cmp);
    for (let i = 0; i < tiers.length; i += 1) {
      for (let j = i + 1; j < tiers.length; j += 1) {
        add(
          `${version}:${tiers[i]}|${version}:${tiers[j]}`,
          own.filter((r) => r.tier === tiers[i]),
          own.filter((r) => r.tier === tiers[j]),
          [family!],
        );
      }
    }
    const regimes = [...new Set(own.flatMap((r) => (r.regime === null ? [] : [r.regime])))].sort(
      cmp,
    );
    for (let i = 0; i < regimes.length; i += 1) {
      for (let j = i + 1; j < regimes.length; j += 1) {
        add(
          `${version}:${regimes[i]}|${version}:${regimes[j]}`,
          own.filter((r) => r.regime === regimes[i]),
          own.filter((r) => r.regime === regimes[j]),
          [family!],
        );
      }
    }
  }
  add(
    "EVENT|TECH",
    rows.filter((r) => EVENT_FAMILIES.includes(r.family)),
    rows.filter((r) => TECHNICAL_FAMILIES.includes(r.family)),
    [...EVENT_FAMILIES, ...TECHNICAL_FAMILIES],
  );
  return pairs;
}

// ---- step 4 and 6: the Critic gate on stored checks -----------------------------------------------------------------

type StoredCheck = {
  n: number;
  state: CheckResult["state"];
  detail: string;
  values: CheckResult["values"];
};

const DATA_IDX = 3; // threshold-ok: zero-based index of Critic check 4 (data issues)
const BOUNDS_IDX = 5; // threshold-ok: zero-based index of Critic check 6 (parameter bounds)
const WINDOW_OPEN = "0001-01-01"; // threshold-ok: a window that holds every date: the input-bound audit stays as stored
const WINDOW_CLOSE = "9999-12-31"; // threshold-ok: see above

/** Rows that reproduce the stored counts of check 4, so the real check judges them under today's cap. */
function rowsFromCounts(values: CheckResult["values"]): CriticRow[] {
  const total = Number(values.rows ?? 0);
  const flagged = Number(values.flagged ?? 0);
  const outside = Number(values.outsideInputBound ?? 0);
  return Array.from({ length: total }, (_, k) => ({
    id: `r${k}`,
    regime: null,
    value: null,
    stressValue: null,
    stressNet: null,
    flagged: k < flagged,
    entryD: k < outside ? "0000-01-01" : "2000-01-01",
    outcomeD: "2000-01-02",
  }));
}

async function ruleBounds(db: Client, ruleVersionId: string): Promise<ParamBound[]> {
  const rs = await db.execute({
    sql: "SELECT params_json FROM rule_version WHERE id = ?",
    args: [ruleVersionId],
  });
  if (rs.rows.length === 0) return [];
  const params = JSON.parse(text(rs.rows[0]!.params_json)) as Record<string, unknown>;
  const out: ParamBound[] = [];
  for (const key of Object.keys(params).sort(cmp)) {
    const v = params[key];
    const b = paramBounds(key);
    if (typeof v === "number" && b !== null) out.push({ key, value: v, min: b[0], max: b[1] });
  }
  return out;
}

export type Recheck = {
  readonly status: "no_critique" | "unchanged" | "changed";
  readonly written: boolean;
  readonly readyChanged: boolean;
};

/**
 * Re-checks a challenger's stored Critic result with today's inputs: check 4 (the stored row counts
 * under the current flag-share cap) and check 6 (the version's parameters against their bounds). The
 * other four checks are the evidence run's numbers and stay as stored. A `critique` row is written only
 * when a state or a number moved (writeCritique); in `review` the `ready` mark follows the six states.
 */
export async function recheckChallenger(
  db: Client,
  args: {
    readonly challengerId: string;
    readonly ruleVersionId: string;
    readonly state: string;
    readonly runId: string;
    readonly d: string;
    readonly params: AgentParams;
  },
): Promise<Recheck> {
  const latest = await db.execute({
    sql: `SELECT checks_json FROM critique WHERE subject_kind = 'challenger' AND subject_id = ?
          AND d <= ? ORDER BY d DESC, run_id DESC LIMIT 1`,
    args: [args.challengerId, args.d],
  });
  if (latest.rows.length === 0)
    return { status: "no_critique", written: false, readyChanged: false };
  const stored = JSON.parse(text(latest.rows[0]!.checks_json)) as StoredCheck[];
  const asCheck = (c: StoredCheck): CheckResult => ({
    n: c.n,
    name: "",
    state: c.state,
    detail: c.detail,
    values: c.values,
  });
  const checks: CheckResult[] = stored.map(asCheck);
  const cp = criticParams(args.params);
  const subject = {
    kind: "challenger" as const,
    id: args.challengerId,
    rows: rowsFromCounts(stored[DATA_IDX]?.values ?? {}),
    blocks: 0,
    val110: { i: "pass" as const, iv: "pass" as const },
    survivorshipExposed: stored[DATA_IDX]?.values.survivorshipExposed === true,
    window: { startD: WINDOW_OPEN, endD: WINDOW_CLOSE, testD: WINDOW_CLOSE },
    params: await ruleBounds(db, args.ruleVersionId),
  };
  if (stored[DATA_IDX] !== undefined && stored[DATA_IDX].state !== "not_assessable") {
    checks[DATA_IDX] = checkDataIssues(subject, cp);
  }
  checks[BOUNDS_IDX] = checkBounds(subject);
  const evaluation: Evaluation = {
    kind: "challenger",
    id: args.challengerId,
    checks,
    passed: checks.every((c) => c.state === "pass"),
  };
  const w = await writeCritique(db, { evaluation, runId: args.runId, d: args.d });
  let readyChanged = false;
  if (args.state === "review" && checks.length === CRITIC_CHECK_COUNT) {
    const r = await reviewChallenger(db, args.challengerId, statesOf(evaluation));
    readyChanged = r.changed;
  }
  return {
    status: w.written ? "changed" : "unchanged",
    written: w.written,
    readyChanged,
  };
}

async function reviewChallengers(
  db: Client,
  o: LearnOptions,
  params: AgentParams,
  runKey: string,
): Promise<{ challengers: number; written: number; readyChanged: number }> {
  const rs = await db.execute({
    sql: `SELECT id, rule_version_id, state FROM challenger WHERE state = 'review' AND state_d <= ?
          AND lineage_id LIKE ? ORDER BY id`,
    args: [o.d, `${o.market}:%`],
  });
  let written = 0;
  let readyChanged = 0;
  for (const r of rs.rows) {
    const x = await recheckChallenger(db, {
      challengerId: text(r.id),
      ruleVersionId: text(r.rule_version_id),
      state: text(r.state),
      runId: runKey,
      d: o.d,
      params,
    });
    if (x.written) written += 1;
    if (x.readyChanged) readyChanged += 1;
  }
  return { challengers: rs.rows.length, written, readyChanged };
}

// ---- step 6: shakedown sessions from the run history ------------------------------------------------------------------

async function shakedownHistory(
  db: Client,
  market: string,
  enteredD: string,
  d: string,
  calendar: readonly CalendarRow[],
): Promise<ShakedownSession[]> {
  if (enteredD >= d) return [];
  const out: ShakedownSession[] = [];
  for (const day of sessionsBetween(addDays(enteredD, 1), d, calendar)) {
    const k2 = signalsKey(market, day);
    const k3 = reviewKey(market, day);
    if (!(await runExists(db, k2)) && !(await runExists(db, k3))) continue;
    out.push({ d: day, ok: (await runOk(db, k2)) && (await runOk(db, k3)) });
  }
  return out;
}

// ---- the entry point --------------------------------------------------------------------------------------------------

export async function learnDay(db: Client, o: LearnOptions): Promise<LearnResult> {
  const key = learnKey(o.market, o.d);
  if (await hasSuccess(db, key)) return result(o, "already_done", null, null);

  const market = await db.execute({
    sql: "SELECT mode, tz, open_time, close_time FROM market WHERE code = ?",
    args: [o.market],
  });
  if (market.rows.length === 0) return recordSkip(db, o, "market_missing");
  const mode = text(market.rows[0]!.mode);
  if (mode === "off") return recordSkip(db, o, "market_off");
  if (mode !== "full" && o.replay !== true) return recordSkip(db, o, "data_only_guard");
  const calendar = o.calendar ?? (await loadCalendar(db, o.market));
  const trading = isTradingDay(o.d, calendar);
  const hours: MarketHours = {
    tz: text(market.rows[0]!.tz),
    open_time: text(market.rows[0]!.open_time),
    close_time: text(market.rows[0]!.close_time),
  };

  const stale = await db.execute({
    sql: "SELECT 1 FROM run_record WHERE concurrency_key = ? AND status = 'running' LIMIT 1",
    args: [key],
  });
  if (stale.rows.length > 0) {
    await db.execute({
      sql: `UPDATE run_record SET status = 'failed', ended_at = ?, error_summary = ?
            WHERE concurrency_key = ? AND status = 'running'`,
      args: [o.now(), "superseded: the previous run did not finish", key],
    });
  }
  const runId = await startRun(db, {
    job: LEARN_JOB,
    market: o.market,
    concurrencyKey: key,
    scheduledFor: o.d,
    commitSha: o.commitSha ?? undefined,
    now: o.now(),
  });
  const stats = emptyStats();
  const clock = o.clockMs ?? ((): number => Date.now());
  const started = clock();
  try {
    const params = o.params ?? (await loadAgentParams(db));
    const budgetMs = params.learning.learningLoopMinutes * MS_PER_MINUTE;
    const batch3 = trading ? await runOk(db, reviewKey(o.market, o.d)) : true;
    stats.variant = !trading ? "reduced" : batch3 ? "full" : "partial";
    if (stats.variant === "partial") stats.partialReason = "batch3_missing";
    const effectiveD = nextSessionAfter(o.d, calendar) ?? addDays(o.d, 1);

    /** One isolated step: a failure is logged and recorded, the next step still runs (AGT-004). */
    const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (stats.stoppedForBudget) return;
      if (clock() - started > budgetMs) {
        stats.stoppedForBudget = true;
        await log(
          db,
          o,
          "warn",
          `learn on ${o.d}: loop budget spent before ${name}; remaining steps skipped`,
          runId,
        );
        return;
      }
      try {
        await fn();
      } catch (error) {
        stats.stepsFailed.push(name);
        const code = error instanceof Error ? error.name : "error";
        await log(db, o, "error", `learn on ${o.d}: step ${name} failed (${code})`, runId);
      }
    };

    // 1. attribution
    if (stats.variant !== "reduced") {
      await step("attribution", async () => {
        if (stats.variant === "full") {
          await syncForwardLedger(db, {
            market: o.market,
            d: o.d,
            calendar,
            hours,
            params,
            replay: o.replay === true,
            masterSeed: o.masterSeed ?? ARENA_MASTER_SEED,
            afterWrite: async (night) => {
              stats.blocked = await attributeBlockedCandidates(night);
            },
          });
        }
        stats.attribution = await attributeNight(db, {
          market: o.market,
          d: o.d,
          calendar,
          params,
          replay: o.replay === true,
        });
      });
      // 2. comparisons
      await step("comparisons", async () => {
        const pairs = await comparisonPairs(db, { market: o.market, d: o.d, calendar, params });
        const rows = nightlyComparisons(params, pairs, o.d);
        await writeComparisonRows(db, rows);
        stats.comparisons = rows.length;
      });
    }
    // 3. lesson staging (read-only)
    await step("lessons", async () => {
      const after = await previousLearnD(db, o.market, o.d);
      const rs = await db.execute({
        sql: `SELECT COUNT(DISTINCT g.lesson_id) AS n FROM lesson_grade g JOIN lesson l ON l.id = g.lesson_id
              WHERE l.market = ? AND g.d <= ? AND (? IS NULL OR g.d > ?)`,
        args: [o.market, o.d, after, after],
      });
      stats.lessonsChanged = num(rs.rows[0]!.n);
    });
    // 4. Critic gate
    await step("critic", async () => {
      const r = await reviewChallengers(db, o, params, key);
      const lessons = await db.execute({
        sql: `SELECT COUNT(DISTINCT subject_id) AS n FROM critique WHERE subject_kind = 'lesson' AND d <= ?`,
        args: [o.d],
      });
      stats.critic = {
        challengers: r.challengers,
        critiquesWritten: r.written,
        readyChanged: r.readyChanged,
        lessonsWithCritique: num(lessons.rows[0]!.n),
      };
    });
    // 5. Lane A
    const hold: { laneA: LaneAResult | null } = { laneA: null };
    await step("lane_a", async () => {
      const laneA = await runLaneA(db, {
        market: o.market,
        d: o.d,
        runId: key,
        effectiveD,
        now: o.now(),
        params: laneAParams(params),
      });
      hold.laneA = laneA;
      for (const e of laneA.events) {
        await log(
          db,
          o,
          "warn",
          `KB-061 injection check refused lesson ${e.lessonId} for playbook ${e.agent}: ${e.findings.map((f) => f.kind).join(", ")}`,
          runId,
        );
      }
      stats.laneA = {
        changes: laneA.changes.length,
        adopted: laneA.adopted.length,
        injectionEvents: laneA.events.length,
      };
    });
    // 6. challengers
    await step("challengers", async () => {
      const rs = await db.execute({
        sql: `SELECT id, state_d FROM challenger WHERE state = 'shakedown' AND state_d <= ?
              AND lineage_id LIKE ? ORDER BY id`,
        args: [o.d, `${o.market}:%`],
      });
      let moved = 0;
      for (const r of rs.rows) {
        const history = await shakedownHistory(db, o.market, text(r.state_d), o.d, calendar);
        const s = await syncShakedown(db, {
          id: text(r.id),
          d: o.d,
          sessions: history,
          learning: params.learning,
        });
        if (s.moved) moved += 1;
      }
      stats.shakedown = { synced: rs.rows.length, movedToReview: moved };
      if (moved > 0) await reviewChallengers(db, o, params, key);
    });
    // 7. plan and the review of yesterday's plan
    await step("plan", async () => {
      const reviewed = await reviewPreviousPlan(db, o.market, o.d);
      stats.planReviewed = reviewed.written;
      const changes = hold.laneA?.changes ?? [];
      const cands = await planCandidates(db, {
        market: o.market,
        d: o.d,
        calendar,
        laneAChanges: changes.map((c) => ({
          agent: c.agent,
          playbookN: c.playbookN,
          effectiveD,
          addedLessonIds: c.addedLessonIds,
          removedLessonIds: c.removedLessonIds,
        })),
      });
      stats.planItems = await writePlan(db, o.market, o.d, selectPlan(cands));
    });
    // 8. the KB version in force (documents are T13)
    await step("kb_version", async () => {
      stats.kbVersion = await currentKbVersion(db, o.market);
    });

    const degraded =
      stats.variant === "partial" || stats.stepsFailed.length > 0 || stats.stoppedForBudget;
    const status: LearnStatus = degraded ? "degraded" : "success";
    await finishRun(db, runId, {
      status,
      itemsProcessed: stats.comparisons + (stats.attribution?.ledgerRows.inserted ?? 0),
      rowsWritten: stats.comparisons + stats.planItems + stats.planReviewed,
      details: { ...stats },
      now: o.now(),
    });
    const reason = stats.stoppedForBudget
      ? "loop_budget"
      : stats.stepsFailed.length > 0
        ? `step_failed:${stats.stepsFailed.join(",")}`
        : stats.partialReason;
    return result(o, status, reason, runId, stats);
  } catch (error) {
    const code =
      error instanceof LearnError
        ? error.code
        : error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error
            ? error.name
            : "unknown_error";
    await finishRun(db, runId, {
      status: "failed",
      errorSummary: error instanceof Error ? `learn/${code}: ${error.message}` : `learn/${code}`,
      details: { code },
      now: o.now(),
    });
    await log(db, o, "error", `learn failed on ${o.d}: ${code}`, runId);
    return result(o, "failed", `learn/${code}`, runId, stats);
  }
}
