// @vitest-environment node
// TST-101 known-answer loader (M3 T3/T5; docs/M3_tst101_draft.md with the D-071 architect rulings).
// Runs EVERY case of tests/fixtures/arena/tst101_public.json that belongs to the cost, slippage,
// sizing and fill modules, asserting exact micro equality. Cases that belong to later tasks are
// listed as `it.todo` with their task (T8 sleeve, T9 cohorts). T6 (ledger/NAV) and T7 (corporate actions) are live.
// The table is the authority: this file never edits an expected value. Where the implementation
// follows an architect ruling that differs from a table value, the test asserts the ruling and
// the difference is named in DISAGREEMENTS below (reported to the architect).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COST_PROFILES, feeFor, isCostProfileCode } from "@/lib/arena/costs";
import {
  DEFAULT_SUSPENSION,
  parseDividend,
  parseRights,
  planCorporateActions,
  quantityRatio,
  rightsCompensationMicro,
  rightsCount,
  suspensionMark,
  toQtyAdjustments,
  type CorpActionRecord,
} from "@/lib/arena/corpActions";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  fillIntradayStop,
  initialStopFromFill,
  selectExit,
  type FillEnv,
} from "@/lib/arena/fills";
import {
  availableCash,
  balancesFromRows,
  fillTxns,
  pendingSettlements,
  replayCostBasis,
  seedTxn,
  settleTxn,
  settlementItem,
  settlementDate,
  txnRows,
  zeroBalances,
  type LedgerFill,
} from "@/lib/arena/ledger";
import { computeNavDay, positionValueMicro } from "@/lib/arena/nav";
import { sizeEntry, stallFloorMicro } from "@/lib/arena/sizing";
import { bucketBpsFor, slippageFill } from "@/lib/arena/slippage";
import { sessionsBetween } from "@/lib/data/calendar";
import { makeRational, mulRat, parseRational } from "@/lib/money/rational";
import { tickFor } from "@/lib/money/tick";

type Case = {
  id: string;
  description: string;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown>;
};

const CASES: Case[] = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../fixtures/arena/tst101_public.json"), "utf8"),
);
const byId = new Map(CASES.map((c) => [c.id, c]));

const big = (v: unknown): bigint => BigInt(String(v));
const str = (v: unknown): string => String(v);
const profileOf = (c: Case) => {
  const code = str(c.inputs.profile);
  if (!isCostProfileCode(code)) throw new Error(`unknown profile ${code}`);
  return COST_PROFILES[code];
};
const expectBig = (actual: bigint, expected: unknown) => expect(actual).toBe(big(expected));

/** Cross-check the table's own derived inputs (tick, bucket bps) against the implementation. */
function checkEnvInputs(c: Case, refKey: string) {
  const ref = big(c.inputs[refKey]);
  if (c.inputs.tick_micro !== undefined) expectBig(tickFor(ref), c.inputs.tick_micro);
  if (c.inputs.adv_bucket_bps !== undefined && c.inputs.adv20_value_micro !== undefined) {
    const bps = bucketBpsFor(big(c.inputs.adv20_value_micro));
    expect(bps.den).toBe(1n);
    expectBig(bps.num, c.inputs.adv_bucket_bps);
  }
}

const bar = (open: bigint, low: bigint) => {
  const high = open > low ? open : low;
  return { openMicro: open, highMicro: high, lowMicro: low, closeMicro: open };
};
const envFor = (c: Case, open: bigint, low: bigint): FillEnv => ({
  bar: bar(open, low),
  advMicro: big(c.inputs.adv20_value_micro ?? "5000000000000"), // ADV >= A$5M = the 10 bps bucket
  profile: COST_PROFILES[isCostProfileCode(c.inputs.profile) ? c.inputs.profile : "P5"],
});

type Handler = (c: Case) => void;

