// Challenger evidence: the VAL-110 wrapper (M6 T9; ARN-087, ARN-085, KB-040 s13; D-090, D-110 #17, #47).
//
// For a challenger in `replay`:
//   1. pre-check the COUNT of validation entries and blocks from entry dates only (no outcome is
//      read); insufficient -> nothing is charged, the reachable date is returned (decision 47);
//   2. write the `validation_access` row in the trial ledger BEFORE the validation rows are loaded
//      (the rows come from a loader that is called only after the charge);
//   3. `evaluateVal110` with `challenger: {challengerRows, incumbentRows}` over the same period
//      (rows present in one version only count against 0 excess, D-090), (iii) from rolling-start
//      cohorts, (iv), (iv-b), (v), (vi) as supplied;
//   4. classify, store the `validation_result` rows, and move the challenger:
//      pass -> shakedown, a failed component -> rejected (the trial stays used), insufficient -> stay.
// Criterion (ii) is required to PASS for a challenger ("n/a" is accepted by the M4 `passes` for a
// family only, decision 17). The Critic checks 1-5 on the same rows are T6's; this module records the
// run id they use in the event reference. The holdout is never touched here.
import type { Client } from "@libsql/client";
import type { StatsParams, LearningParams } from "@/lib/agents/params";
import {
  evaluateVal110,
  type ChallengerRow as ExcessRow,
  type SafetyInput,
  type SignalRow,
  type Val110Result,
  type ValidationResultRecord,
} from "@/lib/stats/val110";
import {
  addWeekdays,
  trialBudget,
  spentTestsBefore,
  trialCounts,
  trialLedgerRow,
  type LineageSplitRecord,
  type TrialLedgerRow,
} from "@/lib/stats/splits";
import { loadChallenger, transitionChallenger } from "./challengerLifecycle";

// ---- pre-check (entry dates only) ---------------------------------------------------------------------

export type EvidenceSize = {
  /** Entries of the challenger's replay in the validation window (keys only). */
  readonly challengerKeys: readonly string[];
  /** Entries of the incumbent's replay in the same window. */
  readonly incumbentKeys: readonly string[];
  /** Sessions S of the validation window and the lineage's frozen block length. */
  readonly sessionCount: number;
  readonly block: number;
  readonly windowEndD: string;
};

export type Sufficiency = {
  readonly sufficient: boolean;
  readonly entries: number;
  /** Rows of (ii): the union of both versions' entries. */
  readonly unionEntries: number;
  readonly blocks: number;
  readonly reachableD: string | null;
};

/**
 * Counts only (ARN-082 look-ahead): sufficient iff the challenger's own entries and the union of
 * both versions' entries reach `min_trades` and the window holds `min_blocks` blocks, the same
 * thresholds `evaluateVal110` applies to (i) and (ii).
 */
export function evidenceSufficiency(
  size: EvidenceSize,
  stats: Pick<StatsParams, "minTrades" | "minBlocks">,
): Sufficiency {
  const entries = new Set(size.challengerKeys).size;
  const unionEntries = new Set([...size.challengerKeys, ...size.incumbentKeys]).size;
  const blocks = size.sessionCount / size.block;
  const sufficient =
    entries >= stats.minTrades && unionEntries >= stats.minTrades && blocks >= stats.minBlocks;
  let reachableD: string | null = null;
  if (!sufficient && entries > 0 && size.sessionCount > 0) {
    // the evaluator's projection: the window length at which the measured rate reaches both floors
    const rate = entries / size.sessionCount;
    const need = Math.max(stats.minBlocks * size.block, Math.ceil(stats.minTrades / rate));
    reachableD = addWeekdays(size.windowEndD, Math.max(0, need - size.sessionCount));
  }
  return { sufficient, entries, unionEntries, blocks, reachableD };
}

// ---- classification ----------------------------------------------------------------------------------------

export type EvidenceOutcome = "pass" | "fail" | "insufficient";

export type Classified = {
  readonly outcome: EvidenceOutcome;
  /** Components that failed, in order (i, ii, iii, iv, iv-b, v, vi). */
  readonly failed: readonly string[];
};

/**
 * pass / fail / insufficient from a VAL-110 result with a challenger input:
 *   - (i) or (ii) insufficient -> insufficient (the core evidence is missing; nothing is judged);
 *   - otherwise any failed component -> fail: (i) fail, (ii) fail or n/a (a challenger needs it),
 *     (iii) blocks, (iv) fail, (iv-b) fail, (v) fail ("n/a" below the variant minimum is no failure),
 *     (vi) fail; (iii) descriptive is no failure (decision 17);
 *   - otherwise (vi) insufficient -> insufficient;
 *   - otherwise pass.
 */
