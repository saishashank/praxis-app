// Executions, cohorts, restart groups, controls (spec 05 ARN-001..004, ARN-053, section 5.1; M3
// design 3 and 4.2 step 6; D-069; T9 proposals D-076). Pure: no database, no clock, no
// Math.random. cohortWriter.ts is the DB side.
//
//   REGISTRY   E01..E12 = 6 families x {U, L} (ARN-002), C1 (broad-index ETF buy-and-hold), C2-F1..F6
//              (matched random-entry controls, no sleeve) and C3-F1..F6 (the same entries with a
//              sleeve). Rows are deterministic: the same call gives the same bytes.
//   GROUPS     `twin_group` is the RESTART group. E(2k-1), E(2k), C2-Fk and C3-Fk share `TW-Fk`;
//              C1 stands alone as `TW-C1`. A group restarts together (ARN-053).
//   SLOTS      one live cohort per slot: an E execution or C1 has one slot; C2-Fk and C3-Fk have
//              `c2_live_per_family` slots each (control_idx 1..20).
//   COHORT     seed = A$600, resolved parameters (copy + SHA-256 hash) in params_json, the seed
//              cash txn dated at the start session, an integer RNG seed derived from the master
//              seed and the cohort id (controls draw their random codes from it in M4).
//   RESTART    a live cohort of a group reaches a terminal close D: its positions and sleeve are
//              liquidated at D+1's open; every cohort of the group restarts at the open after
//              that (D+2). Cohorts of the group that are unfinished go to SHADOW (live = 0) and
//              run on to their own terminal state with no live effect; each finished one is
//              replaced. A terminal state of a shadow cohort restarts nothing.
// C2/C3 entry SELECTION (random eligible codes) needs family entries and is M4; the exit mapping
// is here (ARN-004, TST-101).
import { createHash } from "node:crypto";
import { C1_ETF_PLACEHOLDER } from "@/lib/config/keys";
import { nextTradingDay, type CalendarRow } from "@/lib/data/calendar";
import { type Micro } from "@/lib/money/micro";
import { makeRational, mulRat, parseRational, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { COST_PROFILES, type CostProfileCode } from "./costs";
import { seedTxn, type LedgerTxn, type SettlementMode } from "./ledger";
import type { ExecutionKind, ExecutionRow, RecoveryMode, TerminalKind, Variant } from "./schema";
import {
  DEFAULT_CASH_BUFFER,
  DEFAULT_PARTICIPATION_CAP,
  MIN_MARKETABLE_PARCEL_MICRO,
  stallFloorMicro,
} from "./sizing";
import { DEFAULT_TICK_CROSS_FACTOR } from "./slippage";
import { defaultSleeveConfig, type SleeveConfig } from "./sleeve";
import {
  DEFAULT_BUST_FRACTION,
  DEFAULT_STALL_PARCEL_REJECTIONS,
  DEFAULT_STALL_SESSIONS,
  DEFAULT_TARGET_MULTIPLE,
  DEFAULT_TIMEOUT_SESSIONS,
  assertTerminalParams,
  restartSession,
  type TerminalParams,
} from "./terminal";

// ---- constants -----------------------------------------------------------------------------------------------

export const ARENA_MARKET = "AU";
/** ARN-001: the AU market seed A$600 (Owner O-25). */
export const SEED_MICRO: Micro = 600_000_000n;
export const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"] as const;
export type FamilyId = (typeof FAMILIES)[number];
/** ARN-004 / ch.15 `c2_live_per_family`: 20 live C2 (and C3) portfolios per family. */
export const DEFAULT_CONTROLS_PER_FAMILY = 20;
export const DEFAULT_RULE_VERSION = "v1";
export const DEFAULT_MAX_OPEN_POSITIONS = 2;

/**
 * ARN-004 C1: "S&P/ASX 200 ETF [VERIFY code]". The code is an Owner item (D-069 decision 20); this
 * placeholder is NOT a ticker. A cohort of C1 refuses to place an order while the config key
 * `c1_etf_code` still holds it (c1EtfStatus).
 */
export { C1_ETF_PLACEHOLDER };
export const C1_ETF_CONFIG_KEY = "c1_etf_code";

export type C1EtfStatus = {
  readonly code: string;
  /** False until the Owner has set a real code (ARN-004 [VERIFY code]). */
  readonly verified: boolean;
  readonly flag: string;
};

export function c1EtfStatus(code: string): C1EtfStatus {
  const placeholder = code === C1_ETF_PLACEHOLDER;
  return {
    code,
    verified: !placeholder,
    flag: placeholder
      ? "[VERIFY] C1 index ETF code not set by the Owner (ARN-004); C1 places no orders"
      : "[VERIFY] C1 index ETF code set; Owner to confirm it is the S&P/ASX 200 ETF",
  };
}

// ---- the execution registry --------------------------------------------------------------------------------

export type RegistryOptions = {
  readonly market?: string;
  readonly ruleVersion?: string;
  readonly costProfile?: CostProfileCode;
};

export function twinGroupOf(family: FamilyId): string {
  return `TW-${family}`;
}
export const C1_GROUP = "TW-C1";

function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** ARN-002: E01/E02 F1 ... E11/E12 F6 (odd = unlevered U, even = leverage-sleeve L). */
export function buildExecutionRegistry(options: RegistryOptions = {}): ExecutionRow[] {
  const market = options.market ?? ARENA_MARKET;
  const ruleVersion = options.ruleVersion ?? DEFAULT_RULE_VERSION;
  const costProfile = options.costProfile ?? "P5";
  const row = (
    id: string,
    kind: ExecutionKind,
    family: FamilyId | null,
    variant: Variant | null,
    twinGroup: string,
  ): ExecutionRow => ({
    id,
    market,
    kind,
    family,
    variant,
    twin_group: twinGroup,
    rule_version: ruleVersion,
    cost_profile: costProfile,
    status: "active",
  });
  const rows: ExecutionRow[] = [];
  FAMILIES.forEach((family, i) => {
    rows.push(row(`E${two(2 * i + 1)}`, "E", family, "U", twinGroupOf(family)));
    rows.push(row(`E${two(2 * i + 2)}`, "E", family, "L", twinGroupOf(family)));
  });
  rows.push(row("C1", "C1", null, "U", C1_GROUP));
  for (const family of FAMILIES)
    rows.push(row(`C2-${family}`, "C2", family, "U", twinGroupOf(family)));
  for (const family of FAMILIES)
    rows.push(row(`C3-${family}`, "C3", family, "L", twinGroupOf(family)));
  return rows;
}

/** True for executions that carry a leverage sleeve: the L twins and every C3 control. */
export function carriesSleeve(execution: Pick<ExecutionRow, "kind" | "variant">): boolean {
  return execution.kind === "C3" || (execution.kind === "E" && execution.variant === "L");
}

export type CohortSlot = {
  readonly executionId: string;
  /** 1..n for C2 / C3, null for E and C1. */
  readonly controlIdx: number | null;
};

/** Every slot of the registry, in registry order then control index. */
export function cohortSlots(
  registry: readonly ExecutionRow[],
  controlsPerFamily: number = DEFAULT_CONTROLS_PER_FAMILY,
): CohortSlot[] {
  if (!Number.isSafeInteger(controlsPerFamily) || controlsPerFamily < 1) {
    throw new RangeError("controls per family must be a positive whole number");
  }
  const slots: CohortSlot[] = [];
  for (const e of registry) {
    if (e.kind === "C2" || e.kind === "C3") {
      for (let i = 1; i <= controlsPerFamily; i++) slots.push({ executionId: e.id, controlIdx: i });
    } else {
      slots.push({ executionId: e.id, controlIdx: null });
    }
  }
  return slots;
}

export function cohortIdFor(
  executionId: string,
  controlIdx: number | null,
  startD: string,
): string {
  const slot = controlIdx === null ? executionId : `${executionId}#${two(controlIdx)}`;
  return `${slot}@${startD}`;
}

// ---- resolved parameters (params_json) ---------------------------------------------------------------------

export type CohortParams = {
  readonly market: string;
  readonly seedMicro: Micro;
  readonly terminal: TerminalParams;
  readonly costProfile: CostProfileCode;
  readonly settlementMode: SettlementMode;
  readonly minParcelMicro: Micro;
  readonly participationCap: Rational;
  readonly cashBuffer: Rational;
  readonly tickCrossFactor: Rational;
  readonly maxOpenPositions: number;
  /** C1 only: the ETF code (placeholder until the Owner sets it). */
  readonly c1EtfCode: string;
};

export type ParamOverrides = Partial<Omit<CohortParams, "terminal">> & {
  readonly terminal?: Partial<TerminalParams>;
};

/** Resolve the parameters of a new cohort from the defaults and the injected (config) values. */
export function resolveCohortParams(overrides: ParamOverrides = {}): CohortParams {
  const costProfile = overrides.costProfile ?? "P5";
  const seedMicro = overrides.seedMicro ?? SEED_MICRO;
  const cashBuffer = overrides.cashBuffer ?? DEFAULT_CASH_BUFFER;
  const minParcelMicro = overrides.minParcelMicro ?? MIN_MARKETABLE_PARCEL_MICRO;
  const t = overrides.terminal ?? {};
  const terminal: TerminalParams = {
    seedMicro,
    targetMultiple: t.targetMultiple ?? DEFAULT_TARGET_MULTIPLE,
    bustFraction: t.bustFraction ?? DEFAULT_BUST_FRACTION,
    stallFloorMicro:
      t.stallFloorMicro ??
      stallFloorMicro({
        profile: COST_PROFILES[costProfile],
        parcelMicro: minParcelMicro,
        cashBuffer,
      }),
    stallSessions: t.stallSessions ?? DEFAULT_STALL_SESSIONS,
    stallParcelRejections: t.stallParcelRejections ?? DEFAULT_STALL_PARCEL_REJECTIONS,
    timeoutSessions: t.timeoutSessions ?? DEFAULT_TIMEOUT_SESSIONS,
  };
  assertTerminalParams(terminal);
  return {
    market: overrides.market ?? ARENA_MARKET,
    seedMicro,
    terminal,
    costProfile,
    settlementMode: overrides.settlementMode ?? "matched",
    minParcelMicro,
    participationCap: overrides.participationCap ?? DEFAULT_PARTICIPATION_CAP,
    cashBuffer,
    tickCrossFactor: overrides.tickCrossFactor ?? DEFAULT_TICK_CROSS_FACTOR,
    maxOpenPositions: overrides.maxOpenPositions ?? DEFAULT_MAX_OPEN_POSITIONS,
    c1EtfCode: overrides.c1EtfCode ?? C1_ETF_PLACEHOLDER,
  };
}

const ratText = (r: Rational): string => `${r.num}/${r.den}`;
function ratFromText(text: string): Rational {
  const parts = text.split("/");
  if (parts.length !== 2) throw new TypeError(`bad rational text: ${text}`);
  return makeRational(BigInt(parts[0]), BigInt(parts[1]));
}

/** Key-sorted JSON so the same value always gives the same bytes (and the same hash). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function paramsBody(p: CohortParams): Record<string, unknown> {
  return {
    market: p.market,
    seed_micro: p.seedMicro.toString(),
    cost_profile: p.costProfile,
    settlement_mode: p.settlementMode,
    min_parcel_micro: p.minParcelMicro.toString(),
    participation_cap: ratText(p.participationCap),
    cash_buffer: ratText(p.cashBuffer),
    tick_cross_factor: ratText(p.tickCrossFactor),
    max_open_positions: p.maxOpenPositions,
    c1_etf_code: p.c1EtfCode,
    terminal: {
      target_multiple: ratText(p.terminal.targetMultiple),
      bust_fraction: ratText(p.terminal.bustFraction),
      stall_floor_micro: p.terminal.stallFloorMicro.toString(),
      stall_sessions: p.terminal.stallSessions,
      stall_parcel_rejections: p.terminal.stallParcelRejections,
      timeout_sessions: p.terminal.timeoutSessions,
    },
  };
}

/** `params_json`: `{"hash": sha256 of the canonical params text, "params": {...}}` (ARN-102). */
export function paramsJson(p: CohortParams): string {
  const body = paramsBody(p);
  return canonicalJson({ hash: sha256Hex(canonicalJson(body)), params: body });
}

export function parseCohortParams(text: string): CohortParams {
  const parsed = JSON.parse(text) as { hash: string; params: Record<string, unknown> };
  if (parsed.hash !== sha256Hex(canonicalJson(parsed.params))) {
    throw new RangeError("params_json hash does not match its parameters");
  }
  const b = parsed.params as {
    market: string;
    seed_micro: string;
    cost_profile: CostProfileCode;
    settlement_mode: SettlementMode;
    min_parcel_micro: string;
    participation_cap: string;
    cash_buffer: string;
    tick_cross_factor: string;
    max_open_positions: number;
    c1_etf_code: string;
    terminal: {
      target_multiple: string;
      bust_fraction: string;
      stall_floor_micro: string;
      stall_sessions: number;
      stall_parcel_rejections: number;
      timeout_sessions: number;
    };
  };
  const seedMicro = BigInt(b.seed_micro);
  return {
    market: b.market,
    seedMicro,
    costProfile: b.cost_profile,
    settlementMode: b.settlement_mode,
    minParcelMicro: BigInt(b.min_parcel_micro),
    participationCap: ratFromText(b.participation_cap),
    cashBuffer: ratFromText(b.cash_buffer),
    tickCrossFactor: ratFromText(b.tick_cross_factor),
    maxOpenPositions: b.max_open_positions,
    c1EtfCode: b.c1_etf_code,
    terminal: {
      seedMicro,
      targetMultiple: ratFromText(b.terminal.target_multiple),
      bustFraction: ratFromText(b.terminal.bust_fraction),
      stallFloorMicro: BigInt(b.terminal.stall_floor_micro),
      stallSessions: b.terminal.stall_sessions,
      stallParcelRejections: b.terminal.stall_parcel_rejections,
      timeoutSessions: b.terminal.timeout_sessions,
    },
  };
}

/** `sleeve_json` for an execution that carries a sleeve, else null. */
export function sleeveJsonFor(
  execution: Pick<ExecutionRow, "kind" | "variant">,
  cfg: SleeveConfig,
): string | null {
  if (!carriesSleeve(execution)) return null;
  return canonicalJson({
    leverage: cfg.leverage.toString(),
    margin_cap_micro: cfg.marginCapMicro.toString(),
    margin_nav_fraction: ratText(cfg.marginNavFraction),
    closeout_fraction: ratText(cfg.closeoutFraction),
    financing_rate: ratText(cfg.financingRate),
    financing_basis: cfg.financingBasis.toString(),
    recovery_mode: cfg.recoveryMode as RecoveryMode,
    rec4_sessions: cfg.rec4Sessions,
    profile: cfg.profile.code,
  });
}

// ---- seeded integer PRNG (no Math.random, no clock) ----------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

/** One SplitMix64 step: the next state and the 64-bit output. */
export function splitmix64(state: bigint): { readonly state: bigint; readonly value: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return { state: next, value: (z ^ (z >> 31n)) & MASK64 };
}

/**
 * The `rng_seed` of a cohort: FNV-1a (64 bit) of the cohort id mixed with the master seed through
 * SplitMix64, kept to 62 bits so it fits a signed INTEGER column. Never zero.
 */
export function deriveRngSeed(masterSeed: bigint, cohortId: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(cohortId)) {
    h = ((h ^ BigInt(byte)) * 0x100000001b3n) & MASK64;
  }
  const mixed = splitmix64((h ^ BigInt.asUintN(64, masterSeed)) & MASK64).value;
  const seed = mixed & ((1n << 62n) - 1n);
  return seed === 0n ? 1n : seed;
}

