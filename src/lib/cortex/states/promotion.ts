// Promotion flag (M15 C3b; CTX-044; AT-56 fixture 1 "move-signature block"). U2/U3 codes only.
//
// Two triggers, neither depending on whether a value is disclosed:
//   (1) move signature: a session with notional >= `pumpVolumeMult` x ADV20 (the 20 sessions before
//       it) and |AR0| >= `pumpArPct` blocks new entries for `moveBlockSessions`, unless the same-day
//       notice is a results / guidance release whose financial statements were parsed;
//   (2) notice-and-move count: every notice with a polarity (price-sensitive or not) and every
//       move-signature session without a notice, in a rolling `promotionFlagSessions` window; flag at
//       `noticeCountFlag`, or at `noticeCountFlagWithAr` when a counted item has AR0 > `noticeCountArPct`.
//       Results and guidance with parsed numbers are exempt from the count only.
// The flag runs `promotionFlagSessions` from the last counted notice. An exchange query opens a review
// item only; the flag is set by a retraction or a query response contradicted by the notice, and
// released on a satisfactory response (those verdicts are labels the producer passes in as `review`).
// The flag zeroes positive contributions of the event and volume clusters only (`zeroPositive`);
// never a negative event, a thesis-breaker or an exit trigger (the consumer reads that from here).
//
// Everything is recomputed from the view at t (bars, index, events) so the state at t is a pure
// feature of the view: `prev` only decides whether a row is emitted.
import { advPrevious } from "@/lib/agents/indicators";
import { cmpRat, divRat, makeRational, subRat, type Rational } from "@/lib/money/rational";
import type { AsOfView, EventRow } from "../pit/types";
import type { NoticeFacts } from "./eventPolarity";
import {
  basisRat,
  DEFAULT_STATES_PARAMS,
  pctRat,
  type StatesParams,
  type StateRow,
  type StepOutcome,
} from "./types";

export type PromotionParams = Pick<
  StatesParams,
  | "pumpVolumeMult"
  | "pumpArPct"
  | "moveBlockSessions"
  | "promotionFlagSessions"
  | "noticeCountFlag"
  | "noticeCountFlagWithAr"
  | "noticeCountArPct"
  | "persistAdvSessions"
>;

export type ReviewVerdict = "retraction" | "contradicted" | "satisfactory";

export type PromotionInput = {
  /** Producer facts by event id (financialsParsed is the only one read here). */
  readonly facts?: ReadonlyMap<string, NoticeFacts>;
  /** Review-item verdicts by session date (OI-35). */
  readonly review?: ReadonlyMap<string, ReviewVerdict>;
};

export type PromotionState =
  | { readonly state: "none" }
  | {
      readonly state: "move_block";
      readonly fromD: string;
      /** The block covers this many sessions from `fromD` (inclusive). */
      readonly sessions: number;
    }
  | {
      readonly state: "flagged";
      /** The last counted notice (or the review verdict): the flag runs `sessions` from here. */
      readonly fromD: string;
      readonly sessions: number;
      readonly by: "count" | "retraction" | "contradicted";
      readonly count: number;
    };

export const PROMOTION_NONE: PromotionState = { state: "none" };

export type PromotionEffects = {
  /** G08 `8b_promotion_flag` (move block or flag): no new entries. */
  readonly entriesBlocked: boolean;
  /** Zero the positive event and volume contributions in S (flag only). */
  readonly zeroPositive: boolean;
  /** An exchange query on this session: open a review item, nothing else. */
  readonly reviewItem: boolean;
  /** This session is itself a move signature. */
  readonly moveSignature: boolean;
  /** Counted items in the rolling window at t. */
  readonly count: number;
};

export type PromotionStep = StepOutcome<PromotionState> & { readonly effects: PromotionEffects };

const abs = (r: Rational): Rational => (r.num < 0n ? makeRational(-r.num, r.den) : r);
const ONE = makeRational(1n);

type SessionRead = {
  readonly d: string;
  readonly t: number;
  readonly move: boolean;
  /** Notices of the session with a polarity, exempt results / guidance with numbers removed. */
  readonly countedNotices: number;
  readonly exemptNotices: number;
  readonly queries: number;
  readonly ar0: Rational | null;
};

const isResultsOrGuidance = (e: EventRow): boolean =>
  e.category === "results" || e.category === "guidance_up" || e.category === "guidance_down";

