// Batch 2b inputs and entry selection (M4 T8; docs/M4_design.md 4.2, 4.3, 4.4; decisions 17-19).
//   loadDayInputs   A4 -> A3 -> A2 for session D through the DecisionView (every read is bounded by
//                   D and by cut-off(D)), reduced to the `FamilyInputs` the rule interpreter wants,
//                   plus the rows the agents record (events, regime, insider/flow score).
//   positionStates  the open trades as `PositionState`s, so `evaluatePositions` can decide the CS
//                   exits for D+1 and the IS levels to append to stop_level.
//   planEntries     FAM-001 / FAM-002 on top of the M3 sizing engine (`sizeEntry`, ARN-024a).
// Money is bigint micro-AUD and exact rationals; floats appear only for volatility (decile ranking)
// and the Wilder indicators inside the A4 module (design 2.1).
import type { Client } from "@libsql/client";
import { LookAheadError } from "@/lib/arena/marketData";
import { knownBy, quantityRatio, type CorpActionRecord } from "@/lib/arena/corpActions";
import { COST_PROFILES } from "@/lib/arena/costs";
import type { CohortParams } from "@/lib/arena/cohort";
import { rejectReasonText, sizeEntry, type SizingResult } from "@/lib/arena/sizing";
import {
  localToUtc,
  sessionsBetween,
  addDays,
  type CalendarRow,
  type MarketHours,
} from "@/lib/data/calendar";
import { divFloor, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import {
  createDecisionView,
  decisionCutoffUtc,
  type DecisionView,
  type ViewBar,
} from "./decisionView";
import { eventFactFromRow } from "./families/facts";
import { buildCodeFacts } from "./families/facts";
import { FAMILY_AGENT_VERSION } from "./families/constants";
import { compareCandidates } from "./families/context";
import { evaluatePositions } from "./families/exits";
import type {
  Candidate,
  CodeFacts,
  EventFact,
  ExitEvaluation,
  FamilyInputs,
  PositionState,
  Sources,
  Tier,
} from "./families/types";
import { eventsForDecision } from "./events";
import {
  DEFAULT_INDICATOR_PARAMS,
  logReturns,
  microToFloat,
  stdevFloat,
  volumeRatio,
  type Bar,
} from "./indicators";
import { insiderFlowFor } from "./insiderFlow";
import { crossing, scaleMicro, type Crossing } from "./orderPlan";
import type { AgentParams } from "./params";
import { computeRegime, type RegimeResult, type RegimeLabel } from "./regime";
import type { EventRow, InsiderFlowScoreRow } from "./schema";
import { shortInterestFor } from "./shortInterest";

/** The benchmark index code of the AU market (Batch 1 index stage, `^AXJO`). */
export const INDEX_CODE = "AXJO";
/** regime_daily.version: the rule version of the classifier (bumped when AGT-101 changes). */
export const REGIME_VERSION = 1;
/** signal.schema_version. */
export const SIGNAL_SCHEMA_VERSION = 1;
export const AGENT_VERSION = FAMILY_AGENT_VERSION;

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- corporate-action helpers ----------------------------------------------------------------------

export type SplitAction = {
  readonly exDate: string;
  readonly ratio: Rational;
  /** GL-02: when the action was first confirmed (null/absent = known since before the column). */
  readonly knownAt?: string | null;
};

const cutoffCache = new Map<string, string>();
/**
 * GL-02: the splits a decision on session `d` may use: ex-date <= d (DAT-126) AND confirmed by the
 * decision cut-off of d (known_at <= cut-off(d), `hhmm` is the decision_cut-off setting). The one
 * rule every replay reader shares; the cut-off instant is memoised per session.
 */
export function splitsKnownOn(
  splits: readonly SplitAction[],
  d: string,
  hhmm: string,
): SplitAction[] {
  const key = `${d}|${hhmm}`;
  let cut = cutoffCache.get(key);
  if (cut === undefined) {
    cut = decisionCutoffUtc(d, hhmm);
    cutoffCache.set(key, cut);
  }
  return knownBy(
    splits.filter((a) => a.exDate <= d),
    cut,
  );
}

/** Quantity-changing actions per code, exact; a code with an unreadable payload is reported bad. */
export function splitActionsByCode(actions: readonly CorpActionRecord[]): {
  readonly byCode: Map<string, SplitAction[]>;
  readonly bad: Set<string>;
} {
  const byCode = new Map<string, SplitAction[]>();
  const bad = new Set<string>();
  for (const a of actions) {
    if (a.type !== "split" && a.type !== "consolidation" && a.type !== "bonus_issue") continue;
    try {
      const list = byCode.get(a.code) ?? [];
      list.push({ exDate: a.exDate, ratio: quantityRatio(a), knownAt: a.knownAt ?? null });
      byCode.set(a.code, list);
    } catch {
      bad.add(a.code);
    }
  }
  return { byCode, bad };
}

/** Shares per share between a bar date (exclusive) and D: the product of later ex-date ratios. */
function ratioAfter(splits: readonly SplitAction[], barD: string): Rational {
  let r = makeRational(1n);
  for (const s of splits) if (s.exDate > barD) r = mulRat(r, s.ratio);
  return r;
}

export type AdjBar = Bar & { readonly d: string };

/** Bars on the basis of D (factors with ex-date <= D, DAT-126): prices / ratio, volume x ratio. */
export function adjustBars(bars: readonly ViewBar[], splits: readonly SplitAction[]): AdjBar[] {
  return bars.map((b) => {
    const ratio = ratioAfter(splits, b.d);
    if (ratio.num === ratio.den) {
      return { d: b.d, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    }
    const inv = makeRational(ratio.den, ratio.num);
    return {
      d: b.d,
      open: scaleMicro(b.open, inv),
      high: scaleMicro(b.high, inv),
      low: scaleMicro(b.low, inv),
      close: scaleMicro(b.close, inv),
      volume: scaleMicro(b.volume, ratio),
    };
  });
}

// ---- day inputs ---------------------------------------------------------------------------------------------

export type DayRequest = {
  readonly market: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly hours: MarketHours;
  readonly params: AgentParams;
  /** Replays read backfilled rows whose ingested_at is later than the cut-off by construction. */
  readonly replay: boolean;
  /** Codes held in open trades (their facts are built even when outside the universe). */
  readonly heldCodes: readonly string[];
  readonly actions: readonly CorpActionRecord[];
};

export type DayInputs = {
  readonly d: string;
  readonly cutoff: string;
  readonly view: DecisionView;
  readonly inputs: FamilyInputs;
  /** Facts of every universe code with a bar on D and of every held code. */
  readonly facts: ReadonlyMap<string, CodeFacts>;
  readonly adjusted: ReadonlyMap<string, readonly AdjBar[]>;
  readonly eventsByCode: ReadonlyMap<string, readonly EventFact[]>;
  /** vol20 (float) per universe code with enough history; the C2 decile key. */
  readonly vol20: ReadonlyMap<string, number>;
  readonly newEvents: readonly EventRow[];
  readonly scores: readonly InsiderFlowScoreRow[];
  readonly regime: { readonly d: string; readonly result: RegimeResult } | null;
  readonly partial: boolean;
  readonly partialReasons: readonly string[];
  readonly inputsRef: string;
};

function bigintCol(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError("expected an integer column value");
}

/** Bars to read per code: the longest window of any rule plus the Wilder warm-up (design 2.2). */
export function barsNeeded(p: AgentParams): number {
  const largest = (xs: readonly number[]): number => xs.reduce((m, x) => (x > m ? x : m), 0);
  const window = largest([
    p.f1.highLookback,
    p.windows.smaTrend,
    p.windows.returnWindow + 1,
    p.windows.adv + 1,
    p.windows.vol + 1,
    p.windows.volumeRatio + 1,
    p.f1.maxHold,
  ]);
  const warm =
    largest([p.windows.atr, p.windows.rsiLong]) * DEFAULT_INDICATOR_PARAMS.warmupMultiple;
  return window + warm;
}

async function sourcesOf(db: Client): Promise<Sources> {
  const rs = await db.execute(
    "SELECT source, mode FROM source_status WHERE source IN ('asx_announcements', 'asic_short')",
  );
  const mode = (name: string): "on" | "off" => {
    const row = rs.rows.find((r) => String(r.source) === name);
    return row !== undefined && String(row.mode) === "on" ? "on" : "off";
  };
  return { asx: mode("asx_announcements"), asic: mode("asic_short") };
}

export function eventRowOf(r: Record<string, unknown>): EventRow {
  const n = (v: unknown): number | null => (v === null ? null : Number(v)); // money-float-ok: SQL integer column read as a version/flag
  return {
    market: String(r.market),
    source: String(r.source),
    ann_id: String(r.ann_id),
    code: String(r.code),
    published_at: String(r.published_at),
    timed: Number(r.timed) === 1 ? 1 : 0, // money-float-ok: SQL integer column read as a version/flag
    day0_d: String(r.day0_d),
    group_key: String(r.group_key),
    category: String(r.category) as EventRow["category"],
    price_sensitive: Number(r.price_sensitive) === 1 ? 1 : 0, // money-float-ok: SQL integer column read as a version/flag
    ar_ppm: n(r.ar_ppm),
    ar_num: r.ar_num === null ? null : String(r.ar_num),
    ar_den: r.ar_den === null ? null : String(r.ar_den),
    vol_ratio_ppm: n(r.vol_ratio_ppm),
    polarity: Number(r.polarity) as EventRow["polarity"], // money-float-ok: SQL integer column read as a version/flag
    rule_version: String(r.rule_version),
    category_llm: r.category_llm === null ? null : String(r.category_llm),
    polarity_llm: r.polarity_llm === null ? null : (Number(r.polarity_llm) as never), // money-float-ok: SQL integer column read as a version/flag
  };
}

function vol20Of(adj: readonly AdjBar[], window: number): number | null {
  if (adj.length < window + 1) return null;
  const returns = logReturns(adj.map((b) => microToFloat(b.close)));
  return stdevFloat(returns.slice(-window), window, 1);
}

/** Consolidation within the ARN-011 window, in sessions before D (null = none known). */
function consolidationAgo(
  code: string,
  actions: readonly CorpActionRecord[],
  sessions: readonly string[],
): number | null {
  let best: number | null = null;
  const last = sessions.length - 1;
  for (const a of actions) {
    if (a.code !== code || a.type !== "consolidation") continue;
    const i = sessions.indexOf(a.exDate);
    if (i < 0) continue;
    const ago = last - i;
    if (best === null || ago < best) best = ago;
  }
  return best;
}

/**
 * A4 -> A3 -> A2 for D. Failures of A2/A3 are caught per agent and make the outputs partial
 * (AGT-004, decision 22); a look-ahead is a bug and always propagates.
 */
export async function loadDayInputs(db: Client, req: DayRequest): Promise<DayInputs> {
  const { market, d, params: p } = req;
  const cutoff = decisionCutoffUtc(d, p.decisionCutoff);
  const view = createDecisionView(db, { market, d, cutoff, liveIngestBound: !req.replay });
  const partialReasons: string[] = [];

  // sessions: enough for the longest event window (ARN-011) and the consolidation window
  const lookback = Math.max(p.arn011.placementWindow, p.arn011.consolidationWindow); // money-float-ok: window sizes in sessions
  const sessions = sessionsBetween(addDays(d, -lookback * 2), d, req.calendar);
  const sources = await sourcesOf(db);
  // GL-02: only actions confirmed by the decision cut-off of D exist for this decision
  const actions = knownBy(req.actions, cutoff);
  const { byCode: splitsByCode, bad } = splitActionsByCode(actions);

  // universe rows of D
  const uni = await db.execute({
    sql: `SELECT code, tier, halted FROM universe_snapshot
          WHERE market = ? AND d = ? AND d <= ? AND status = 'active' ORDER BY code`,
    args: [market, d, d],
  });
  const universe = uni.rows.map((r) => ({
    code: String(r.code),
    tier: String(r.tier) as Tier,
    halted: bigintCol(r.halted) === 1n,
  }));

  // A3: regime
  let regime: DayInputs["regime"] = null;
  try {
    regime = await computeRegime(view, INDEX_CODE, p, REGIME_VERSION);
  } catch (error) {
    if (error instanceof LookAheadError) throw error;
    partialReasons.push("a3_failed");
  }
  if (regime !== null && regime.d !== d) {
    partialReasons.push("a3_no_index_bar");
    regime = null;
  }
  if (regime === null && !partialReasons.some((x) => x.startsWith("a3"))) {
    partialReasons.push("a3_no_index_data");
  }
  const regimeLabel: RegimeLabel = regime === null ? "unknown" : regime.result.state;

  // A2: events (rows for announcements not yet recorded, then every usable stored row)
  let newEvents: EventRow[] = [];
  let a2Ok = sources.asx === "on";
  const windowStart = sessions[0] ?? d;
  const tz = req.hours.tz;
  const sinceIso = localToUtc(windowStart, "00:00", tz).toISOString();
  if (a2Ok) {
    try {
      newEvents = await eventsForDecision(view, {
        params: p,
        calendar: req.calendar,
        hours: req.hours,
        indexCode: INDEX_CODE,
        codes: universe.map((u) => u.code),
        sinceIso,
        prevCloseFactor: (code, day0) => {
          let f: Rational | null = null;
          for (const s of splitsByCode.get(code) ?? []) {
            if (s.exDate === day0) {
              f = mulRat(f ?? makeRational(1n), makeRational(s.ratio.den, s.ratio.num));
            }
          }
          return f;
        },
      });
    } catch (error) {
      if (error instanceof LookAheadError) throw error;
      a2Ok = false;
      partialReasons.push("a2_failed");
    }
  }
  const stored = await db.execute({
    sql: `SELECT * FROM event WHERE market = ? AND day0_d >= ? AND day0_d <= ? AND published_at < ?
          ORDER BY source, ann_id`,
    args: [market, windowStart, d, cutoff],
  });
  const rows = new Map<string, EventRow>();
  for (const r of stored.rows) {
    const row = eventRowOf(r as Record<string, unknown>);
    rows.set(`${row.source}|${row.ann_id}`, row);
  }
  for (const r of newEvents) rows.set(`${r.source}|${r.ann_id}`, r);

  // A4: per code facts
  const need = barsNeeded(p);
  const wanted = new Map<string, { tier: Tier; halted: boolean; universe: boolean }>();
  for (const u of universe) wanted.set(u.code, { tier: u.tier, halted: u.halted, universe: true });
  for (const code of req.heldCodes) {
    if (!wanted.has(code)) wanted.set(code, { tier: "U3", halted: false, universe: false });
  }
  const facts = new Map<string, CodeFacts>();
  const adjusted = new Map<string, readonly AdjBar[]>();
  const vol20 = new Map<string, number>();
  const scores: InsiderFlowScoreRow[] = [];
  const day0Low = new Map<string, bigint | null>();
  for (const code of [...wanted.keys()].sort(cmpStr)) {
    if (bad.has(code)) continue;
    const w = wanted.get(code)!;
    const raw = await view.bars(code, need);
    const last = raw[raw.length - 1];
    if (last === undefined || last.d !== d) continue; // no bar for D: no decision input
    const adj = adjustBars(raw, splitsByCode.get(code) ?? []);
    let score: InsiderFlowScoreRow | null = null;
    let shortDrop: boolean | "unknown" = "unknown";
    if (w.universe) {
      try {
        score = await insiderFlowFor(view, code, p, req.calendar, req.hours);
        scores.push(score);
        shortDrop = (await shortInterestFor(view, code, p, req.calendar)).drop;
      } catch (error) {
        if (error instanceof LookAheadError) throw error;
        partialReasons.push("a2_score_failed");
      }
    }
    facts.set(
      code,
      buildCodeFacts(
        {
          code,
          tier: w.tier,
          adjusted: adj,
          raw,
          halted: w.halted,
          insiderScoreQ: score === null ? null : score.score_q,
          shortDrop,
          consolidationSessionsAgo: consolidationAgo(code, actions, sessions),
          promotional: false,
        },
        p,
      ),
    );
    adjusted.set(code, adj);
    if (w.universe) {
      const v = vol20Of(adj, p.windows.vol);
      if (v !== null) vol20.set(code, v);
    }
  }

  // event facts (the day-0 raw low comes from the day-0 bar)
  const eventsByCode = new Map<string, EventFact[]>();
  const allEvents: EventFact[] = [];
  for (const row of [...rows.values()].sort(
    (a, b) =>
      cmpStr(a.day0_d, b.day0_d) || cmpStr(a.source, b.source) || cmpStr(a.ann_id, b.ann_id),
  )) {
    if (!facts.has(row.code) && !wanted.has(row.code)) continue;
    const key = `${row.code}|${row.day0_d}`;
    if (!day0Low.has(key)) {
      const b = await view.bars(row.code, 1, row.day0_d);
      day0Low.set(key, b.length > 0 && b[0]!.d === row.day0_d ? b[0]!.low : null);
    }
    const fact = eventFactFromRow(row, day0Low.get(key) ?? null);
    allEvents.push(fact);
    const list = eventsByCode.get(row.code) ?? [];
    list.push(fact);
    eventsByCode.set(row.code, list);
  }

  // an upstream failure: event families make no new entries (as ASX off), F1/F4 continue (decision 22)
  const effectiveSources: Sources = a2Ok ? sources : { ...sources, asx: "off" };
  const universeFacts = universe
    .map((u) => facts.get(u.code))
    .filter((f): f is CodeFacts => f !== undefined);
  const inUniverse = new Set(universeFacts.map((f) => f.code));
  const ingest = await db.execute({
    sql: `SELECT MAX(ingested_at) AS at FROM price_bar WHERE market = ? AND d = ? AND d <= ?`,
    args: [market, d, d],
  });
  const at =
    ingest.rows.length === 0 || ingest.rows[0]!.at === null ? "none" : String(ingest.rows[0]!.at);
  const marker = await db.execute({
    sql: "SELECT run_id FROM completion_marker WHERE market = ? AND d = ? AND kind = 'data'",
    args: [market, d],
  });
  const run =
    marker.rows.length === 0 || marker.rows[0]!.run_id === null
      ? "none"
      : String(marker.rows[0]!.run_id);
  return {
    d,
    cutoff,
    view,
    inputs: {
      market,
      d,
      regime: regimeLabel,
      sessions,
      sources: effectiveSources,
      eventCoverage: a2Ok,
      codes: universeFacts,
      events: allEvents.filter((e) => inUniverse.has(e.code)),
    },
    facts,
    adjusted,
    eventsByCode,
    vol20,
    newEvents,
    scores,
    regime,
    partial: partialReasons.length > 0,
    partialReasons,
    inputsRef: `batch1:${run}@${at}`,
  };
}

// ---- open positions: exits and stop levels (design 2.6) ------------------------------------------------

export type OpenTrade = {
  readonly tradeId: string;
  readonly cohortId: string;
  readonly code: string;
  readonly fillD: string;
  readonly fillMicro: bigint;
  readonly stopSpec: string | null;
  /** Decision Card of the entry order (exit orders link to it, decision 20). */
  readonly cardId?: string | null;
};

/** Everything `evaluatePositions` needs for one open trade, on the basis of D (raw prices at D). */
export function positionState(
  trade: OpenTrade,
  plan: import("./orderPlan").OrderPlan,
  day: DayInputs,
  actions: readonly CorpActionRecord[],
  calendar: readonly CalendarRow[],
  p: AgentParams,
): PositionState | null {
  const facts = day.facts.get(trade.code);
  const adj = day.adjusted.get(trade.code);
  if (facts === undefined || adj === undefined) return null;
  const d = day.d;
  const sinceFill = crossing(actions, trade.code, trade.fillD, d);
  const applied = new Set(plan.caApplied);
  const sinceBasis = crossing(actions, trade.code, plan.caThrough, d, applied);
  const atFill = crossing(actions, trade.code, plan.caThrough, trade.fillD, applied);
  const fillMicro = scaleMicro(trade.fillMicro, sinceFill.priceFactor);
  let highest = 0n;
  for (const b of adj) if (b.d >= trade.fillD && b.close > highest) highest = b.close;
  if (highest === 0n) highest = facts.bar.close;

  // rules whose levels were written in caThrough terms are re-based to D; control levels are
  // anchored on the actual fill
  const cs = plan.plan.cs.map((rule) =>
    rule.kind === "close_below_level"
      ? { ...rule, levelMicro: scaleMicro(rule.levelMicro, sinceBasis.priceFactor) }
      : rule,
  );
  for (const rel of plan.rel) {
    const atrAtFill = scaleMicro(rel.atrMicro, atFill.priceFactor);
    const level = trade.fillMicro - scaleMicro(atrAtFill, rel.k);
    cs.push({
      id: rel.id,
      via: null,
      kind: "close_below_level",
      levelMicro: scaleMicro(level < 1n ? 1n : level, sinceFill.priceFactor),
    });
  }
  const dry = plan.plan.cs.reduce(
    (m, r) => (r.kind === "volume_dry_up" && r.sessions > m ? r.sessions : m),
    0,
  );
  const volumes = adj.map((b) => b.volume);
  const ratios: (Rational | null)[] = [];
  for (let j = dry - 1; j >= 0; j--) {
    ratios.push(volumeRatio(volumes.slice(0, volumes.length - j), p.windows.volumeRatio));
  }
  const held = sessionsBetween(trade.fillD, d, calendar).length;
  return {
    tradeId: trade.tradeId,
    code: trade.code,
    family: plan.family,
    plan: { ...plan.plan, cs },
    fillDay: trade.fillD,
    fillMicro,
    sessionsHeld: held,
    closeMicro: facts.bar.close,
    highestCloseMicro: highest,
    atrMicro: facts.ind.atrWarm ? facts.ind.atrMicro : null,
    closeAboveExitSma: facts.ind.closeAboveSmaShort,
    volumeRatios: ratios,
    events: day.eventsByCode.get(trade.code) ?? [],
  };
}

export function evaluateOpen(states: readonly PositionState[]): ExitEvaluation[] {
  return evaluatePositions(states);
}

// ---- entry selection (FAM-001, FAM-002) ----------------------------------------------------------------------

/** Rank order with the FAM-001 tie-breaks, one candidate per code (the first). */
export function rankedCandidates(list: readonly Candidate[]): Candidate[] {
  const sorted = [...list].sort(compareCandidates);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const c of sorted) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    out.push(c);
  }
  return out;
}

