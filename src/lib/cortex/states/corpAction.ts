// Corporate-action state machine (M15 C3b; CTX-015, CTX-024 re-base; AT-52 ratchet; AT-56 fixtures
// 3b and 5; D-261 forward-measured; D-321 provenance; D-322 post-break test). One code, one session
// at a time, over the as-of view:
//
//   none ──pending ASX notice with a ratio──> candidate ──agree (notice+vendor, notice+break price,
//        the data layer, or at the unresolved limit)──> confirmed ──break session re-base──> none
//   candidate ──explained-move test fails on two consecutive post-break sessions──> disconfirmed
//        ──next session──> none
//   candidate ──unresolved after N sessions, ratios disagree──> candidate + Owner alert
//   none ──|raw move| >= 15 % with no candidate──> jump_block (2 sessions) ──> none
//   none ──row without provenance──> none (+ `unknown_provenance` row and Owner alert; fail closed)
//
// A ratio is never applied before its break session (a crash before the break is a crash). While a
// candidate is unconfirmed: no entries; a held stop is read on both bases (`twoBasisStop`) and the
// freeze loss limit runs on adjusted prices from the last clean close; every exit is booked on the
// adjusted basis with the share count reconciled to the ratio (`reconcileExit`, the ledger
// invariant). On confirmation the stop is re-based by the ratio before the ratchet (`rebaseStop`,
// `ratchetStop`): the only way a stop ever moves down.
//
// Provenance (D-321): the machine reads each record's `sources` and `status` (`CorpActionProvenance`,
// types.ts: from `corporate_action.evidence_json` and `corporate_action_event`, supplied by the
// producer on the record or in `provenance` by action id). Rules:
//   pending   + announcement in sources            -> notice candidate (two-basis freeze)
//   confirmed + announcement in sources            -> confirmed by the data layer: re-base at the break
//   any       + sources within {vendor, price}     -> vendor evidence only: corroborates a notice,
//                                                     never a candidate, never re-bases a Cortex stop
//   rejected / reversed                            -> ignored
//   no provenance                                  -> fail closed: `unknown_provenance` row + alert
// Money and ratios are exact (bigint micro, Rational).
import { quantityRatio, type CorpActionRecord } from "@/lib/arena/corpActions";
import { rebaseQty } from "@/lib/arena/ledger";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import {
  cmpRat,
  divRat,
  makeRational,
  mulRat,
  parseRational,
  subRat,
  type Rational,
} from "@/lib/money/rational";
import type { AsOfView } from "../pit/types";
import {
  basisMicro,
  basisRat,
  DEFAULT_STATES_PARAMS,
  pctRat,
  type CandidateSource,
  type CorpActionProvenance,
  type StatesParams,
  type StateRow,
  type StepOutcome,
} from "./types";

export type { CandidateSource } from "./types";

export type CorpActionParams = Pick<
  StatesParams,
  | "freezeMaxLossPct"
  | "unresolvedFreezeSessions"
  | "confirmTolerancePct"
  | "disconfirmDevPct"
  | "disconfirmSessions"
  | "jumpBlockPct"
  | "jumpBlockSessions"
>;

/** Provenance by action id when the records themselves do not carry it. */
export type ProvenanceMap = ReadonlyMap<string, CorpActionProvenance>;

/** Sessions a resolved group key stays in `seen` after its break (bounds the state). */
export const SEEN_HORIZON_SESSIONS = 60;

/** Types that carry a stated ratio (quantity-changing) or a TERP (entitlement offers). */
const QUANTITY_TYPES: readonly string[] = ["split", "consolidation", "bonus_issue"];
const TERP_TYPES: readonly string[] = ["rights_renounceable", "rights_non_renounceable"];

const isSource = (s: unknown): s is CandidateSource =>
  s === "announcement" || s === "vendor" || s === "price";
const isStatus = (s: unknown): s is CorpActionProvenance["status"] =>
  s === "pending" || s === "confirmed" || s === "rejected" || s === "reversed";

/** The record's provenance: the map entry, else the fields riding on the record; null = unknown. */
export function provenanceOf(
  rec: CorpActionRecord,
  provenance?: ProvenanceMap,
): CorpActionProvenance | null {
  const m = provenance?.get(rec.id);
  if (m !== undefined) return m;
  const r = rec as Partial<CorpActionProvenance>;
  if (Array.isArray(r.sources) && r.sources.every(isSource) && isStatus(r.status)) {
    return { sources: r.sources, status: r.status };
  }
  return null;
}