export type Prng = {
  /** Next 64-bit unsigned output. */
  readonly nextU64: () => bigint;
  /** Uniform integer in [0, n), no modulo bias. */
  readonly below: (n: bigint) => bigint;
};

export function createPrng(seed: bigint): Prng {
  let state = BigInt.asUintN(64, seed);
  const nextU64 = (): bigint => {
    const step = splitmix64(state);
    state = step.state;
    return step.value;
  };
  const below = (n: bigint): bigint => {
    if (n <= 0n) throw new RangeError("bound must be positive");
    const space = MASK64 + 1n;
    const limit = space - (space % n);
    for (;;) {
      const v = nextU64();
      if (v < limit) return v % n;
    }
  };
  return { nextU64, below };
}

// ---- starting a cohort ------------------------------------------------------------------------------------------

export type CohortStart = {
  readonly id: string;
  readonly executionId: string;
  readonly kind: ExecutionKind;
  readonly family: string | null;
  readonly controlIdx: number | null;
  /** The first session of the cohort: orders decided the session before fill at its open. */
  readonly startD: string;
  readonly seedMicro: Micro;
  readonly ruleVersion: string;
  readonly paramsJson: string;
  readonly costProfileVersion: number;
  readonly sleeveJson: string | null;
  readonly dataSnapshotId: string | null;
  readonly rngSeed: bigint;
  readonly twinGroup: string | null;
  readonly restartOf: string | null;
  /** The seed cash transaction (ARN-001), dated at the start session. */
  readonly seedTxn: LedgerTxn;
};

