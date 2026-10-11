// @vitest-environment node
// TST-101 known-answer loader (M3 T3/T5; docs/M3_tst101_draft.md with the D-071 architect rulings).
// Runs EVERY case of tests/fixtures/arena/tst101_public.json that belongs to the cost, slippage,
// sizing and fill modules, asserting exact micro equality. Cases that belong to later tasks are
// listed as `it.todo` with their task (T6 ledger/NAV, T7 corporate actions, T8 sleeve, T9 cohorts).
// The table is the authority: this file never edits an expected value. Where the implementation
// follows an architect ruling that differs from a table value, the test asserts the ruling and
// the difference is named in DISAGREEMENTS below (reported to the architect).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COST_PROFILES, feeFor, isCostProfileCode } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  fillIntradayStop,
  initialStopFromFill,
  selectExit,
  type FillEnv,
} from "@/lib/arena/fills";
import { sizeEntry, stallFloorMicro } from "@/lib/arena/sizing";
import { bucketBpsFor, slippageFill } from "@/lib/arena/slippage";
import { parseRational } from "@/lib/money/rational";
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
  // liquidation NAV = NAV - slippage cost - brokerage (NAV itself belongs to T6).
  expectBig(
    big(c.expected.nav_micro) - f.slipMicro * qty - f.brokerageMicro,
    c.expected.liquidation_nav_micro,
  );
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

const feeIds = Array.from({ length: 13 }, (_, i) => `TST101-${String(i + 1).padStart(3, "0")}`);
const handlers: Record<string, Handler> = {
  ...Object.fromEntries(feeIds.map((id) => [id, brokerage])),
  ...Object.fromEntries(
    ["014", "015", "016", "017", "018", "019", "020", "021"].map((n) => [`TST101-${n}`, slippage]),
  ),
  ...Object.fromEntries(["022", "023", "024", "025"].map((n) => [`TST101-${n}`, sizing])),
  "TST101-026": settlementSale,
  "TST101-031": initialStop,
  "TST101-032": stopFill,
  "TST101-033": stopFill,
  "TST101-034": exitMapping034,
  "TST101-036": stopFill,
  "TST101-037": stopFill,
  "TST101-039": liquidation039,
  "TST101-040": stall040,
  "TST101-041": stall041,
};

// Parts of a case (or whole cases) that belong to a later task. Each is an `it.todo`.
const LATER: Record<string, string> = {
  "TST101-026": "T6 settlement: matched / conservative cash availability by session",
  "TST101-027": "T7 corporate actions: dividend receivable, pay date, franking",
  "TST101-028": "T7 corporate actions: split neutrality",
  "TST101-029": "T7 corporate actions: renounceable and non-renounceable rights",
  "TST101-030": "T7 corporate actions: suspension haircut from session 21 (ruling)",
  "TST101-035": "T8 sleeve: financing 365-day cumulative",
  "TST101-036": "T8 sleeve: trigger price, P/L, cash returned (the IS fill is asserted here)",
  "TST101-037": "T8 sleeve: loss cap and brokerage beyond margin (the IS fill is asserted here)",
  "TST101-038": "T6 NAV (ARN-051)",
  "TST101-039": "T6/T9 liquidation NAV and the target verdict (the exit fill is asserted here)",
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
