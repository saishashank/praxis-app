// Event polarity and the U2/U3 D+2 entry rule (M15 C3b; CTX-043; AT-56 fixtures 1 and 2).
//
// Polarity needs the category keyword AND a consistent sector-adjusted day-0 abnormal return with
// |AR0| >= max(`polarityMinPct`, `polaritySigmaMult` x the code's 60-session daily return sd).
// Verifiable categories only: results; guidance; a contract with a disclosed value AND counterparty;
// a takeover with binding status or a term sheet. Everything else is polarity 0: `other` for a
// non-binding or indicative proposal, `claimed` for a party-less or value-less title.
//
// The view's `EventRow` carries the category, the exact AR0 and the volume ratio; whether a contract
// title names a value and a party, whether a takeover is binding and whether a results/guidance
// release had its financial statements parsed are stored by the event producer (P5) beside the row
// and come in as `NoticeFacts` by event id. An absent fact reads as "not shown" (fail closed).
//
// For U2/U3 codes only results and guidance releases with parsed financial statements can create an
// entry, on D+2, when persistence holds on end-of-day prints: the D+1 close keeps at least half of
// AR0 and D+1 volume >= `persistVolumeMult` x ADV20 over the 20 sessions before day 0 (the limit fill
// at D+2 is the fill module's). U1 keeps D+1 entries (AGT-020).
import { advPrevious } from "@/lib/agents/indicators";
import type { EventCategory, Polarity } from "@/lib/agents/schema";
import { cmpRat, divRat, makeRational, mulRat, subRat, type Rational } from "@/lib/money/rational";
import { sessionIndexOf } from "../pit/asOfView";
import type { AsOfView, EventRow } from "../pit/types";
import { DEFAULT_STATES_PARAMS, pctRat, type StatesParams } from "./types";

export type PolarityParams = Pick<
  StatesParams,
  | "polarityMinPct"
  | "polaritySigmaMult"
  | "polaritySigmaSessions"
  | "persistVolumeMult"
  | "persistAdvSessions"
>;

/** What the producer knows about a notice beyond the event row (all default to false). */
export type NoticeFacts = {
  readonly hasValue?: boolean;
  readonly hasCounterparty?: boolean;
  /** Takeover: binding agreement or a term sheet (not an indicative, non-binding proposal). */
  readonly binding?: boolean;
  /** Results / guidance: revenue and net profit line items present in the stored record. */
  readonly financialsParsed?: boolean;
};

export type PolarityLabel =
  | "verified" // keyword + verifiable + a consistent move: polarity +-1
  | "claimed" // contract without a disclosed value or counterparty: 0
  | "other" // non-verifiable category, non-binding proposal, review: 0
  | "no_move" // verifiable but |AR0| below the threshold (or no AR): 0
  | "inconsistent"; // move against the category's direction: 0

export type PolarityResult = {
  readonly polarity: Polarity;
  readonly label: PolarityLabel;
  readonly reason: string;
  /** The |AR0| threshold used (as a fraction); null when no sd could be computed and the floor applied. */
  readonly threshold: Rational;
};

/** Categories whose direction is fixed by the keyword; null = either direction is consistent. */
const EXPECTED_SIGN: Partial<Record<EventCategory, 1 | -1 | null>> = {
  results: null,
  guidance_up: 1,
  guidance_down: -1,
  contract_win: 1,
  takeover_target: 1,
  takeover_bidder: null,
};

/** The verifiable categories (CTX-043), each with the fact it needs beyond the keyword. */
export function verifiable(category: EventCategory, facts: NoticeFacts): PolarityLabel | "ok" {
  switch (category) {
    case "results":
    case "guidance_up":
    case "guidance_down":
      return "ok";
    case "contract_win":
      return facts.hasValue === true && facts.hasCounterparty === true ? "ok" : "claimed";
    case "takeover_target":
    case "takeover_bidder":
      return facts.binding === true ? "ok" : "other";
    default:
      return "other";
  }
}

const abs = (r: Rational): Rational => (r.num < 0n ? makeRational(-r.num, r.den) : r);

