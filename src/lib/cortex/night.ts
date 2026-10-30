// The Cortex night (M15 C3c; docs/M15_design.md 1 "Shape", 3a "night", 3b; spec ch. 17 CTX-010…014,
// CTX-020…028, CTX-053…055). `runNight(inputs)` is the one pure function the live stage (P2), the
// replay driver (P3) and the offline tools (O5) call: inputs in, decisions out, identical bytes for
// identical inputs (AT-50). No store, no clock, no network, no random draw of its own (D-279).
//
//   L0  night integrity: late bar / quota / incomplete universe → abstain-all with the reason; a code
//       with a null or malformed close, or a D9 veto flag, fails G01.
//   L1  features: every active / watch score angle on every universe code through the as-of view at
//       t, rank-standardised within the night's universe (registry `rankStandardise`).
//   L2  score and p per family: eligibility, S over the declared clusters, Platt p under the refit
//       guard (score/`scoreCode`); no map → `map_missing` (D-281).
//   L3  the twelve gates in CTX-013 order (gates/), stopping at the first failure, whose id and
//       plain label are recorded; then ranking (economics/`rankCandidates`).
//   L4  sizing hand-off: initial stop (FAM-004 spec at the D close), the CTX-028 limit price
//       (`limitPriceMicro`), the sizing engine's qty, cost per order and the card fields.
//
// Arms (CTX-023, CTX-054, D-266, D-280): a book whose family is `allowed` gets live decisions AND a
// shadow arm with the CTX-026 portfolio limits off; a book whose family is not allowed gets shadow
// decisions only (G03 is not applied in that arm). Every blocked candidate is kept with its first
// failing gate so batch 3 scores it as a would-have trade; every cash-holding book without a live
// decision gets one abstain record naming the gate that stopped its best candidate.
//
// Money is integer micro-dollars / Rational, statistics are floats, every list is in a fixed order
// (sorted codes, books, families, angle ids). Nothing reads `view.sessions[t + 1]`: the fill
// session comes from the trading calendar (known at load).
import { evaluateExit, f1Plan, f4Plan, initialStop } from "@/lib/agents/families/exits";
import type {
  ExitPlan,
  Family,
  PositionState,
  RegimeLabel,
  StopSpec,
  Tier,
} from "@/lib/agents/families/types";
import type { ViewBar } from "@/lib/agents/decisionView";
import { atrSeries, atrToMicro } from "@/lib/agents/indicators";
import type { AgentParams } from "@/lib/agents/params";
import type { CostProfile, FeeContext } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryLimit,
  fillIntradayStop,
  limitPriceMicro,
  selectExit,
  type Bar,
  type FillEnv,
  type SimulatedFill,
} from "@/lib/arena/fills";
import type { SettlementItem } from "@/lib/arena/ledger";
import { sizeEntry, type SizingResult } from "@/lib/arena/sizing";
import { nextTradingDay } from "@/lib/data/calendar";
import type { Micro } from "@/lib/money/micro";
import { divFloor, makeRational, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { cellKey, TOP3_BAND_KEY, type CellStatistic } from "@/lib/stats/cells";
import type { Prng } from "@/lib/stats/rng";
import { ANGLES, evaluateAngle, rankStandardise, scoredSet } from "./angles/registry";
import type { AngleCluster, AngleDef, AngleStatus, AngleValue } from "./angles/types";
import { costPerOrder, type CostPerOrder } from "./economics/cost";
import { breakEvenCard } from "./economics/breakEven";
import { rankCandidates, type RankCandidate } from "./economics/rank";
import {
  gateCost,
  gateDisagreement,
  gateEconomic,
  gateEligibility,
  gateEventState,
  gateFamilyStatus,
  gateGapCap,
  gateL0Code,
  gateL0Night,
  gatePortfolio,
  gateRegime,
  gateSettledCash,
  gateStopCap,
  deployableCash,
  gateIndex,
  L0_CODE_LABEL,
  STOP_CAP_LABEL,
  L0_NIGHT_LABEL,
  MIN_MARKETABLE_PARCEL_MICRO,
  NOT_ENOUGH_HISTORY_LABEL,
  WARMING_UP_LABEL,
  type Exposure,
  type FamilyStatus,
  type GateId,
  type GateResult,
  type GateTraceEntry,
} from "./gates";
import { isLateBarNight, quotaDegrade } from "./pit/integrity";
import type { AsOfView, InputKind, InputManifest } from "./pit/types";
import { scoreCode, type CodeScore } from "./score";
import { activeSetHash } from "./score/map";
import type { CortexMap, ScoredAngle } from "./score/types";
import { coldStartAt } from "./states/coldStart";

// ---- shapes --------------------------------------------------------------------------------------------

export type { FamilyStatus };
/** Family → status; a family absent from the map is `shadow` (D-280: V1 unchanged until the import). */
export type FamilyStatusMap = Readonly<Partial<Record<Family | "F7", FamilyStatus>>>;

export type BookPosition = {
  readonly code: string;
  readonly qty: bigint;
  readonly costMicro: Micro;
  readonly stopMicro: Micro;
  readonly entryD: string;
};

/** One live E cohort (book) as the night sees it (design 3a `BookState`, + the CTX-027 pending items). */
export type BookState = {
  readonly bookId: string;
  readonly family: Family;
  readonly executionId: string;
  readonly positions: readonly BookPosition[];
  /** Cash whose settlement is complete at the decision close. */
  readonly settledCashMicro: Micro;
  /** Unsettled fills (sale receipts, buy payables) with their T+2 sessions (`pendingSettlements`). */
  readonly pending?: readonly SettlementItem[];
  readonly navMicro: Micro;
  readonly costProfile: CostProfile;
  readonly feeContext?: FeeContext;
  readonly sessionsSinceGoLive: number;
  /** Exposure multiplier for a book with a leverage sleeve (CTX-026 "notional × leverage"); default 1. */
  readonly leverage?: Rational;
};

/**
 * What a family's rule version declares (data of the import, D-281): the K clusters S runs over,
 * the development mean net the ranking shrinks towards, the family's universe tiers (D-332), the
 * development band edge of the pooled top-3 cell (D-334), the card's gain / loss figures. The exit
 * plan is the family's v1 plan (`f1Plan` / `f4Plan`, D-333), not a field here.
 */
export type FamilyNightRule = {
  readonly ruleVersion: string;
  readonly clusters: readonly AngleCluster[];
  readonly familyMeanNet: number;
  /** The family's v1 universe tiers: a code outside them is not a candidate (no row). */
  readonly tiers: readonly Tier[];
  /** S at the lower edge of the pooled top-3 band on the development split; absent → G04 `band_missing`. */
  readonly top3MinS?: number;
  /** CTX-053 over-confidence monitor: the family's p is hidden from cards (`similar: null`). */
  readonly pHidden?: boolean;
  /** Conditional mean gross gain and loss of the family's matched setups (card break-even line). */
  readonly gainLoss?: { readonly gain: number; readonly loss: number };
  /** Entries a book may open on one night (default 1). */
  readonly slots?: number;
};

export type StateRef = {
  readonly code: string;
  readonly kind: "corp_action" | "halt" | "promotion";
  readonly state: string;
  readonly basis: unknown;
};

export type NightInputs = {
  readonly market: string;
  readonly d: string;
  /** Index of `d` in `view.sessions`. */
  readonly t: number;
  readonly view: AsOfView;
  readonly params: AgentParams;
  readonly status: FamilyStatusMap;
  /** Empty → every book abstains `map_missing` and only shadow rows are produced (D-281). */
  readonly maps: ReadonlyMap<Family, CortexMap>;
  /** key = `family|top3|volBucket|liqTier` (stats/cells `cellKey`). */
  readonly cells: ReadonlyMap<string, CellStatistic>;
  /** All 12 books (the CTX-026 caps span them). */
  readonly books: readonly BookState[];
  readonly rules: ReadonlyMap<Family, FamilyNightRule>;
  /** Current `cortex_state` rows per code (the latest per kind). */
  readonly states: readonly StateRef[];
  /** Angle id → passport status; an angle absent here is `candidate` (never scored). */
  readonly passports: ReadonlyMap<string, AngleStatus>;
  /** The registry by default; a test may inject synthetic definitions. */
  readonly angles?: readonly AngleDef[];
  /** Text labels usable at the cut-off (shadow until CTX-040 passes); unused by any gate. */
  readonly labels?: ReadonlyMap<string, unknown>;
  readonly kills: {
    readonly arena: boolean;
    readonly families: ReadonlySet<Family>;
    readonly sourcesOff: ReadonlySet<InputKind>;
  };
  /** D-289: wall-clock minutes the stage has used (the core never reads a clock); absent = 0. */
  readonly degrade?: { readonly elapsedMinutes: number };
  /** ARN-011 reasons per U2/U3 code from the v1 `applyArn011` (D-332); absent = all pass. */
  readonly arn011Failed?: ReadonlyMap<string, readonly string[]>;
  /** CTX-055 go-live date; absent = cold-start rules off (replay before go-live, offline). */
  readonly goLiveD?: string | null;
  readonly prng: (scope: string) => Prng;
};

export type NightReason = "late_bar" | "quota" | "map_missing" | "universe_incomplete";

export type CardFields = {
  /** p of similar setups; lo / hi are null until the import carries the map's Platt interval (D-339); null when p is hidden. */
  readonly similar: {
    readonly p: number;
    readonly lo: number | null;
    readonly hi: number | null;
    readonly n: number;
  } | null;
  readonly breakEven: readonly { readonly c: number; readonly pBe: number }[];
  readonly reasonsFor: readonly AngleCluster[];
  readonly reasonsAgainst: readonly AngleCluster[];
  /** The gate that was not applied in this arm and would have failed (shadow arm: G11). */
  readonly wouldHaveStopped: GateId | null;
  readonly regime: RegimeLabel;
  readonly independentSources: readonly InputKind[];
  readonly costPerOrderPpm: number;
};

export type Decision = {
  readonly bookId: string;
  readonly family: Family;
  readonly code: string;
  readonly arm: "live" | "shadow";
  readonly s: number | null;
  readonly p: number | null;
  readonly expectedNetMicro: Micro | null;
  /** [key, −L_real, −d] (CTX-022; D-314 floats); empty for a blocked candidate. */
  readonly rankKey: readonly number[];
  readonly rank: number | null;
  readonly tier: Tier;
  readonly volBucket: string;
  readonly refMicro: Micro;
  readonly limitMicro: Micro;
  readonly stopMicro: Micro;
  readonly qty: bigint;
  readonly orderValueMicro: Micro;
  readonly halfSize: boolean;
  readonly plan: ExitPlan;
  readonly stopSpec: StopSpec;
  readonly trace: readonly GateTraceEntry[];
  readonly card: CardFields;
};

/** A candidate a gate stopped: the sizing fields are null when the gate failed before they existed. */
export type BlockedDecision = Omit<
  Decision,
  "limitMicro" | "stopMicro" | "qty" | "orderValueMicro"
> & {
  readonly limitMicro: Micro | null;
  readonly stopMicro: Micro | null;
  readonly qty: bigint | null;
  readonly orderValueMicro: Micro | null;
  readonly firstFail: GateId;
};

export type Abstain = {
  readonly bookId: string;
  readonly gateId: GateId;
  readonly label: string;
  readonly detail: unknown;
};

export type SectorTilt = {
  readonly bookId: string;
  readonly sector: string;
  readonly tiltPp: number;
};

export type NightOutput = {
  readonly status: "ran" | "abstain_all";
  readonly reason: NightReason | null;
  readonly manifest: InputManifest;
  /** code → angle id → value, the scored set only (one row per code, CTX-050 / D-293). */
  readonly features: ReadonlyMap<string, ReadonlyMap<string, AngleValue>>;
  readonly activeSetHash: string;
  /** Live arm: passed every gate, ranked, sized, taken (one per slot). */
  readonly decisions: readonly Decision[];
  /** Live arm: passed every gate but not taken (ranked below the slots). */
  readonly queued: readonly Decision[];
  /** Shadow arm (families not allowed; CTX-026 off for allowed books). */
  readonly shadow: readonly Decision[];
  /** Every blocked candidate of both arms, for would-have scoring (CTX-023). */
  readonly blocked: readonly BlockedDecision[];
  readonly abstains: readonly Abstain[];
  readonly sectorTilt: readonly SectorTilt[];
};

// ---- constants -------------------------------------------------------------------------------------------

/** D-317: one ATR(20) per code per night, folded over the same 250 bars. */
export const ATR_PERIOD = 20;
export const ATR_HISTORY = 250;
/** Volatility buckets of the matched-setup key: ATR(20) ÷ close, pre-registered edges 2 % and 4 %. */
export const VOL_BUCKET_EDGES: readonly number[] = [0.02, 0.04]; // threshold-ok: pre-registered bucket edges
export const VOL_BUCKETS: readonly string[] = ["v1", "v2", "v3"];
const DEFAULT_SLOTS = 1;
const HALF = makeRational(1n, 2n);

// ---- helpers ----------------------------------------------------------------------------------------------

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const micro = (v: bigint): number => Number(v) / 1_000_000;

/** The volatility bucket of a code tonight: ATR(20) ÷ close against `VOL_BUCKET_EDGES`. */
export function volBucketOf(atrMicro: Micro, closeMicro: Micro): string {
  if (closeMicro <= 0n) throw new RangeError("close must be positive");
  const ratio = Number(atrMicro) / Number(closeMicro);
  let i = 0;
  while (i < VOL_BUCKET_EDGES.length && ratio >= VOL_BUCKET_EDGES[i]!) i += 1;
  return VOL_BUCKETS[i]!;
}

/** Wilder ATR(20) over the last `ATR_HISTORY` raw bars, in micro; null before `ATR_PERIOD + 1` bars. */
export function atr20Micro(bars: readonly ViewBar[]): Micro | null {
  if (bars.length < ATR_PERIOD + 1) return null;
  const series = atrSeries(
    bars.map((b) => micro(b.high)),
    bars.map((b) => micro(b.low)),
    bars.map((b) => micro(b.close)),
    ATR_PERIOD,
  );
  const last = series[series.length - 1];
  if (last === null || last === undefined || !(last > 0)) return null;
  return atrToMicro(last);
}

/**
 * D-333: the entry carries the family's v1 exit plan (stops, trails, time stops). F1 and F4 have
 * plans from params and ATR alone; F2/F3/F5/F6 need event or constant inputs not wired yet → null
 * (their candidates fail G04 `rule_missing`).
 */
export function familyPlan(
  family: Family,
  params: AgentParams,
  atrMicro: Micro | null,
): ExitPlan | null {
  if (family === "F1") return f1Plan(params, atrMicro);
  if (family === "F4") return f4Plan(params, atrMicro);
  return null;
}

const EMPTY_PLAN: ExitPlan = { initialStops: [], trails: [], cs: [] };

/** The initial stop spec of a plan (its first initial-stop rule). */
export function planStopSpec(plan: ExitPlan, atrMicro: Micro | null): StopSpec {
  return (
    plan.initialStops[0]?.spec ?? { atr_micro: atrMicro, k: null, cap: null, level_micro: null }
  );
}

function scaleHalf(v: Micro): Micro {
  return divFloor(v * HALF.num, HALF.den);
}

const toBar = (b: ViewBar): Bar => ({
  openMicro: b.open,
  highMicro: b.high,
  lowMicro: b.low,
  closeMicro: b.close,
});

// ---- L1 features ----------------------------------------------------------------------------------------------

/**
 * The feature step (CTX-011, CTX-012; TST-109 target): every scored angle on every universe code at
 * t, numeric outputs rank-standardised within the universe with the angle's orientation, flags and
 * buckets kept, undefined kept (eligibility reads it). Pure over the view at t.
 */
export function featuresAt(
  view: AsOfView,
  t: number,
  scored: readonly AngleDef[],
  codes: readonly string[] = view.codes(t),
): ReadonlyMap<string, ReadonlyMap<string, AngleValue>> {
  const sortedCodes = [...codes].sort(byText);
  const perCode = new Map<string, Map<string, AngleValue>>(
    sortedCodes.map((c) => [c, new Map<string, AngleValue>()]),
  );
  const angles = [...scored].sort((a, b) => byText(a.id, b.id));
  for (const def of angles) {
    const raw = new Map<string, AngleValue>();
    const numeric = new Map<string, number>();
    for (const code of sortedCodes) {
      const v = evaluateAngle(def, "active", view, code, t);
      raw.set(code, v);
      if (typeof v === "number" && Number.isFinite(v)) numeric.set(code, v);
    }
    const ranked = rankStandardise(numeric, def.orientation);
    for (const code of sortedCodes) {
      const v = raw.get(code);
      perCode.get(code)!.set(def.id, typeof v === "number" ? ranked.get(code) : v);
    }
  }
  return perCode;
}

/** The D9 veto flags of a code: gate angles of domain 9 with a compute that return a flag. */
export function l0VetoFlags(
  view: AsOfView,
  t: number,
  code: string,
  gateAngles: readonly AngleDef[],
): string[] {
  const flags: string[] = [];
  for (const def of gateAngles) {
    const v = evaluateAngle(def, "active", view, code, t);
    if (v !== undefined && typeof v === "object" && "flag" in v) flags.push(`${def.id}:${v.flag}`);
  }
  return flags.sort(byText);
}

// ---- per-code facts -----------------------------------------------------------------------------------------------

type CodeNightFacts = {
  readonly code: string;
  readonly tier: Tier | null;
  readonly bar: ViewBar | null;
  readonly adjClose: bigint | null;
  readonly atrMicro: Micro | null;
  readonly advValueMicro: Micro;
  readonly adv20Shares: bigint;
  readonly industry: string | null;
  readonly vetoFlags: readonly string[];
};

function codeFacts(
  view: AsOfView,
  t: number,
  d: string,
  code: string,
  advWindow: number,
  gateAngles: readonly AngleDef[],
): CodeNightFacts {
  const bars = view.bars(code, t, ATR_HISTORY);
  const last = bars[bars.length - 1];
  const bar = last !== undefined && last.d === d ? last : null;
  const adj = view.adj(code, t, 1);
  const adjClose = adj.adjClose[adj.adjClose.length - 1] ?? null;
  const advBars = bars.slice(-advWindow);
  let value = 0n;
  let shares = 0n;
  for (const b of advBars) {
    value += b.close * b.volume;
    shares += b.volume;
  }
  const n = BigInt(advBars.length === 0 ? 1 : advBars.length);
  return {
    code,
    tier: view.tier(code, t),
    bar,
    adjClose,
    atrMicro: bar === null ? null : atr20Micro(bars),
    advValueMicro: value / n,
    adv20Shares: shares / n,
    industry: view.industry(code, t),
    vetoFlags: l0VetoFlags(view, t, code, gateAngles),
  };
}

// ---- the night -----------------------------------------------------------------------------------------------------

type Eval = {
  readonly trace: GateTraceEntry[];
  readonly firstFail: GateId | null;
  readonly score: CodeScore | null;
  readonly cell: CellStatistic | undefined;
  readonly volBucket: string;
  readonly halfSize: boolean;
  readonly plan: ExitPlan | null;
  readonly stopSpec: StopSpec | null;
  readonly stopMicro: Micro | null;
  readonly limitMicro: Micro | null;
  readonly sizing: SizingResult | null;
  readonly cost: CostPerOrder | null;
  readonly wouldHaveStopped: GateId | null;
  readonly sources: readonly InputKind[];
};

type NightCtx = {
  readonly inputs: NightInputs;
  readonly night: { status: "ran" } | { status: "abstain_all"; reason: string };
  readonly scoredDefs: readonly AngleDef[];
  readonly scoredAngles: readonly ScoredAngle[];
  readonly hash: string;
  readonly features: ReadonlyMap<string, ReadonlyMap<string, AngleValue>>;
  readonly facts: ReadonlyMap<string, CodeNightFacts>;
  readonly regime: RegimeLabel;
  readonly fillD: string;
  readonly exposures: readonly Exposure[];
  readonly arenaNavMicro: Micro;
  readonly coldExcluded: (family: Family) => boolean;
  readonly sources: readonly InputKind[];
};

function statusOf(inputs: NightInputs): (id: string) => AngleStatus {
  return (id) => inputs.passports.get(id) ?? "candidate";
}

function stateOf(states: readonly StateRef[], code: string, kind: StateRef["kind"]): string | null {
  let out: string | null = null;
  for (const s of states) if (s.code === code && s.kind === kind) out = s.state;
  return out;
}

function closeAt(view: AsOfView, t: number, d: string, code: string): Micro | null {
  const bars = view.bars(code, t, 1);
  const b = bars[bars.length - 1];
  return b !== undefined && b.d === d ? b.close : null;
}

/** Every held line across the books valued at the night's close (cost when the code has no D bar). */
export function bookExposures(
  books: readonly BookState[],
  view: AsOfView,
  t: number,
  d: string,
): Exposure[] {
  const out: Exposure[] = [];
  for (const book of [...books].sort((a, b) => byText(a.bookId, b.bookId))) {
    const lev = book.leverage ?? makeRational(1n);
    for (const p of [...book.positions].sort((a, b) => byText(a.code, b.code))) {
      const close = closeAt(view, t, d, p.code);
      const notional = close === null ? p.costMicro : p.qty * close;
      out.push({
        bookId: book.bookId,
        code: p.code,
        industry: view.industry(p.code, t),
        exposureMicro: divFloor(notional * lev.num, lev.den),
      });
    }
  }
  return out;
}

function evaluateCandidate(
  ctx: NightCtx,
  book: BookState,
  code: string,
  arm: "live" | "shadow",
  familyAllowed: boolean,
  deployable: Micro,
  tonight: readonly Exposure[],
): Eval {
  const { inputs } = ctx;
  const { params } = inputs;
  const f = ctx.facts.get(code)!;
  const rule = inputs.rules.get(book.family);
  const trace: GateTraceEntry[] = [];
  let score: CodeScore | null = null;
  let cell: CellStatistic | undefined = undefined;
  let volBucket = "";
  let halfSize = false;
  let plan: ExitPlan | null = null;
  let stopSpec: StopSpec | null = null;
  let stopMicro: Micro | null = null;
  let limitMicro: Micro | null = null;
  let sizing: SizingResult | null = null;
  let cost: CostPerOrder | null = null;
  let wouldHaveStopped: GateId | null = null;
  const skipStatus = arm === "shadow" && !familyAllowed;
  const skipLimits = arm === "shadow" && familyAllowed;

  const done = (firstFail: GateId | null): Eval => ({
    trace,
    firstFail,
    score,
    cell,
    volBucket,
    halfSize,
    plan,
    stopSpec,
    stopMicro,
    limitMicro,
    sizing,
    cost,
    wouldHaveStopped,
    sources: ctx.sources,
  });
  const step = (gateId: GateId, r: GateResult): boolean => {
    trace.push({ ...r, gateId });
    return r.pass;
  };

  // 1. L0 vetoes
  const night = gateL0Night(ctx.night);
  if (!night.pass) {
    step("G01_l0_veto", night);
    return done("G01_l0_veto");
  }
  const l0 =
    f.tier === null
      ? ({ pass: false, gateId: "G01_l0_veto", label: L0_CODE_LABEL, value: "no_tier" } as const)
      : gateL0Code({
          bar: f.bar,
          adjClose: f.adjClose,
          vetoFlags: f.vetoFlags,
          arn011Failed: f.tier === "U1" ? [] : (inputs.arn011Failed?.get(code) ?? []),
        });
  if (!step("G01_l0_veto", l0)) return done("G01_l0_veto");
  const tier = f.tier!;
  const bar = f.bar!;

  // 2. eligibility (CTX-012; an ATR warming up is an undefined feature too)
  const feats = ctx.features.get(code) ?? new Map<string, AngleValue>();
  const clusters = rule?.clusters ?? inputs.maps.get(book.family)?.clusters ?? [];
  score =
    clusters.length > 0
      ? scoreCode(feats, ctx.scoredAngles, inputs.maps.get(book.family), ctx.hash, clusters)
      : null;
  if (score !== null && score.status === "ineligible") {
    step("G02_eligibility", gateEligibility(score.eligibility));
    return done("G02_eligibility");
  }
  if (f.atrMicro === null) {
    step("G02_eligibility", {
      pass: false,
      gateId: "G02_eligibility",
      label: WARMING_UP_LABEL,
      value: "atr20",
    });
    return done("G02_eligibility");
  }
  if (score !== null) step("G02_eligibility", { pass: true }); // no score → no eligibility verdict (N2)

  // 3. family status
  if (skipStatus) {
    step("G03_family_status", { pass: true, value: "shadow" });
  } else {
    const r = gateFamilyStatus({
      status: inputs.status[book.family] ?? "shadow",
      killed: inputs.kills.arena || inputs.kills.families.has(book.family),
      coldStartExcluded: ctx.coldExcluded(book.family),
    });
    if (!step("G03_family_status", r)) return done("G03_family_status");
  }

  // 4. economic gate
  volBucket = volBucketOf(f.atrMicro, bar.close);
  cell = inputs.cells.get(cellKey(book.family, TOP3_BAND_KEY, volBucket, tier));
  plan = familyPlan(book.family, params, f.atrMicro);
  if (rule === undefined || score === null || score.status !== "scored" || plan === null) {
    step("G04_economic", {
      pass: false,
      gateId: "G04_economic",
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "rule_missing",
    });
    return done("G04_economic");
  }
  if (rule.top3MinS === undefined) {
    step("G04_economic", {
      pass: false,
      gateId: "G04_economic",
      label: NOT_ENOUGH_HISTORY_LABEL,
      value: "band_missing",
    });
    return done("G04_economic");
  }
  const econ = gateEconomic({
    map: score.guard,
    cell,
    regime: ctx.regime,
    inBand: score.score.s >= rule.top3MinS,
    opts: {
      cellMinSetups: params.cortex.cellMinSetups,
      cellMinBlocks: params.cortex.cellMinBlocks,
    },
  });
  if (!step("G04_economic", econ)) return done("G04_economic");
  const theCell = cell!;

  // sizing hand-off data (needed by 5, 11 and 12): stop at the D close, limit, qty
  stopSpec = planStopSpec(plan, f.atrMicro);
  stopMicro = initialStop(stopSpec, bar.close);
  if (stopMicro <= 0n || stopMicro >= bar.close) {
    step("G06_stop_cap", {
      pass: false,
      gateId: "G06_stop_cap",
      label: STOP_CAP_LABEL,
      value: `stop:${stopMicro}`,
    });
    return done("G06_stop_cap");
  }

  // 5. cost (informational)
  const regimeGate = gateRegime(book.family, ctx.regime);
  halfSize = regimeGate.halfSize;
  const cashIn = halfSize ? scaleHalf(deployable) : deployable;
  const navIn = halfSize ? scaleHalf(book.navMicro) : book.navMicro;
  sizing = sizeEntry({
    settledCashMicro: cashIn,
    navMicro: navIn,
    refPriceMicro: bar.close,
    advValueMicro: f.advValueMicro,
    adv20Shares: f.adv20Shares,
    tier,
    profile: book.costProfile,
    feeContext: book.feeContext,
  });
  const notional =
    sizing.orderValueMicro > 0n ? sizing.orderValueMicro : MIN_MARKETABLE_PARCEL_MICRO;
  cost = costPerOrder({
    profile: book.costProfile,
    notionalMicro: notional,
    priceMicro: bar.close,
    tier,
    advMicro: f.advValueMicro,
    feeContext: book.feeContext,
  });
  step(
    "G05_cost",
    gateCost({
      cost,
      costGateK: Number(params.entry.costGateK.num) / Number(params.entry.costGateK.den),
      cellMeanNet: theCell.meanNet,
    }),
  );

  // 6. stop cap
  if (!step("G06_stop_cap", gateStopCap(stopSpec, bar.close, params.entry.maxStopDistance))) {
    return done("G06_stop_cap");
  }
  limitMicro = limitPriceMicro(
    bar.close,
    stopMicro,
    params.cortex.entryGapCap,
    params.entry.maxStopDistance,
  );

  // 7. gap cap
  const gap = gateGapCap({
    refMicro: bar.close,
    stopMicro,
    gap95: theCell.gap95,
    maxLoss: params.cortex.maxLoss,
  });
  if (!step("G07_gap_cap", gap)) return done("G07_gap_cap");

  // 8. event and state vetoes
  const ev = gateEventState({
    d: inputs.d,
    fillD: ctx.fillD,
    indexChangesLoaded: inputs.view.indexChangesLoaded,
    indexChanges: inputs.view.indexChanges(code, inputs.t),
    sessions: inputs.view.sessions.slice(0, inputs.t + 1),
    indexChangeWindowSessions: params.entry.indexChangeWindowSessions,
    promotionState: stateOf(inputs.states, code, "promotion"),
    haltState: stateOf(inputs.states, code, "halt"),
    haltedNow: inputs.view.halted(code, inputs.t),
    corpActionState: stateOf(inputs.states, code, "corp_action"),
    events: inputs.view.events(code, inputs.t),
  });
  if (!step("G08_event_state", ev)) return done("G08_event_state");

  // 9. regime
  if (!step("G09_regime", regimeGate)) return done("G09_regime");

  // 10. disagreement
  if (!step("G10_disagreement", gateDisagreement(score.score, params.cortex.disagreementMax))) {
    return done("G10_disagreement");
  }

  // 11. portfolio limits
  const portfolio = gatePortfolio({
    bookId: book.bookId,
    code,
    industry: f.industry,
    orderValueMicro: sizing.orderValueMicro,
    exposures: [...ctx.exposures, ...tonight],
    arenaNavMicro: ctx.arenaNavMicro,
    caps: {
      maxBooksSameCode: params.cortex.maxBooksSameCode,
      maxCodeNavShare: params.cortex.maxCodeNavShare,
      maxIndustryNavShare: params.cortex.maxIndustryNavShare,
    },
  });
  if (skipLimits) {
    step("G11_portfolio", { pass: true, value: "shadow:limits_off" });
    if (!portfolio.pass) wouldHaveStopped = "G11_portfolio";
  } else if (!step("G11_portfolio", portfolio)) {
    return done("G11_portfolio");
  }

  // 12. settled cash
  const cash = gateSettledCash({
    deployableMicro: deployable,
    entryFeeMicro: sizing.brokerageMicro,
    halfSize,
    sizing,
  });
  if (!step("G12_settled_cash", cash)) return done("G12_settled_cash");
  return done(null);
}

function cardOf(
  ctx: NightCtx,
  e: Eval,
  cell: CellStatistic | undefined,
  rule: FamilyNightRule | undefined,
): CardFields {
  const score = e.score !== null && e.score.status === "scored" ? e.score : null;
  const p = score?.p ?? null;
  const means =
    score === null ? [] : [...score.score.clusters].filter((c) => c.n > 0 && c.mean !== 0);
  const byAbs = (
    a: { mean: number; cluster: AngleCluster },
    b: { mean: number; cluster: AngleCluster },
  ): number => Math.abs(b.mean) - Math.abs(a.mean) || byText(a.cluster, b.cluster);
  return {
    similar:
      p === null || cell === undefined || rule?.pHidden === true
        ? null
        : { p, lo: null, hi: null, n: cell.n },
    breakEven:
      rule?.gainLoss === undefined
        ? []
        : breakEvenCard(rule.gainLoss.gain, rule.gainLoss.loss, e.cost ?? undefined).line,
    reasonsFor: means
      .filter((c) => c.mean > 0)
      .sort(byAbs)
      .map((c) => c.cluster),
    reasonsAgainst: means
      .filter((c) => c.mean < 0)
      .sort(byAbs)
      .map((c) => c.cluster),
    wouldHaveStopped: e.wouldHaveStopped,
    regime: ctx.regime,
    independentSources: e.sources,
    costPerOrderPpm: e.cost?.ppm ?? 0,
  };
}

function expectedNet(e: Eval, shrunkMeanNet: number | null): Micro | null {
  if (e.sizing === null || shrunkMeanNet === null) return null;
  const v = shrunkMeanNet * Number(e.sizing.orderValueMicro);
  return roundHalfAwayFromZero(makeRational(BigInt(Math.round(v))));
}

function blockedOf(
  ctx: NightCtx,
  book: BookState,
  code: string,
  arm: "live" | "shadow",
  e: Eval,
): BlockedDecision {
  const f = ctx.facts.get(code)!;
  const score = e.score !== null && e.score.status === "scored" ? e.score : null;
  const plan = e.plan ?? familyPlan(book.family, ctx.inputs.params, f.atrMicro) ?? EMPTY_PLAN;
  const spec = e.stopSpec ?? planStopSpec(plan, f.atrMicro);
  return {
    bookId: book.bookId,
    family: book.family,
    code,
    arm,
    s: score?.score.s ?? null,
    p: score?.p ?? null,
    expectedNetMicro: expectedNet(e, e.cell?.meanNet ?? null),
    rankKey: [],
    rank: null,
    tier: f.tier ?? "U3",
    volBucket: e.volBucket,
    refMicro: f.bar?.close ?? 0n,
    limitMicro: e.limitMicro,
    stopMicro: e.stopMicro,
    qty: e.sizing?.qty ?? null,
    orderValueMicro: e.sizing?.orderValueMicro ?? null,
    halfSize: e.halfSize,
    plan,
    stopSpec: spec,
    trace: e.trace,
    card: cardOf(ctx, e, e.cell, ctx.inputs.rules.get(book.family)),
    firstFail: e.firstFail!,
  };
}

type Passer = RankCandidate & { readonly eval: Eval };

function decisionOf(
  ctx: NightCtx,
  book: BookState,
  code: string,
  arm: "live" | "shadow",
  e: Eval,
  rank: number,
  rankKey: readonly number[],
  shrunkMeanNet: number,
): Decision {
  const f = ctx.facts.get(code)!;
  const score = e.score as Extract<CodeScore, { status: "scored" }>;
  return {
    bookId: book.bookId,
    family: book.family,
    code,
    arm,
    s: score.score.s,
    p: score.p,
    expectedNetMicro: expectedNet(e, shrunkMeanNet),
    rankKey,
    rank,
    tier: f.tier!,
    volBucket: e.volBucket,
    refMicro: f.bar!.close,
    limitMicro: e.limitMicro!,
    stopMicro: e.stopMicro!,
    qty: e.sizing!.qty,
    orderValueMicro: e.sizing!.orderValueMicro,
    halfSize: e.halfSize,
    plan: e.plan!,
    stopSpec: e.stopSpec!,
    trace: e.trace,
    card: cardOf(ctx, e, e.cell, ctx.inputs.rules.get(book.family)),
  };
}

/** The abstain record of a book: the gate that stopped the candidate that got furthest (ties: code order). */
function abstainOf(
  bookId: string,
  night: NightCtx["night"],
  blocked: readonly BlockedDecision[],
): Abstain {
  if (night.status === "abstain_all") {
    return {
      bookId,
      gateId: "G01_l0_veto",
      label: L0_NIGHT_LABEL,
      detail: { reason: night.reason },
    };
  }
  const counts: Record<string, number> = {};
  let best: BlockedDecision | null = null;
  for (const b of blocked) {
    counts[b.firstFail] = (counts[b.firstFail] ?? 0) + 1;
    if (best === null || gateIndex(b.firstFail) > gateIndex(best.firstFail)) best = b;
  }
  if (best === null) {
    return {
      bookId,
      gateId: "G01_l0_veto",
      label: L0_NIGHT_LABEL,
      detail: { reason: "no_candidates" },
    };
  }
  const last = best.trace[best.trace.length - 1]!;
  const label = last.pass ? L0_NIGHT_LABEL : last.label;
  return {
    bookId,
    gateId: best.firstFail,
    label,
    detail: { code: best.code, value: last.pass ? null : (last.value ?? null), counts },
  };
}

/**
 * CTX-025 sector tilt, shadow: per book and industry, the book's exposure share of its NAV minus the
 * industry's share of the universe at t, in percentage points (logged, no effect).
 */
export function sectorTiltOf(
  books: readonly BookState[],
  exposures: readonly Exposure[],
  universe: readonly { code: string; industry: string | null }[],
): SectorTilt[] {
  const known = universe.filter((u) => u.industry !== null);
  const universeCount = new Map<string, number>();
  for (const u of known) universeCount.set(u.industry!, (universeCount.get(u.industry!) ?? 0) + 1);
  const out: SectorTilt[] = [];
  for (const book of [...books].sort((a, b) => byText(a.bookId, b.bookId))) {
    if (book.navMicro <= 0n) continue;
    const byInd = new Map<string, Micro>();
    for (const e of exposures) {
      if (e.bookId !== book.bookId || e.industry === null) continue;
      byInd.set(e.industry, (byInd.get(e.industry) ?? 0n) + e.exposureMicro);
    }
    for (const sector of [...byInd.keys()].sort(byText)) {
      const bookShare = Number(byInd.get(sector)!) / Number(book.navMicro);
      const uniShare = known.length === 0 ? 0 : (universeCount.get(sector) ?? 0) / known.length;
      out.push({ bookId: book.bookId, sector, tiltPp: 100 * (bookShare - uniShare) });
    }
  }
  return out;
}

/** Pure: identical bytes for identical inputs (AT-50). */
export function runNight(inputs: NightInputs): NightOutput {
  const { view, t, d, params } = inputs;
  if (view.sessions[t] !== d)
    throw new RangeError(`sessions[${t}] is ${view.sessions[t]}, not ${d}`);
  const manifest = view.manifest(t);
  const angles = inputs.angles ?? ANGLES;
  const status = statusOf(inputs);
  const scoredDefs = scoredSet(angles, status);
  const scoredAngles: ScoredAngle[] = scoredDefs.map((a) => ({
    id: a.id,
    version: a.version,
    cluster: a.cluster as AngleCluster,
  }));
  const hash = activeSetHash(scoredAngles);
  const sources = [...new Set(scoredDefs.flatMap((a) => a.inputs))].sort(byText);
  const books = [...inputs.books].sort((a, b) => byText(a.bookId, b.bookId));
  const fillD = nextTradingDay(d, view.calendar);
  const codes = view.codes(t);

  // L0 night (D-336: bars dated D counted here; the stale share is the core's figure)
  const axjo = view.index("AXJO", t, 1);
  const benchmarkBarD = axjo[axjo.length - 1]?.d ?? null;
  const barsOnD = codes.filter((c) => closeAt(view, t, d, c) !== null).length;
  // stale share: members of the previous session's universe (or tonight's) without a bar dated D
  const members = new Set<string>([...(t > 0 ? view.codes(t - 1) : []), ...codes]);
  const staleShare = members.size === 0 ? 0 : 1 - barsOnD / members.size;
  let reason: NightReason | null = isLateBarNight({ d, benchmarkBarD, universeBarsOnD: barsOnD })
    ? "late_bar"
    : null;
  if (reason === null) {
    reason = quotaDegrade({
      elapsedMinutes: inputs.degrade?.elapsedMinutes ?? 0,
      stageMinutes: params.cortex.stageMinutes,
      staleShare,
      staleUniverseMaxShare: params.cortex.staleUniverseMaxShare,
    });
  }
  const deployableOf = (b: BookState): Micro =>
    deployableCash({ settledCashMicro: b.settledCashMicro, pending: b.pending ?? [] }, fillD);
  const cashHolding = (b: BookState): boolean => deployableOf(b) >= MIN_MARKETABLE_PARCEL_MICRO;

  if (reason !== null) {
    const night = { status: "abstain_all", reason } as const;
    return {
      status: "abstain_all",
      reason,
      manifest,
      features: new Map(),
      activeSetHash: hash,
      decisions: [],
      queued: [],
      shadow: [],
      blocked: [],
      abstains: books.filter(cashHolding).map((b) => abstainOf(b.bookId, night, [])),
      sectorTilt: sectorTiltOf(books, bookExposures(books, view, t, d), []),
    };
  }

  // L1
  const features = featuresAt(view, t, scoredDefs, codes);
  const gateAngles = angles.filter(
    (a) =>
      a.kind === "gate" &&
      a.domain === 9 &&
      a.compute !== undefined &&
      status(a.id) !== "candidate",
  );
  const facts = new Map<string, CodeNightFacts>(
    codes.map((c) => [c, codeFacts(view, t, d, c, params.windows.adv, gateAngles)]),
  );
  const regime = view.regime(t);
  const exposures = bookExposures(books, view, t, d);
  let arenaNav = 0n;
  for (const b of books) arenaNav += b.navMicro;
  const cold =
    inputs.goLiveD === undefined || inputs.goLiveD === null
      ? null
      : coldStartAt(view, t, { goLiveD: inputs.goLiveD }, false).state;
  const coldExcluded = (family: Family): boolean =>
    cold !== null && !cold.familiesAllowed.includes(family);
  const mapMissing = inputs.maps.size === 0;
  const ctx: NightCtx = {
    inputs,
    night: { status: "ran" },
    scoredDefs,
    scoredAngles,
    hash,
    features,
    facts,
    regime,
    fillD,
    exposures,
    arenaNavMicro: arenaNav > 0n ? arenaNav : 1n,
    coldExcluded,
    sources,
  };

  const decisions: Decision[] = [];
  const queued: Decision[] = [];
  const shadow: Decision[] = [];
  const blocked: BlockedDecision[] = [];
  const abstains: Abstain[] = [];
  const tonight: Exposure[] = [];

  const runArm = (
    book: BookState,
    arm: "live" | "shadow",
    allowed: boolean,
    deployable: Micro,
  ): { taken: Decision[]; queued: Decision[]; blocked: BlockedDecision[] } => {
    const rule = inputs.rules.get(book.family);
    const slots = rule?.slots ?? DEFAULT_SLOTS;
    const passers: Passer[] = [];
    const armBlocked: BlockedDecision[] = [];
    for (const code of codes) {
      // D-332: the candidate set is the family's v1 universe tiers (no row for a code outside them)
      const tier = facts.get(code)!.tier;
      if (rule === undefined || tier === null || !rule.tiers.includes(tier)) continue;
      const e = evaluateCandidate(
        ctx,
        book,
        code,
        arm,
        allowed,
        deployable,
        arm === "live" ? tonight : [],
      );
      if (e.firstFail !== null) {
        armBlocked.push(blockedOf(ctx, book, code, arm, e));
        continue;
      }
      const score = e.score as Extract<CodeScore, { status: "scored" }>;
      const cell = e.cell!;
      passers.push({
        code,
        volBucket: e.volBucket,
        meanNet: cell.meanNet,
        nEff: cell.nEff,
        lReal: cell.lReal,
        disagreement: score.disagreement.d,
        advMicro: facts.get(code)!.advValueMicro,
        eval: e,
      });
    }
    const ranked = rankCandidates(passers, rule?.familyMeanNet ?? 0, params.cortex.rankShrinkN0);
    const taken: Decision[] = [];
    const rest: Decision[] = [];
    for (const r of ranked) {
      const e = r.candidate.eval;
      const dec = decisionOf(
        ctx,
        book,
        r.candidate.code,
        arm,
        e,
        r.rank,
        r.rankKey,
        r.shrunkMeanNet,
      );
      if (taken.length >= slots) {
        rest.push(dec);
        continue;
      }
      if (arm === "live" && taken.length > 0) {
        // the caps once more against tonight's earlier picks across the books (CTX-026 spans them)
        const again = gatePortfolio({
          bookId: book.bookId,
          code: dec.code,
          industry: facts.get(dec.code)!.industry,
          orderValueMicro: dec.orderValueMicro,
          exposures: [...exposures, ...tonight],
          arenaNavMicro: ctx.arenaNavMicro,
          caps: {
            maxBooksSameCode: params.cortex.maxBooksSameCode,
            maxCodeNavShare: params.cortex.maxCodeNavShare,
            maxIndustryNavShare: params.cortex.maxIndustryNavShare,
          },
        });
        if (!again.pass) {
          armBlocked.push({
            ...dec,
            trace: [
              ...dec.trace.filter((x) => x.gateId !== "G11_portfolio"),
              { ...again, gateId: "G11_portfolio" },
            ],
            firstFail: "G11_portfolio",
          });
          continue;
        }
      }
      taken.push(dec);
      if (arm === "live") {
        tonight.push({
          bookId: book.bookId,
          code: dec.code,
          industry: facts.get(dec.code)!.industry,
          exposureMicro: dec.orderValueMicro,
        });
      }
    }
    return { taken, queued: rest, blocked: armBlocked };
  };

  for (const book of books) {
    const allowed = (inputs.status[book.family] ?? "shadow") === "allowed";
    const deployable = deployableOf(book);
    const live = runArm(book, "live", allowed, deployable);
    decisions.push(...live.taken);
    queued.push(...live.queued);
    blocked.push(...live.blocked);
    const sh = runArm(book, "shadow", allowed, deployable);
    shadow.push(...sh.taken);
    blocked.push(...sh.blocked);
    if (live.taken.length === 0 && cashHolding(book)) {
      abstains.push(abstainOf(book.bookId, ctx.night, live.blocked));
    }
  }

  const universe = codes.map((c) => ({ code: c, industry: facts.get(c)!.industry }));
  return {
    status: mapMissing ? "abstain_all" : "ran",
    reason: mapMissing ? "map_missing" : null,
    manifest,
    features,
    activeSetHash: hash,
    decisions,
    queued,
    shadow,
    blocked,
    abstains,
    sectorTilt: sectorTiltOf(books, [...exposures, ...tonight], universe),
  };
}

// ---- would-have scoring (batch 3 helper) -----------------------------------------------------------------------------

export type WouldHaveInput = {
  readonly code: string;
  readonly family: Family;
  readonly qty: bigint;
  readonly limitMicro: Micro;
  /** The decision's exit plan (D-333): initial stop, trails, time stops, CS levels. */
  readonly plan: ExitPlan;
  /** ATR(20) at the decision (the trails read it). */
  readonly atrMicro: Micro | null;
  /** Raw bars of the sessions AFTER the decision night, oldest first (the first is the fill session). */
  readonly bars: readonly ViewBar[];
  readonly profile: CostProfile;
  readonly advMicro: Micro;
  readonly feeContext?: FeeContext;
};

export type WouldHaveOutcome = {
  readonly fillStatus: "filled" | "unfilled";
  readonly fillMicro: Micro | null;
  readonly fillD: string | null;
  readonly exitD: string | null;
  /** The exit fill's rule (`gap_open`, `level`, `close_signal`) and the plan rule behind a CS exit. */
  readonly exitRule: string | null;
  readonly csRule: string | null;
  readonly grossMicro: Micro | null;
  readonly netMicro: Micro | null;
  /** D-301: a net of exactly 0 is a loss. */
  readonly outcomeClass: "win" | "loss" | null;
  readonly stopMicro: Micro | null;
};

/**
 * One decision scored as a would-have trade (CTX-023, CTX-054; FAM-008 fill model): the limit fill
 * on the first later bar (`fillEntryLimit`, D-288), the initial stop referenced to the fill, then
 * the family's v1 plan walked through `evaluateExit` at every close (trail levels active from the
 * next session; CS rules — time stop, max hold, SMA, levels — fill at the next open; ARN-021
 * `selectExit` when both apply on one session). Unfilled = no trade in both arms. Returns null
 * while the hold is still open (not enough later bars).
 */
export function wouldHaveOutcome(input: WouldHaveInput): WouldHaveOutcome | null {
  const first = input.bars[0];
  if (first === undefined) return null;
  const env = (b: ViewBar): FillEnv => ({
    bar: toBar(b),
    advMicro: input.advMicro,
    profile: input.profile,
    feeContext: input.feeContext,
  });
  const entry = fillEntryLimit(env(first), input.qty, input.limitMicro);
  if (entry.status === "unfilled") {
    return {
      fillStatus: "unfilled",
      fillMicro: null,
      fillD: first.d,
      exitD: null,
      exitRule: null,
      csRule: null,
      grossMicro: null,
      netMicro: null,
      outcomeClass: null,
      stopMicro: null,
    };
  }
  const fill = entry.fill;
  const stop = initialStop(planStopSpec(input.plan, input.atrMicro), fill.fillPriceMicro);
  let level = stop;
  let highest = fill.fillPriceMicro;
  let pendingCs: string | null = null;
  let exit: SimulatedFill | null = null;
  let exitD: string | null = null;
  let csRule: string | null = null;
  for (let i = 0; i < input.bars.length; i += 1) {
    const b = input.bars[i]!;
    const cs = pendingCs === null ? null : fillCloseSignalExit(env(b), input.qty);
    const is =
      level > 0n ? fillIntradayStop(env(b), input.qty, level, { afterOpen: i === 0 }) : null;
    const chosen = selectExit(cs, is);
    if (chosen !== null) {
      exit = chosen;
      exitD = b.d;
      csRule = chosen === cs ? pendingCs : null;
      break;
    }
    if (b.close > highest) highest = b.close;
    const pos: PositionState = {
      tradeId: `wh:${input.code}:${first.d}`,
      code: input.code,
      family: input.family,
      plan: input.plan,
      fillDay: first.d,
      fillMicro: fill.fillPriceMicro,
      sessionsHeld: i + 1,
      closeMicro: b.close,
      highestCloseMicro: highest,
      atrMicro: input.atrMicro,
      closeAboveExitSma: null,
      volumeRatios: [],
      events: [],
    };
    const ev = evaluateExit(pos);
    for (const l of ev.isLevels) if (l.levelMicro > level) level = l.levelMicro;
    pendingCs = ev.cs?.rule ?? null;
  }
  if (exit === null) return null;
  const gross = exit.valueMicro - fill.valueMicro;
  const net = gross - fill.brokerageMicro - exit.brokerageMicro;
  return {
    fillStatus: "filled",
    fillMicro: fill.fillPriceMicro,
    fillD: first.d,
    exitD,
    exitRule: exit.rule,
    csRule,
    grossMicro: gross,
    netMicro: net,
    outcomeClass: net > 0n ? "win" : "loss",
    stopMicro: stop,
  };
}

// ---- canonical bytes -------------------------------------------------------------------------------------------------------

function canon(v: unknown): string {
  if (typeof v === "bigint") return `"${v}n"`;
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : `"${String(v)}"`;
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Map) {
    const keys = [...v.keys()].map(String).sort(byText);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v.get(k))}`).join(",")}}`;
  }
  if (v instanceof Set) return canon([...v]);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => byText(a, b));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`).join(",")}}`;
}

/** Canonical JSON of a night (bigint as "<decimal>n", Maps as sorted objects): the AT-50 byte identity. */
export function nightOutputJson(out: NightOutput): string {
  return canon(out);
}