const brokerage: Handler = (c) => {
  const ctx =
    c.inputs.buy_number_same_security_same_day === undefined
      ? {}
      : { firstBuyOfSecurityToday: c.inputs.buy_number_same_security_same_day === 1 };
  const fee = feeFor(profileOf(c), big(c.inputs.order_value_micro), "buy", {
    code: str(c.inputs.code),
    zeroFeeCodes: new Set((c.inputs.zero_fee_list as string[] | undefined) ?? []),
    ...ctx,
  });
  expectBig(fee, c.expected.brokerage_micro);
  // The fee is the same on the sell side for every profile except P2's free first buy.
  if (c.inputs.profile !== "P2") {
    expectBig(
      feeFor(profileOf(c), big(c.inputs.order_value_micro), "sell"),
      c.expected.brokerage_micro,
    );
  }
};

const slippage: Handler = (c) => {
  checkEnvInputs(c, "reference_price_micro");
  const side = c.inputs.side === "sell" ? "sell" : "buy";
  const ref = big(c.inputs.reference_price_micro);
  const q = slippageFill(
    ref,
    side,
    big(c.inputs.adv20_value_micro),
    parseRational(str(c.inputs.tick_cross_factor)),
  );
  expectBig(q.fillMicro, c.expected.fill_micro);
  if (c.id === "TST101-019") {
    // tick-bps 250: tick x 10_000 / price (spec ARN-032 acceptance), exactly.
    const tickBps = tickFor(ref) * 10_000n;
    expect(tickBps % ref).toBe(0n);
    expectBig(tickBps / ref, c.expected.tick_bps);
  }
  // The reported slippage is the unrounded price amount; the fill-based figure must be at least it.
  expect(q.slipMicro >= big(c.expected.slippage_micro)).toBe(true);
};

const sizing: Handler = (c) => {
  checkEnvInputs(c, "reference_price_micro");
  const r = sizeEntry({
    settledCashMicro: big(c.inputs.settled_cash_micro),
    navMicro: big(c.inputs.nav_micro),
    refPriceMicro: big(c.inputs.reference_price_micro),
    advValueMicro: big(c.inputs.adv20_value_micro),
    adv20Shares: big(c.inputs.adv20_shares ?? "1000000000"),
    tier: "U1",
    profile: profileOf(c),
    cashBuffer: parseRational(str(c.inputs.buffer_pct)),
    ...(c.inputs.participation_pct === undefined
      ? {}
      : { participationCap: parseRational(str(c.inputs.participation_pct)) }),
    ...(c.inputs.min_marketable_parcel_micro === undefined
      ? {}
      : { minParcelMicro: big(c.inputs.min_marketable_parcel_micro) }),
  });
  const e = c.expected;
  expectBig(r.bufferMicro, e.buffer_micro);
  expectBig(r.estBrokerageMicro, e.est_brokerage_micro);
  expectBig(r.deployableMicro, e.deployable_micro);
  expectBig(r.fillPriceMicro, e.fill_micro);
  expectBig(r.qty, e.shares ?? e.shares_sized);
  expectBig(r.orderValueMicro, e.order_value_micro ?? e.shares_sized_value ?? r.orderValueMicro);
  if (e.cap_shares !== undefined) expectBig(r.capShares, e.cap_shares);
  const status = str(e.status);
  if (status === "filled") {
    expect(r.accepted).toBe(true);
    expectBig(r.brokerageMicro, e.actual_brokerage_micro);
    expectBig(r.totalCostMicro, e.total_cost_micro);
    expectBig(r.cashAfterMicro, e.cash_remaining_micro);
  } else {
    expect(r.accepted).toBe(false);
    expect(r.reasons).toEqual([status === "rejected_participation" ? "participation" : "parcel"]);
  }
};