export type StartInput = {
  readonly execution: ExecutionRow;
  readonly controlIdx: number | null;
  readonly startD: string;
  readonly params: CohortParams;
  readonly masterSeed: bigint;
  readonly dataSnapshotId?: string | null;
  readonly restartOf?: string | null;
};

export function planCohortStart(input: StartInput): CohortStart {
  const { execution, params } = input;
  const slotted = execution.kind === "C2" || execution.kind === "C3";
  if (slotted !== (input.controlIdx !== null)) {
    throw new RangeError(`${execution.id}: control index is for C2 and C3 only`);
  }
  if (
    input.controlIdx !== null &&
    (!Number.isSafeInteger(input.controlIdx) || input.controlIdx < 1)
  ) {
    throw new RangeError("control index must be a positive whole number");
  }
  const profile = COST_PROFILES[params.costProfile];
  const id = cohortIdFor(execution.id, input.controlIdx, input.startD);
  return {
    id,
    executionId: execution.id,
    kind: execution.kind,
    family: execution.family,
    controlIdx: input.controlIdx,
    startD: input.startD,
    seedMicro: params.seedMicro,
    ruleVersion: execution.rule_version,
    paramsJson: paramsJson(params),
    costProfileVersion: profile.version,
    sleeveJson: sleeveJsonFor(execution, defaultSleeveConfig(profile)),
    dataSnapshotId: input.dataSnapshotId ?? null,
    rngSeed: deriveRngSeed(input.masterSeed, id),
    twinGroup: execution.twin_group,
    restartOf: input.restartOf ?? null,
    seedTxn: seedTxn(input.startD, params.seedMicro),
  };
}

