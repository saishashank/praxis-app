// Corporate-action cash effects for the arena (M3 design 4.2 step 3, 4.5; spec ARN-026, ARN-036,
// ARN-043, DAT-220..223; D-069 decisions 7, 11, 13, 14; D-071 TST101-030 ruling; T7 proposals D-074).
// HIGH-RISK money module: bigint micro-AUD and exact rationals, one half-away-from-zero rounding
// per quantity, no floats. Pure functions; corpActionWriter.ts is the DB side.
//
//   dividend (cash, special)  entitlement = shares held at the PRIOR session's close.
//                             ex-date: div_accrue (div_recv +, equity -) of round(qty x dps), once.
//                             pay date: div_pay (div_recv -, cash_settled +), same amount.
//                             Franking stays on the corporate_action payload; no ledger effect.
//   rights                    non-renounceable: nothing (DAT-223). renounceable: shares x rights
//                             ratio x last traded price (0 if never traded), one rounding, ca_comp.
//   split / consolidation /   no cash, no P/L (ARN-043): the quantity is re-based by the exact
//   bonus issue               ratio on the ex-date (QtyAdjustment, decision 14); position_cost is
//                             untouched. A whole-share result is exact; a fractional result is
//                             rounded down (ARN-023) and its cost stays in the position.
//   cash merger, delisting    the holding closes on the ex-date (ca_dispose): last price, or the
//                             cash terms; administration / liquidation -> 0 (ARN-026).
//   suspension                frozen at the last price; from session `after`+1 marked at the haircut
//                             (suspensionMark, used by NAV; once per position per day).
// TODO(T9): legacy ledger. When a cohort ends holding a suspended position, ARN-026 moves it at
// its haircut value to the ended cohort's legacy ledger (trade.legacy = 1); that belongs to the
// cohort-end logic and is not done here.
import { sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { cmpRat, makeRational, mulRat, parseRational, type Rational } from "@/lib/money/rational";
import { assertInt64, MICRO_PER_DOLLAR, type Micro } from "@/lib/money/micro";
import {
  assertTradingDate,
  divAccrueTxn,
  divPayTxn,
  rebaseQty,
  replayCostBasis,
  reversalTxn,
  type LedgerFill,
  type LedgerRow,
  type LedgerTxn,
  type QtyAdjustment,
} from "./ledger";
import { derivePositions, type Mark } from "./nav";
import type { LedgerAccount } from "./schema";

export type CorpActionErrorCode = "bad_payload" | "no_price" | "bad_state";

export class CorpActionError extends Error {
  readonly code: CorpActionErrorCode;
  constructor(code: CorpActionErrorCode, message: string) {
    super(message);
    this.name = "CorpActionError";
    this.code = code;
  }
}

/** One confirmed `corporate_action` row (payload already parsed from payload_json). */
export type CorpActionRecord = {
  readonly id: string;
  readonly code: string;
  /** DAT-220 type, e.g. cash_dividend, split, rights_renounceable, delisting. */
  readonly type: string;
  readonly exDate: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** GL-02: instant the action was first confirmed (ISO UTC); null/absent = known since before. */
  readonly knownAt?: string | null;
};

/**
 * V2-I7 / D-793: a NULL `known_at` means "known since before the column existed" only for an action
 * whose FIRST event is older than this instant (migration 0016 was merged on 2026-10-30; the
 * production database gets it later, so every legacy row's first event is earlier). A NULL row whose
 * first event is on or after the bound came from a writer that did not stamp it; it is then treated
 * as known from its newest event, never as "always known", so the look-ahead guard stays on.
 */
export const LEGACY_NULL_KNOWN_AT_BEFORE = "2026-10-30T00:00:00.000Z";

export function boundedKnownAt(
  knownAt: string | null,
  firstEventAt: string | null,
  newestEventAt: string | null,
): string | null {
  if (knownAt !== null) return knownAt;
  if (firstEventAt === null || newestEventAt === null) return null;
  const first = Date.parse(firstEventAt);
  if (Number.isFinite(first) && first < Date.parse(LEGACY_NULL_KNOWN_AT_BEFORE)) return null;
  return newestEventAt;
}

/**
 * GL-02: the actions known at a cut-off. An action counts only when it was confirmed at or before the
 * instant (known_at <= cutoff); a null/absent known_at means it predates the column and always counts.
 * Compared as instants, not as text, so a differing ISO form cannot mis-order two times.
 */
export function knownBy<T extends { readonly knownAt?: string | null }>(
  actions: readonly T[],
  cutoffIso: string,
): T[] {
  const cut = Date.parse(cutoffIso);
  return actions.filter((a) => {
    if (a.knownAt === null || a.knownAt === undefined) return true;
    const k = Date.parse(a.knownAt);
    return Number.isFinite(k) && k <= cut;
  });
}

// ---- payload readers (exact; a JSON number goes through its decimal text, never arithmetic) -----

function bad(rec: CorpActionRecord, what: string): never {
  throw new CorpActionError("bad_payload", `action ${rec.id} (${rec.type}): ${what}`);
}

/** A non-negative integer from a safe-integer number or a digit string; undefined when absent. */
function intField(rec: CorpActionRecord, key: string): bigint | undefined {
  const v = rec.payload[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) bad(rec, `${key} must be a non-negative integer`);
    return BigInt(v);
  }
  if (typeof v === "string") {
    try {
      const r = parseRational(v);
      if (r.den === 1n && r.num >= 0n) return r.num;
    } catch {
      // falls through to the error below
    }
  }
  return bad(rec, `${key} must be a non-negative integer`);
}

