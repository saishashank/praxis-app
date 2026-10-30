// Fixed-notional returns for the signal ledger and its controls (M4 T11; design 2.7, D-088 draft;
// ARN-080/081/083/094, VAL-110 v-vi). Pure and exact: bigint micro amounts and rationals only, no
// float, no clock, no random source. One position is "walked" session by session from its entry
// fill: the entry at the next open (ARN-032 slippage of the row's ADV bucket, P5 brokerage), the
// family's exits (IS levels, CS orders for the next open, same fill rules as M3), the stressed
// twin (P3 + 50 % slippage, ARN-083) and the daily mark-to-market series. Rows and controls use
// the SAME walk, so a control's return is computed identically to a row's (design 2.7).
import type { ViewBar } from "@/lib/agents/decisionView";
import {
  evaluateExit,
  gapCancelsAtFill,
  initialStop,
  type CsTrigger,
  type EventFact,
  type ExitPlan,
} from "@/lib/agents/families";
import type { AgentParams } from "@/lib/agents/params";
import { feeFor, getCostProfile, type CostProfile } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  fillIntradayStop,
  selectExit,
  type Bar as FillBar,
  type FillEnv,
  type SimulatedFill,
} from "@/lib/arena/fills";
import {
  DEFAULT_TICK_CROSS_FACTOR,
  SLIPPAGE_BUCKETS,
  slippageFill,
  type SlippageBucket,
} from "@/lib/arena/slippage";
import {
  addRat,
  divFloor,
  makeRational,
  mulRat,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import { toMicroFromVendor } from "@/lib/money/micro";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import {
  dividendAmountMicro,
  parseDividend,
  planCorporateActions,
  type CorpActionRecord,
} from "@/lib/arena/corpActions";
import { exDividendOn, toExDividendActions } from "@/lib/arena/exDividend";

const QTY_CHANGING: ReadonlySet<string> = new Set(["split", "consolidation", "bonus_issue"]);
const CLOSING: ReadonlySet<string> = new Set(["merger_cash", "merger_scrip", "delisting"]);

// ---------------------------------------------------------------------------------------------
// What a walk reads from the world
// ---------------------------------------------------------------------------------------------

/** Facts about an open position's code as of the close of one session (what `evaluateExit` needs). */
export type PositionFacts = {
  readonly atrMicro: bigint | null;
  /** Close vs the CS SMA (F4); null in warm-up. */
  readonly closeAboveExitSma: boolean | null;
  /** Volume ratios of the last sessions, oldest first, ending that session (F5 dry-up). */
  readonly volumeRatios: readonly (Rational | null)[];
  /** Events of the code with day 0 on or before that session. */
  readonly events: readonly EventFact[];
};

/**
 * The only door a walk uses to read prices. `bar(code, d)` is the RAW bar of a session or null
 * (no trading); `positionFacts(code, d)` must use data up to the close of `d` only. A source that
 * answers from a snapshot bounds both by `d`; the walk never asks for a session it has not reached.
 */
export interface PathSource {
  /** Confirmed corporate actions of a code (the walk reads those with an ex-date inside the hold). */
  corpActions?(code: string): readonly CorpActionRecord[];
  /**
   * FAM-007 (GL-02): the decision cut-off instant (ISO) of session `d`. A dividend going ex on the
   * next session counts for the stop only when confirmed by it. Required (D-282b), so a source cannot silently skip dated dividends; before: applied only
   * dividends with no `known_at` (conservative: nothing is assumed known).
   */
  decisionCutoffOf(d: string): string;
  /** Trading sessions, oldest first (the snapshot calendar). */
  readonly sessions: readonly string[];
  bar(code: string, d: string): ViewBar | null;
  positionFacts(code: string, d: string): PositionFacts | null;
}

/** Session bars from a loaded snapshot (`loadSnapshot` output), prices converted to micro once. */
export function snapshotBarLookup(snapshot: {
  readonly bars: readonly {
    readonly code: string;
    readonly d: string;
    readonly o: number;
    readonly h: number;
    readonly l: number;
    readonly c: number;
    readonly volume: number;
  }[];
  readonly tables: { readonly calendar?: readonly unknown[] };
}): { sessions: string[]; bar: (code: string, d: string) => ViewBar | null } {
  const sessions = (snapshot.tables.calendar ?? [])
    .map((r) => r as { d: string; kind: string })
    .filter((r) => r.kind === "session" || r.kind === "early_close")
    .map((r) => r.d)
    .sort();
  const byCode = new Map<string, Map<string, ViewBar>>();
  for (const b of snapshot.bars) {
    let m = byCode.get(b.code);
    if (m === undefined) {
      m = new Map();
      byCode.set(b.code, m);
    }
    m.set(b.d, {
      d: b.d,
      open: toMicroFromVendor(b.o),
      high: toMicroFromVendor(b.h),
      low: toMicroFromVendor(b.l),
      close: toMicroFromVendor(b.c),
      volume: BigInt(b.volume),
    });
  }
  return { sessions, bar: (code, d) => byCode.get(code)?.get(d) ?? null };
}

// ---------------------------------------------------------------------------------------------
// Cost set-up: P5 (absolute-gate profile) and the stress twin (P3 + 50 % slippage)
// ---------------------------------------------------------------------------------------------

export type CostSetup = {
  readonly notionalMicro: bigint;
  readonly profile: CostProfile;
  readonly buckets: readonly SlippageBucket[];
  readonly stressProfile: CostProfile;
  readonly stressBuckets: readonly SlippageBucket[];
};

/** The absolute-gate profile of ARN-081 / VAL-110 (i). */
export const LEDGER_COST_PROFILE = "P5";

const PERCENT_BASE = 100n; // threshold-ok: percent denominator for the stress slippage uplift

/** Slippage buckets with every bps multiplied by (100 + extraPct) / 100 (exact). */
export function scaleBuckets(
  buckets: readonly SlippageBucket[],
  extraPct: bigint,
): SlippageBucket[] {
  const factor = makeRational(PERCENT_BASE + extraPct, PERCENT_BASE);
  return buckets.map((b) => ({ fromAdvMicro: b.fromAdvMicro, bps: mulRat(b.bps, factor) }));
}

/** Cost set-up from the resolved parameters (notional, stress profile and uplift are keys). */
export function costSetupFrom(
  p: AgentParams,
  buckets: readonly SlippageBucket[] = SLIPPAGE_BUCKETS,
): CostSetup {
  return {
    notionalMicro: p.replay.ledgerNotionalMicro,
    profile: getCostProfile(LEDGER_COST_PROFILE),
    buckets,
    stressProfile: getCostProfile(p.stats.stressCostProfile),
    stressBuckets: scaleBuckets(buckets, BigInt(p.stats.stressSlippageExtraPct)),
  };
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

export type PositionSpec = {
  readonly code: string;
  readonly plan: ExitPlan;
  /** Index (in `sessions`) of the session whose open is the entry fill. */
  readonly entryIdx: number;
  /** Last session index the walk may read (the end of the snapshot). */
  readonly endIdx: number;
  /** 20-session ADV (traded value, micro) of the decision session: the slippage bucket. */
  readonly advMicro: bigint;
  /** F3: cancel at the fill when the open is at or above this raw price. */
  readonly maxOpenMicro: bigint | null;
  /** Close the position at the last session's open if it is still open (controls). */
  readonly forceExit: boolean;
};

export type MtmPoint = { readonly d: string; readonly pnlMicro: bigint };

export type WalkExit = {
  readonly d: string;
  readonly idx: number;
  readonly tag: "IS" | "CS";
  /** Shares sold (after any re-base by splits, consolidations and bonus issues). */
  readonly qtyOut: bigint;
  /** Cash received net of brokerage (exact; the stated terms for a corporate-action exit). */
  readonly proceedsMicro: bigint;
  readonly stressProceedsMicro: bigint;
  /** CS rule id, `end_of_data` for a forced exit, or `stop` for an IS exit. */
  readonly rule: string;
  readonly fillOutMicro: bigint;
  readonly brokOutMicro: bigint;
  /** Reference price of the exit (open for CS and gaps, the stop level for an in-range stop). */
  readonly refOutMicro: bigint;
  readonly stressFillOutMicro: bigint;
  readonly stressBrokOutMicro: bigint;
};

export type WalkFilled = {
  readonly kind: "filled";
  readonly code: string;
  readonly entryD: string;
  readonly entryIdx: number;
  readonly qty: bigint;
  readonly fillInMicro: bigint;
  readonly brokInMicro: bigint;
  readonly refInMicro: bigint;
  readonly stressFillInMicro: bigint;
  readonly stressBrokInMicro: bigint;
  readonly exit: WalkExit | null;
  /** Cash dividends credited at their ex-dates (ARN-036, franking excluded). */
  readonly dividendMicro: bigint;
  /** corp_action_in_hold when an action in the hold is not modelled (rights, spin-off, ...). */
  readonly flags: readonly string[];
  /** The exit was forced at the end of the data (censored path). */
  readonly forced: boolean;
  readonly mtm: readonly MtmPoint[];
};

export type SkipReason = "no_session" | "no_bar" | "gap" | "unaffordable" | "no_room";
export type WalkSkipped = { readonly kind: "skipped"; readonly reason: SkipReason };
export type WalkResult = WalkFilled | WalkSkipped;

function fillBar(b: ViewBar): FillBar {
  return { openMicro: b.open, highMicro: b.high, lowMicro: b.low, closeMicro: b.close };
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Highest initial stop of the plan (F6 carries its contributors' stops: the earliest exit wins). */
function initialLevel(plan: ExitPlan, fillMicro: bigint): bigint {
  let level = 0n;
  for (const rule of plan.initialStops) {
    const s = rule.spec;
    if (s.k !== null && s.atr_micro === null) continue; // no warm ATR: the ATR part is unavailable
    level = maxBig(level, initialStop(s, fillMicro));
  }
  return level;
}

/**
 * Walk one position from its entry fill. Entry: ARN-032 slippage of the ADV bucket, quantity
 * floor(notional / fill), P5 brokerage. Each session after the entry: a CS order decided at the
 * previous close fills at the open, the IS level (initial, or the latest trailing levels, design
 * 2.6) is tested against the bar, and `selectExit` picks the earlier one (ARN-021, D-071). At each
 * close the plan's CS rules and trailing levels are evaluated with `evaluateExit` (the same
 * function the live batch runs). A session without a bar is carried; nothing here reads a session
 * later than the one being processed.
 */
export function walkPosition(src: PathSource, spec: PositionSpec, cost: CostSetup): WalkResult {
  const { sessions } = src;
  const entryD = sessions[spec.entryIdx];
  if (entryD === undefined || spec.entryIdx > spec.endIdx)
    return { kind: "skipped", reason: "no_session" };
  if (spec.forceExit && spec.entryIdx >= spec.endIdx) return { kind: "skipped", reason: "no_room" };
  const entryBar = src.bar(spec.code, entryD);
  if (entryBar === null) return { kind: "skipped", reason: "no_bar" };
  if (spec.maxOpenMicro !== null && gapCancelsAtFill(entryBar.open, spec.maxOpenMicro)) {
    return { kind: "skipped", reason: "gap" };
  }
  const envOf = (bar: ViewBar, stress: boolean): FillEnv => ({
    bar: fillBar(bar),
    advMicro: spec.advMicro,
    profile: stress ? cost.stressProfile : cost.profile,
    buckets: stress ? cost.stressBuckets : cost.buckets,
  });

  const price = slippageFill(
    entryBar.open,
    "buy",
    spec.advMicro,
    DEFAULT_TICK_CROSS_FACTOR,
    cost.buckets,
  ).fillMicro;
  const qty0 = divFloor(cost.notionalMicro, price);
  if (qty0 <= 0n) return { kind: "skipped", reason: "unaffordable" };
  const entry = fillEntryAtOpen(envOf(entryBar, false), qty0);
  const stressEntry = fillEntryAtOpen(envOf(entryBar, true), qty0);

  let level0 = initialLevel(spec.plan, entry.fillPriceMicro);
  let plan: ExitPlan = spec.plan;
  let frameFill = entry.fillPriceMicro;
  let qty = qty0;
  let trailLevels: readonly bigint[] = [];
  let pending: CsTrigger | null = null;
  let highest = 0n;
  let prevClose = 0n;
  let heldValue = entry.valueMicro + entry.brokerageMicro;
  let divTotal = 0n;
  let divPending = 0n;
  let exit: WalkExit | null = null;
  let forced = false;
  const flags = new Set<string>();
  const mtm: MtmPoint[] = [];

  const actionsByD = new Map<string, CorpActionRecord[]>();
  for (const a of src.corpActions?.(spec.code) ?? []) {
    if (a.exDate <= entryD) continue;
    const list = actionsByD.get(a.exDate);
    if (list === undefined) actionsByD.set(a.exDate, [a]);
    else list.push(a);
  }
  const exDivs = toExDividendActions(
    (src.corpActions?.(spec.code) ?? []).filter((a) => a.exDate > entryD),
  );
  const exDivAt = (i: number, d: string): bigint =>
    exDividendOn(exDivs, spec.code, d, src.decisionCutoffOf(sessions[i - 1] ?? ""));
  const rebase = (price: bigint, ratio: Rational): bigint => divFloor(price * ratio.den, ratio.num);

  const closeOut = (
    idx: number,
    bar: ViewBar,
    chosen: SimulatedFill,
    rule: string,
    tag: "IS" | "CS",
    level: bigint,
  ): void => {
    const stressSell =
      chosen.rule === "close_signal"
        ? fillCloseSignalExit(envOf(bar, true), qty)
        : fillIntradayStop(envOf(bar, true), qty, level, {
            afterOpen: idx === spec.entryIdx,
            exDividendMicro: exDivAt(idx, bar.d),
          });
    if (stressSell === null)
      throw new RangeError("stress exit did not fill where the base exit did");
    const proceeds = qty * chosen.fillPriceMicro - chosen.brokerageMicro;
    exit = {
      d: bar.d,
      idx,
      tag,
      rule,
      qtyOut: qty,
      fillOutMicro: chosen.fillPriceMicro,
      brokOutMicro: chosen.brokerageMicro,
      refOutMicro: chosen.refPriceMicro,
      proceedsMicro: proceeds,
      stressFillOutMicro: stressSell.fillPriceMicro,
      stressBrokOutMicro: stressSell.brokerageMicro,
      stressProceedsMicro: qty * stressSell.fillPriceMicro - stressSell.brokerageMicro,
    };
    mtm.push({ d: bar.d, pnlMicro: proceeds + divPending - heldValue });
    divPending = 0n;
  };

  /** Corporate actions with ex-date d, on the holding at the prior close. True = position closed. */
  const applyActions = (i: number, d: string, acts: readonly CorpActionRecord[]): boolean => {
    const rest: CorpActionRecord[] = [];
    for (const rec of [...acts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (rec.type === "cash_dividend" || rec.type === "special_dividend") {
        // ARN-036: round_half_away(qty x dps) on the holding at the prior close; franking excluded
        const amount = dividendAmountMicro(qty, parseDividend(rec).dpsMicro);
        divTotal += amount;
        divPending += amount;
      } else if (QTY_CHANGING.has(rec.type) || CLOSING.has(rec.type)) rest.push(rec);
      else flags.add("corp_action_in_hold"); // rights, spin-offs, code changes: not modelled
    }
    if (rest.length === 0) return false;
    const day = planCorporateActions({
      d,
      priorD: sessions[i - 1]!,
      actions: rest,
      fills: [
        {
          id: "walk",
          d: entryD,
          code: spec.code,
          side: "buy",
          qty,
          valueMicro: entry.valueMicro,
          brokerageMicro: 0n,
        },
      ],
      adjustments: [],
      ledgerRows: [],
      lastCloseFor: () => (prevClose > 0n ? prevClose : undefined),
    });
    for (const adj of day.adjustments) {
      if (adj.qtyAfter === 0n) {
        let proceeds = 0n;
        for (const t of day.txns) {
          if (t.kind !== "ca_dispose") continue;
          for (const post of t.postings)
            if (post.account === "cash_settled") proceeds += post.deltaMicro;
        }
        const perShare = roundHalfAwayFromZero(makeRational(proceeds, adj.qtyBefore));
        const fillOut = perShare > 0n ? perShare : 1n; // the column needs > 0; exact proceeds are kept
        exit = {
          d,
          idx: i,
          tag: "CS",
          rule: `corp_action:${adj.type}`,
          qtyOut: adj.qtyBefore,
          fillOutMicro: fillOut,
          brokOutMicro: 0n,
          refOutMicro: fillOut,
          proceedsMicro: proceeds,
          stressFillOutMicro: fillOut,
          stressBrokOutMicro: 0n,
          stressProceedsMicro: proceeds,
        };
        mtm.push({ d, pnlMicro: proceeds + divPending - heldValue });
        divPending = 0n;
        return true;
      }
      // split / consolidation / bonus: whole shares, cost unchanged (ARN-043); price state re-based
      qty = adj.qtyAfter;
      frameFill = rebase(frameFill, adj.ratio);
      level0 = rebase(level0, adj.ratio);
      highest = rebase(highest, adj.ratio);
      trailLevels = trailLevels.map((l) => rebase(l, adj.ratio));
      plan = {
        ...plan,
        cs: plan.cs.map((r) =>
          r.kind === "close_below_level"
            ? { ...r, levelMicro: rebase(r.levelMicro, adj.ratio) }
            : r,
        ),
      };
    }
    return false;
  };

  for (let i = spec.entryIdx; i <= spec.endIdx; i += 1) {
    const d = sessions[i];
    if (d === undefined) break;
    const acts = i === spec.entryIdx ? undefined : actionsByD.get(d);
    if (acts !== undefined && applyActions(i, d, acts)) break;
    const bar = i === spec.entryIdx ? entryBar : src.bar(spec.code, d);
    if (bar === null) continue;

    if (i === spec.entryIdx) {
      const is =
        level0 > 0n ? fillIntradayStop(envOf(bar, false), qty, level0, { afterOpen: true }) : null;
      if (is !== null) {
        closeOut(i, bar, is, "stop", "IS", level0);
        break;
      }
    } else {
      if (spec.forceExit && i === spec.endIdx && pending === null) {
        pending = { rule: "end_of_data", via: null, detail: "end of the data" };
        forced = true;
      }
      const cs = pending === null ? null : fillCloseSignalExit(envOf(bar, false), qty);
      let level = level0;
      for (const l of trailLevels) level = maxBig(level, l);
      const is =
        level > 0n
          ? fillIntradayStop(envOf(bar, false), qty, level, { exDividendMicro: exDivAt(i, d) })
          : null;
      const chosen = selectExit(cs, is);
      if (chosen !== null) {
        const isCs = chosen.rule === "close_signal";
        closeOut(
          i,
          bar,
          chosen,
          isCs ? (pending?.rule ?? "cs") : "stop",
          isCs ? "CS" : "IS",
          level,
        );
        break;
      }
    }

    // still open at the close
    const value = qty * bar.close;
    mtm.push({ d, pnlMicro: value + divPending - heldValue });
    divPending = 0n;
    heldValue = value;
    prevClose = bar.close;
    highest = maxBig(highest, bar.close);
    if (i === spec.endIdx) break;

    const facts = src.positionFacts(spec.code, d);
    if (facts === null) {
      pending = null;
      continue;
    }
    const ev = evaluateExit({
      tradeId: "walk",
      code: spec.code,
      family: "F1", // evaluateExit does not branch on the family; the plan carries every rule
      plan,
      fillDay: entryD,
      fillMicro: frameFill,
      sessionsHeld: i - spec.entryIdx + 1,
      closeMicro: bar.close,
      highestCloseMicro: highest,
      atrMicro: facts.atrMicro,
      closeAboveExitSma: facts.closeAboveExitSma,
      volumeRatios: facts.volumeRatios,
      events: facts.events,
    });
    pending = ev.cs;
    trailLevels = ev.isLevels.map((l) => l.levelMicro);
  }

  return {
    kind: "filled",
    code: spec.code,
    entryD,
    entryIdx: spec.entryIdx,
    qty: qty0,
    fillInMicro: entry.fillPriceMicro,
    brokInMicro: entry.brokerageMicro,
    refInMicro: entry.refPriceMicro,
    stressFillInMicro: stressEntry.fillPriceMicro,
    stressBrokInMicro: stressEntry.brokerageMicro,
    exit,
    forced,
    dividendMicro: divTotal,
    flags: [...flags].sort(),
    mtm,
  };
}

// ---------------------------------------------------------------------------------------------
// Exact returns
// ---------------------------------------------------------------------------------------------

/** An exact fraction of micro amounts (not reduced: the numerator and denominator are the amounts). */
export type Fraction = { readonly num: bigint; readonly den: bigint };

export type Economics = {
  /** qty x fill_in + brokerage_in. */
  readonly costMicro: bigint;
  /** qty x fill_out - brokerage_out. */
  readonly proceedsMicro: bigint;
  /** Net return proceeds / cost - 1 as (proceeds - cost) / cost. */
  readonly net: Fraction;
  /** Stressed twin (P3 + 50 % slippage). */
  readonly stressInMicro: bigint;
  readonly stressOutMicro: bigint;
  readonly stress: Fraction;
  /** Gross: (qty x ref_out) / (qty x ref_in) - 1 before brokerage and slippage (ARN-094). */
  readonly gross: Fraction;
};

/** Amounts of a closed position; null while it is open. */
export function economicsOf(w: WalkFilled): Economics | null {
  const x = w.exit;
  if (x === null) return null;
  const costMicro = w.qty * w.fillInMicro + w.brokInMicro;
  const proceedsMicro = x.proceedsMicro + w.dividendMicro;
  const stressInMicro = w.qty * w.stressFillInMicro + w.stressBrokInMicro;
  const stressOutMicro = x.stressProceedsMicro + w.dividendMicro;
  return {
    costMicro,
    proceedsMicro,
    net: { num: proceedsMicro - costMicro, den: costMicro },
    stressInMicro,
    stressOutMicro,
    stress: { num: stressOutMicro - stressInMicro, den: stressInMicro },
    gross: {
      num: x.qtyOut * x.refOutMicro + w.dividendMicro - w.qty * w.refInMicro,
      den: w.qty * w.refInMicro,
    },
  };
}

/** A fraction as a normalised rational (for sums and means). */
export function fractionToRational(f: Fraction): Rational {
  return makeRational(f.num, f.den);
}

/** Mean of exact rationals; null for an empty list. */
export function meanRational(values: readonly Rational[]): Rational | null {
  if (values.length === 0) return null;
  let sum = makeRational(0n);
  for (const v of values) sum = addRat(sum, v);
  return mulRat(sum, makeRational(1n, BigInt(values.length)));
}

/** Paired excess of a row over its controls: r - mean(c_j) (decision 25). */
export function pairedExcess(row: Rational, controls: readonly Rational[]): Rational | null {
  const m = meanRational(controls);
  return m === null ? null : subRat(row, m);
}

/** A row's brokerage for a standalone order value (used by cost feasibility; P5 each side). */
export function roundTripBrokerage(cost: CostSetup, valueMicro: bigint): bigint {
  return feeFor(cost.profile, valueMicro, "buy") + feeFor(cost.profile, valueMicro, "sell");
}

// ---------------------------------------------------------------------------------------------
// Daily mark-to-market series and period returns (VAL-110 v-vi)
// ---------------------------------------------------------------------------------------------

export type DailyPoint = { readonly d: string; readonly pnlMicro: bigint; readonly open: number };

/** Sum the per-row MTM series by date: P/L and the number of rows with a point that day. */
export function aggregateDaily(series: readonly (readonly MtmPoint[])[]): DailyPoint[] {
  const byDay = new Map<string, { pnl: bigint; open: number }>();
  for (const s of series) {
    for (const p of s) {
      const cur = byDay.get(p.d);
      if (cur === undefined) byDay.set(p.d, { pnl: p.pnlMicro, open: 1 });
      else {
        cur.pnl += p.pnlMicro;
        cur.open += 1;
      }
    }
  }
  return [...byDay.keys()]
    .sort()
    .map((d) => ({ d, pnlMicro: byDay.get(d)!.pnl, open: byDay.get(d)!.open }));
}

/**
 * Period return = sum of MTM P/L / (notional x average open rows in the period); days with no
 * open row are skipped. Exact: sum(pnl) x days / (notional x sum(open)). Null when no row was open.
 */
export function periodReturn(
  points: readonly DailyPoint[],
  notionalMicro: bigint,
  from: string,
  to: string,
): Rational | null {
  let pnl = 0n;
  let open = 0n;
  let days = 0n;
  for (const p of points) {
    if (p.d < from || p.d > to || p.open === 0) continue;
    pnl += p.pnlMicro;
    open += BigInt(p.open);
    days += 1n;
  }
  if (days === 0n) return null;
  return makeRational(pnl * days, notionalMicro * open);
}

/** Period returns grouped by a caller-chosen key (e.g. ISO week), in key order. */
export function periodReturns(
  points: readonly DailyPoint[],
  notionalMicro: bigint,
  keyOf: (d: string) => string,
): { key: string; ret: Rational }[] {
  const groups = new Map<string, DailyPoint[]>();
  for (const p of points) {
    const k = keyOf(p.d);
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [p]);
    else g.push(p);
  }
  const out: { key: string; ret: Rational }[] = [];
  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!;
    const r = periodReturn(g, notionalMicro, g[0]!.d, g[g.length - 1]!.d);
    if (r !== null) out.push({ key: k, ret: r });
  }
  return out;
}