/** |AR0| of session t': the event's exact AR when a notice has one, else raw return minus ^AXJO return. */
export function sessionAr0(
  view: AsOfView,
  code: string,
  t: number,
  notices: readonly EventRow[],
): Rational | null {
  const withAr = notices.find((e) => e.ar !== null);
  if (withAr !== undefined) return withAr.ar;
  const bars = view.bars(code, t, 2);
  if (bars.length < 2 || bars[1]!.d !== view.sessions[t] || bars[0]!.close === 0n) return null;
  const ret = subRat(divRat(makeRational(bars[1]!.close), makeRational(bars[0]!.close)), ONE);
  const idx = view.index("AXJO", t, 2);
  if (idx.length === 2 && idx[1]!.d === view.sessions[t] && idx[0]!.close !== 0n) {
    return subRat(
      ret,
      subRat(divRat(makeRational(idx[1]!.close), makeRational(idx[0]!.close)), ONE),
    );
  }
  return ret;
}

/** True when session t is a move signature (volume and AR thresholds; the results exemption applied). */
export function isMoveSignature(
  view: AsOfView,
  code: string,
  t: number,
  notices: readonly EventRow[],
  input: PromotionInput,
  params: PromotionParams,
): boolean {
  const exempt = notices.some(
    (e) => isResultsOrGuidance(e) && input.facts?.get(e.id)?.financialsParsed === true,
  );
  if (exempt) return false;
  const ar0 = sessionAr0(view, code, t, notices);
  if (ar0 === null || cmpRat(abs(ar0), pctRat(params.pumpArPct)) < 0) return false;
  const raw = view.bars(code, t, params.persistAdvSessions + 1);
  const last = raw[raw.length - 1];
  if (last === undefined || last.d !== view.sessions[t]) return false;
  const adv = advPrevious(
    raw.map((b) => b.close),
    raw.map((b) => b.volume),
    params.persistAdvSessions,
  );
  if (adv === null) return false;
  const notional = makeRational(last.close * last.volume);
  const need = {
    num: adv.num * BigInt(Math.round(params.pumpVolumeMult * 1000)),
    den: adv.den * 1000n,
  };
  return cmpRat(notional, need) >= 0;
}

function readSession(
  view: AsOfView,
  code: string,
  t: number,
  input: PromotionInput,
  params: PromotionParams,
): SessionRead {
  const d = view.sessions[t]!;
  const notices = view.events(code, t).filter((e) => e.day0 === d);
  let counted = 0;
  let exempt = 0;
  let queries = 0;
  for (const e of notices) {
    if (e.category === "exchange_query") queries += 1;
    if (e.polarity === 0) continue;
    if (isResultsOrGuidance(e) && input.facts?.get(e.id)?.financialsParsed === true) exempt += 1;
    else counted += 1;
  }
  return {
    d,
    t,
    move: isMoveSignature(view, code, t, notices, input, params),
    countedNotices: counted,
    exemptNotices: exempt,
    queries,
    ar0: sessionAr0(view, code, t, notices),
  };
}

function row(code: string, fromD: string, state: string, basis: Record<string, unknown>): StateRow {
  return { kind: "promotion", code, fromD, state, basis, sourceRef: null };
}

/** The state the rules put the code in at t, from the view alone. */
export function promotionStateAt(
  view: AsOfView,
  code: string,
  t: number,
  params: PromotionParams = DEFAULT_STATES_PARAMS,
  input: PromotionInput = {},
): PromotionStep {
  return stepPromotion(view, code, t, null, params, input);
}