export type ActionTerms = {
  /** Price factor old/new: pre-break price = post-break price x factor (2 for a 2-for-1 split). */
  readonly priceFactor: Rational | null;
  /** Share multiplier at the break (= priceFactor for quantity types, 1 for a TERP offer). */
  readonly qtyRatio: Rational;
  /** TERP in micro for an entitlement offer (the factor is cum close / TERP at the break). */
  readonly terpMicro: bigint | null;
};

/** Stated terms of a record, or null when the type never carries a ratio (dividends, placements...). */
export function actionTerms(rec: CorpActionRecord): ActionTerms | null {
  if (QUANTITY_TYPES.includes(rec.type)) {
    const r = quantityRatio(rec);
    return { priceFactor: r, qtyRatio: r, terpMicro: null };
  }
  if (TERP_TYPES.includes(rec.type)) {
    const terp = rec.payload.terp_micro ?? rec.payload.terp;
    if (terp === undefined || terp === null) return null;
    const r = parseRational(typeof terp === "string" ? terp : String(terp));
    const micro = rec.payload.terp_micro !== undefined ? r : mulRat(r, makeRational(1_000_000n));
    if (micro.den !== 1n || micro.num <= 0n) return null;
    return { priceFactor: null, qtyRatio: makeRational(1n), terpMicro: micro.num };
  }
  return null;
}

export type GroupEntry = { readonly rec: CorpActionRecord; readonly terms: ActionTerms };

/** Records of one code grouped by break session (ex-date) and class, each with its stated terms. */
export type CandidateGroup = {
  readonly key: string; // `${exD}|${class}`
  readonly exD: string;
  /** Pending ASX notice with a ratio: the candidate. */
  readonly notice: GroupEntry | null;
  /** Vendor (or price) evidence: corroborates a notice only. */
  readonly vendor: GroupEntry | null;
  /** A notice-sourced row the data layer confirmed: re-base at the break (D-321). */
  readonly confirmedRow: GroupEntry | null;
  /** Records with a ratio but no provenance: fail closed. */
  readonly unknown: readonly CorpActionRecord[];
};

const classOf = (type: string): string => (QUANTITY_TYPES.includes(type) ? "quantity" : "terp");

/**
 * Groups known by the cut-off of sessions[t], oldest break first. Groups holding only vendor or
 * price evidence are dropped (never candidates, never a re-base); groups with an unknown-provenance
 * record are kept so the machine can fail closed on them.
 */