export function classifyEvidence(r: Val110Result): Classified {
  const c = r.checks;
  if (c.i === "insufficient" || c.ii === "insufficient") {
    return { outcome: "insufficient", failed: [] };
  }
  const failed: string[] = [];
  if (c.i !== "pass") failed.push("i");
  if (c.ii !== "pass") failed.push("ii");
  if (c.iii === "blocks") failed.push("iii");
  if (c.iv !== "pass") failed.push("iv");
  if (c.ivb !== "pass") failed.push("iv-b");
  if (c.v === "fail") failed.push("v");
  if (c.vi === "fail") failed.push("vi");
  if (failed.length > 0) return { outcome: "fail", failed };
  if (c.vi !== "pass") return { outcome: "insufficient", failed: [] };
  return { outcome: "pass", failed: [] };
}

// ---- the run -----------------------------------------------------------------------------------------------------

/** Everything the loader returns, called only after the access row is written. */
export type EvidenceRows = {
  readonly rows: readonly SignalRow[];
  readonly challengerRows: readonly ExcessRow[];
  readonly incumbentRows: readonly ExcessRow[];
  readonly safety: SafetyInput | null;
  readonly costInfeasible: boolean;
  readonly pboWeekly: readonly (readonly number[])[] | null;
  readonly dsr: {
    readonly daily: readonly number[];
    readonly variantDailySr: readonly number[];
    readonly defaultSrVariance: number;
  } | null;
};

export type EvidenceRun = {
  readonly challengerId: string;
  readonly runId: string;
  readonly d: string;
  readonly variant: string;
  readonly split: LineageSplitRecord;
  readonly stats: StatsParams;
  readonly learning: Pick<LearningParams, "shakedownSessions">;
  readonly activeLineages: number;
  /** The lineage's trial budget on this split: m, or the rolled budget after a roll. */
  readonly budgetTotal?: number;
  readonly size: EvidenceSize;
  /** Called only after the validation_access row exists. */
  readonly loadRows: () => Promise<EvidenceRows>;
  readonly masterSeed?: bigint;
  readonly actor?: string;
};

export type EvidenceReport =
  | {
      readonly outcome: "skipped";
      readonly reason: "not_in_replay" | "split_deferred" | "budget_exhausted";
      readonly charged: false;
    }
  | {
      readonly outcome: "insufficient";
      readonly charged: boolean;
      readonly reachableD: string | null;
      readonly failed: readonly string[];
    }
  | {
      readonly outcome: "pass" | "fail";
      readonly charged: boolean;
      readonly failed: readonly string[];
      readonly resultIds: readonly string[];
    };

const finite = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : v);

