// G12 settled cash, parcel and stall (M15 C3c; spec ch. 17 CTX-027; AT-56 fixture 10 "Monday sale,
// Tuesday buy → refused"). Deployable cash = settled cash plus sale proceeds whose T+2 settlement
// session is the FILL session or earlier, less payables (`availableCash` in conservative mode,
// arena/ledger.ts) — a Monday sale settles Wednesday, so a Tuesday buy cannot use it. The entry must
// leave a parcel of at least A$500 net of the entry fee (`MIN_MARKETABLE_PARCEL_MICRO`); F4 at half
// size in SHOCK needs two parcels (FAM-009). The v1 stall predicate (ARN-071) is restated here as a
// pure function so the night, the replay and the report use one rule.
import type { SizingReason, SizingResult } from "@/lib/arena/sizing";
import { MIN_MARKETABLE_PARCEL_MICRO } from "@/lib/arena/sizing";
import {
  availableCash,
  settlementDate,
  zeroBalances,
  type SettlementItem,
} from "@/lib/arena/ledger";
import type { Micro } from "@/lib/money/micro";
import { PARCEL_LABEL, PARTICIPATION_LABEL, SETTLED_CASH_LABEL } from "./list";
import { fail, pass, type GateResult } from "./types";

export { MIN_MARKETABLE_PARCEL_MICRO, settlementDate };

/** ARN-071: sessions without a position and below one parcel before a book is stalled. */
export const STALL_SESSIONS = 5;

export type CashPosition = {
  /** Cash whose settlement is complete at the decision close. */
  readonly settledCashMicro: Micro;
  /** Unsettled fills (sale receipts and buy payables) with their settlement sessions. */
  readonly pending: readonly SettlementItem[];
};

/**
 * CTX-027 deployable cash for a buy that fills on `fillD`: settled cash + receipts settling on or
 * before the fill session − every payable (conservative mode of `availableCash`). Never negative.
 */
export function deployableCash(cash: CashPosition, fillD: string): Micro {
  const balances = { ...zeroBalances(), cash_settled: cash.settledCashMicro };
  let pay = 0n;
  for (const item of cash.pending) if (item.side === "buy") pay -= item.netMicro;
  const v = availableCash({
    mode: "conservative",
    balances: { ...balances, cash_pay: pay },
    pending: cash.pending,
    sessionD: fillD,
  });
  return v < 0n ? 0n : v;
}

/** Sale proceeds not yet deployable on `fillD` (they count towards "not stalled", ARN-071). */
export function unsettledProceeds(cash: CashPosition, fillD: string): Micro {
  let v = 0n;
  for (const item of cash.pending)
    if (item.side === "sell" && item.settleD > fillD) v += item.netMicro;
  return v;
}

export type SettledCashInput = {
  readonly deployableMicro: Micro;
  /** The entry's brokerage (buy side) at the planned order value. */
  readonly entryFeeMicro: Micro;
  /** F4 in SHOCK: two parcels needed (FAM-009). */
  readonly halfSize: boolean;
  /** The sizing engine's verdict for this entry; a rejection fails the gate with its reasons. */
  readonly sizing?: Pick<SizingResult, "accepted" | "reasons"> | null;
  readonly parcelMicro?: Micro;
};

/**
 * G12 (CTX-027): deployable cash net of the entry fee ≥ one parcel (two at half size), and the
 * sizing engine accepted the order (cash, whole share, parcel, participation).
 */
export function gateSettledCash(input: SettledCashInput): GateResult {
  const parcel = input.parcelMicro ?? MIN_MARKETABLE_PARCEL_MICRO;
  if (parcel <= 0n) throw new RangeError("parcel must be positive");
  if (input.entryFeeMicro < 0n) throw new RangeError("entry fee cannot be negative");
  const need = input.halfSize ? 2n * parcel : parcel;
  const net = input.deployableMicro - input.entryFeeMicro;
  if (net < need) {
    return fail(
      "G12_settled_cash",
      SETTLED_CASH_LABEL,
      `deployable_net:${net} < ${need}${input.halfSize ? ":half_size" : ""}`,
    );
  }
  if (input.sizing && !input.sizing.accepted) {
    const reasons: readonly SizingReason[] = input.sizing.reasons;
    return fail("G12_settled_cash", sizingLabel(reasons), `sizing:${reasons.join(",")}`);
  }
  return pass(`deployable_net:${net}`);
}

/** The plain label of a sizing rejection: cash → settled cash, parcel / whole share → parcel, participation. */
export function sizingLabel(reasons: readonly SizingReason[]): string {
  if (reasons.includes("cash")) return SETTLED_CASH_LABEL;
  if (reasons.includes("parcel") || reasons.includes("whole_share")) return PARCEL_LABEL;
  if (reasons.includes("participation")) return PARTICIPATION_LABEL;
  return SETTLED_CASH_LABEL;
}

export type StallInput = {
  readonly hasOpenPosition: boolean;
  readonly deployableMicro: Micro;
  readonly unsettledProceedsMicro: Micro;
  /** Consecutive sessions (before tonight) the predicate already held. */
  readonly runSessions: number;
  readonly parcelMicro?: Micro;
};

export type StallResult = {
  /** Tonight meets the per-session predicate (no position, under one parcel, nothing unsettled). */
  readonly belowFloor: boolean;
  /** Consecutive sessions including tonight. */
  readonly runSessions: number;
  /** ARN-071: five consecutive sessions → stalled (a designed terminal state). */
  readonly stalled: boolean;
  /** CTX-027: within one capped loss of the floor → Owner item before the next entry. */
  readonly nearFloor: boolean;
};

/**
 * The v1 stall predicate (ARN-071), one value A$500 everywhere: no open position and deployable
 * cash below one parcel, with unsettled proceeds counting towards "not stalled", for
 * `STALL_SESSIONS` consecutive sessions. `maxLossShare` is the capped loss (`max_loss_pct`) used
 * for the near-floor Owner item: deployable < parcel ÷ (1 − max_loss).
 */
export function stallCheck(input: StallInput, maxLoss: { num: bigint; den: bigint }): StallResult {
  const parcel = input.parcelMicro ?? MIN_MARKETABLE_PARCEL_MICRO;
  const below =
    !input.hasOpenPosition && input.deployableMicro + input.unsettledProceedsMicro < parcel;
  const run = below ? input.runSessions + 1 : 0;
  // deployable × (den − num) < parcel × den  ⇔  deployable < parcel / (1 − max_loss)
  const nearFloor =
    !input.hasOpenPosition &&
    input.deployableMicro * (maxLoss.den - maxLoss.num) < parcel * maxLoss.den;
  return { belowFloor: below, runSessions: run, stalled: run >= STALL_SESSIONS, nearFloor };
}