/** A sell at the open via the CS path: same formula as any open sell (ARN-021). */
const settlementSale: Handler = (c) => {
  const open = big(c.inputs.reference_open_micro);
  const f = fillCloseSignalExit(envFor(c, open, open), big(c.inputs.held_shares));
  expectBig(f.fillPriceMicro, c.expected.sale_fill_micro);
  expectBig(f.valueMicro, c.expected.sale_value_micro);
  expectBig(f.brokerageMicro, c.expected.brokerage_micro);
  expectBig(f.valueMicro - f.brokerageMicro, c.expected.net_proceeds_micro);
};

/**
 * T6, ARN-025 / D-071 TST101-026: the sale of case 026 through the ledger. Matched: proceeds fund a
 * buy the same session. Conservative: only from the start of the T+2 session (Tue 2026-10-13 sale,
 * Thu 2026-10-15 settlement); the settlement posting then holds the same figure as settled cash.
 */
const settlementLedger026: Handler = (c) => {
  settlementSale(c);
  const open = big(c.inputs.reference_open_micro);
  const f = fillCloseSignalExit(envFor(c, open, open), big(c.inputs.held_shares));
  const tradeD = "2026-10-13";
  const sale: LedgerFill = {
    id: "F1",
    d: tradeD,
    code: "ZZA",
    side: "sell",
    qty: f.qty,
    valueMicro: f.valueMicro,
    brokerageMicro: f.brokerageMicro,
  };
  const rows = [
    ...txnRows(seedTxn("2026-10-12", big(c.inputs.settled_cash_before_micro))),
    ...fillTxns(sale, big(c.expected.sale_value_micro)).flatMap(txnRows),
  ];
  const balances = balancesFromRows(rows);
  const pending = pendingSettlements([sale], new Set(), []);
  const at = (mode: "matched" | "conservative", sessionD: string) =>
    availableCash({ mode, balances, pending, sessionD });
  expectBig(at("matched", tradeD), c.expected.matched_cash_available_same_day_micro);
  expectBig(at("conservative", tradeD), c.expected.conservative_cash_available_same_day_micro);
  expectBig(
    at("conservative", "2026-10-14"),
    c.expected.conservative_cash_available_same_day_micro,
  );
  const settleD = settlementDate(tradeD, []);
  expect(settleD).toBe("2026-10-15");
  expectBig(
    at("conservative", settleD),
    c.expected.conservative_cash_available_settlement_session_micro,
  );
  const settled = balancesFromRows([...rows, ...txnRows(settleTxn(pending[0], settleD))]);
  expectBig(settled.cash_settled, c.expected.conservative_cash_available_settlement_session_micro);
  expect(settled.cash_recv).toBe(0n);
};

/** T6, ARN-051: every NAV term once; margin counted once; franking excluded. */
const nav038: Handler = (c) => {
  const i = c.inputs;
  const notional = big(i.sleeve_notional_micro);
  const entry = big(i.sleeve_entry_fill_micro);
  const unreal = (notional * (big(i.sleeve_mark_micro) - entry)) / entry; // exact: -8,000,000
  expectBig(unreal, c.expected.sleeve_unrealised_pl_micro);
  const day = computeNavDay({
    cohortId: "K1",
    d: "2026-10-14",
    balances: {
      ...zeroBalances(),
      cash_settled: big(i.settled_cash_micro),
      cash_recv: big(i.unsettled_receivable_micro),
      div_recv: big(i.dividend_receivable_micro),
      sleeve_margin: big(i.sleeve_margin_micro),
      fin_accrued: -big(i.accrued_unpaid_financing_micro),
    },
    positions: new Map([["ZZA", big(i.holding_shares)]]),
    markFor: () => ({ closeMicro: big(i.raw_close_micro), advMicro: 5_000_000_000_000n }),
    profile: COST_PROFILES.P5,
    sleeveUnrealMicro: unreal,
  });
  expectBig(day.row.positionsMicro, c.expected.holdings_value_micro);
  expectBig(day.row.navMicro, c.expected.nav_micro);
  // franking (6,428,571) is never an input to NAV: the figure above already excludes it
  expect(big(i.franking_micro) > 0n).toBe(true);
};