export type SizingContext = {
  readonly params: CohortParams;
  /** Available cash for entries and the NAV the cash buffer is taken from. */
  readonly cashMicro: bigint;
  readonly navMicro: bigint;
  /** Sleeve margin + entry brokerage to keep free for the leg that carries the sleeve (ARN-003). */
  readonly sleeveReserveMicro: bigint;
};

export type SizingEnv = {
  readonly refPriceMicro: bigint;
  readonly advValueMicro: bigint;
  readonly adv20Shares: bigint;
  readonly tier: Tier;
  readonly code: string;
};

export type Leg = {
  readonly key: string;
  readonly halfSize: boolean;
  readonly env: SizingEnv;
  /** This leg is the one a leverage sleeve would open with (at most one per cohort, ARN-003). */
  readonly sleeve: boolean;
};

export type LegResult = { readonly leg: Leg; readonly sizing: SizingResult };

const HALF = makeRational(1n, 2n);

function scaleFraction(v: bigint, f: Rational): bigint {
  return divFloor(v * f.num, f.den);
}

/** One leg through the M3 sizing engine on `fraction` of the cash and the NAV (ARN-024a). */
export function sizeLeg(ctx: SizingContext, leg: Leg, legs: number): SizingResult {
  const fraction = mulRat(
    legs === 2 ? HALF : makeRational(1n),
    leg.halfSize ? HALF : makeRational(1n),
  );
  const cash = scaleFraction(ctx.cashMicro < 0n ? 0n : ctx.cashMicro, fraction);
  const nav = scaleFraction(ctx.navMicro, fraction);
  return sizeEntry({
    settledCashMicro: cash,
    navMicro: nav,
    sleeveMarginMicro: leg.sleeve ? ctx.sleeveReserveMicro : 0n,
    refPriceMicro: leg.env.refPriceMicro,
    advValueMicro: leg.env.advValueMicro,
    adv20Shares: leg.env.adv20Shares,
    tier: leg.env.tier,
    profile: COST_PROFILES[ctx.params.costProfile],
    feeContext: { code: leg.env.code, firstBuyOfSecurityToday: true },
    minParcelMicro: ctx.params.minParcelMicro,
    participationCap: ctx.params.participationCap,
    cashBuffer: ctx.params.cashBuffer,
    tickCrossFactor: ctx.params.tickCrossFactor,
  });
}