/** AT-11: every execution and control starts a cohort with A$600 on the same session. */
export function planInitialStart(input: {
  readonly registry: readonly ExecutionRow[];
  readonly startD: string;
  readonly paramsFor: (execution: ExecutionRow) => CohortParams;
  readonly masterSeed: bigint;
  readonly controlsPerFamily?: number;
  readonly dataSnapshotId?: string | null;
}): CohortStart[] {
  const byId = new Map(input.registry.map((e) => [e.id, e]));
  return cohortSlots(input.registry, input.controlsPerFamily).map((slot) => {
    const execution = byId.get(slot.executionId) as ExecutionRow;
    return planCohortStart({
      execution,
      controlIdx: slot.controlIdx,
      startD: input.startD,
      params: input.paramsFor(execution),
      masterSeed: input.masterSeed,
      dataSnapshotId: input.dataSnapshotId,
    });
  });
}

// ---- group restart (ARN-053) --------------------------------------------------------------------------------------

/** The live cohort of one slot, as the restart planner needs it. */
export type SlotCohort = {
  readonly id: string;
  readonly executionId: string;
  readonly controlIdx: number | null;
  readonly startD: string;
  readonly terminalKind: TerminalKind | null;
  /** Liquidation NAV at the terminal close (nav_daily), recorded on a shadow flip; null if unknown. */
  readonly liqNavMicro: Micro | null;
};

