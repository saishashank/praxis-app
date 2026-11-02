// Lineage splits, deferral dates and the trial ledger (M4 design 4.8 items 1 and 10; ARN-082, ARN-085;
// decisions 23, 26). Pure and deterministic: no clock, no randomness. Outputs match migration 0008
// `lineage`, `lineage_split` and `trial_ledger`.
//
// Layout (all counts in sessions, positions in the lineage's session calendar, E = last session):
//   holdout    = [holdoutStart, holdoutEnd]   holdoutEnd = E - completion
//   validation = [valStart, valEnd]           valEnd = holdoutStart - 1 - purge
//   development = [0, devEnd]                 devEnd = valStart - 1 - purge
// Splits are defined by ENTRY dates (ARN-082); entries in a purge gap or after the holdout end
// (the completion window) belong to no split.
import type { StatsParams } from "../agents/params";
import { CONFIG_KEYS } from "../config/keys";
import { percentile } from "./bootstrap";
import { rolledTrialBudget } from "./gates";

export type LineageRecord = {
  readonly id: string;
  readonly created_d: string;
  readonly parent: string | null;
};

export type LineageSplitRecord = {
  readonly lineage_id: string;
  readonly version: number;
  readonly block_sessions: number;
  readonly holdout_len: number;
  readonly validation_len: number;
  readonly purge: number;
  readonly data_end_d: string;
  readonly holdout_start_d: string | null;
  readonly holdout_end_d: string | null;
  readonly validation_start_d: string | null;
  readonly validation_end_d: string | null;
  readonly dev_end_d: string | null;
  readonly deferred_until_d: string | null;
  readonly reason: "create" | "roll";
  readonly measured_on_run: string | null;
};

/** A stored `lineage_split` row (any driver's row object) as a record. */
export function splitFromRow(r: Readonly<Record<string, unknown>>): LineageSplitRecord {
  const opt = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    lineage_id: String(r.lineage_id),
    version: Number(r.version),
    block_sessions: Number(r.block_sessions),
    holdout_len: Number(r.holdout_len),
    validation_len: Number(r.validation_len),
    purge: Number(r.purge),
    data_end_d: String(r.data_end_d),
    holdout_start_d: opt(r.holdout_start_d),
    holdout_end_d: opt(r.holdout_end_d),
    validation_start_d: opt(r.validation_start_d),
    validation_end_d: opt(r.validation_end_d),
    dev_end_d: opt(r.dev_end_d),
    deferred_until_d: opt(r.deferred_until_d),
    reason: String(r.reason) as "create" | "roll",
    measured_on_run: opt(r.measured_on_run),
  };
}

export type SplitName = "development" | "validation" | "holdout" | "purge" | "completion";

/** Lineage id = `<market>:<family>` (ch.05 5.1, decision 23). */
export function lineageId(market: string, family: string): string {
  return `${market}:${family}`;
}

export function createLineage(
  market: string,
  family: string,
  createdD: string,
  parent: string | null = null,
): LineageRecord {
  return { id: lineageId(market, family), created_d: createdD, parent };
}

// ---- families' holding-period bounds (purge) ----

const FAMILY_MAX_HOLD_KEYS = {
  F1: "f1_max_hold",
  F2: "f2_time_stop",
  F3: "f3_time_exit",
  F4: "f4_time_exit",
  F5: "f5_time_stop",
  F6: "f6_time_stop",
} as const;

/**
 * Upper bound of the family's maximum-holding parameter from the registry range (ch.15 bounds):
 * F1 120, F2 90, F3 40, F4 20, F5 45, F6 40. Purge = this + purge_extra_sessions (140, 110, 60, 40, 65, 60).
 */
export function maxHoldingUpperBound(family: keyof typeof FAMILY_MAX_HOLD_KEYS): number {
  const def = CONFIG_KEYS[FAMILY_MAX_HOLD_KEYS[family]] as { range?: readonly [number, number] };
  if (def.range === undefined) throw new Error(`no range for ${family} holding bound`);
  return def.range[1];
}

export function purgeSessions(maxHoldingUpper: number, params: StatsParams): number {
  return maxHoldingUpper + params.purgeExtraSessions;
}

// ---- dates ----