/**
 * FAM-001: one slot or one candidate -> the top-ranked at full size. Two slots and two candidates ->
 * both at half the cash, only if BOTH meet every sizing rule; otherwise the top-ranked alone at
 * full size. "Half size" (F4 in SHOCK) halves again and must still meet the parcel; a failure is a
 * rejection with its reasons (no entry).
 */
export function planLegs(ctx: SizingContext, ranked: readonly Leg[], slots: number): LegResult[] {
  if (ranked.length === 0 || slots < 1) return [];
  if (slots >= 2 && ranked.length >= 2) {
    const two = [ranked[0]!, ranked[1]!].map((leg) => ({ leg, sizing: sizeLeg(ctx, leg, 2) }));
    if (two.every((r) => r.sizing.accepted)) return two;
  }
  const top = ranked[0]!;
  return [{ leg: top, sizing: sizeLeg(ctx, top, 1) }];
}

export { rejectReasonText };

// ---- ADV in D+1 terms and the reference price ----------------------------------------------------------------

export type EntryEnvInput = {
  readonly facts: CodeFacts;
  readonly cross: Crossing;
  readonly p: AgentParams;
};

/** Reference price (D close on the basis of the fill session) and ADV figures for sizing. */
export function sizingEnvFor(input: EntryEnvInput): SizingEnv {
  const { facts, cross, p } = input;
  const bars = facts.rawBars.slice(-p.windows.adv);
  let value = 0n;
  let shares = 0n;
  for (const b of bars) {
    value += b.close * b.volume;
    shares += b.volume;
  }
  const n = BigInt(bars.length === 0 ? 1 : bars.length);
  return {
    refPriceMicro: scaleMicro(facts.bar.close, cross.priceFactor),
    advValueMicro: divFloor(value, n),
    adv20Shares: scaleMicro(divFloor(shares, n), cross.ratio),
    tier: facts.tier,
    code: facts.code,
  };
}