export type ShadowPlan = {
  readonly cohortId: string;
  readonly newCohortId: string;
  /** What the live cohort would have realised: its liquidation NAV at the terminal close. */
  readonly liveLiquidationNavMicro: Micro | null;
};
export type EndedPlan = { readonly cohortId: string; readonly newCohortId: string };

export type GroupRestartPlan = {
  readonly group: string;
  readonly triggerCohortId: string;
  /** The close at which the trigger resolved. */
  readonly closeD: string;
  /** The session whose open liquidates the group. */
  readonly liquidationD: string;
  /** The session at whose open every successor cohort starts, together. */
  readonly restartD: string;
  /** Live and unfinished: flip to shadow and run on to their own terminal state. */
  readonly shadow: readonly ShadowPlan[];
  /** Live and already resolved: replaced by their successor. */
  readonly ended: readonly EndedPlan[];
  readonly starts: readonly CohortStart[];
};

/**
 * Plan the joint restart of a group after a LIVE cohort resolved at close `closeD` (ARN-053).
 * `live` are ALL the live cohorts of the group (one per slot). Deterministic: ordered by
 * execution id then control index.
 */
export function planGroupRestart(input: {
  readonly group: string;
  readonly triggerCohortId: string;
  readonly closeD: string;
  readonly calendar: readonly CalendarRow[];
  readonly live: readonly SlotCohort[];
  readonly executionFor: (executionId: string) => ExecutionRow;
  readonly paramsFor: (execution: ExecutionRow) => CohortParams;
  readonly masterSeed: bigint;
  readonly dataSnapshotId?: string | null;
}): GroupRestartPlan {
  const trigger = input.live.find((c) => c.id === input.triggerCohortId);
  if (trigger === undefined) throw new RangeError("the trigger is not a live cohort of the group");
  if (trigger.terminalKind === null) throw new RangeError("the trigger has no terminal state");
  const seen = new Set<string>();
  const ordered = [...input.live].sort(
    (a, b) =>
      (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0) ||
      (a.controlIdx ?? 0) - (b.controlIdx ?? 0),
  );
  const restartD = restartSession(input.closeD, input.calendar);
  const shadow: ShadowPlan[] = [];
  const ended: EndedPlan[] = [];
  const starts: CohortStart[] = [];
  for (const cohort of ordered) {
    const slotKey = `${cohort.executionId}#${cohort.controlIdx ?? 0}`;
    if (seen.has(slotKey)) throw new RangeError(`two live cohorts in slot ${slotKey}`);
    seen.add(slotKey);
    const execution = input.executionFor(cohort.executionId);
    if (execution.twin_group !== input.group) {
      throw new RangeError(`${execution.id} is not in group ${input.group}`);
    }
    const start = planCohortStart({
      execution,
      controlIdx: cohort.controlIdx,
      startD: restartD,
      params: input.paramsFor(execution),
      masterSeed: input.masterSeed,
      dataSnapshotId: input.dataSnapshotId,
      restartOf: cohort.id,
    });
    starts.push(start);
    if (cohort.terminalKind === null) {
      shadow.push({
        cohortId: cohort.id,
        newCohortId: start.id,
        liveLiquidationNavMicro: cohort.liqNavMicro,
      });
    } else {
      ended.push({ cohortId: cohort.id, newCohortId: start.id });
    }
  }
  return {
    group: input.group,
    triggerCohortId: input.triggerCohortId,
    closeD: input.closeD,
    liquidationD: nextTradingDay(input.closeD, input.calendar),
    restartD,
    shadow,
    ended,
    starts,
  };
}