/** Add `n` weekdays (Mon-Fri, no holiday calendar) to an ISO date: an ESTIMATE used for deferral dates. */
export function addWeekdays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    t.setUTCDate(t.getUTCDate() + 1);
    const wd = t.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return t.toISOString().slice(0, 10);
}

// ---- layout ----

export type Layout = {
  readonly holdoutStart: number;
  readonly holdoutEnd: number;
  readonly validationStart: number;
  readonly validationEnd: number;
  readonly devEnd: number;
  /** Development sessions available (devEnd + 1, may be <= 0). */
  readonly devSessions: number;
};

/** Position the three windows backwards from the data end. Indexes may be negative when history is short. */
export function layoutWindows(
  sessionCount: number,
  holdoutLen: number,
  validationLen: number,
  purge: number,
  completion: number,
): Layout {
  const E = sessionCount - 1;
  const holdoutEnd = E - completion;
  const holdoutStart = holdoutEnd - holdoutLen + 1;
  const validationEnd = holdoutStart - 1 - purge;
  const validationStart = validationEnd - validationLen + 1;
  const devEnd = validationStart - 1 - purge;
  return {
    holdoutStart,
    holdoutEnd,
    validationStart,
    validationEnd,
    devEnd,
    devSessions: devEnd + 1,
  };
}

/** Sessions of history needed before the split is possible. */
export function sessionsNeeded(
  devMin: number,
  holdoutLen: number,
  validationLen: number,
  purge: number,
  completion: number,
): number {
  return devMin + purge + validationLen + purge + holdoutLen + completion;
}

export type SplitCreateInput = {
  readonly market: string;
  readonly family: string;
  /** Ascending session dates up to the data end. */
  readonly calendar: readonly string[];
  /** Upper bound of the family's maximum-holding parameter, in sessions (see maxHoldingUpperBound). */
  readonly maxHoldingUpper: number;
  /** Realised rows of the v1 primary variant (entry and exit dates; exit null while open). */
  readonly primaryRows: readonly { readonly entryD: string; readonly exitD: string | null }[];
  readonly params: StatsParams;
  readonly version?: number;
  readonly reason?: "create" | "roll";
  readonly measuredOnRun?: string | null;
};

/** p75 (param) of realised holding sessions, floor `bootstrapBlockMinSessions`, measured on the data before the default layout. */
export function measureBlock(input: SplitCreateInput): number {
  const { calendar, params } = input;
  const purge = purgeSessions(input.maxHoldingUpper, params);
  const def = layoutWindows(
    calendar.length,
    params.splitHoldoutMinSessions,
    params.splitValidationMinSessions,
    purge,
    purge,
  );
  const cutoff = def.validationStart - purge; // entries strictly before this index
  const index = new Map<string, number>();
  calendar.forEach((d, i) => index.set(d, i));
  const holds: number[] = [];
  for (const r of input.primaryRows) {
    if (r.exitD === null) continue;
    const a = index.get(r.entryD);
    const b = index.get(r.exitD);
    if (a === undefined || b === undefined || a >= cutoff || b < a) continue;
    holds.push(b - a);
  }
  if (holds.length === 0) return params.bootstrapBlockMinSessions;
  return Math.max(
    params.bootstrapBlockMinSessions,
    percentile(holds, params.bootstrapBlockPercentile),
  );
}