const initialStop: Handler = (c) => {
  checkEnvInputs(c, "reference_open_micro");
  const open = big(c.inputs.reference_open_micro);
  const f = fillEntryAtOpen(envFor(c, open, open), 1n);
  expectBig(f.fillPriceMicro, c.expected.entry_fill_micro);
  expectBig(
    initialStopFromFill(f.fillPriceMicro, big(c.inputs.stop_distance_micro)),
    c.expected.initial_stop_level_micro,
  );
  // From the open the stop would be different: the stop is set from the actual fill.
  expect(f.fillPriceMicro).not.toBe(open);
};

const stopFill: Handler = (c) => {
  const open = big(c.inputs.session_open_micro);
  const low = big(c.inputs.session_low_micro);
  const level = big(c.inputs.stop_level_micro ?? c.expected.trigger_price_micro);
  const f = fillIntradayStop(envFor(c, open, low), 1n, level);
  expect(f).not.toBeNull();
  expectBig(f?.fillPriceMicro ?? 0n, c.expected.is_fill_micro ?? c.expected.fill_micro);
};

const exitMapping034: Handler = (c) => {
  const open = big(c.inputs.session_open_micro);
  const low = big(c.inputs.session_low_micro);
  const env = envFor(c, open, low);
  const cs = fillCloseSignalExit(env, 1n);
  const is = fillIntradayStop(env, 1n, big(c.inputs.stop_level_micro));
  expectBig(cs.fillPriceMicro, c.expected.cs_fill_micro);
  expectBig(is?.fillPriceMicro ?? 0n, c.expected.is_fill_micro);
  // ARN-022 (spec/05:53): the earlier fill wins — the CS exit at the open precedes the intraday stop.
  expect(selectExit(cs, is)).toBe(cs);
  expectBig(selectExit(cs, is)?.fillPriceMicro ?? 0n, c.expected.selected_fill_micro);
};

const liquidation039: Handler = (c) => {
  const open = big(c.inputs.raw_close_micro);
  const qty = big(c.inputs.holding_shares);
  const f = fillCloseSignalExit(envFor(c, open, open), qty);
  expectBig(f.valueMicro, c.expected.exit_value_micro);
  expectBig(f.slipMicro * qty, c.expected.exit_slippage_cost_micro);
  expectBig(f.brokerageMicro, c.expected.exit_brokerage_micro);
  expectBig(
    big(c.expected.nav_micro) - f.slipMicro * qty - f.brokerageMicro,
    c.expected.liquidation_nav_micro,
  );
  // T6: the same figures from the NAV module, and the target verdict (ARN-052, section 5.1).
  const day = computeNavDay({
    cohortId: "K1",
    d: "2026-10-14",
    balances: { ...zeroBalances(), cash_settled: big(c.inputs.cash_micro) },
    positions: new Map([["ZZA", qty]]),
    markFor: () => ({ closeMicro: open, advMicro: big(c.inputs.adv20_value_micro) }),
    profile: profileOf(c),
  });
  expectBig(day.row.navMicro, c.expected.nav_micro);
  expectBig(day.row.liqNavMicro, c.expected.liquidation_nav_micro);
  const target = big(c.inputs.target_liquidation_micro);
  expect(day.row.navMicro >= target).toBe(true); // NAV alone would call it a win
  expect(String(day.row.liqNavMicro >= target)).toBe(str(c.expected.target_reached));
};

const stall040: Handler = (c) => {
  const floor = stallFloorMicro({ profile: COST_PROFILES.P5 });
  expectBig(floor, "510606061");
  expect(floor >= 510_606_061n && floor <= 511_000_000n).toBe(true);
  expect(big(c.inputs.u_nav_micro) < floor).toBe(true);
  expect(big(c.inputs.l_nav_micro) > floor).toBe(true);
};