// ---- effective N (ARN-053), the stored fields only ---------------------------------------------------------------

/** The fields effective-N reporting (M4) reads from `cohort`; all are stored by M3. */
export type EffectiveNCohort = {
  readonly id: string;
  readonly executionId: string;
  readonly startD: string;
  readonly terminalD: string | null;
  readonly terminalKind: TerminalKind | null;
};

/**
 * ARN-053: the number of RESOLVED cohorts that do not overlap in time with an already counted
 * cohort, greedy in start order (ties by id) over the actual outcome intervals [start, terminal
 * close]. Computed per execution; a live cohort that overlaps its own twin's shadow cohort may not
 * count. Unresolved cohorts are never counted (and never block a later one: they are censored).
 */
export function effectiveN(cohorts: readonly EffectiveNCohort[]): {
  readonly n: number;
  readonly counted: readonly string[];
} {
  const resolved = cohorts
    .filter((c) => c.terminalKind !== null && c.terminalD !== null)
    .sort((a, b) =>
      a.startD !== b.startD
        ? a.startD < b.startD
          ? -1
          : 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
  const counted: string[] = [];
  let lastEnd: string | null = null;
  for (const c of resolved) {
    if (lastEnd !== null && c.startD <= lastEnd) continue;
    counted.push(c.id);
    lastEnd = c.terminalD;
  }
  return { n: counted.length, counted };
}

export function effectiveNByExecution(
  cohorts: readonly EffectiveNCohort[],
): ReadonlyMap<string, { readonly n: number; readonly counted: readonly string[] }> {
  const groups = new Map<string, EffectiveNCohort[]>();
  for (const c of cohorts) groups.set(c.executionId, [...(groups.get(c.executionId) ?? []), c]);
  const out = new Map<string, { n: number; counted: readonly string[] }>();
  for (const id of [...groups.keys()].sort()) out.set(id, effectiveN(groups.get(id) ?? []));
  return out;
}

// ---- C2 exit mapping in ATR units (ARN-004, TST-101) -----------------------------------------------------------

/**
 * What kind of exit a family rule is, for the matched random-entry control (ARN-004):
 *   entry_atr        entry minus k x ATR: already relative to the entry, applies unchanged
 *   event_anchored   a price level anchored on the event (event-day low, F2 close below the event
 *                    low): the SAME distance in ATR(20) units from the control's own entry session
 *   indicator / time unchanged
 *   event_dependent  cannot be mapped (thesis-breakers, a polarity event, F6 "earliest exit of any
 *                    contributing family"): replaced by the family's time stop
 */
export type ExitRuleKind =
  "entry_atr" | "event_anchored" | "indicator" | "time" | "event_dependent";

export type FamilyExitRule = {
  readonly id: string;
  readonly kind: ExitRuleKind;
  /** `close` rules fire on a close (CS), `intraday` rules are stop levels (IS). */
  readonly trigger: "intraday" | "close" | "n/a";
  readonly label: string;
};

/** The family's time stop in sessions (spec 07 section 7.4), used for unmappable exits. */
export const FAMILY_TIME_STOP_SESSIONS: Readonly<Record<FamilyId, number>> = {
  F1: 120,
  F2: 60,
  F3: 20,
  F4: 10,
  F5: 30,
  F6: 20,
};

/** Exit rules per family from spec 07 section 7.4, classified for the C2 mapping. */
export const FAMILY_EXIT_RULES: Readonly<Record<FamilyId, readonly FamilyExitRule[]>> = {
  F1: [
    { id: "F1.is_initial", kind: "entry_atr", trigger: "intraday", label: "entry - 2 x ATR" },
    {
      id: "F1.is_trail",
      kind: "indicator",
      trigger: "close",
      label: "3 x ATR below highest close",
    },
    { id: "F1.cs_40", kind: "time", trigger: "close", label: "40 sessions held, return < +5%" },
    { id: "F1.cs_max", kind: "time", trigger: "close", label: "hard maximum hold 120 sessions" },
  ],
  F2: [
    { id: "F2.is_initial", kind: "entry_atr", trigger: "intraday", label: "entry - 2.5 x ATR" },
    {
      id: "F2.cs_guidance",
      kind: "event_dependent",
      trigger: "close",
      label: "- polarity guidance event",
    },
    {
      id: "F2.cs_event_low",
      kind: "event_anchored",
      trigger: "close",
      label: "close below event-day low",
    },
    { id: "F2.cs_60", kind: "time", trigger: "close", label: "60 sessions" },
  ],
  F3: [
    { id: "F3.is_event_low", kind: "event_anchored", trigger: "intraday", label: "event-day low" },
    { id: "F3.is_trail", kind: "indicator", trigger: "close", label: "trail 2.5 x ATR after +10%" },
    { id: "F3.cs_20", kind: "time", trigger: "close", label: "20 sessions" },
  ],
  F4: [
    { id: "F4.cs_sma5", kind: "indicator", trigger: "close", label: "close > SMA5" },
    { id: "F4.cs_10", kind: "time", trigger: "close", label: "10 sessions" },
    { id: "F4.is_initial", kind: "entry_atr", trigger: "intraday", label: "entry - 2 x ATR" },
  ],
  F5: [
    {
      id: "F5.is_initial",
      kind: "entry_atr",
      trigger: "intraday",
      label: "entry - 2.5 x ATR, capped -20%",
    },
    { id: "F5.is_trail", kind: "indicator", trigger: "close", label: "trail 3 x ATR" },
    {
      id: "F5.cs_volume",
      kind: "indicator",
      trigger: "close",
      label: "volume ratio < 0.5 for 3 sessions",
    },
    { id: "F5.cs_polarity", kind: "event_dependent", trigger: "close", label: "- polarity event" },
    { id: "F5.cs_30", kind: "time", trigger: "close", label: "30 sessions" },
  ],
  F6: [
    { id: "F6.is_initial", kind: "entry_atr", trigger: "intraday", label: "entry - 2 x ATR" },
    { id: "F6.cs_20", kind: "time", trigger: "close", label: "20 sessions" },
    {
      id: "F6.cs_earliest",
      kind: "event_dependent",
      trigger: "close",
      label: "earliest exit of any contributing family",
    },
  ],
};

/** The event's distance as an exact multiple of the ATR measured at the event: distance / ATR. */
export function atrMultiple(distanceMicro: Micro, atrMicro: Micro): Rational {
  if (atrMicro <= 0n) throw new RangeError("ATR must be positive");
  if (distanceMicro < 0n) throw new RangeError("distance cannot be negative");
  return makeRational(distanceMicro, atrMicro);
}

/**
 * The control's stop (TST101-042): `multiple` x ATR(20) at the control's entry session, below its
 * own entry-day open. offset = round_half_away(multiple x ATR) once, stop = open - offset; the
 * stop must stay above zero. No tick snapping (the stock stops are not snapped either).
 */
export function controlStopMicro(input: {
  readonly entryDayOpenMicro: Micro;
  readonly atr20Micro: Micro;
  readonly multiple: Rational;
}): { readonly offsetMicro: Micro; readonly stopMicro: Micro } {
  if (input.entryDayOpenMicro <= 0n) throw new RangeError("entry-day open must be positive");
  if (input.atr20Micro <= 0n) throw new RangeError("ATR must be positive");
  if (input.multiple.num < 0n) throw new RangeError("ATR multiple cannot be negative");
  const offset = roundHalfAwayFromZero(mulRat(makeRational(input.atr20Micro), input.multiple));
  const stop = input.entryDayOpenMicro - offset;
  if (stop <= 0n) throw new RangeError("the mapped stop would not stay above zero");
  return { offsetMicro: offset, stopMicro: stop };
}

export type MappedExit =
  | {
      readonly ruleId: string;
      readonly kind: "atr_level";
      readonly trigger: "intraday" | "close" | "n/a";
      readonly multiple: Rational;
      readonly levelMicro: Micro;
    }
  | { readonly ruleId: string; readonly kind: "unchanged"; readonly rule: ExitRuleKind }
  | { readonly ruleId: string; readonly kind: "time_stop"; readonly sessions: number };

/**
 * Map a family's exit rules onto a control (ARN-004). `events` holds, per event-anchored rule id,
 * the event's distance and the ATR(20) at the event; the level is rebuilt from the control's own
 * entry-day open and ATR(20). Anything unmappable becomes the family's time stop.
 */
export function mapControlExits(input: {
  readonly family: FamilyId;
  readonly entryDayOpenMicro: Micro;
  readonly atr20Micro: Micro;
  readonly events: Readonly<
    Record<string, { readonly distanceMicro: Micro; readonly atrMicro: Micro }>
  >;
}): MappedExit[] {
  return FAMILY_EXIT_RULES[input.family].map((rule): MappedExit => {
    if (rule.kind === "event_anchored") {
      const e = input.events[rule.id];
      if (e === undefined) throw new RangeError(`no event distance for rule ${rule.id}`);
      const multiple = atrMultiple(e.distanceMicro, e.atrMicro);
      const { stopMicro } = controlStopMicro({
        entryDayOpenMicro: input.entryDayOpenMicro,
        atr20Micro: input.atr20Micro,
        multiple,
      });
      return {
        ruleId: rule.id,
        kind: "atr_level",
        trigger: rule.trigger,
        multiple,
        levelMicro: stopMicro,
      };
    }
    if (rule.kind === "event_dependent") {
      return {
        ruleId: rule.id,
        kind: "time_stop",
        sessions: FAMILY_TIME_STOP_SESSIONS[input.family],
      };
    }
    return { ruleId: rule.id, kind: "unchanged", rule: rule.kind };
  });
}

/** Decimal text such as "1.3" as the exact ATR multiple (config and fixtures carry text, never floats). */
export function parseAtrMultiple(text: string): Rational {
  return parseRational(text);
}