export function candidateGroups(
  view: AsOfView,
  code: string,
  t: number,
  provenance?: ProvenanceMap,
): CandidateGroup[] {
  const byKey = new Map<string, CandidateGroup>();
  for (const rec of view.corpActions(code, t)) {
    const terms = actionTerms(rec);
    if (terms === null) continue;
    const key = `${rec.exDate}|${classOf(rec.type)}`;
    const g = byKey.get(key) ?? {
      key,
      exD: rec.exDate,
      notice: null,
      vendor: null,
      confirmedRow: null,
      unknown: [],
    };
    const p = provenanceOf(rec, provenance);
    const entry: GroupEntry = { rec, terms };
    let next: CandidateGroup = g;
    if (p === null) next = { ...g, unknown: [...g.unknown, rec] };
    else if (p.status === "rejected" || p.status === "reversed") next = g;
    else if (p.sources.includes("announcement")) {
      next =
        p.status === "confirmed"
          ? { ...g, confirmedRow: g.confirmedRow ?? entry }
          : { ...g, notice: g.notice ?? entry };
    } else if (p.sources.length > 0) next = { ...g, vendor: g.vendor ?? entry };
    else next = { ...g, unknown: [...g.unknown, rec] }; // provenance without a source: unknown
    byKey.set(key, next);
  }
  return [...byKey.values()]
    .filter((g) => g.notice !== null || g.confirmedRow !== null || g.unknown.length > 0)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---- state -----------------------------------------------------------------------------------------------

export type ConfirmedBy =
  "notice_vendor" | "notice_price" | "unresolved_agree" | "notice_data_layer";

type Common = {
  /** Group keys already resolved (confirmed, disconfirmed, unknown) so they are not re-entered. */
  readonly seen: readonly string[];
};

export type CorpActionState =
  | (Common & { readonly state: "none" })
  | (Common & {
      readonly state: "candidate";
      readonly key: string;
      readonly actionId: string;
      readonly exD: string;
      readonly noticeFactor: Rational | null;
      readonly vendorFactor: Rational | null;
      readonly terpMicro: bigint | null;
      readonly qtyRatio: Rational;
      /** Factor in force (null before the break for a TERP offer). */
      readonly priceFactor: Rational | null;
      readonly sinceD: string;
      /** Raw close of the last session before the break; null until the break has a prior bar. */
      readonly lastCleanCloseMicro: bigint | null;
      /** 1-based session count from the break session; 0 before the break. */
      readonly freezeSessions: number;
      /** Consecutive post-break sessions on which the explained-move test failed. */
      readonly deviationRun: number;
      /** The notice-vs-break-price agreement test has run (first session both were known). */
      readonly priceTested: boolean;
      readonly ownerAlert: boolean;
    })
  | (Common & {
      readonly state: "confirmed";
      readonly key: string;
      readonly actionId: string;
      readonly exD: string;
      readonly priceFactor: Rational;
      readonly qtyRatio: Rational;
      readonly by: ConfirmedBy;
      readonly confirmedD: string;
      /** True once the break session has passed and the re-base was emitted. */
      readonly rebased: boolean;
    })
  | (Common & {
      readonly state: "disconfirmed";
      readonly key: string;
      readonly actionId: string;
      readonly exD: string;
      readonly disconfirmedD: string;
    })
  | (Common & {
      readonly state: "jump_block";
      readonly fromD: string;
      readonly sessionsLeft: number;
      readonly jumpPct: Rational;
    });

export type ConfirmedState = Extract<CorpActionState, { state: "confirmed" }>;
type CandidateState = Extract<CorpActionState, { state: "candidate" }>;
type NoneState = Extract<CorpActionState, { state: "none" }>;

export const CORP_ACTION_NONE: CorpActionState = { state: "none", seen: [] };

/** What the caller applies this session on top of the state (stops, entries, ledger). */
export type CorpActionEffects = {
  /** G08 `8d_unresolved_action`, the jump block and the fail-closed row: no new entries this session. */
  readonly entriesBlocked: boolean;
  /** "raw": stops on raw prices; "two_basis": exit only when both bases breach; "rebased": after re-base. */
  readonly stopBasis: "raw" | "two_basis" | "rebased";
  /** Factor to read the raw close on the pre-break basis (null = raw). */
  readonly priceFactor: Rational | null;
  readonly qtyRatio: Rational | null;
  /** Apply before the ratchet this session: every stop and reference x 1/factor, shares x qtyRatio. */
  readonly rebase: { readonly priceFactor: Rational; readonly qtyRatio: Rational } | null;
  /** Freeze loss limit breached on adjusted prices: exit regardless, booked on the adjusted basis. */
  readonly freezeExit: boolean;
  /** Owner alert: unresolved past the limit with disagreeing ratios, or a row without provenance. */
  readonly ownerAlert: boolean;
  /** Disconfirmed this session: the stop runs on raw prices from the next open; reverse bookings. */
  readonly reverseBookings: boolean;
  /** A jump with no candidate: the entry needs the volume test (CTX-015 last sentence). */
  readonly volumeTestNeeded: boolean;
};

export type CorpActionStep = StepOutcome<CorpActionState> & { readonly effects: CorpActionEffects };

const NO_EFFECTS: CorpActionEffects = {
  entriesBlocked: false,
  stopBasis: "raw",
  priceFactor: null,
  qtyRatio: null,
  rebase: null,
  freezeExit: false,
  ownerAlert: false,
  reverseBookings: false,
  volumeTestNeeded: false,
};

const LABEL_UNCONFIRMED = "a corporate action with a stated ratio is not yet confirmed";
const LABEL_NONE = "no corporate action in the way";

const abs = (r: Rational): Rational => (r.num < 0n ? makeRational(-r.num, r.den) : r);
const ONE = makeRational(1n);

/** |a / b - 1| <= tol (percent): the two factors agree. */
export function factorsAgree(a: Rational, b: Rational, tolPct: number): boolean {
  return cmpRat(abs(subRat(divRat(a, b), ONE)), pctRat(tolPct)) <= 0;
}

/** Relative deviation |raw - explained| / explained of a raw close from the level the ratio explains. */
export function explainedDeviation(
  rawCloseMicro: bigint,
  lastCleanCloseMicro: bigint,
  priceFactor: Rational,
): Rational {
  const explained = divRat(makeRational(lastCleanCloseMicro), priceFactor); // raw-basis level
  return abs(divRat(subRat(makeRational(rawCloseMicro), explained), explained));
}

function row(
  code: string,
  fromD: string,
  state: string,
  basis: Record<string, unknown>,
  sourceRef: string | null,
): StateRow {
  return { kind: "corp_action", code, fromD, state, basis, sourceRef };
}

/** The raw close of sessions[t] when the code traded that session. */
function closeOn(view: AsOfView, code: string, t: number, d: string): bigint | null {
  const b = view.bars(code, t, 1)[0];
  return b !== undefined && b.d === d ? b.close : null;
}

/** The raw close of the last session strictly before `d` that is known at t. */
function closeBefore(view: AsOfView, code: string, t: number, d: string): bigint | null {
  const n = Math.max(2, t - firstSessionAtOrAfter(view, d) + 2);
  const bars = view.bars(code, t, n);
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i]!.d < d) return bars[i]!.close;
  return null;
}