/** One session; `prev` decides only whether a `cortex_state` row is appended. */
export function stepPromotion(
  view: AsOfView,
  code: string,
  t: number,
  prev: PromotionState | null,
  params: PromotionParams = DEFAULT_STATES_PARAMS,
  input: PromotionInput = {},
): PromotionStep {
  const d = view.sessions[t]!;
  const s = prev ?? PROMOTION_NONE;
  const tier = view.tier(code, t);
  const none = (reason: string, effects: Partial<PromotionEffects> = {}): PromotionStep => ({
    next: PROMOTION_NONE,
    label: "no promotion flag",
    reason,
    row: s.state === "none" ? null : row(code, d, "none", { after: s.state }),
    effects: {
      entriesBlocked: false,
      zeroPositive: false,
      reviewItem: false,
      moveSignature: false,
      count: 0,
      ...effects,
    },
  });
  if (tier !== "U2" && tier !== "U3") return none("not_u23");

  const W = params.promotionFlagSessions;
  // Sessions back to t - 2W + 2: the count at any session s' in [t - W + 1, t] needs its own window.
  const from = Math.max(0, t - 2 * W + 2);
  const reads = new Map<number, SessionRead>();
  for (let i = from; i <= t; i += 1) reads.set(i, readSession(view, code, i, input, params));
  const today = reads.get(t)!;
  const itemsOf = (r: SessionRead): number =>
    r.countedNotices + (r.move && r.countedNotices + r.exemptNotices === 0 ? 1 : 0);

  // (2) the notice-and-move count in the window ending at s', and whether it flags there
  const countAt = (sEnd: number): { count: number; flag: boolean; lastCountedT: number } => {
    let count = 0;
    let bigAr = false;
    let lastCountedT = -1;
    for (let i = Math.max(0, sEnd - W + 1); i <= sEnd; i += 1) {
      const r = reads.get(i)!;
      const items = itemsOf(r);
      if (items === 0) continue;
      count += items;
      lastCountedT = i;
      if (r.ar0 !== null && cmpRat(r.ar0, pctRat(params.noticeCountArPct)) > 0) bigAr = true;
    }
    const flag =
      count >= params.noticeCountFlag || (count >= params.noticeCountFlagWithAr && bigAr);
    return { count, flag, lastCountedT };
  };
  const nowCount = countAt(t);
  // The flag runs W sessions from the last counted notice of any session on which it was set, and
  // the issuer cannot shorten it: the latest such notice still inside its run decides.
  let countFromT = -1;
  for (let sEnd = Math.max(0, t - W + 1); sEnd <= t; sEnd += 1) {
    const c = countAt(sEnd);
    if (c.flag && c.lastCountedT > t - W && c.lastCountedT > countFromT)
      countFromT = c.lastCountedT;
  }

  // review verdicts (OI-35): a retraction or a contradicted response within its run, unless a
  // satisfactory response came after it
  let reviewFlag: "retraction" | "contradicted" | null = null;
  let reviewFromT = -1;
  for (let i = Math.max(0, t - W + 1); i <= t; i += 1) {
    const v = input.review?.get(view.sessions[i]!);
    if (v === "satisfactory") reviewFlag = null;
    else if (v === "retraction" || v === "contradicted") {
      reviewFlag = v;
      reviewFromT = i;
    }
  }

  // (1) the move block: the latest move signature within `moveBlockSessions`
  let moveFromT = -1;
  for (let i = Math.max(0, t - params.moveBlockSessions + 1); i <= t; i += 1) {
    if (reads.get(i)!.move) moveFromT = i;
  }

  const base = { reviewItem: today.queries > 0, moveSignature: today.move, count: nowCount.count };

  if (countFromT >= 0 || reviewFlag !== null) {
    const fromT = Math.max(countFromT, reviewFromT);
    const by: "count" | "retraction" | "contradicted" =
      reviewFlag !== null && reviewFromT >= countFromT ? reviewFlag : "count";
    const next: PromotionState = {
      state: "flagged",
      fromD: view.sessions[fromT]!,
      sessions: W,
      by,
      count: nowCount.count,
    };
    const changed = s.state !== "flagged" || s.fromD !== next.fromD || s.by !== next.by;
    return {
      next,
      label: "a promotion flag is in the way",
      reason: by === "count" ? "notice_and_move_count" : by,
      row: changed ? row(code, d, "flagged", { by, count: nowCount.count, sessions: W }) : null,
      effects: { ...base, entriesBlocked: true, zeroPositive: true },
    };
  }
  if (moveFromT >= 0) {
    const next: PromotionState = {
      state: "move_block",
      fromD: view.sessions[moveFromT]!,
      sessions: params.moveBlockSessions,
    };
    const changed = s.state !== "move_block" || s.fromD !== next.fromD;
    return {
      next,
      label: "a sharp move on heavy volume blocks entries for now",
      reason: "move_signature",
      row: changed
        ? row(code, d, "move_block", {
            ar0: basisRat(reads.get(moveFromT)!.ar0),
            sessions: params.moveBlockSessions,
          })
        : null,
      effects: { ...base, entriesBlocked: true, zeroPositive: false },
    };
  }
  return none(today.queries > 0 ? "exchange_query_review" : "none", base);
}
