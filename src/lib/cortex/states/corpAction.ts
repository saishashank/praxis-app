// Corporate-action state machine (M15 C3b; CTX-015, CTX-024 re-base; AT-52 ratchet; AT-56 fixtures
// 3b and 5; D-261 forward-measured). One code, one session at a time, over the as-of view:
//
//   none ──notice with a ratio──> candidate ──agree (notice+vendor, notice+price, or at the
//        unresolved limit)──> confirmed ──break session re-base──> none
//   candidate ──explained-move test fails twice──> disconfirmed ──next session──> none
//   candidate ──unresolved after N sessions, ratios disagree──> candidate + Owner alert
//   none ──|raw move| >= 15 % with no candidate──> jump_block (2 sessions) ──> none
//
// A ratio is never applied before its break session (a crash before the break is a crash). While a
// candidate is unconfirmed: no entries; a held stop is read on both bases (`twoBasisStop`) and the
// freeze loss limit runs on adjusted prices from the last clean close; every exit is booked on the
// adjusted basis with the share count reconciled to the ratio (`reconcileExit`, the ledger
// invariant). On confirmation the stop is re-based by the ratio before the ratchet (`rebaseStop`,
// `ratchetStop`): the only way a stop ever moves down.
//
// Which records are candidates: a `CorpActionRecord` whose payload carries `sources` (string[]) or
// `source` (string) from the DAT-221 evidence (`data/corporateActions/rules.mjs` SOURCES:
// "announcement" | "vendor" | "price"). A record with "announcement" among its sources is a notice
// candidate; "vendor" and "price" alone are never candidates (CTX-015, pass 22). A record with no
// source field at all is a row the data layer already confirmed (DAT-221 auto-confirm or the Owner
// queue): it enters as `confirmed` and is re-based at its break like any other confirmation.
// Money and ratios are exact (bigint micro, Rational); the only float is nothing.
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
  type StatesParams,
  type StateRow,
  type StepOutcome,
} from "./types";

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

/** Types that carry a stated ratio (quantity-changing) or a TERP (entitlement offers). */
const QUANTITY_TYPES: readonly string[] = ["split", "consolidation", "bonus_issue"];
const TERP_TYPES: readonly string[] = ["rights_renounceable", "rights_non_renounceable"];

export type CandidateSource = "announcement" | "vendor" | "price";

/** The evidence sources of a record; empty when the payload has none (data-layer confirmed). */
export function sourcesOf(rec: CorpActionRecord): readonly CandidateSource[] {
  const raw = rec.payload.sources ?? rec.payload.source;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.filter(
    (s): s is CandidateSource => s === "announcement" || s === "vendor" || s === "price",
  );
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

/** Records of one code grouped by break session (ex-date) and class, each with its stated terms. */
export type CandidateGroup = {
  readonly key: string; // `${exD}|${class}`
  readonly exD: string;
  readonly notice: { readonly rec: CorpActionRecord; readonly terms: ActionTerms } | null;
  readonly vendor: { readonly rec: CorpActionRecord; readonly terms: ActionTerms } | null;
  /** A row the data layer confirmed (no source field): enters as confirmed. */
  readonly confirmedRow: { readonly rec: CorpActionRecord; readonly terms: ActionTerms } | null;
};

const classOf = (type: string): string => (QUANTITY_TYPES.includes(type) ? "quantity" : "terp");

/** Groups known by the cut-off of sessions[t], oldest break first; vendor-only groups are dropped. */
export function candidateGroups(view: AsOfView, code: string, t: number): CandidateGroup[] {
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
    };
    const src = sourcesOf(rec);
    const entry = { rec, terms };
    let next: CandidateGroup = g;
    if (src.length === 0) next = { ...g, confirmedRow: g.confirmedRow ?? entry };
    else if (src.includes("announcement")) next = { ...g, notice: g.notice ?? entry };
    else if (src.includes("vendor")) next = { ...g, vendor: g.vendor ?? entry };
    byKey.set(key, next);
  }
  return [...byKey.values()]
    .filter((g) => g.notice !== null || g.confirmedRow !== null)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---- state -----------------------------------------------------------------------------------------------

export type ConfirmedBy = "notice_vendor" | "notice_price" | "unresolved_agree" | "data_layer";