/** Create (or roll) the versioned split record for a lineage; deferred when development < 252 sessions. */
export function createLineageSplit(input: SplitCreateInput): LineageSplitRecord {
  const { calendar, params } = input;
  if (calendar.length === 0) throw new RangeError("calendar is empty");
  const id = lineageId(input.market, input.family);
  const purge = purgeSessions(input.maxHoldingUpper, params);
  const completion = purge;
  const block = measureBlock(input);
  const holdoutLen = Math.max(params.splitHoldoutMinSessions, params.splitBlockMultiple * block);
  const validationLen = Math.max(
    params.splitValidationMinSessions,
    params.splitBlockMultiple * block,
  );
  const dataEnd = calendar[calendar.length - 1]!;
  const base = {
    lineage_id: id,
    version: input.version ?? 1,
    block_sessions: block,
    holdout_len: holdoutLen,
    validation_len: validationLen,
    purge,
    data_end_d: dataEnd,
    reason: input.reason ?? "create",
    measured_on_run: input.measuredOnRun ?? null,
  } as const;
  const lay = layoutWindows(calendar.length, holdoutLen, validationLen, purge, completion);
  if (lay.devSessions < params.splitDevelopmentMinSessions || lay.validationStart < 0) {
    const needed = sessionsNeeded(
      params.splitDevelopmentMinSessions,
      holdoutLen,
      validationLen,
      purge,
      completion,
    );
    return {
      ...base,
      holdout_start_d: null,
      holdout_end_d: null,
      validation_start_d: null,
      validation_end_d: null,
      dev_end_d: null,
      deferred_until_d: addWeekdays(dataEnd, needed - calendar.length),
    };
  }
  return {
    ...base,
    holdout_start_d: calendar[lay.holdoutStart]!,
    holdout_end_d: calendar[lay.holdoutEnd]!,
    validation_start_d: calendar[lay.validationStart]!,
    validation_end_d: calendar[lay.validationEnd]!,
    dev_end_d: calendar[lay.devEnd]!,
    deferred_until_d: null,
  };
}

export type SplitRollInput = {
  readonly market: string;
  readonly family: string;
  /** The lineage's latest split (its version + 1 is the new one). */
  readonly previous: Pick<LineageSplitRecord, "version">;
  /** Ascending session dates up to the data end (the actual calendar; later sessions are estimated). */
  readonly calendar: readonly string[];
  readonly maxHoldingUpper: number;
  /** Realised rows of the primary variant (entry and exit dates; exit null while open). */
  readonly primaryRows: readonly { readonly entryD: string; readonly exitD: string | null }[];
  readonly params: StatsParams;
  /**
   * The date after which the new holdout may start (ARN-082): the latest of the promoted version's
   * registration, the Owner's last view of its shadow results and the promotion date.
   */
  readonly anchorD: string;
  /** Idempotency marker stored on the new split (`promotion:<id>`). */
  readonly measuredOnRun: string;
};

/**
 * The split record at a roll caused by a promotion (ARN-082, M6 design 2.9; pure). The holdout
 * starts one purge of sessions after the anchor date and the validation window ends one purge before
 * it; development is everything earlier. Block and window lengths are re-measured exactly as at
 * creation (p-percentile of realised holds on the data before the validation window, floor, window
 * lengths from the block multiple). The holdout is usable once its length plus the completion window
 * has passed: sessions beyond the data end are weekday ESTIMATES (the known limit of `addWeekdays`,
 * as for deferral dates), so its dates are expected dates, not calendar facts.
 */
