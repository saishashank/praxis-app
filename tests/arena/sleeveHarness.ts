// Synthetic cohort with a leverage sleeve for the T8 property tests (TST-104 style) and the
// invariant mutation tests. Test support only. A seeded random walk of ONE code (ZZA): random
// family entries (stock buy, sized by sizeEntry through planSleeveEntry, with a real sleeve, a
// skipped sleeve or a shadow sleeve), random family exits (stock CS exit and the sleeve's CS exit),
// the 50 % close-out evaluated every session, financing posted daily, T+2 settlement, a NAV per
// close computed INCREMENTALLY, lock and recovery REC-1..REC-4. Deterministic in `seed`.
import { COST_PROFILES } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  type FillEnv,
  type SimulatedFill,
} from "@/lib/arena/fills";
import {
  availableCash,
  fillTxns,
  pendingSettlements,
  replayCostBasis,
  seedTxn,
  settlementsDue,
  txnRows,
  zeroBalances,
  type LedgerBalances,
  type LedgerFill,
  type LedgerRow,
  type LedgerTxn,
} from "@/lib/arena/ledger";
import { computeNavDay, type CohortBooks, type NavDay } from "@/lib/arena/nav";
import type { RecoveryMode } from "@/lib/arena/schema";
import {
  closedTrade,
  closeSleeve,
  defaultSleeveConfig,
  earlierSleeveExit,
  evaluateUnlock,
  financingAccruedAt,
  lockAfterClose,
  lockStatus,
  openRealTradeAt,
  openTrade,
  planSleeveEntry,
  quoteSleeveExit,
  quoteSleeveEntry,
  realisedUnleveredNetSince,
  sessionsSinceLock,
  shadowNetSince,
  sleeveCloseTxn,
  sleeveEligibility,
  sleeveFinancingTxn,
  sleeveLiquidationCostMicro,
  sleeveOpenTxn,
  sleeveUnrealAt,
  type SleeveCloseResult,
  type SleeveConfig,
  type SleeveExitQuote,
  type SleeveStateEntry,
  type SleeveTrade,
} from "@/lib/arena/sleeve";
import { addDays, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { makeCalendar, rng } from "./ledgerHarness";

const START = "2026-01-05";
const ADV = 6_000_000_000_000n;
const roundTick = (v: bigint): bigint => (v / 10_000n) * 10_000n;

export type SleeveSim = {
  cohortId: string;
  seedMicro: bigint;
  calendar: CalendarRow[];
  dates: string[];
  cfg: SleeveConfig;
  rows: LedgerRow[];
  fills: LedgerFill[];
  trades: SleeveTrade[];
  states: SleeveStateEntry[];
  days: NavDay[];
  books: CohortBooks;
  closes: Map<string, bigint>;
  closeResults: Map<string, SleeveCloseResult>;
  entryFees: Map<string, bigint>;
  stats: {
    realOpened: number;
    shadowOpened: number;
    closeouts: number;
    capped: number;
    locks: number;
    unlocks: number;
    skipped: number;
  };
};

export function simulateSleeve(options: {
  seed: number;
  days: number;
  mode: RecoveryMode;
}): SleeveSim {
  const r = rng(options.seed);
  const cohortId = "K1";
  const seedMicro = 600_000_000n;
  const profile = COST_PROFILES.P5;
  const cfg: SleeveConfig = { ...defaultSleeveConfig(profile), recoveryMode: options.mode };
  const calendar = makeCalendar(r, options.days);
  const dates = sessionsBetween(START, addDays(START, options.days * 2 + 90), calendar).slice(
    0,
    options.days,
  );

  const rows: LedgerRow[] = [];
  const fills: LedgerFill[] = [];
  const balances: Record<string, bigint> = { ...zeroBalances() };
  const trades = new Map<string, SleeveTrade>();
  const states: SleeveStateEntry[] = [];
  const days: NavDay[] = [];
  const closes = new Map<string, bigint>();
  const closeResults = new Map<string, SleeveCloseResult>();
  const entryFees = new Map<string, bigint>();
  const navByDate = new Map<string, bigint>();
  const stats = {
    realOpened: 0,
    shadowOpened: 0,
    closeouts: 0,
    capped: 0,
    locks: 0,
    unlocks: 0,
    skipped: 0,
  };
  let held = 0n;
  let fillCount = 0;
  let tradeCount = 0;
  let price = roundTick(BigInt(r.int(300, 3_000)) * 10_000n);

  const post = (txn: LedgerTxn) => {
    for (const row of txnRows(txn)) {
      rows.push(row);
      balances[row.account] += row.deltaMicro;
    }
  };
  const settledIds = () =>
    new Set(
      rows.filter((x) => x.kind === "settle" && x.refType === "fill").map((x) => x.refId ?? ""),
    );
  const pendingNow = () => pendingSettlements(fills, settledIds(), calendar);
  const tradeList = () => [...trades.values()];

  const recordFill = (d: string, fill: SimulatedFill) => {
    fillCount += 1;
    const lf: LedgerFill = {
      id: `F${String(fillCount).padStart(5, "0")}`,
      d,
      code: "ZZA",
      side: fill.side,
      qty: fill.qty,
      valueMicro: fill.valueMicro,
      brokerageMicro: fill.brokerageMicro,
    };
    fills.push(lf);
    const cost = replayCostBasis(fills, [], d).saleCostByFillId.get(lf.id);
    for (const t of fillTxns(lf, cost)) post(t);
    held += fill.side === "buy" ? fill.qty : -fill.qty;
  };

  const postedFinancing = (id: string): bigint =>
    -rows
      .filter(
        (x) =>
          x.kind === "financing" &&
          x.account === "fin_accrued" &&
          x.refType === "sleeve_trade" &&
          x.refId === id,
      )
      .reduce((t, x) => t + x.deltaMicro, 0n);
  const catchUp = (t: SleeveTrade, d: string) => {
    const target = financingAccruedAt(t, d, cfg);
    const posted = postedFinancing(t.id);
    if (target > posted) post(sleeveFinancingTxn(t, d, target - posted));
  };

  const openOf = (shadow: boolean): SleeveTrade | null =>
    tradeList().find((t) => t.shadow === shadow && t.closed === null) ?? null;

  const closeTrade = (t: SleeveTrade, d: string, exit: SleeveExitQuote) => {
    const financing = financingAccruedAt(t, d, cfg);
    if (!t.shadow) catchUp(t, d);
    const entryFee = entryFees.get(t.id) as bigint;
    const result = closeSleeve({
      trade: t,
      entryBrokerageMicro: entryFee,
      closeD: d,
      exitPriceMicro: exit.fill.fillPriceMicro,
      exitBrokerageMicro: exit.fill.brokerageMicro,
      closedBy: exit.closedBy,
      exitFillId: t.shadow ? null : `XF-${t.id}`,
      financingMicro: financing,
    });
    const done = closedTrade(t, result);
    trades.set(t.id, done);
    closeResults.set(t.id, result);
    if (exit.closedBy === "closeout") stats.closeouts += 1;
    if (result.capped) stats.capped += 1;
    if (!t.shadow) {
      post(sleeveCloseTxn(t, result));
      const lock = lockAfterClose(states, done, cfg);
      if (lock !== null) {
        states.push(lock);
        stats.locks += 1;
      }
    }
  };

  post(seedTxn(dates[0], seedMicro));

  for (const d of dates) {
    for (const t of settlementsDue(pendingNow(), d)) post(t);

    // today's bar
    const gap = r.chance(0.04) ? r.int(-1_800, 800) : r.int(-250, 250);
    const o0 = roundTick(price + (price * BigInt(gap)) / 10_000n);
    const o = o0 < 2_000_000n ? 2_000_000n : o0;
    const c0 = roundTick(o + (o * BigInt(r.int(-450, 450))) / 10_000n);
    const c = c0 < 2_000_000n ? 2_000_000n : c0;
    const high = (o > c ? o : c) + BigInt(r.int(0, 8)) * 10_000n;
    const low0 = (o < c ? o : c) - BigInt(r.int(0, 12)) * 10_000n;
    const low = low0 < 2_000_000n ? 2_000_000n : low0;
    const bar = { openMicro: o, highMicro: high, lowMicro: low, closeMicro: c };
    const env: FillEnv = { bar, advMicro: ADV, profile };
    price = c;
    closes.set(d, c);

    // 1. exits: the family exit (stock + sleeves at the open) and the sleeve close-out
    const familyExit = held > 0n && r.chance(0.16);
    for (const shadow of [false, true]) {
      const t = openOf(shadow);
      if (t === null) continue;
      const closeout = quoteSleeveExit(
        env,
        t,
        { kind: "closeout", financingMicro: financingAccruedAt(t, d, cfg) },
        cfg,
      );
      const family = familyExit ? quoteSleeveExit(env, t, { kind: "cs" }, cfg) : null;
      const pick =
        closeout !== null && family !== null
          ? earlierSleeveExit(family, closeout)
          : (closeout ?? family);
      if (pick !== null) closeTrade(t, d, pick);
    }
    if (familyExit) {
      const exit = fillCloseSignalExit(env, held);
      if (exit.valueMicro > exit.brokerageMicro) recordFill(d, exit);
    }

    // 2. entry (stock + sleeve per ARN-003)
    if (held === 0n && r.chance(0.35)) {
      const avail = availableCash({
        mode: "matched",
        balances: balances as LedgerBalances,
        pending: pendingNow(),
        sessionD: d,
      });
      const nav = computeNavDay({
        cohortId,
        d,
        balances: balances as LedgerBalances,
        positions: new Map(),
        markFor: () => undefined,
        profile,
        sleeveUnrealMicro: 0n,
      }).row.navMicro;
      const real = openOf(false);
      const plan = planSleeveEntry({
        sizing: {
          settledCashMicro: avail,
          navMicro: nav,
          refPriceMicro: o,
          advValueMicro: ADV,
          adv20Shares: 1_000_000_000n,
          tier: "U1",
          profile,
        },
        cfg,
        locked: lockStatus(states).locked,
        hasOpenSleeve: real !== null,
        settledCashMicro: balances.cash_settled,
        eligibility: sleeveEligibility({ tier: "U1" }),
      });
      if (plan.kind !== "none") {
        const stockFill = fillEntryAtOpen(env, plan.sizing.qty);
        recordFill(d, stockFill);
        tradeCount += 1;
        const id = `S${String(tradeCount).padStart(4, "0")}`;
        if (plan.kind === "stock_and_sleeve") {
          const quote = quoteSleeveEntry(env, plan.marginMicro, cfg);
          const t = openTrade({
            id,
            cohortId,
            code: "ZZA",
            openD: d,
            quote,
            entryFillId: `EF-${id}`,
            cfg,
          });
          trades.set(id, t);
          entryFees.set(id, quote.entryBrokerageMicro);
          post(sleeveOpenTxn(t, quote.entryBrokerageMicro));
          stats.realOpened += 1;
          // the close-out can only bite after the open of the entry session
          const co = quoteSleeveExit(
            env,
            t,
            { kind: "closeout", financingMicro: 0n, afterOpen: true },
            cfg,
          );
          if (co !== null) closeTrade(t, d, co);
        } else if (plan.sleeve === "shadow") {
          if (openOf(true) === null) {
            const quote = quoteSleeveEntry(env, plan.shadowMarginMicro, cfg);
            const t = openTrade({
              id,
              cohortId,
              code: "ZZA",
              openD: d,
              quote,
              entryFillId: null,
              shadow: true,
              cfg,
            });
            trades.set(id, t);
            entryFees.set(id, quote.entryBrokerageMicro);
            stats.shadowOpened += 1;
            const co = quoteSleeveExit(
              env,
              t,
              { kind: "closeout", financingMicro: 0n, afterOpen: true },
              cfg,
            );
            if (co !== null) closeTrade(t, d, co);
          }
        } else {
          stats.skipped += 1;
        }
      }
    }

    // 3. financing to the end of the day, NAV, recovery
    const realOpen = openRealTradeAt(tradeList(), d);
    if (realOpen !== null) catchUp(realOpen, d);
    const day = computeNavDay({
      cohortId,
      d,
      balances: { ...(balances as LedgerBalances) },
      positions: held > 0n ? new Map([["ZZA", held]]) : new Map(),
      markFor: () => ({ closeMicro: c, advMicro: ADV }),
      profile,
      sleeveUnrealMicro: sleeveUnrealAt({
        trades: tradeList(),
        d,
        closeFor: () => c,
        cfg,
      }),
      sleeveLiquidationCostMicro: sleeveLiquidationCostMicro(realOpen, cfg),
    });
    days.push(day);
    navByDate.set(d, day.row.navMicro);

    const status = lockStatus(states);
    if (status.locked && status.lockD !== null) {
      const locking = tradeList()
        .filter((t) => !t.shadow && t.closed !== null && t.closed.closeD === status.lockD)
        .sort((a, b) => (a.openD < b.openD ? 1 : -1))[0];
      const before = [...navByDate.entries()]
        .filter(([date]) => locking !== undefined && date < locking.openD)
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))[0];
      const unlock = evaluateUnlock(
        states,
        {
          d,
          navMicro: day.row.navMicro,
          refNavMicro: before === undefined ? seedMicro : before[1],
          realisedUnleveredNetMicro: realisedUnleveredNetSince(rows, status.lockD, d),
          shadowNetMicro: shadowNetSince(tradeList(), status.lockD, d),
          sessionsSinceLock: sessionsSinceLock(status.lockD, d, calendar),
        },
        cfg,
      );
      if (unlock !== null) {
        states.push(unlock);
        stats.unlocks += 1;
      }
    }
  }

  const finalTrades = tradeList();
  const books: CohortBooks = {
    cohortId,
    rows,
    fills,
    markFor: (d) => {
      const close = closes.get(d);
      return close === undefined ? undefined : { closeMicro: close, advMicro: ADV };
    },
    profile,
    sleeveUnrealFor: (d) =>
      sleeveUnrealAt({ trades: finalTrades, d, closeFor: (_code, dd) => closes.get(dd), cfg }),
    sleeveLiquidationCostFor: (d) =>
      sleeveLiquidationCostMicro(openRealTradeAt(finalTrades, d), cfg),
  };
  return {
    cohortId,
    seedMicro,
    calendar,
    dates,
    cfg,
    rows,
    fills,
    trades: finalTrades,
    states,
    days,
    books,
    closes,
    closeResults,
    entryFees,
    stats,
  };
}