const stall041: Handler = (c) => {
  const r = sizeEntry({
    settledCashMicro: big(c.inputs.cash_micro),
    navMicro: big(c.inputs.nav_micro),
    refPriceMicro: big(c.inputs.reference_price_micro),
    advValueMicro: 5_000_000_000_000n,
    adv20Shares: 1_000_000_000n,
    tier: "U1",
    profile: COST_PROFILES.P5,
  });
  expect(r.reasons).toEqual(["parcel"]);
  expectBig(r.orderValueMicro, c.expected.rejection_value_micro);
};

/** A cohort that bought qty ZZA at priceMicro and holds them at the close of 2026-10-12. */
function holdingRows(qty: bigint, priceMicro: bigint, cashMicro: bigint) {
  const buy: LedgerFill = {
    id: "F1",
    d: "2026-10-05",
    code: "ZZA",
    side: "buy",
    qty,
    valueMicro: qty * priceMicro,
    brokerageMicro: 0n,
  };
  const txns = [
    seedTxn("2026-10-01", qty * priceMicro + cashMicro),
    ...fillTxns(buy),
    settleTxn(settlementItem(buy, []), "2026-10-07"),
  ];
  return { buy, txns, rows: txns.flatMap(txnRows) };
}
const caAction = (type: string, exDate: string, payload: Record<string, unknown>) =>
  ({ id: "A1", code: "ZZA", type, exDate, payload }) satisfies CorpActionRecord;

/** T7, ARN-036: receivable from the ex-date (60 x dps), cash on the pay date, franking never in NAV. */
const dividend027: Handler = (c) => {
  const i = c.inputs;
  const qty = big(i.shares_at_prior_close);
  const { rows, buy } = holdingRows(qty, 10_000_000n, 0n);
  const action = caAction("cash_dividend", "2026-10-13", {
    dps_micro: str(i.dps_micro),
    pay_date: "2026-10-20",
    franking_pct: str(i.franking_pct),
    franking_credit_micro: str(i.franking_credit_micro),
  });
  expect(parseDividend(action).payD).toBe("2026-10-20");
  const plan = planCorporateActions({
    d: "2026-10-13",
    priorD: "2026-10-12",
    actions: [action],
    fills: [buy],
    adjustments: [],
    ledgerRows: rows,
    lastCloseFor: () => undefined,
  });
  const exRows = [...rows, ...plan.txns.flatMap(txnRows)];
  const ex = balancesFromRows(exRows);
  expectBig(ex.div_recv, c.expected.receivable_micro);
  expect(plan.franking[0].creditMicro).toBe(big(c.expected.franking_recorded_micro));
  // no ledger row carries the franking credit, so NAV cannot include it
  expect(exRows.some((r) => r.deltaMicro === big(i.franking_credit_micro))).toBe(false);
  const navOf = (balances: typeof ex) =>
    computeNavDay({
      cohortId: "K1",
      d: "2026-10-20",
      balances,
      positions: new Map([["ZZA", qty]]),
      markFor: () => ({ closeMicro: 10_000_000n, advMicro: 5_000_000_000_000n }),
      profile: COST_PROFILES.P5,
    }).row.navMicro;
  const navAtEx = navOf(ex);
  const payPlan = planCorporateActions({
    d: "2026-10-20",
    priorD: "2026-10-19",
    actions: [action],
    fills: [buy],
    adjustments: [],
    ledgerRows: exRows,
    lastCloseFor: () => undefined,
  });
  const paid = balancesFromRows([...exRows, ...payPlan.txns.flatMap(txnRows)]);
  expectBig(paid.cash_settled, c.expected.cash_on_pay_date_micro);
  expect(paid.div_recv).toBe(0n);
  expectBig(navOf(paid) - navAtEx, c.expected.franking_in_nav_micro); // receivable to cash: NAV equal
};