export function rollLineageSplit(input: SplitRollInput): LineageSplitRecord {
  const { calendar, params } = input;
  if (calendar.length === 0) throw new RangeError("calendar is empty");
  const purge = purgeSessions(input.maxHoldingUpper, params);
  const dataEnd = calendar[calendar.length - 1]!;
  // first session strictly after the anchor, then one purge of sessions
  let after = calendar.findIndex((d) => d > input.anchorD);
  if (after < 0) after = calendar.length;
  const holdoutStart = after + purge;

  const at = (i: number): string => {
    if (i < calendar.length) return calendar[i]!;
    return addWeekdays(dataEnd, i - (calendar.length - 1));
  };
  const layoutFrom = (holdoutLen: number, validationLen: number): Layout => {
    const holdoutEnd = holdoutStart + holdoutLen - 1;
    const validationEnd = holdoutStart - 1 - purge;
    const validationStart = validationEnd - validationLen + 1;
    const devEnd = validationStart - 1 - purge;
    return {
      holdoutStart,
      holdoutEnd,
      validationStart,
      validationEnd,
      devEnd,
      devSessions: devEnd + 1,
    };
  };

  // block: measured on the entries before the validation window of the default-length layout
  const def = layoutFrom(params.splitHoldoutMinSessions, params.splitValidationMinSessions);
  const cutoff = def.validationStart - purge;
  const index = new Map<string, number>();
  calendar.forEach((d, i) => index.set(d, i));
  const holds: number[] = [];
  for (const r of input.primaryRows) {
    if (r.exitD === null) continue;
    const a = index.get(r.entryD);
    const b = index.get(r.exitD);
    if (a === undefined || b === undefined || a >= cutoff || b < a) continue;
    holds.push(b - a);
  }
  const block =
    holds.length === 0
      ? params.bootstrapBlockMinSessions
      : Math.max(
          params.bootstrapBlockMinSessions,
          percentile(holds, params.bootstrapBlockPercentile),
        );
  const holdoutLen = Math.max(params.splitHoldoutMinSessions, params.splitBlockMultiple * block);
  const validationLen = Math.max(
    params.splitValidationMinSessions,
    params.splitBlockMultiple * block,
  );
  const lay = layoutFrom(holdoutLen, validationLen);
  const base = {
    lineage_id: lineageId(input.market, input.family),
    version: input.previous.version + 1,
    block_sessions: block,
    holdout_len: holdoutLen,
    validation_len: validationLen,
    purge,
    data_end_d: dataEnd,
    reason: "roll",
    measured_on_run: input.measuredOnRun,
  } as const;
  if (lay.devSessions < params.splitDevelopmentMinSessions || lay.validationStart < 0) {
    const short = params.splitDevelopmentMinSessions - Math.max(0, lay.devSessions);
    return {
      ...base,
      holdout_start_d: null,
      holdout_end_d: null,
      validation_start_d: null,
      validation_end_d: null,
      dev_end_d: null,
      deferred_until_d: addWeekdays(dataEnd, short),
    };
  }
  return {
    ...base,
    holdout_start_d: at(lay.holdoutStart),
    holdout_end_d: at(lay.holdoutEnd),
    validation_start_d: calendar[lay.validationStart]!,
    validation_end_d: calendar[lay.validationEnd]!,
    dev_end_d: calendar[lay.devEnd]!,
    deferred_until_d: null,
  };
}

/** Which split an entry date falls in (by entry date, ARN-082); null while the split is deferred. */
export function splitOf(split: LineageSplitRecord, entryD: string): SplitName | null {
  if (split.deferred_until_d !== null) return null;
  if (entryD <= split.dev_end_d!) return "development";
  if (entryD < split.validation_start_d!) return "purge";
  if (entryD <= split.validation_end_d!) return "validation";
  if (entryD < split.holdout_start_d!) return "purge";
  if (entryD <= split.holdout_end_d!) return "holdout";
  return "completion";
}

/** Sessions of the calendar inside the validation window of a split (none when deferred). */
export function validationSessions(
  split: LineageSplitRecord,
  calendar: readonly string[],
): readonly string[] {
  if (split.deferred_until_d !== null) return [];
  return calendar.filter((d) => d >= split.validation_start_d! && d <= split.validation_end_d!);
}

// ---- trial ledger ----

export type TrialKind =
  "validation_access" | "holdout_access" | "pattern_test" | "challenger" | "new_lineage";

export type TrialLedgerRow = {
  readonly id: string;
  readonly market: string;
  readonly lineage_id: string;
  readonly split_version: number;
  readonly kind: TrialKind;
  readonly rule_version: string | null;
  readonly variant: string | null;
  readonly run_id: string | null;
  readonly d: string;
};

export type TrialInput = Omit<TrialLedgerRow, "id">;

/**
 * Deterministic id from the row's own fields, so a re-run inserts the same row (ON CONFLICT DO
 * NOTHING): one access per (lineage, split, kind, rule version, variant, run, day).
 */