async function writeResults(db: Client, rows: readonly ValidationResultRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await db.batch(
    rows.map((r) => ({
      sql: `INSERT INTO validation_result (id, run_id, lineage_id, rule_version, variant,
              split_version, test, level, B, n, blocks, stat, p, mde, lower, upper, L_used, m_used,
              outcome, reachable_d)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      args: [
        r.id,
        r.run_id,
        r.lineage_id,
        r.rule_version,
        r.variant,
        r.split_version,
        r.test,
        r.level,
        r.B,
        r.n,
        r.blocks,
        finite(r.stat),
        finite(r.p),
        finite(r.mde),
        finite(r.lower),
        finite(r.upper),
        r.L_used,
        r.m_used,
        r.outcome,
        r.reachable_d,
      ],
    })),
    "write",
  );
}

async function loadTrialRows(
  db: Client,
  lineage: string,
  split: number,
): Promise<TrialLedgerRow[]> {
  const rs = await db.execute({
    sql: `SELECT id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d
          FROM trial_ledger WHERE lineage_id = ? AND split_version = ?`,
    args: [lineage, split],
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    market: String(r.market),
    lineage_id: String(r.lineage_id),
    split_version: Number(r.split_version),
    kind: String(r.kind) as TrialLedgerRow["kind"],
    rule_version: r.rule_version === null ? null : String(r.rule_version),
    variant: r.variant === null ? null : String(r.variant),
    run_id: r.run_id === null ? null : String(r.run_id),
    d: String(r.d),
  }));
}

/**
 * One evidence run for a challenger in `replay` (see the file header). Idempotent per (challenger,
 * run id, day): the trial row id is deterministic, so a repeat charges nothing again, the
 * validation_result rows are `ON CONFLICT DO NOTHING`, and the bootstraps are seeded.
 */
export async function runChallengerEvidence(db: Client, run: EvidenceRun): Promise<EvidenceReport> {
  const ch = await loadChallenger(db, run.challengerId);
  if (ch === null) throw new Error(`unknown challenger ${run.challengerId}`);
  if (ch.state !== "replay") return { outcome: "skipped", reason: "not_in_replay", charged: false };
  if (run.split.deferred_until_d !== null) {
    return { outcome: "skipped", reason: "split_deferred", charged: false };
  }

  const pre = evidenceSufficiency(run.size, run.stats);
  if (!pre.sufficient) {
    return { outcome: "insufficient", charged: false, reachableD: pre.reachableD, failed: [] };
  }

  const market = String(
    (
      await db.execute({
        sql: "SELECT market FROM rule_version WHERE id = ?",
        args: [ch.rule_version_id],
      })
    ).rows[0]!.market,
  );
  const access = trialLedgerRow({
    market,
    lineage_id: ch.lineage_id,
    split_version: run.split.version,
    kind: "validation_access",
    rule_version: ch.rule_version_id,
    variant: run.variant,
    run_id: run.runId,
    d: run.d,
  });
  // ARN-085: an access beyond the lineage's budget would void the level alpha / (m L); a repeat of
  // an access already charged (same id) is not a new charge and is let through.
  const before = await loadTrialRows(db, ch.lineage_id, run.split.version);
  if (
    !before.some((r) => r.id === access.id) &&
    trialBudget(
      before,
      ch.lineage_id,
      run.split.version,
      run.budgetTotal ?? run.stats.trialBudgetPerLineage,
    ).exhausted
  ) {
    return { outcome: "skipped", reason: "budget_exhausted", charged: false };
  }
  const ins = await db.execute({
    sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version,
            variant, run_id, d) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      access.id,
      access.market,
      access.lineage_id,
      access.split_version,
      access.kind,
      access.rule_version,
      access.variant,
      access.run_id,
      access.d,
    ],
  });
  const charged = ins.rowsAffected > 0;

  // only now are the validation rows read
  const data = await run.loadRows();
  const ledgerRows = await loadTrialRows(db, ch.lineage_id, run.split.version);
  const trials = trialCounts(ledgerRows, ch.lineage_id, run.split.version);
  // VAL-112 (D-226): k = validation and pattern tests spent on this split version BEFORE this access,
  // ordered by (d, id) so that a repeat of the same run gets the same level (a pure function of the
  // trial ledger).
  const priorTests = spentTestsBefore(ledgerRows, ch.lineage_id, run.split.version, access);
  const result = evaluateVal110({
    priorTests,
    runId: run.runId,
    lineageId: ch.lineage_id,
    ruleVersion: ch.rule_version_id,
    variant: run.variant,
    split: run.split,
    access,
    params: run.stats,
    activeLineages: run.activeLineages,
    rows: data.rows,
    sessionCount: run.size.sessionCount,
    block: run.size.block,
    windowEndD: run.size.windowEndD,
    trialsOnSplit: trials.total,
    challenger: { challengerRows: data.challengerRows, incumbentRows: data.incumbentRows },
    safety: data.safety,
    costInfeasible: data.costInfeasible,
    pboWeekly: data.pboWeekly,
    dsr: data.dsr,
    ...(run.masterSeed === undefined ? {} : { masterSeed: run.masterSeed }),
  });
  await writeResults(db, result.results);

  const cls = classifyEvidence(result);
  if (cls.outcome === "insufficient") {
    return {
      outcome: "insufficient",
      charged,
      reachableD: result.reachableD,
      failed: [],
    };
  }
  const resultIds = result.results.map((r) => r.id);
  const ref = {
    run_id: run.runId,
    trial_id: access.id,
    validation_result_ids: resultIds,
    checks: result.checks,
    failed: cls.failed,
    critique_run: run.runId,
  };
  await transitionChallenger(
    db,
    {
      id: run.challengerId,
      to: cls.outcome === "pass" ? "shakedown" : "rejected",
      d: run.d,
      actor: run.actor ?? "A6",
      reason:
        cls.outcome === "pass"
          ? "VAL-110 passed (i)-(vi) incl. (ii) vs the incumbent"
          : `VAL-110 failed: ${cls.failed.join(", ")}`,
      ref,
    },
    run.learning,
  );
  return { outcome: cls.outcome, charged, failed: cls.failed, resultIds };
}

/**
 * `proposed -> replay` once the first learning run has enough validation entries (entry-count
 * pre-check only; nothing is charged here, the access is charged by the evidence run).
 */
export async function advanceProposed(
  db: Client,
  args: {
    readonly challengerId: string;
    readonly d: string;
    readonly size: EvidenceSize;
    readonly stats: Pick<StatsParams, "minTrades" | "minBlocks">;
    readonly learning: Pick<LearningParams, "shakedownSessions">;
    readonly actor?: string;
  },
): Promise<{ readonly moved: boolean; readonly sufficiency: Sufficiency }> {
  const sufficiency = evidenceSufficiency(args.size, args.stats);
  const ch = await loadChallenger(db, args.challengerId);
  if (ch === null) throw new Error(`unknown challenger ${args.challengerId}`);
  if (ch.state !== "proposed" || !sufficiency.sufficient) return { moved: false, sufficiency };
  const r = await transitionChallenger(
    db,
    {
      id: args.challengerId,
      to: "replay",
      d: args.d,
      actor: args.actor ?? "A6",
      reason: "enough validation entries",
      ref: {
        entries: sufficiency.entries,
        union_entries: sufficiency.unionEntries,
        blocks: sufficiency.blocks,
      },
    },
    args.learning,
  );
  return { moved: r.changed, sufficiency };
}