/** Sample sd of simple daily returns of the adjusted closes over the last `n` sessions before t (float statistic). */
export function returnSigma(view: AsOfView, code: string, t: number, n: number): number | null {
  const series = view.adj(code, t, n + 1);
  const closes = series.adjClose;
  if (closes.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1]!;
    if (a === 0n) continue;
    rets.push(Number(closes[i]! - a) / Number(a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v);
}

/** max(polarityMinPct, polaritySigmaMult x sigma) as an exact fraction (sigma rounded to 1e-9). */
export function polarityThreshold(sigma: number | null, params: PolarityParams): Rational {
  const floor = pctRat(params.polarityMinPct);
  if (sigma === null || !Number.isFinite(sigma)) return floor;
  const scaled = BigInt(Math.round(sigma * params.polaritySigmaMult * 1_000_000_000));
  const bySigma = makeRational(scaled, 1_000_000_000n);
  return cmpRat(bySigma, floor) > 0 ? bySigma : floor;
}

/** The CTX-043 polarity of one event known at t. */
export function eventPolarityAt(
  view: AsOfView,
  code: string,
  t: number,
  event: EventRow,
  facts: NoticeFacts = {},
  params: PolarityParams = DEFAULT_STATES_PARAMS,
): PolarityResult {
  const threshold = polarityThreshold(
    returnSigma(view, code, sessionIndexBefore(view, t, event.day0), params.polaritySigmaSessions),
    params,
  );
  const v = verifiable(event.category, facts);
  if (v !== "ok")
    return { polarity: 0, label: v, reason: `category_${event.category}_${v}`, threshold };
  if (event.ar === null) return { polarity: 0, label: "no_move", reason: "no_ar0", threshold };
  if (cmpRat(abs(event.ar), threshold) < 0) {
    return { polarity: 0, label: "no_move", reason: "ar0_below_threshold", threshold };
  }
  const sign: 1 | -1 = event.ar.num > 0n ? 1 : -1;
  const expected = EXPECTED_SIGN[event.category];
  if (expected !== null && expected !== undefined && expected !== sign) {
    return { polarity: 0, label: "inconsistent", reason: "move_against_category", threshold };
  }
  return { polarity: sign, label: "verified", reason: "keyword_and_move", threshold };
}

/** The index of the last session strictly before `d` that is <= t (so the sd never reads day 0). */
function sessionIndexBefore(view: AsOfView, t: number, d: string): number {
  let i = Math.min(t, view.sessions.length - 1);
  while (i > 0 && view.sessions[i]! >= d) i -= 1;
  return i;
}

export type EntryStage = "d1" | "d2";

export type EntryCheck = {
  readonly eligible: boolean;
  /** Which session the entry rule asks for (U1: D+1; U2/U3: D+2). */
  readonly stage: EntryStage;
  readonly label: string;
  readonly reason: string;
};

/**
 * CTX-043 entry rule for one event at t. U1: eligible on D+1 when the polarity is non-zero. U2/U3:
 * only results / guidance with parsed financials, on D+2, with EOD persistence. Everything else is
 * an observation that feeds the cards and the count, never an entry.
 */
export function eventEntryCheck(
  view: AsOfView,
  code: string,
  t: number,
  event: EventRow,
  facts: NoticeFacts = {},
  params: PolarityParams = DEFAULT_STATES_PARAMS,
): EntryCheck {
  const tier = view.tier(code, t);
  const pol = eventPolarityAt(view, code, t, event, facts, params);
  const i0 = sessionIndexOf(view.sessions, event.day0);
  if (tier === "U1" || tier === null) {
    if (pol.polarity === 0) {
      return {
        eligible: false,
        stage: "d1",
        label: "this notice has no verified direction",
        reason: pol.reason,
      };
    }
    const ok = t === i0 + 1;
    return {
      eligible: ok,
      stage: "d1",
      label: ok ? "entry on the session after the notice" : "not the entry session for this notice",
      reason: ok ? "u1_d1" : "u1_not_d1",
    };
  }
  const isResults =
    event.category === "results" ||
    event.category === "guidance_up" ||
    event.category === "guidance_down";
  if (!isResults || facts.financialsParsed !== true) {
    return {
      eligible: false,
      stage: "d2",
      label: "for a smaller company only results or guidance with parsed figures can start a trade",
      reason: isResults ? "u23_financials_not_parsed" : "u23_category_not_entry",
    };
  }
  if (pol.polarity === 0) {
    return {
      eligible: false,
      stage: "d2",
      label: "this notice has no verified direction",
      reason: pol.reason,
    };
  }
  if (t !== i0 + 2) {
    return {
      eligible: false,
      stage: "d2",
      label: "not the entry session for this notice",
      reason: "u23_not_d2",
    };
  }
  // Persistence on EOD prints: D+1 close keeps >= half of AR0 (return from the close before day 0).
  const series = view.adj(code, t, t - i0 + 2); // from day0 - 1 to t
  const idx = (i: number): number => series.d.indexOf(view.sessions[i]!);
  const pre = idx(i0 - 1);
  const d1 = idx(i0 + 1);
  if (pre < 0 || d1 < 0 || series.adjClose[pre]! === 0n) {
    return {
      eligible: false,
      stage: "d2",
      label: "not enough prices around the notice",
      reason: "u23_missing_bars",
    };
  }
  const ret = subRat(
    divRat(makeRational(series.adjClose[d1]!), makeRational(series.adjClose[pre]!)),
    makeRational(1n),
  );
  const half = divRat(event.ar!, makeRational(2n));
  const keeps = pol.polarity === 1 ? cmpRat(ret, half) >= 0 : cmpRat(ret, half) <= 0;
  if (!keeps) {
    return {
      eligible: false,
      stage: "d2",
      label: "the move did not hold into the next close",
      reason: "u23_no_persistence",
    };
  }
  // D+1 notional >= mult x ADV20 computed on the 20 sessions before day 0 (raw closes, AGT-030).
  const raw = view.bars(code, i0 + 1, params.persistAdvSessions + 2); // ends at D+1
  const closes = raw.map((b) => b.close);
  const vols = raw.map((b) => b.volume);
  // advPrevious excludes its last element: feed it the bars up to day 0 so the window is before day 0.
  const adv = advPrevious(closes.slice(0, -1), vols.slice(0, -1), params.persistAdvSessions);
  const d1Bar = raw[raw.length - 1];
  if (adv === null || d1Bar === undefined || d1Bar.d !== view.sessions[i0 + 1]) {
    return {
      eligible: false,
      stage: "d2",
      label: "not enough volume history before the notice",
      reason: "u23_no_adv",
    };
  }
  const notional = makeRational(d1Bar.close * d1Bar.volume);
  const need = mulRat(
    adv,
    makeRational(BigInt(Math.round(params.persistVolumeMult * 1000)), 1000n),
  );
  if (cmpRat(notional, need) < 0) {
    return {
      eligible: false,
      stage: "d2",
      label: "the volume after the notice was not large enough",
      reason: "u23_no_volume",
    };
  }
  return {
    eligible: true,
    stage: "d2",
    label: "entry on the second session after the notice",
    reason: "u23_d2_persisted",
  };
}