export type ConfirmedState = Extract<CorpActionState, { state: "confirmed" }>;

type Common = {
  /** Group keys already resolved (confirmed, disconfirmed or past) so they are not re-entered. */
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
      /** Consecutive sessions on which the explained-move test failed. */
      readonly deviationRun: number;
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

export const CORP_ACTION_NONE: CorpActionState = { state: "none", seen: [] };

/** What the caller applies this session on top of the state (stops, entries, ledger). */
export type CorpActionEffects = {
  /** G08 `8d_unresolved_action` and the jump block: no new entries this session. */
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
  /** Unresolved past the limit and the ratios disagree: raise an Owner alert before any exit. */
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

function closeOn(view: AsOfView, code: string, t: number, d: string): bigint | null {
  const bars = view.bars(code, t, 1);
  const b = bars[0];
  return b !== undefined && b.d === d ? b.close : null;
}

/** The raw close of the last session strictly before `d` that is known at t. */
function closeBefore(view: AsOfView, code: string, t: number, d: string): bigint | null {
  const bars = view.bars(code, t, 2);
  for (let i = bars.length - 1; i >= 0; i -= 1) if (bars[i]!.d < d) return bars[i]!.close;
  return null;
}

function enterConfirmed(
  g: CandidateGroup,
  entry: { rec: CorpActionRecord; terms: ActionTerms },
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

function confirmedRow(code: string, s: CorpActionState & { state: "confirmed" }): StateRow {
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
): CorpActionStep {
  const d = view.sessions[t]!;
  const s = prev ?? CORP_ACTION_NONE;
  const groups = candidateGroups(view, code, t);
  const byKey = new Map(groups.map((g) => [g.key, g] as const));

  // ---- a running candidate ------------------------------------------------------------------------------
  if (s.state === "candidate") {
    const g = byKey.get(s.key);
    const seenPlus = [...s.seen, s.key];
    // The data layer confirmed it meanwhile (a sourceless row with the same break): confirmed.
    if (g?.confirmedRow && g.confirmedRow.terms.priceFactor !== null) {
      const next = enterConfirmed(
        g,
        g.confirmedRow,
        g.confirmedRow.terms.priceFactor,
        "data_layer",
        d,
        seenPlus,
      );
      return finishConfirmed(view, code, t, next, "data layer confirmed the action");
    }
    const vendorFactor = s.vendorFactor ?? g?.vendor?.terms.priceFactor ?? null;
    const noticeFactor = s.noticeFactor;
    const beforeBreak = d < s.exD;
    const atOrAfterBreak = !beforeBreak;
    const lastClean =
      s.lastCleanCloseMicro ?? (atOrAfterBreak ? closeBefore(view, code, t, s.exD) : null);
    // Notice + vendor agree (any time, both stated).
    if (
      noticeFactor !== null &&
      vendorFactor !== null &&
      factorsAgree(noticeFactor, vendorFactor, params.confirmTolerancePct)
    ) {
      const next = enterConfirmed(g!, g!.notice!, noticeFactor, "notice_vendor", d, seenPlus);
      return finishConfirmed(view, code, t, next, "notice and vendor ratios agree");
    }
    if (beforeBreak) {
      const next: CorpActionState = { ...s, vendorFactor };
      return {
        next,
        label: "a corporate action with a stated ratio is not yet confirmed",
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
        label: "a corporate action with a stated ratio is not yet confirmed",
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
    const observed = makeRational(lastClean, raw); // old price / new price on the break basis
    // Notice + observed price on the break session agree: confirmed, re-based now.
    if (
      freezeSessions === 1 &&
      noticeFactor !== null &&
      factorsAgree(noticeFactor, observed, params.confirmTolerancePct)
    ) {
      const next = enterConfirmed(g!, g!.notice!, noticeFactor, "notice_price", d, seenPlus);
      return finishConfirmed(view, code, t, next, "notice ratio and the break-session price agree");
    }
    // Explained-move test (break session included: a crash on the break is a crash).
    const dev = explainedDeviation(raw, lastClean, priceFactor);
    const deviationRun = cmpRat(dev, pctRat(params.disconfirmDevPct)) > 0 ? s.deviationRun + 1 : 0;
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
    // Freeze loss limit on adjusted prices from the last clean close.
    const adjClose = mulRat(makeRational(raw), priceFactor);
    const loss = subRat(ONE, divRat(adjClose, makeRational(lastClean)));
    const freezeExit = cmpRat(loss, pctRat(params.freezeMaxLossPct)) > 0;
    // Unresolved at the limit: confirmed when the observed ratio now agrees, else Owner alert.
    let ownerAlert = s.ownerAlert;
    if (freezeSessions >= params.unresolvedFreezeSessions) {
      if (
        noticeFactor !== null &&
        factorsAgree(noticeFactor, observed, params.confirmTolerancePct)
      ) {
        const next = enterConfirmed(g!, g!.notice!, noticeFactor, "unresolved_agree", d, seenPlus);
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
      ownerAlert,
    };
    const alertNow = ownerAlert && !s.ownerAlert;
    return {
      next,
      label: ownerAlert
        ? "Owner alert: a corporate action is unresolved and the prices do not agree with the notice"
        : freezeExit
          ? "the loss during the unconfirmed corporate action passed the freeze limit"
          : "a corporate action with a stated ratio is not yet confirmed",
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

  // ---- confirmed: re-base at the break, then end ---------------------------------------------------------
  if (s.state === "confirmed") {
    if (s.rebased || d > s.exD) {
      const next: CorpActionState = { state: "none", seen: s.seen };
      return {
        next,
        label: "no corporate action in the way",
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
      label: "no corporate action in the way",
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
    const next: CorpActionState = { state: "none", seen: s.seen };
    const out = startFromNone(view, code, t, next, groups, params);
    return out.row === null
      ? { ...out, row: row(code, d, "none", { after: "jump_block" }, null) }
      : out;
  }

  return startFromNone(view, code, t, s, groups, params);
}

function rebaseNow(
  code: string,
  d: string,
  s: CorpActionState & { state: "confirmed" },
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
  next: CorpActionState & { state: "confirmed" },
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

function startFromNone(
  view: AsOfView,
  code: string,
  t: number,
  s: CorpActionState & { state: "none" },
  groups: readonly CandidateGroup[],
  params: CorpActionParams,
): CorpActionStep {
  const d = view.sessions[t]!;
  const fresh = groups.find((g) => !s.seen.includes(g.key));
  if (fresh !== undefined) {
    const seen = s.seen;
    if (fresh.notice === null) {
      // data-layer confirmed row (no notice ever seen here)
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
        // a TERP row before its break: wait as a candidate that is already confirmed by the data layer
        const next: CorpActionState = {
          state: "candidate",
          seen,
          key: fresh.key,
          actionId: c.rec.id,
          exD: fresh.exD,
          noticeFactor: null,
          vendorFactor: null,
          terpMicro: c.terms.terpMicro,
          qtyRatio: c.terms.qtyRatio,
          priceFactor: null,
          sinceD: d,
          lastCleanCloseMicro: null,
          freezeSessions: 0,
          deviationRun: 0,
          ownerAlert: false,
        };
        return {
          next,
          label: "a corporate action with a stated ratio is not yet confirmed",
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
      const next = enterConfirmed(fresh, c, factor, "data_layer", d, [...seen, fresh.key]);
      return finishConfirmed(view, code, t, next, "data layer confirmed the action");
    }
    const n = fresh.notice;
    const next: CorpActionState = {
      state: "candidate",
      seen,
      key: fresh.key,
      actionId: n.rec.id,
      exD: fresh.exD,
      noticeFactor: n.terms.priceFactor,
      vendorFactor: fresh.vendor?.terms.priceFactor ?? null,
      terpMicro: n.terms.terpMicro,
      qtyRatio: n.terms.qtyRatio,
      priceFactor: null,
      sinceD: d,
      lastCleanCloseMicro: null,
      freezeSessions: 0,
      deviationRun: 0,
      ownerAlert: false,
    };
    // Run the candidate step at once so a notice known on its break session is tested today.
    const out = stepCorpAction(view, code, t, next, params);
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
        seen: s.seen,
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
    next: s,
    label: "no corporate action in the way",
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
): CorpActionStep {
  let s: CorpActionState | null = null;
  let last: CorpActionStep | null = null;
  for (let i = 0; i <= t; i += 1) {
    last = stepCorpAction(view, code, i, s, params);
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