/** The index of the first session on or after `d` (sessions.length when none). */
function firstSessionAtOrAfter(view: AsOfView, d: string): number {
  let i = 0;
  while (i < view.sessions.length && view.sessions[i]! < d) i += 1;
  return i;
}

/** The raw close of the break session (the first traded session on or after `exD`) known at t. */
function breakClose(view: AsOfView, code: string, t: number, exD: string): bigint | null {
  const from = firstSessionAtOrAfter(view, exD);
  if (from > t) return null;
  const bars = view.bars(code, t, t - from + 1);
  const b = bars.find((x) => x.d >= exD);
  return b === undefined ? null : b.close;
}

/** `seen` keys whose break is within the horizon (bounds the carried state; D-324). */
function pruneSeen(seen: readonly string[], view: AsOfView, t: number): readonly string[] {
  const floor = view.sessions[Math.max(0, t - SEEN_HORIZON_SESSIONS)]!;
  return seen.filter((k) => k.slice(0, 10) >= floor);
}

function enterConfirmed(
  g: CandidateGroup,
  entry: GroupEntry,
  priceFactor: Rational,
  by: ConfirmedBy,
  d: string,
  seen: readonly string[],
): ConfirmedState {
  return {
    state: "confirmed",
    seen,
    key: g.key,
    actionId: entry.rec.id,
    exD: g.exD,
    priceFactor,
    qtyRatio: entry.terms.qtyRatio,
    by,
    confirmedD: d,
    rebased: false,
  };
}

function confirmedRow(code: string, s: ConfirmedState): StateRow {
  return row(
    code,
    s.confirmedD,
    "confirmed",
    {
      exD: s.exD,
      priceFactor: basisRat(s.priceFactor),
      qtyRatio: basisRat(s.qtyRatio),
      by: s.by,
    },
    s.actionId,
  );
}

function rebaseNow(
  code: string,
  d: string,
  s: ConfirmedState,
  reason: string,
  rowOut: StateRow | null,
): CorpActionStep {
  const next: CorpActionState = { ...s, rebased: true };
  return {
    next,
    label: "a confirmed corporate action re-based the stop today",
    reason,
    row: rowOut,
    effects: {
      ...NO_EFFECTS,
      stopBasis: "rebased",
      priceFactor: s.priceFactor,
      qtyRatio: s.qtyRatio,
      rebase: { priceFactor: s.priceFactor, qtyRatio: s.qtyRatio },
    },
  };
}

/** A confirmation reached this session: re-base now when the break is today or past, else wait. */
function finishConfirmed(
  view: AsOfView,
  code: string,
  t: number,
  next: ConfirmedState,
  reason: string,
): CorpActionStep {
  const d = view.sessions[t]!;
  const r = confirmedRow(code, next);
  if (d >= next.exD) return rebaseNow(code, d, next, reason, r);
  return {
    next,
    label: "a confirmed corporate action takes effect at its break session",
    reason,
    row: r,
    effects: NO_EFFECTS,
  };
}

/**
 * One session of the machine. `prev` null = nothing known before. The step reads only
 * `view.corpActions` and `view.bars` at `t` (pure; TST-109 holds by construction).
 */