export function trialLedgerRow(input: TrialInput): TrialLedgerRow {
  const part = (v: string | null): string => (v === null ? "-" : v);
  const id = `trial:${input.lineage_id}:${input.split_version}:${input.kind}:${part(
    input.rule_version,
  )}:${part(input.variant)}:${part(input.run_id)}:${input.d}`;
  return { id, ...input };
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Idempotent append: a row with the same id is not added twice; order = id ascending. */
export function appendTrial(
  ledger: readonly TrialLedgerRow[],
  row: TrialLedgerRow,
): readonly TrialLedgerRow[] {
  if (ledger.some((r) => r.id === row.id)) return ledger;
  return [...ledger, row].sort((a, b) => cmp(a.id, b.id));
}

export type TrialCounts = {
  readonly total: number;
  readonly validationAccesses: number;
  readonly holdoutAccesses: number;
  readonly byKind: Readonly<Record<TrialKind, number>>;
};

/**
 * VAL-112 (D-283): k, the validation_access + pattern_test rows spent on one split version of a
 * lineage. With `access`, only those strictly before it in (d, id) order (so a repeat of the same
 * run gets the same level); without, all of them. The one count behind every level.
 */
export function spentTestsBefore(
  ledger: readonly Pick<TrialLedgerRow, "id" | "d" | "lineage_id" | "split_version" | "kind">[],
  lineage: string,
  splitVersion: number,
  access?: Pick<TrialLedgerRow, "id" | "d">,
): number {
  return ledger.filter(
    (r) =>
      r.lineage_id === lineage &&
      r.split_version === splitVersion &&
      (r.kind === "validation_access" || r.kind === "pattern_test") &&
      (access === undefined || r.d < access.d || (r.d === access.d && r.id < access.id)),
  ).length;
}

/** Trials charged to a lineage on one split version (ARN-085: every kind counts toward the budget). */
export function trialCounts(
  ledger: readonly TrialLedgerRow[],
  lineage: string,
  splitVersion: number,
): TrialCounts {
  const byKind: Record<TrialKind, number> = {
    validation_access: 0,
    holdout_access: 0,
    pattern_test: 0,
    challenger: 0,
    new_lineage: 0,
  };
  for (const r of ledger) {
    if (r.lineage_id === lineage && r.split_version === splitVersion) byKind[r.kind] += 1;
  }
  const total =
    byKind.validation_access +
    byKind.holdout_access +
    byKind.pattern_test +
    byKind.challenger +
    byKind.new_lineage;
  return {
    total,
    validationAccesses: byKind.validation_access,
    holdoutAccesses: byKind.holdout_access,
    byKind,
  };
}

export type TrialBudget = {
  readonly total: number;
  readonly used: number;
  readonly remaining: number;
  readonly exhausted: boolean;
};

/**
 * Cumulative budget on a frozen split: remaining = total - used. `total` is m on a first split and
 * the rolled budget (rolledBudgetAtRoll) after a roll.
 */
export function trialBudget(
  ledger: readonly TrialLedgerRow[],
  lineage: string,
  splitVersion: number,
  total: number,
): TrialBudget {
  const used = trialCounts(ledger, lineage, splitVersion).total;
  const remaining = Math.max(0, total - used);
  return { total, used, remaining, exhausted: remaining === 0 };
}

/** Sessions shared by two splits' validation windows. */
export function sharedValidationSessions(
  oldSplit: LineageSplitRecord,
  newSplit: LineageSplitRecord,
  calendar: readonly string[],
): number {
  const a = new Set(validationSessions(oldSplit, calendar));
  return validationSessions(newSplit, calendar).filter((d) => a.has(d)).length;
}

/**
 * New budget at a roll (decision 26): m - ceil(accessesOld x overlap); accessesOld = validation +
 * holdout accesses on the old split; overlap = shared validation sessions / new validation sessions.
 */
export function rolledBudgetAtRoll(
  ledger: readonly TrialLedgerRow[],
  oldSplit: LineageSplitRecord,
  newSplit: LineageSplitRecord,
  calendar: readonly string[],
  m: number,
): number {
  const c = trialCounts(ledger, oldSplit.lineage_id, oldSplit.version);
  const newSessions = validationSessions(newSplit, calendar).length;
  if (newSessions === 0) return m;
  return rolledTrialBudget(
    m,
    c.validationAccesses + c.holdoutAccesses,
    sharedValidationSessions(oldSplit, newSplit, calendar),
    newSessions,
  );
}

/** The holdout is used once per rule version (ARN-082). */
export function holdoutUsed(
  ledger: readonly TrialLedgerRow[],
  lineage: string,
  splitVersion: number,
  ruleVersion: string,
): boolean {
  return ledger.some(
    (r) =>
      r.kind === "holdout_access" &&
      r.lineage_id === lineage &&
      r.split_version === splitVersion &&
      r.rule_version === ruleVersion,
  );
}