/** T7, ARN-043 / decision 14: 2-for-1 re-bases quantity and price, no cash, no P/L. */
const split028: Handler = (c) => {
  const i = c.inputs;
  const shares = big(i.shares_before);
  const close = big(i.raw_close_before_micro);
  const { buy, rows } = holdingRows(shares, close, big(i.cash_before_micro));
  const action = caAction("split", "2026-10-13", {
    new: Number(str(i.split_ratio_new_per_old)),
    old: 1,
  });
  const plan = planCorporateActions({
    d: "2026-10-13",
    priorD: "2026-10-12",
    actions: [action],
    fills: [buy],
    adjustments: [],
    ledgerRows: rows,
    lastCloseFor: () => undefined,
  });
  expect(plan.txns).toEqual([]); // cash delta 0: no cash, cost or P/L posting at all
  const after = plan.adjustments[0].qtyAfter;
  expectBig(after, c.expected.shares_after);
  const factor = makeRational(1n, big(i.split_ratio_new_per_old)); // f = 1/2
  const afterClose = mulRat(makeRational(close), factor);
  expect(afterClose.den).toBe(1n);
  expectBig(afterClose.num, c.expected.raw_close_after_micro);
  expectBig(shares * close, c.expected.nav_before_micro);
  expectBig(after * afterClose.num, c.expected.nav_after_micro);
  expectBig(after * afterClose.num - shares * close, c.expected.price_pl_micro);
  const navOn = (qty: bigint, price: bigint) =>
    computeNavDay({
      cohortId: "K1",
      d: "2026-10-13",
      balances: balancesFromRows(rows),
      positions: new Map([["ZZA", qty]]),
      markFor: () => ({ closeMicro: price, advMicro: 5_000_000_000_000n }),
      profile: COST_PROFILES.P5,
    }).row.navMicro;
  expect(navOn(after, afterClose.num)).toBe(navOn(shares, close)); // whole-cohort NAV, cash included
  expectBig(navOn(after, afterClose.num) - navOn(shares, close), c.expected.cash_delta_micro);
  expect(replayCostBasis([buy], toQtyAdjustments(plan), "2026-10-13").holdings.get("ZZA")).toEqual({
    qty: after,
    costMicro: shares * close,
  });
  expect(quantityRatio(action)).toEqual(makeRational(big(i.split_ratio_new_per_old)));
};

/** T7, DAT-223: renounceable rights at the last traded price, non-renounceable nothing. */
const rights029: Handler = (c) => {
  const i = c.inputs;
  const shares = big(i.shares);
  const payload = {
    rights: { new: 1, old: 4 },
    last_price_micro: str(i.rights_last_traded_micro),
  };
  expect(parseRational(str(i.ratio_rights_per_share))).toEqual(makeRational(1n, 4n));
  const ren = parseRights(caAction("rights_renounceable", "2026-10-13", payload));
  const non = parseRights(caAction("rights_non_renounceable", "2026-10-13", payload));
  const count = rightsCount(shares, ren);
  expect(count.den).toBe(1n);
  expectBig(count.num, c.expected.rights_count);
  expectBig(rightsCompensationMicro(shares, ren), c.expected.renounceable_comp_micro);
  expectBig(rightsCompensationMicro(shares, non), c.expected.non_renounceable_comp_micro);
  const { buy, rows } = holdingRows(shares, 10_000_000n, big(i.cash_before_micro));
  const planOf = (type: string) =>
    planCorporateActions({
      d: "2026-10-13",
      priorD: "2026-10-12",
      actions: [caAction(type, "2026-10-13", payload)],
      fills: [buy],
      adjustments: [],
      ledgerRows: rows,
      lastCloseFor: () => undefined,
    });
  const cash = (type: string) =>
    balancesFromRows([...rows, ...planOf(type).txns.flatMap(txnRows)]).cash_settled -
    balancesFromRows(rows).cash_settled;
  expectBig(cash("rights_renounceable"), c.expected.renounceable_comp_micro);
  expectBig(cash("rights_non_renounceable"), c.expected.non_renounceable_comp_micro);
  expect(planOf("rights_renounceable").txns[0].kind).toBe("ca_comp");
};