export function stepCorpAction(
  view: AsOfView,
  code: string,
  t: number,
  prev: CorpActionState | null,
  params: CorpActionParams = DEFAULT_STATES_PARAMS,
  provenance?: ProvenanceMap,
): CorpActionStep {
  const d = view.sessions[t]!;
  const s = prev ?? CORP_ACTION_NONE;
  const groups = candidateGroups(view, code, t, provenance);

  if (s.state === "candidate") return stepCandidate(view, code, t, s, groups, params);

  // ---- confirmed: re-base at the break, then end ---------------------------------------------------------
  if (s.state === "confirmed") {
    if (s.rebased || d > s.exD) {
      const next: CorpActionState = { state: "none", seen: s.seen };
      return {
        next,
        label: LABEL_NONE,
        reason: "confirmed_done",
        row: row(code, d, "none", { after: "confirmed", key: s.key }, s.actionId),
        effects: NO_EFFECTS,
      };
    }
    if (d === s.exD)
      return rebaseNow(code, d, s, "break session: stops re-based before the ratchet", null);
    return {
      next: s,
      label: "a confirmed corporate action takes effect at its break session",
      reason: "confirmed_before_break",
      row: null,
      effects: NO_EFFECTS,
    };
  }

  if (s.state === "disconfirmed") {
    const next: CorpActionState = { state: "none", seen: s.seen };
    return {
      next,
      label: LABEL_NONE,
      reason: "disconfirmed_done",
      row: row(code, d, "none", { after: "disconfirmed", key: s.key }, s.actionId),
      effects: NO_EFFECTS,
    };
  }

  if (s.state === "jump_block") {
    if (s.sessionsLeft > 1) {
      const next: CorpActionState = { ...s, sessionsLeft: s.sessionsLeft - 1 };
      return {
        next,
        label: "a large unexplained price jump blocks entries for now",
        reason: "jump_block",
        row: null,
        effects: { ...NO_EFFECTS, entriesBlocked: true, volumeTestNeeded: true },
      };
    }
    const next: NoneState = { state: "none", seen: s.seen };
    const out = startFromNone(view, code, t, next, groups, params);
    return out.row === null
      ? { ...out, row: row(code, d, "none", { after: "jump_block" }, null) }
      : out;
  }

  return startFromNone(view, code, t, s, groups, params);
}