function positiveInt(rec: CorpActionRecord, v: unknown, what: string): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 1) return BigInt(v);
  return bad(rec, `${what} must be a positive integer`);
}

/**
 * A money amount per share as an exact rational in micro-AUD. Either `<base>_micro` (integer or
 * digit string, may be fractional micro as a decimal string) or `<base>` as A$ (decimal string or
 * JSON number). Undefined when neither is present.
 */
function microPerShare(rec: CorpActionRecord, base: string): Rational | undefined {
  const m = rec.payload[`${base}_micro`];
  const a = rec.payload[base];
  const raw = m !== undefined && m !== null ? m : a;
  if (raw === undefined || raw === null) return undefined;
  let r: Rational;
  try {
    r = parseRational(typeof raw === "string" ? raw : String(raw));
  } catch {
    return bad(rec, `${base} is not a plain decimal`);
  }
  if (r.num < 0n) bad(rec, `${base} cannot be negative`);
  return m !== undefined && m !== null ? r : mulRat(r, makeRational(MICRO_PER_DOLLAR));
}

function dateField(rec: CorpActionRecord, key: string): string | undefined {
  const v = rec.payload[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return bad(rec, `${key} must be a date`);
  try {
    assertTradingDate(v);
  } catch {
    return bad(rec, `${key} must be a YYYY-MM-DD date`);
  }
  return v;
}

// ---- dividends -----------------------------------------------------------------------------------

export type DividendTerms = {
  /** Dividend per share, exact, in micro-AUD (may be a fraction of a micro). */
  readonly dpsMicro: Rational;
  readonly payD: string;
  /** Franking percentage as an exact rational (informational), or null. */
  readonly frankingPct: Rational | null;
  /** Vendor franking credit for the entitlement, recorded as given, never computed or posted. */
  readonly frankingCreditMicro: Micro | null;
};

export function parseDividend(rec: CorpActionRecord): DividendTerms {
  const dps = microPerShare(rec, "dps");
  if (dps === undefined) return bad(rec, "dividend needs dps or dps_micro");
  const payD = dateField(rec, "pay_date");
  if (payD === undefined) return bad(rec, "dividend needs pay_date");
  if (payD < rec.exDate) return bad(rec, "pay_date is before the ex-date");
  const pct = rec.payload.franking_pct;
  let frankingPct: Rational | null = null;
  if (pct !== undefined && pct !== null) {
    try {
      frankingPct = parseRational(typeof pct === "string" ? pct : String(pct));
    } catch {
      return bad(rec, "franking_pct is not a plain decimal");
    }
  }
  return {
    dpsMicro: dps,
    payD,
    frankingPct,
    frankingCreditMicro: intField(rec, "franking_credit_micro") ?? null,
  };
}

/** ARN-036: round_half_away(qty x dps), once. qty is the holding at the prior session's close. */
export function dividendAmountMicro(qtyPriorClose: bigint, dpsMicro: Rational): Micro {
  if (qtyPriorClose < 0n) throw new RangeError("quantity cannot be negative");
  return roundHalfAwayFromZero(mulRat(makeRational(qtyPriorClose), dpsMicro));
}

// ---- rights (DAT-223) ----------------------------------------------------------------------------

export type RightsTerms = {
  readonly renounceable: boolean;
  /** Rights per share held, exact (1 right per 4 shares = 1/4). */
  readonly ratio: Rational;
  /** Last traded price of the right in micro-AUD; null = never traded (worth zero). */
  readonly lastPriceMicro: Micro | null;
};

export function parseRights(rec: CorpActionRecord): RightsTerms {
  const renounceable = rec.type === "rights_renounceable";
  const r = rec.payload.rights;
  if (r === null || typeof r !== "object") return bad(rec, "rights needs {new, old}");
  const fields = r as Record<string, unknown>;
  const ratio = makeRational(
    positiveInt(rec, fields.new, "rights.new"),
    positiveInt(rec, fields.old, "rights.old"),
  );
  let price = microPerShare(rec, "last_price");
  if (price === undefined) {
    const cents = intField(rec, "last_price_cents");
    if (cents !== undefined) price = makeRational(cents * 10_000n);
  }
  if (price !== undefined && price.den !== 1n) return bad(rec, "last price must be whole micro");
  return {
    renounceable,
    ratio,
    lastPriceMicro: price === undefined || price.num === 0n ? null : price.num,
  };
}

export function rightsCount(shares: bigint, terms: RightsTerms): Rational {
  return mulRat(makeRational(shares), terms.ratio);
}

/**
 * DAT-223 compensation for an offer that is not taken up, in micro-AUD: renounceable only,
 * round_half_away(shares x ratio x last traded price) once; zero if the right never traded.
 */
export function rightsCompensationMicro(shares: bigint, terms: RightsTerms): Micro {
  if (!terms.renounceable || terms.lastPriceMicro === null) return 0n;
  return roundHalfAwayFromZero(
    mulRat(rightsCount(shares, terms), makeRational(terms.lastPriceMicro)),
  );
}

// ---- splits, consolidations, bonus issues (ARN-043, decision 14) -----------------------------------

/**
 * Quantity ratio for a quantity-changing action: new shares per held share. Split and
 * consolidation: new/old. Bonus issue: (old + new)/old. The adjustment factor of M2 is its inverse
 * (price x factor); the exact payload ratio is used here, not the REAL adjustment_factor column.
 */
export function quantityRatio(rec: CorpActionRecord): Rational {
  const n = positiveInt(rec, rec.payload.new, "new");
  const o = positiveInt(rec, rec.payload.old, "old");
  if (rec.type === "split") {
    if (n <= o) bad(rec, "a split needs more new than old shares");
    return makeRational(n, o);
  }
  if (rec.type === "consolidation") {
    if (n >= o) bad(rec, "a consolidation needs fewer new than old shares");
    return makeRational(n, o);
  }
  if (rec.type === "bonus_issue") return makeRational(o + n, o);
  return bad(rec, "not a quantity-changing action");
}

// ---- suspension (ARN-026, D-071 TST101-030) ---------------------------------------------------------

export type SuspensionConfig = {
  /** suspension_haircut (ch.15, default 1/2): marked value = value x haircut. */
  readonly haircut: Rational;
  /** suspension_haircut_after (ch.15, default 20): sessions fully elapsed before the haircut. */
  readonly afterSessions: number;
};

export const DEFAULT_SUSPENSION: SuspensionConfig = {
  haircut: makeRational(1n, 2n),
  afterSessions: 20,
};

/**
 * 1-based halted-session number: the first session on which the code is halted is 1.
 * `haltStartD` and `d` are both counted.
 */
export function haltSessionNumber(
  haltStartD: string,
  d: string,
  calendar: readonly CalendarRow[],
): number {
  return sessionsBetween(haltStartD, d, calendar).length;
}

/**
 * Ruling D-071 (TST101-030): "after 20 sessions" means the haircut applies from session 21, i.e.
 * once 20 halted sessions have fully elapsed before the day being marked. `elapsedBefore` counts
 * those completed halted sessions (session number - 1).
 */
export function haircutApplies(elapsedBefore: number, afterSessions: number): boolean {
  return elapsedBefore >= afterSessions;
}

/**
 * The NAV mark of a suspended code: frozen at the last traded raw close, no sale possible; the
 * haircut is attached from session `afterSessions + 1`. The haircut value itself is computed by
 * positionValueMicro (qty x close x haircut, one rounding per position per day).
 */
export function suspensionMark(input: {
  readonly lastCloseMicro: Micro;
  readonly advMicro: Micro;
  readonly haltStartD: string;
  readonly d: string;
  readonly calendar: readonly CalendarRow[];
  readonly config?: SuspensionConfig;
}): Mark {
  const config = input.config ?? DEFAULT_SUSPENSION;
  if (config.haircut.num <= 0n || cmpRat(config.haircut, makeRational(1n)) > 0) {
    throw new RangeError("suspension haircut must be in (0, 1]");
  }
  if (!Number.isSafeInteger(config.afterSessions) || config.afterSessions < 0) {
    throw new RangeError("suspension_haircut_after must be a non-negative integer");
  }
  const number = haltSessionNumber(input.haltStartD, input.d, input.calendar);
  if (number < 1) throw new RangeError("the day is before the halt started");
  return {
    closeMicro: input.lastCloseMicro,
    advMicro: input.advMicro,
    halted: true,
    haircut: haircutApplies(number - 1, config.afterSessions) ? config.haircut : null,
  };
}

// ---- disposal terms (cash merger, delisting) -------------------------------------------------------

const ZERO_VALUE_REASONS = ["administration", "liquidation"] as const;

/** Proceeds per share in micro for a closing action, or throws no_price. */
function disposalPerShare(
  rec: CorpActionRecord,
  lastCloseMicro: Micro | undefined,
): { readonly perShare: Rational; readonly basis: string } {
  const last = (): Rational => {
    if (lastCloseMicro === undefined) {
      throw new CorpActionError(
        "no_price",
        `action ${rec.id}: no last traded price for ${rec.code}`,
      );
    }
    return makeRational(lastCloseMicro);
  };
  if (rec.type === "merger_cash") {
    const cash = microPerShare(rec, "cash_per_share");
    if (cash === undefined) return bad(rec, "cash merger needs cash_per_share");
    return { perShare: cash, basis: "cash_terms" };
  }
  if (rec.type === "merger_scrip") {
    // DAT-223: scrip converts to the acquirer if listed in the same market, else cash at the last
    // price. Only the second branch is modelled (T7); a listed acquirer is refused loudly.
    if (rec.payload.acquirer_listed === true) {
      return bad(rec, "scrip conversion into a listed acquirer is not supported yet");
    }
    return { perShare: last(), basis: "last_price" };
  }
  // delisting
  const reason = rec.payload.reason;
  if (typeof reason !== "string") return bad(rec, "delisting needs a reason");
  const distribution = microPerShare(rec, "distribution");
  if ((ZERO_VALUE_REASONS as readonly string[]).includes(reason)) {
    return distribution === undefined
      ? { perShare: makeRational(0n), basis: "zero" }
      : { perShare: distribution, basis: "distribution" };
  }
  return { perShare: last(), basis: "last_price" };
}

// ---- the plan for one cohort-day ---------------------------------------------------------------------

export type PlannedAdjustment = {
  readonly actionId: string;
  readonly type: string;
  readonly code: string;
  readonly exD: string;
  /** New quantity per held share; 0 closes the holding. */
  readonly ratio: Rational;
  readonly qtyBefore: bigint;
  readonly qtyAfter: bigint;
};

export type CorpActionPlan = {
  readonly d: string;
  /** Ledger txns in posting order: dividend payments first, then the ex-date effects. */
  readonly txns: readonly LedgerTxn[];
  readonly adjustments: readonly PlannedAdjustment[];
  /** Franking recorded from the payload for audit; never posted, never in NAV (ARN-036). */
  readonly franking: readonly {
    readonly actionId: string;
    readonly code: string;
    readonly creditMicro: Micro;
  }[];
};

export type PlanInput = {
  /** The session being closed. */
  readonly d: string;
  /** The session before it (entitlement date). */
  readonly priorD: string;
  /** Confirmed actions with ex-date on or before d (earlier ones matter for pay dates). */
  readonly actions: readonly CorpActionRecord[];
  readonly fills: readonly LedgerFill[];
  /** Quantity adjustments already recorded (cohort_event ca_adjust). */
  readonly adjustments: readonly QtyAdjustment[];
  /** Ledger rows posted so far (to find accruals and payments). */
  readonly ledgerRows: readonly LedgerRow[];
  /** Last traded raw close at or before priorD, micro; undefined when unknown. */
  readonly lastCloseFor: (code: string) => Micro | undefined;
};

const TYPE_ORDER: Record<string, number> = {
  cash_dividend: 0,
  special_dividend: 0,
  rights_renounceable: 1,
  rights_non_renounceable: 1,
  split: 2,
  consolidation: 2,
  bonus_issue: 2,
  merger_cash: 3,
  merger_scrip: 3,
  delisting: 3,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedForDay(actions: readonly CorpActionRecord[]): CorpActionRecord[] {
  return [...actions].sort(
    (a, b) =>
      compareText(a.code, b.code) ||
      (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
      compareText(a.id, b.id),
  );
}

const isDividend = (rec: CorpActionRecord): boolean =>
  rec.type === "cash_dividend" || rec.type === "special_dividend";

function disposeTxn(
  rec: CorpActionRecord,
  d: string,
  costMicro: Micro,
  proceedsMicro: Micro,
): LedgerTxn | null {
  if (costMicro <= 0n) return null;
  const postings: { account: LedgerAccount; deltaMicro: Micro }[] = [
    { account: "position_cost", deltaMicro: -costMicro },
  ];
  if (proceedsMicro > 0n) postings.push({ account: "cash_settled", deltaMicro: proceedsMicro });
  if (costMicro !== proceedsMicro) {
    postings.push({ account: "equity", deltaMicro: costMicro - proceedsMicro });
  }
  return {
    txnId: `ca:${rec.id}`,
    d,
    kind: "ca_dispose",
    refType: "corporate_action",
    refId: rec.id,
    postings: assertBalanced(postings),
  };
}

function assertBalanced<T extends { deltaMicro: Micro }>(postings: T[]): T[] {
  let total = 0n;
  for (const p of postings) total += assertInt64(p.deltaMicro);
  if (total !== 0n) throw new RangeError(`corporate-action txn off by ${total.toString()}`);
  return postings;
}

/**
 * Everything the corporate actions do to one cohort on session `d`, deterministic and pure:
 *  1. dividends accrued earlier and payable on or before d (and not yet paid) are paid,
 *  2. actions with ex_date = d take effect on the holding at the prior session's close, ordered by
 *     code, then dividend, rights, quantity change, closing action, then action id.
 * Replays produce the same plan from the same inputs; the writer skips what is already stored.
 */
export function planCorporateActions(input: PlanInput): CorpActionPlan {
  const { d, priorD } = input;
  assertTradingDate(d);
  assertTradingDate(priorD);
  if (priorD >= d) throw new CorpActionError("bad_state", "priorD must precede d");

  const recorded = input.adjustments.filter((a) => a.exD <= priorD);
  const held = derivePositions(input.fills, recorded, priorD).positions;
  const todays = sortedForDay(input.actions.filter((a) => a.exDate === d));
  const txns: LedgerTxn[] = [];
  const adjustments: PlannedAdjustment[] = [];
  const franking: { actionId: string; code: string; creditMicro: Micro }[] = [];

  // 1. payments of dividends accrued on earlier days (those accrued today with pay date = d later)
  const accrued = new Map<string, Micro>();
  const paid = new Set<string>();
  for (const row of input.ledgerRows) {
    if (row.kind === "reversal" && row.refType === "txn" && row.refId !== null) {
      if (row.refId.startsWith("divacc:")) paid.add(row.refId.slice("divacc:".length)); // reversed: never pay
    }
    if (row.refType !== "dividend" || row.refId === null) continue;
    if (row.kind === "div_accrue" && row.account === "div_recv")
      accrued.set(row.refId, row.deltaMicro);
    if (row.kind === "div_pay" && row.account === "div_recv") paid.add(row.refId);
  }
  const dividendById = new Map(
    input.actions.filter(isDividend).map((rec) => [rec.id, rec] as const),
  );
  const payNow = (rec: CorpActionRecord, amount: Micro): void => {
    txns.push(divPayTxn({ d, refId: rec.id, amountMicro: amount }));
  };
  for (const [id, amount] of [...accrued].sort((a, b) => compareText(a[0], b[0]))) {
    const rec = dividendById.get(id);
    if (rec === undefined || paid.has(id) || rec.exDate >= d) continue;
    if (parseDividend(rec).payD <= d) payNow(rec, amount);
  }

  // 2. ex-date effects
  for (const rec of todays) {
    const qty = held.get(rec.code) ?? 0n;
    if (isDividend(rec)) {
      const terms = parseDividend(rec);
      if (qty === 0n) continue;
      const amount = dividendAmountMicro(qty, terms.dpsMicro);
      if (terms.frankingCreditMicro !== null) {
        franking.push({ actionId: rec.id, code: rec.code, creditMicro: terms.frankingCreditMicro });
      }
      if (amount === 0n) continue;
      // always emitted: a stored accrual that differs makes the writer raise txn_conflict
      txns.push(divAccrueTxn({ d, refId: rec.id, amountMicro: amount }));
      if (terms.payD <= d && !paid.has(rec.id)) payNow(rec, amount);
      continue;
    }
    if (rec.type === "rights_renounceable" || rec.type === "rights_non_renounceable") {
      const terms = parseRights(rec);
      const comp = rightsCompensationMicro(qty, terms);
      if (qty === 0n || comp === 0n) continue;
      txns.push({
        txnId: `ca:${rec.id}`,
        d,
        kind: "ca_comp",
        refType: "corporate_action",
        refId: rec.id,
        postings: [
          { account: "cash_settled", deltaMicro: comp },
          { account: "equity", deltaMicro: -comp },
        ],
      });
      continue;
    }
    if (rec.type === "split" || rec.type === "consolidation" || rec.type === "bonus_issue") {
      if (qty === 0n) continue;
      const ratio = quantityRatio(rec);
      const after = rebaseQty(qty, ratio);
      adjustments.push({
        actionId: rec.id,
        type: rec.type,
        code: rec.code,
        exD: d,
        ratio,
        qtyBefore: qty,
        qtyAfter: after,
      });
      if (after === 0n) {
        // a consolidation that leaves no whole share: the cost is written off, never silently kept
        const cost = replayCostBasis(input.fills, recorded, priorD).holdings.get(rec.code);
        const txn = disposeTxn(rec, d, cost?.costMicro ?? 0n, 0n);
        if (txn !== null) txns.push(txn);
      }
      continue;
    }
    if (rec.type === "merger_cash" || rec.type === "merger_scrip" || rec.type === "delisting") {
      if (qty === 0n) continue;
      const { perShare } = disposalPerShare(rec, input.lastCloseFor(rec.code));
      const proceeds = roundHalfAwayFromZero(mulRat(makeRational(qty), perShare));
      const cost = replayCostBasis(input.fills, recorded, priorD).holdings.get(rec.code);
      adjustments.push({
        actionId: rec.id,
        type: rec.type,
        code: rec.code,
        exD: d,
        ratio: makeRational(0n),
        qtyBefore: qty,
        qtyAfter: 0n,
      });
      const txn = disposeTxn(rec, d, cost?.costMicro ?? 0n, proceeds);
      if (txn !== null) txns.push(txn);
      else if (proceeds > 0n) {
        throw new CorpActionError("bad_state", `action ${rec.id}: proceeds without a cost basis`);
      }
    }
    // spin_off and code_change: no cash effect is modelled (the price series carries them)
  }
  return { d, txns, adjustments, franking };
}

/** The recorded adjustments as the ledger/NAV modules want them. */
export function toQtyAdjustments(plan: Pick<CorpActionPlan, "adjustments">): QtyAdjustment[] {
  return plan.adjustments.map((a) => ({ code: a.code, exD: a.exD, ratio: a.ratio }));
}

/**
 * DAT-222: a corporate action is re-resolved by appending reversal txns for everything it posted
 * and then posting its replacement (planCorporateActions with the corrected record), never by
 * editing. Returns the compensating txns for every txn of `actionId` not yet reversed.
 */
export function reversalsForAction(
  actionId: string,
  ledgerRows: readonly LedgerRow[],
  d: string,
): LedgerTxn[] {
  const groups = new Map<string, LedgerRow[]>();
  const reversed = new Set<string>();
  for (const row of ledgerRows) {
    if (row.kind === "reversal" && row.refType === "txn" && row.refId !== null) {
      reversed.add(row.refId);
    }
    if (
      row.refId === actionId &&
      (row.refType === "dividend" || row.refType === "corporate_action")
    ) {
      groups.set(row.txnId, [...(groups.get(row.txnId) ?? []), row]);
    }
  }
  const out: LedgerTxn[] = [];
  for (const [txnId, rows] of [...groups].sort((a, b) => compareText(a[0], b[0]))) {
    if (reversed.has(txnId) || rows[0].kind === "reversal") continue;
    out.push(
      reversalTxn(
        {
          txnId,
          d: rows[0].d,
          kind: rows[0].kind,
          refType: rows[0].refType,
          refId: rows[0].refId,
          postings: rows.map((r) => ({ account: r.account, deltaMicro: r.deltaMicro })),
        },
        d,
      ),
    );
  }
  return out;
}