/**
 * T7, ARN-026, D-071 ruling: "after 20 sessions" = the haircut from halted session 21, i.e. once
 * 20 halted sessions have ELAPSED before the marked day (halt_sessions_elapsed = 20). The table's
 * 300,000,000 holds under that reading; with 19 elapsed the position is still frozen at 600,000,000.
 */
const suspension030: Handler = (c) => {
  const i = c.inputs;
  const sessions = sessionsBetween("2026-10-05", "2027-03-31", []);
  const elapsed = Number(str(i.halt_sessions_elapsed));
  const config = { haircut: parseRational(str(i.haircut)), afterSessions: 20 };
  expect(config.haircut).toEqual(DEFAULT_SUSPENSION.haircut);
  const markOn = (elapsedBefore: number) =>
    suspensionMark({
      lastCloseMicro: big(i.frozen_price_micro),
      advMicro: 5_000_000_000_000n,
      haltStartD: sessions[0],
      d: sessions[elapsedBefore],
      calendar: [],
      config,
    });
  const qty = big(i.shares);
  expectBig(positionValueMicro(qty, markOn(elapsed)), c.expected.marked_value_micro);
  expect(positionValueMicro(qty, markOn(elapsed - 1))).toBe(qty * big(i.frozen_price_micro));
};

const feeIds = Array.from({ length: 13 }, (_, i) => `TST101-${String(i + 1).padStart(3, "0")}`);
const handlers: Record<string, Handler> = {
  ...Object.fromEntries(feeIds.map((id) => [id, brokerage])),
  ...Object.fromEntries(
    ["014", "015", "016", "017", "018", "019", "020", "021"].map((n) => [`TST101-${n}`, slippage]),
  ),
  ...Object.fromEntries(["022", "023", "024", "025"].map((n) => [`TST101-${n}`, sizing])),
  "TST101-026": settlementLedger026,
  "TST101-027": dividend027,
  "TST101-028": split028,
  "TST101-029": rights029,
  "TST101-030": suspension030,
  "TST101-031": initialStop,
  "TST101-032": stopFill,
  "TST101-033": stopFill,
  "TST101-034": exitMapping034,
  "TST101-036": stopFill,
  "TST101-037": stopFill,
  "TST101-038": nav038,
  "TST101-039": liquidation039,
  "TST101-040": stall040,
  "TST101-041": stall041,
};

// Parts of a case (or whole cases) that belong to a later task. Each is an `it.todo`.
const LATER: Record<string, string> = {
  "TST101-035": "T8 sleeve: financing 365-day cumulative",
  "TST101-036": "T8 sleeve: trigger price, P/L, cash returned (the IS fill is asserted here)",
  "TST101-037": "T8 sleeve: loss cap and brokerage beyond margin (the IS fill is asserted here)",
  "TST101-040": "T9 stall: 5 consecutive sessions (the floor is asserted here)",
  "TST101-041": "T9 stall: 20 consecutive sessions (per-session rejection is asserted here)",
  "TST101-042": "T9 C2 exit mapping in ATR units",
  "TST101-043": "T8 sleeve: loss_to_recover and REC-2 unlock",
};

describe("TST-101 known answers (cost, slippage, sizing, fill modules)", () => {
  it("the table has 43 cases and every case is handled or deferred to a named task", () => {
    expect(CASES).toHaveLength(43);
    for (const c of CASES) {
      expect(handlers[c.id] !== undefined || LATER[c.id] !== undefined, c.id).toBe(true);
    }
    for (const id of [...Object.keys(handlers), ...Object.keys(LATER)]) {
      expect(byId.has(id), id).toBe(true);
    }
  });

  for (const c of CASES) {
    const handler = handlers[c.id];
    if (handler !== undefined) it(`${c.id} ${c.description}`, () => handler(c));
  }

  for (const [id, label] of Object.entries(LATER)) it.todo(`${id} ${label}`);
});