function stepCandidate(
  view: AsOfView,
  code: string,
  t: number,
  s: CandidateState,
  groups: readonly CandidateGroup[],
  params: CorpActionParams,
): CorpActionStep {
  const d = view.sessions[t]!;
  const g = groups.find((x) => x.key === s.key);
  const seenPlus = [...s.seen, s.key];
  const beforeBreak = d < s.exD;
  const lastClean =
    s.lastCleanCloseMicro ?? (beforeBreak ? null : closeBefore(view, code, t, s.exD));
  const vendorFactor = s.vendorFactor ?? g?.vendor?.terms.priceFactor ?? null;
  const noticeFactor = s.noticeFactor;

  // The data layer confirmed a notice-sourced row for this break: confirmed (TERP: from the break).
  if (g?.confirmedRow) {
    const c = g.confirmedRow;
    const factor =
      c.terms.priceFactor ??
      (lastClean !== null && c.terms.terpMicro !== null && !beforeBreak
        ? makeRational(lastClean, c.terms.terpMicro)
        : null);
    if (factor !== null) {
      const next = enterConfirmed(g, c, factor, "notice_data_layer", d, seenPlus);
      return finishConfirmed(view, code, t, next, "data layer confirmed the notice");
    }
  }
  // Notice + vendor agree (any time, both stated).
  if (
    g?.notice &&
    noticeFactor !== null &&
    vendorFactor !== null &&
    factorsAgree(noticeFactor, vendorFactor, params.confirmTolerancePct)
  ) {
    const next = enterConfirmed(g, g.notice, noticeFactor, "notice_vendor", d, seenPlus);
    return finishConfirmed(view, code, t, next, "notice and vendor ratios agree");
  }
  if (beforeBreak) {
    const next: CorpActionState = { ...s, vendorFactor };
    return {
      next,
      label: LABEL_UNCONFIRMED,
      reason: "candidate_before_break",
      row: null,
      effects: { ...NO_EFFECTS, entriesBlocked: true },
    };
  }
  // At or after the break: the factor in force, the observed ratio, the tests.
  let priceFactor = s.priceFactor;
  if (priceFactor === null && s.terpMicro !== null && lastClean !== null) {
    priceFactor = makeRational(lastClean, s.terpMicro);
  }
  if (priceFactor === null) priceFactor = noticeFactor;
  const raw = closeOn(view, code, t, d);
  const freezeSessions = s.freezeSessions + 1;
  const basisCommon = {
    exD: s.exD,
    priceFactor: basisRat(priceFactor),
    qtyRatio: basisRat(s.qtyRatio),
    lastCleanCloseMicro: basisMicro(lastClean),
  };
  if (raw === null || lastClean === null || priceFactor === null) {
    // No bar on this session (halted through the break) or no prior bar: freeze without tests.
    const next: CorpActionState = {
      ...s,
      vendorFactor,
      lastCleanCloseMicro: lastClean,
      priceFactor,
      freezeSessions,
    };
    return {
      next,
      label: LABEL_UNCONFIRMED,
      reason: "candidate_no_bar",
      row: null,
      effects: {
        ...NO_EFFECTS,
        entriesBlocked: true,
        stopBasis: "two_basis",
        priceFactor,
        qtyRatio: s.qtyRatio,
      },
    };
  }
  // Notice + observed break-session ratio agree, tested on the first session both are known
  // (a notice first known after the break still reads the break-day close; D-322/SF-5).
  const brk = breakClose(view, code, t, s.exD);
  if (
    !s.priceTested &&
    g?.notice &&
    noticeFactor !== null &&
    brk !== null &&
    factorsAgree(noticeFactor, makeRational(lastClean, brk), params.confirmTolerancePct)
  ) {
    const next = enterConfirmed(g, g.notice, noticeFactor, "notice_price", d, seenPlus);
    return finishConfirmed(view, code, t, next, "notice ratio and the break-session price agree");
  }
  // Explained-move test on the sessions after the break (D-322): two consecutive failures disconfirm.
  const dev = explainedDeviation(raw, lastClean, priceFactor);
  const deviationRun =
    freezeSessions >= 2 && cmpRat(dev, pctRat(params.disconfirmDevPct)) > 0
      ? s.deviationRun + 1
      : 0;
  if (deviationRun >= params.disconfirmSessions) {
    const next: CorpActionState = {
      state: "disconfirmed",
      seen: seenPlus,
      key: s.key,
      actionId: s.actionId,
      exD: s.exD,
      disconfirmedD: d,
    };
    return {
      next,
      label: "the price did not move as the announced ratio said: the action is disconfirmed",
      reason: "disconfirmed_explained_move",
      row: row(
        code,
        d,
        "disconfirmed",
        { ...basisCommon, deviation: basisRat(dev), run: deviationRun },
        s.actionId,
      ),
      effects: { ...NO_EFFECTS, stopBasis: "raw", reverseBookings: true },
    };
  }
  // Freeze loss limit on adjusted prices from the last clean close (the break session included).
  const adjClose = mulRat(makeRational(raw), priceFactor);
  const loss = subRat(ONE, divRat(adjClose, makeRational(lastClean)));
  const freezeExit = cmpRat(loss, pctRat(params.freezeMaxLossPct)) > 0;
  // Unresolved at the limit: confirmed when today's observed ratio agrees, else Owner alert.
  let ownerAlert = s.ownerAlert;
  if (freezeSessions >= params.unresolvedFreezeSessions) {
    if (
      g?.notice &&
      noticeFactor !== null &&
      factorsAgree(noticeFactor, makeRational(lastClean, raw), params.confirmTolerancePct)
    ) {
      const next = enterConfirmed(g, g.notice, noticeFactor, "unresolved_agree", d, seenPlus);
      return finishConfirmed(
        view,
        code,
        t,
        next,
        "unresolved at the limit; notice and observed ratio agree",
      );
    }
    ownerAlert = true;
  }
  const next: CorpActionState = {
    ...s,
    vendorFactor,
    priceFactor,
    lastCleanCloseMicro: lastClean,
    freezeSessions,
    deviationRun,
    priceTested: brk !== null,
    ownerAlert,
  };
  const alertNow = ownerAlert && !s.ownerAlert;
  return {
    next,
    label: ownerAlert
      ? "Owner alert: a corporate action is unresolved and the prices do not agree with the notice"
      : freezeExit
        ? "the loss during the unconfirmed corporate action passed the freeze limit"
        : LABEL_UNCONFIRMED,
    reason: alertNow ? "owner_alert" : freezeExit ? "freeze_loss_exit" : "candidate_frozen",
    row: alertNow
      ? row(code, d, "candidate_owner_alert", { ...basisCommon, freezeSessions }, s.actionId)
      : null,
    effects: {
      ...NO_EFFECTS,
      entriesBlocked: true,
      stopBasis: "two_basis",
      priceFactor,
      qtyRatio: s.qtyRatio,
      freezeExit,
      ownerAlert: alertNow,
    },
  };
}

function newCandidate(
  view: AsOfView,
  t: number,
  g: CandidateGroup,
  entry: GroupEntry,
  noticeFactor: Rational | null,
  vendorFactor: Rational | null,
  seen: readonly string[],
): CandidateState {
  const d = view.sessions[t]!;
  // A notice first known after the break: the freeze already ran that long (break session = 1).
  const brkIdx = firstSessionAtOrAfter(view, g.exD);
  return {
    state: "candidate",
    seen,
    key: g.key,
    actionId: entry.rec.id,
    exD: g.exD,
    noticeFactor,
    vendorFactor,
    terpMicro: entry.terms.terpMicro,
    qtyRatio: entry.terms.qtyRatio,
    priceFactor: null,
    sinceD: d,
    lastCleanCloseMicro: null,
    freezeSessions: d >= g.exD ? Math.max(0, t - brkIdx) : 0,
    deviationRun: 0,
    priceTested: false,
    ownerAlert: false,
  };
}

function startFromNone(
  view: AsOfView,
  code: string,
  t: number,
  s: NoneState,
  groups: readonly CandidateGroup[],
  params: CorpActionParams,
): CorpActionStep {
  const d = view.sessions[t]!;
  const seen = pruneSeen(s.seen, view, t);
  const fresh = groups.find((g) => !seen.includes(g.key));
  if (fresh !== undefined) {
    // Fail closed on a row without provenance (D-321): no candidate, no re-base, Owner alert.
    if (fresh.notice === null && fresh.confirmedRow === null) {
      const ids = fresh.unknown.map((r) => r.id);
      const next: CorpActionState = { state: "none", seen: [...seen, fresh.key] };
      return {
        next,
        label: "Owner alert: a corporate action has no recorded source; entries are blocked today",
        reason: "unknown_provenance",
        row: row(
          code,
          d,
          "unknown_provenance",
          { exD: fresh.exD, actionIds: ids, types: fresh.unknown.map((r) => r.type) },
          ids[0] ?? null,
        ),
        effects: { ...NO_EFFECTS, entriesBlocked: true, ownerAlert: true },
      };
    }
    if (fresh.notice === null) {
      // A notice-sourced row the data layer confirmed, never seen pending here.
      const c = fresh.confirmedRow!;
      const factor =
        c.terms.priceFactor ??
        (() => {
          const clean = closeBefore(view, code, t, fresh.exD);
          return clean !== null && c.terms.terpMicro !== null && d >= fresh.exD
            ? makeRational(clean, c.terms.terpMicro)
            : null;
        })();
      if (factor === null) {
        // a TERP row before its break: wait as a candidate; it confirms at the break (SF-3)
        const next = newCandidate(view, t, fresh, c, null, null, seen);
        return {
          next,
          label: LABEL_UNCONFIRMED,
          reason: "candidate_terp_pending",
          row: row(
            code,
            d,
            "candidate",
            { exD: fresh.exD, terpMicro: basisMicro(c.terms.terpMicro) },
            c.rec.id,
          ),
          effects: { ...NO_EFFECTS, entriesBlocked: true },
        };
      }
      const next = enterConfirmed(fresh, c, factor, "notice_data_layer", d, [...seen, fresh.key]);
      return finishConfirmed(view, code, t, next, "data layer confirmed the notice");
    }
    const n = fresh.notice;
    const next = newCandidate(
      view,
      t,
      fresh,
      n,
      n.terms.priceFactor,
      fresh.vendor?.terms.priceFactor ?? null,
      seen,
    );
    // Run the candidate step at once so a notice known on or after its break is tested today.
    const out = stepCandidate(view, code, t, next, groups, params);
    const entered = row(
      code,
      d,
      "candidate",
      {
        exD: fresh.exD,
        noticeFactor: basisRat(n.terms.priceFactor),
        vendorFactor: basisRat(fresh.vendor?.terms.priceFactor ?? null),
        terpMicro: basisMicro(n.terms.terpMicro),
      },
      n.rec.id,
    );
    return out.row === null ? { ...out, row: entered } : out;
  }
  // No candidate: the unexplained-jump check.
  const bars = view.bars(code, t, 2);
  if (bars.length === 2 && bars[1]!.d === d && bars[0]!.close > 0n) {
    const move = subRat(divRat(makeRational(bars[1]!.close), makeRational(bars[0]!.close)), ONE);
    if (cmpRat(abs(move), pctRat(params.jumpBlockPct)) >= 0) {
      const next: CorpActionState = {
        state: "jump_block",
        seen,
        fromD: d,
        sessionsLeft: params.jumpBlockSessions,
        jumpPct: move,
      };
      return {
        next,
        label: "a large unexplained price jump blocks entries for now",
        reason: "jump_block_start",
        row: row(
          code,
          d,
          "jump_block",
          { move: basisRat(move), sessions: params.jumpBlockSessions },
          null,
        ),
        effects: { ...NO_EFFECTS, entriesBlocked: true, volumeTestNeeded: true },
      };
    }
  }
  return {
    next: seen.length === s.seen.length ? s : { state: "none", seen },
    label: LABEL_NONE,
    reason: "none",
    row: null,
    effects: NO_EFFECTS,
  };
}

/** The state after folding every session 0..t (a pure feature of the view; TST-109 helper input). */
export function corpActionStateAt(
  view: AsOfView,
  code: string,
  t: number,
  params: CorpActionParams = DEFAULT_STATES_PARAMS,
  provenance?: ProvenanceMap,
): CorpActionStep {
  let s: CorpActionState | null = null;
  let last: CorpActionStep | null = null;
  for (let i = 0; i <= t; i += 1) {
    last = stepCorpAction(view, code, i, s, params, provenance);
    s = last.next;
  }
  return last!;
}

// ---- stops, re-base, ledger invariant -------------------------------------------------------------------------

export type TwoBasisResult = {
  readonly rawBreach: boolean;
  readonly adjBreach: boolean;
  /** Exit only when both bases breach (a genuine split breaches the raw basis alone). */
  readonly exit: boolean;
};

/**
 * The two-basis stop rule while a candidate is unconfirmed: the stop (set on the pre-break basis) is
 * compared with the raw close and with the ratio-adjusted close (raw x factor). A factor of null
 * (before the break) reads as raw only.
 */
export function twoBasisStop(input: {
  readonly rawCloseMicro: bigint;
  readonly stopMicro: bigint;
  readonly priceFactor: Rational | null;
}): TwoBasisResult {
  const rawBreach = input.rawCloseMicro <= input.stopMicro;
  if (input.priceFactor === null) return { rawBreach, adjBreach: rawBreach, exit: rawBreach };
  const adj = mulRat(makeRational(input.rawCloseMicro), input.priceFactor);
  const adjBreach = cmpRat(adj, makeRational(input.stopMicro)) <= 0;
  return { rawBreach, adjBreach, exit: rawBreach && adjBreach };
}

/**
 * Re-base a stop (or any price reference) by a confirmed factor: new = old / factor, rounded half
 * away from zero once. A 2-for-1 halves the stop; a 1-for-10 consolidation multiplies it by 10.
 */
export function rebaseStop(stopMicro: bigint, priceFactor: Rational): bigint {
  if (priceFactor.num <= 0n) throw new RangeError("price factor must be positive");
  return roundHalfAwayFromZero(divRat(makeRational(stopMicro), priceFactor));
}

/**
 * The ratchet (CTX-024, AT-52): a stop only moves up, except a confirmed re-base. With `rebase` the
 * previous stop is first re-based, then the ratchet runs against the proposed stop on the new basis.
 */
export function ratchetStop(
  prevStopMicro: bigint,
  proposedStopMicro: bigint,
  rebase: Rational | null = null,
): bigint {
  const floor = rebase === null ? prevStopMicro : rebaseStop(prevStopMicro, rebase);
  return proposedStopMicro > floor ? proposedStopMicro : floor;
}

export class LedgerInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

export type ExitBooking = {
  /** Shares the exit sells: the held count reconciled to the candidate ratio. */
  readonly shares: bigint;
  /** Price per reconciled share (the raw print). */
  readonly priceMicro: bigint;
  /** shares x price, one rounding. */
  readonly proceedsMicro: bigint;
};

/**
 * Every exit during a candidate or confirmed state is booked on the adjusted basis with the share
 * count reconciled to the ratio, so a 1:10 candidate never books a phantom loss. The ledger
 * invariant: an exit the ledger cannot reconcile to whole shares held is refused (the caller raises
 * the Owner alert instead of booking it).
 */
export function reconcileExit(input: {
  readonly heldQty: bigint;
  readonly qtyRatio: Rational | null;
  readonly rawCloseMicro: bigint;
}): ExitBooking {
  if (input.heldQty <= 0n) throw new LedgerInvariantError("no shares held to exit");
  const shares = input.qtyRatio === null ? input.heldQty : rebaseQty(input.heldQty, input.qtyRatio);
  if (shares <= 0n) {
    throw new LedgerInvariantError(
      `the ratio ${basisRat(input.qtyRatio)} leaves no whole share of ${input.heldQty} to exit`,
    );
  }
  return {
    shares,
    priceMicro: input.rawCloseMicro,
    proceedsMicro: roundHalfAwayFromZero(
      mulRat(makeRational(shares), makeRational(input.rawCloseMicro)),
    ),
  };
}
