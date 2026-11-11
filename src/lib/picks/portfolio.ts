// D-950 "My portfolio" (Owner 2026-11-11, replaces D-913 "Follow the picks"): three practice
// portfolios, one per risk profile, each starting with the same practice money, that buy from the
// picks of EVERY strategy (the families and the nightly shortlist) and share the money between the
// strategies by their evidence (./allocation.ts, D-951).
//
//   Buy   a pick on the day its paper trade is bought (the pick tracking's entry day and fill,
//         ./track.ts), when its strategy still has room in its share: the strategies of the day go
//         by share (largest first), each through its picks by publication and rank. The size is the
//         smallest of the strategy's room, the value over the profile's holdings, the stock cap
//         (smaller companies have their own cap), the risk cap (value x risk per position over the
//         distance to the stop-loss) and the cash. A stock already held is not bought twice; a buy
//         under the minimum parcel, or whose brokerage both ways is more than the cost limit of the
//         buy, is not made (D-952).
//   Sell  at the stop-loss (intraday, the gap rule), at the aim, at the next open when the time frame
//         ends with no support, when the holding is weak (below its buy price and its N-session
//         average with no signal for M sessions and no new pick), or when its strategy's closing
//         signal fires (the strategy's own sell at the close; for the shortlist a close under its
//         20-session average, the rule's "not breaking down" test) (D-953).
//   Trim  at the next open when a strategy's part of the value drifts more than the profile's band
//         over its share, from its largest holding held long enough, if the sale passes the cost
//         limit (D-954).
//   Cash  waits uninvested (no interest).
//
// Pure: the same picks, results, bars and signals give the same trades, values and splits; the
// database step rebuilds it every night from scratch (./portfolioStore.ts). Money is bigint micro-AUD;
// fills, slippage and brokerage are the arena's (ARN-031/032). Splits, consolidations and bonus
// issues re-base shares and levels from the ex-date (as ./track.ts); dividends are not credited.
import { fillCloseSignalExit, fillIntradayStop, type Bar } from "@/lib/arena/fills";
import { feeFor, type CostProfile } from "@/lib/arena/costs";
import { rebaseQty } from "@/lib/arena/ledger";
import { divCeil, divFloor, mulRat, makeRational, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import type { Micro } from "@/lib/money/micro";
import {
  allocate,
  PPM,
  recordOf,
  STRATEGIES,
  type Allocation,
  type AllocationProfile,
  type StrategyKey,
} from "./allocation";
import {
  buyWords,
  exitWords,
  splitWords,
  trimWords,
  type SplitShareWords,
  type StrategyNames,
} from "./portfolioWords";

export type PortfolioExit =
  "stop" | "gap" | "aim" | "time_frame" | "weak" | "strategy_exit" | "rebalance";
export type TradeReason = "pick" | PortfolioExit;

export type PortfolioPick = {
  readonly pubD: string;
  readonly rank: number;
  readonly code: string;
  readonly strategy: StrategyKey;
  readonly tier: string;
  /** The published reference price (the stop distance of the strategy's picks). */
  readonly referenceMicro: Micro;
  /** The pick tracking's buy (null while waiting or missed). */
  readonly entryD: string | null;
  readonly entryMicro: Micro | null;
  readonly stopMicro: Micro;
  readonly aimMicro: Micro;
  readonly timeFrameSessions: number;
};

/** A finished pick of the profile (the evidence of its strategy). */
export type FinishedPick = {
  readonly strategy: StrategyKey;
  readonly exitD: string;
  readonly netPpm: number;
};

export type DatedBar = Bar & { readonly d: string };

export type ProfileParams = {
  /** Most stocks held at once. */
  readonly holdings: number;
  /** Most of the value lost if a new holding hits its stop-loss, ppm. */
  readonly riskPpm: number;
  /** Most of the value in one stock, ppm (already at most the portfolio's stock cap). */
  readonly stockCapPpm: number;
  /** Most of the value in one smaller company (tier U3), ppm. */
  readonly smallStockCapPpm: number;
  readonly allocation: AllocationProfile;
  /** Drift over a strategy's share that starts a trim, ppm of the value. */
  readonly bandPpm: number;
  /** Sessions a holding is kept before it can be trimmed. */
  readonly minHoldSessions: number;
};

export type PortfolioParams = {
  readonly seedMicro: Micro;
  readonly minParcelMicro: Micro;
  /** Most of the value one strategy may have, ppm. */
  readonly strategyCapPpm: number;
  /** Most a buy's brokerage both ways may cost as a share of the buy (each sale: half), ppm. */
  readonly costMaxPpm: number;
  /** Sessions of the average a weak holding closes under. */
  readonly weakAverageSessions: number;
  /** Sessions without any strategy signal before a weak holding is sold. */
  readonly weakQuietSessions: number;
  /** Sessions of the average a shortlist holding must stay above (its closing signal). */
  readonly shortlistAverageSessions: number;
  readonly costProfile: CostProfile;
  readonly profile: ProfileParams;
  readonly names: StrategyNames;
};

export type PortfolioInput = {
  readonly picks: readonly PortfolioPick[];
  readonly finished: readonly FinishedPick[];
  /** Bars per code, oldest first (enough history before the first pick for the averages). */
  readonly bars: ReadonlyMap<string, readonly DatedBar[]>;
  /** Sessions on which any strategy signalled the code. */
  readonly signalDays: ReadonlyMap<string, ReadonlySet<string>>;
  /** Sessions on which a strategy's closing signal fired for a code, by `${strategy}|${code}`. */
  readonly closeSignals: ReadonlyMap<string, ReadonlySet<string>>;
  /** Confirmed share re-bases per code (ex-date, quantity ratio), by ex-date. */
  readonly actions?: ReadonlyMap<string, readonly { exD: string; ratio: Rational }[]>;
  /** Average daily value traded per code (for slippage), micro-AUD. */
  readonly advMicro: ReadonlyMap<string, Micro>;
  /** The night: nothing after it is used. */
  readonly asOfD: string;
};

export type PortfolioTrade = {
  /** Order of the trade in the run (1, 2, ...). */
  readonly seq: number;
  readonly d: string;
  readonly side: "buy" | "sell";
  readonly code: string;
  readonly strategy: StrategyKey;
  readonly pubD: string;
  readonly rank: number;
  /** The seq of the buy that opened the holding. */
  readonly pos: number;
  readonly qty: bigint;
  readonly priceMicro: Micro;
  readonly feeMicro: Micro;
  /** Sale: proceeds after brokerage minus the part of the cost sold; null for a buy. */
  readonly netMicro: Micro | null;
  readonly reason: TradeReason;
  /** True when the sale closed the holding. */
  readonly closes: boolean;
  /** Plain words, without the stock, amounts or dates (the page adds them). */
  readonly words: string;
};

export type PortfolioHolding = {
  readonly pos: number;
  readonly code: string;
  readonly strategy: StrategyKey;
  readonly pubD: string;
  readonly entryD: string;
  readonly entryMicro: Micro;
  readonly qty: bigint;
  readonly costMicro: Micro;
};

export type PortfolioDay = {
  readonly d: string;
  readonly cashMicro: Micro;
  /** Holdings at the session's close. */
  readonly holdingsMicro: Micro;
  readonly valueMicro: Micro;
  readonly holdings: number;
  /** Fall from the highest value so far, ppm (0 or below). */
  readonly fallPpm: number;
};

export type PortfolioSplit = {
  readonly d: string;
  readonly shares: readonly { strategy: StrategyKey; targetPpm: number }[];
  readonly cashPpm: number;
  readonly words: string;
};

export type SkipReason = "full" | "held" | "share" | "cash" | "small" | "cost" | "stop";

export type PortfolioResult = {
  readonly trades: PortfolioTrade[];
  readonly holdings: PortfolioHolding[];
  readonly days: PortfolioDay[];
  /** One row each time the rounded split changes. */
  readonly splits: PortfolioSplit[];
  /** Picks that filled but were not bought, with the reason. */
  readonly skipped: { pubD: string; rank: number; code: string; reason: SkipReason }[];
};

type Plan = { reason: PortfolioExit; qty: bigint; words: string };

type Position = {
  pos: number;
  pubD: string;
  rank: number;
  code: string;
  strategy: StrategyKey;
  entryD: string;
  entryMicro: Micro;
  qty: bigint;
  cost: Micro;
  stop: Micro;
  aim: Micro;
  timeFrame: number;
  held: number;
  plan: Plan | null;
};

const BIG_PPM = 1_000_000n; // threshold-ok: parts per million
const PERCENT_PPM = 10_000; // threshold-ok: ppm in one percent (the split is compared in whole percents)

/** A price level in post-event terms (as ./track.ts): divided by the quantity ratio, half away, at least 1. */
function levelAt(v: Micro, ratio: Rational): Micro {
  const r = roundHalfAwayFromZero(mulRat(makeRational(v), makeRational(ratio.den, ratio.num)));
  return r < 1n ? 1n : r;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ppmOf = (num: bigint, den: bigint): number => (den > 0n ? Number((num * BIG_PPM) / den) : 0);
const part = (v: bigint, ppm: number): bigint => divFloor(v * BigInt(ppm), BIG_PPM);
const min = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

/** Mean close of the last `n` bars up to index `i` (inclusive); null with fewer bars. */
function average(bars: readonly DatedBar[], i: number, n: number): Micro | null {
  if (n <= 0 || i + 1 < n) return null;
  let s = 0n;
  for (let j = i - n + 1; j <= i; j += 1) s += bars[j]!.closeMicro;
  return divFloor(s, BigInt(n));
}

export function simulatePortfolio(input: PortfolioInput, p: PortfolioParams): PortfolioResult {
  const prof = p.profile;
  if (prof.holdings < 1) throw new RangeError("holdings must be at least 1");
  const picks = [...input.picks].sort(
    (a, b) => cmp(a.pubD, b.pubD) || a.rank - b.rank || cmp(a.code, b.code),
  );
  const firstD = picks[0]?.pubD;
  const trades: PortfolioTrade[] = [];
  const days: PortfolioDay[] = [];
  const splits: PortfolioSplit[] = [];
  const skipped: PortfolioResult["skipped"] = [];
  if (firstD === undefined) return { trades, holdings: [], days, splits, skipped };

  const barAt = new Map<string, Map<string, number>>();
  const sessionSet = new Set<string>();
  for (const [code, list] of input.bars) {
    const m = new Map<string, number>();
    list.forEach((b, i) => {
      m.set(b.d, i);
      if (b.d >= firstD && b.d <= input.asOfD) sessionSet.add(b.d);
    });
    barAt.set(code, m);
  }
  const sessions = [...sessionSet].sort(cmp);
  const entriesOn = new Map<string, PortfolioPick[]>();
  const pickedOn = new Map<string, PortfolioPick[]>(); // by `${code}|${pubD}`
  for (const k of picks) {
    pickedOn.set(`${k.code}|${k.pubD}`, [...(pickedOn.get(`${k.code}|${k.pubD}`) ?? []), k]);
    if (k.entryD !== null && k.entryMicro !== null && k.entryD <= input.asOfD)
      entriesOn.set(k.entryD, [...(entriesOn.get(k.entryD) ?? []), k]);
  }
  const finished = [...input.finished].sort((a, b) => cmp(a.exitD, b.exitD) || a.netPpm - b.netPpm);
  const lastClose = new Map<string, Micro>();
  let cash = p.seedMicro;
  let open: Position[] = [];
  let seq = 0;
  let peak = p.seedMicro;
  let lastSplit: PortfolioSplit | null = null;

  const barOf = (code: string, d: string): { bar: DatedBar; i: number } | null => {
    const i = barAt.get(code)?.get(d);
    return i === undefined ? null : { bar: input.bars.get(code)![i]!, i };
  };
  const envOf = (code: string, bar: DatedBar) => ({
    bar,
    advMicro: input.advMicro.get(code) ?? 0n,
    profile: p.costProfile,
  });
  const priceOf = (pos: Position): Micro => lastClose.get(pos.code) ?? pos.entryMicro;
  const value = (): Micro => {
    let v = cash;
    for (const pos of open) v += pos.qty * priceOf(pos);
    return v;
  };
  const exposure = (s: StrategyKey): Micro => {
    let v = 0n;
    for (const pos of open) if (pos.strategy === s) v += pos.qty * priceOf(pos);
    return v;
  };
  /** Sells `qty` of the holding; returns true when it closed the holding. */
  const sell = (
    pos: Position,
    d: string,
    qty: bigint,
    price: Micro,
    fee: Micro,
    reason: PortfolioExit,
    words: string,
  ): boolean => {
    const closes = qty >= pos.qty;
    const costPart = closes ? pos.cost : divFloor(pos.cost * qty, pos.qty);
    const proceeds = qty * price - fee;
    cash += proceeds;
    seq += 1;
    trades.push({
      seq,
      d,
      side: "sell",
      code: pos.code,
      strategy: pos.strategy,
      pubD: pos.pubD,
      rank: pos.rank,
      pos: pos.pos,
      qty,
      priceMicro: price,
      feeMicro: fee,
      netMicro: proceeds - costPart,
      reason,
      closes,
      words,
    });
    pos.qty -= qty;
    pos.cost -= costPart;
    return closes;
  };
  const exitOnBar = (pos: Position, d: string, bar: DatedBar): boolean => {
    const stop = fillIntradayStop(envOf(pos.code, bar), pos.qty, pos.stop, {
      afterOpen: d === pos.entryD,
    });
    if (stop !== null) {
      const reason = stop.rule === "gap_open" ? "gap" : "stop";
      return sell(
        pos,
        d,
        pos.qty,
        stop.fillPriceMicro,
        stop.brokerageMicro,
        reason,
        exitWords(reason, pos.strategy, p),
      );
    }
    if (bar.highMicro >= pos.aim) {
      const price = bar.openMicro > pos.aim ? bar.openMicro : pos.aim;
      const fee = feeFor(p.costProfile, pos.qty * price, "sell");
      return sell(pos, d, pos.qty, price, fee, "aim", exitWords("aim", pos.strategy, p));
    }
    return false;
  };
  /** Brokerage x sides within the cost limit of the trade's value (a buy passes both sides' fees). */
  const costOk = (fee: Micro, tradeValue: Micro, sides: bigint): boolean =>
    fee * sides * BIG_PPM <= BigInt(p.costMaxPpm) * tradeValue;

  const allocationOn = (d: string, inPlay: Set<StrategyKey>): Allocation => {
    const results = new Map<StrategyKey, number[]>();
    for (const f of finished) {
      if (f.exitD >= d) break;
      results.set(f.strategy, [...(results.get(f.strategy) ?? []), f.netPpm / PPM]);
    }
    const records = new Map([...results].map(([s, r]) => [s, recordOf(r)]));
    const stops = new Map<StrategyKey, { sum: number; n: number }>();
    for (const k of picks) {
      if (k.pubD >= d) break;
      if (k.referenceMicro <= 0n) continue;
      const x = stops.get(k.strategy) ?? { sum: 0, n: 0 };
      x.sum += ppmOf(k.referenceMicro - k.stopMicro, k.referenceMicro) / PPM;
      x.n += 1;
      stops.set(k.strategy, x);
    }
    return allocate(
      {
        inPlay: [...inPlay],
        records,
        stopDistance: new Map([...stops].map(([s, x]) => [s, x.sum / x.n])),
        strategyCap: p.strategyCapPpm / PPM,
      },
      prof.allocation,
    );
  };
  const noteSplit = (d: string, a: Allocation) => {
    const rounded = (x: number) => Math.round(x / PERCENT_PPM);
    const key = (s: { shares: readonly { strategy: string; targetPpm: number }[] }) =>
      s.shares
        .filter((x) => rounded(x.targetPpm) > 0)
        .map((x) => `${x.strategy}:${rounded(x.targetPpm)}`)
        .sort()
        .join(",");
    const shares = a.shares.map((x) => ({ strategy: x.strategy, targetPpm: x.targetPpm }));
    if (lastSplit !== null && key(lastSplit) === key({ shares })) return;
    const detail: SplitShareWords[] = a.shares.map((x) => ({
      strategy: x.strategy,
      targetPpm: x.targetPpm,
      n: x.n,
      mean: x.mean,
      capped: x.capped,
      weak: x.weak,
    }));
    const split: PortfolioSplit = {
      d,
      shares,
      cashPpm: a.cashPpm,
      words: splitWords(detail, a.cashPpm, lastSplit?.shares ?? null, p),
    };
    splits.push(split);
    lastSplit = split;
  };

  for (const d of sessions) {
    // 1. share re-bases with ex-date on this session (a holding bought before it)
    for (const pos of open) {
      for (const a of input.actions?.get(pos.code) ?? []) {
        if (a.exD !== d || pos.entryD >= a.exD) continue;
        pos.qty = rebaseQty(pos.qty, a.ratio);
        pos.stop = levelAt(pos.stop, a.ratio);
        pos.aim = levelAt(pos.aim, a.ratio);
        pos.entryMicro = levelAt(pos.entryMicro, a.ratio);
        const c = lastClose.get(pos.code);
        if (c !== undefined) lastClose.set(pos.code, levelAt(c, a.ratio));
      }
    }
    // 2. sales: tomorrow's planned sales at the open, then the stop and the aim on the bar
    const kept: Position[] = [];
    for (const pos of open) {
      const at = barOf(pos.code, d);
      if (at === null) {
        kept.push(pos);
        continue;
      }
      if (pos.qty === 0n) {
        sell(
          pos,
          d,
          0n,
          at.bar.openMicro,
          0n,
          "time_frame",
          exitWords("none_left", pos.strategy, p),
        );
        continue;
      }
      if (pos.plan !== null) {
        const plan = pos.plan;
        pos.plan = null;
        const qty = plan.qty < pos.qty ? plan.qty : pos.qty;
        const out = fillCloseSignalExit(envOf(pos.code, at.bar), qty);
        if (sell(pos, d, qty, out.fillPriceMicro, out.brokerageMicro, plan.reason, plan.words))
          continue;
      }
      if (!exitOnBar(pos, d, at.bar)) kept.push(pos);
    }
    open = kept;
    // 3. the split of the session: the strategies with a holding or a pick bought today
    const today = (entriesOn.get(d) ?? []).filter((k) => barOf(k.code, d) !== null);
    const inPlay = new Set<StrategyKey>([
      ...open.map((x) => x.strategy),
      ...today.map((k) => k.strategy),
    ]);
    const alloc = allocationOn(d, inPlay);
    if (inPlay.size > 0) noteSplit(d, alloc);
    const targetOf = new Map(alloc.shares.map((x) => [x.strategy, x.targetPpm]));
    // 4. buys: strategy by strategy (largest share first), each through its picks by publication, rank
    const byStrategy = [...today].sort(
      (a, b) =>
        (targetOf.get(b.strategy) ?? 0) - (targetOf.get(a.strategy) ?? 0) ||
        STRATEGIES.indexOf(a.strategy) - STRATEGIES.indexOf(b.strategy) ||
        cmp(a.pubD, b.pubD) ||
        a.rank - b.rank,
    );
    for (const k of byStrategy) {
      const at = barOf(k.code, d)!;
      const entry = k.entryMicro!;
      const skip = (reason: SkipReason) =>
        skipped.push({ pubD: k.pubD, rank: k.rank, code: k.code, reason });
      if (open.some((x) => x.code === k.code)) {
        skip("held");
        continue;
      }
      if (open.length >= prof.holdings) {
        skip("full");
        continue;
      }
      if (entry <= k.stopMicro) {
        skip("stop");
        continue;
      }
      const v = value();
      const target = targetOf.get(k.strategy) ?? 0;
      const room = part(v, target) - exposure(k.strategy);
      if (room < entry) {
        skip("share"); // not one share's worth of room left in the strategy's share
        continue;
      }
      const cap = k.tier === "U3" ? prof.smallStockCapPpm : prof.stockCapPpm;
      const risk = divFloor(v * BigInt(prof.riskPpm) * entry, BIG_PPM * (entry - k.stopMicro));
      const budget = min(room, divFloor(v, BigInt(prof.holdings)), part(v, cap), risk, cash);
      let qty = divFloor(budget, entry);
      let fee = qty > 0n ? feeFor(p.costProfile, qty * entry, "buy") : 0n;
      while (qty > 0n && qty * entry + fee > cash) {
        qty -= 1n;
        fee = qty > 0n ? feeFor(p.costProfile, qty * entry, "buy") : 0n;
      }
      if (qty === 0n) {
        skip("cash");
        continue;
      }
      const amount = qty * entry;
      if (amount < p.minParcelMicro) {
        skip("small");
        continue;
      }
      if (!costOk(fee + feeFor(p.costProfile, amount, "sell"), amount, 1n)) {
        skip("cost");
        continue;
      }
      cash -= amount + fee;
      seq += 1;
      const pos: Position = {
        pos: seq,
        pubD: k.pubD,
        rank: k.rank,
        code: k.code,
        strategy: k.strategy,
        entryD: d,
        entryMicro: entry,
        qty,
        cost: amount + fee,
        stop: k.stopMicro,
        aim: k.aimMicro,
        timeFrame: k.timeFrameSessions,
        held: 0,
        plan: null,
      };
      trades.push({
        seq,
        d,
        side: "buy",
        code: k.code,
        strategy: k.strategy,
        pubD: k.pubD,
        rank: k.rank,
        pos: seq,
        qty,
        priceMicro: entry,
        feeMicro: fee,
        netMicro: null,
        reason: "pick",
        closes: false,
        words: buyWords(k.strategy, ppmOf(amount, v), target, p),
      });
      // the buy session's own range can already reach the stop or the aim (as the pick tracking)
      if (!exitOnBar(pos, d, at.bar)) open.push(pos);
    }
    // 5. the close: values, new picks of a held stock, and tomorrow's planned sales
    for (const pos of open) {
      const at = barOf(pos.code, d);
      if (at === null) continue;
      lastClose.set(pos.code, at.bar.closeMicro);
      pos.held += 1;
      const repick = (pickedOn.get(`${pos.code}|${d}`) ?? [])[0];
      if (repick !== undefined && repick.pubD !== pos.pubD) {
        // picked again: keep it under the new pick's plan (the stop never moves down)
        pos.stop = repick.stopMicro > pos.stop ? repick.stopMicro : pos.stop;
        pos.aim = repick.aimMicro;
        pos.timeFrame = repick.timeFrameSessions;
        pos.held = 0;
        continue;
      }
      const planAll = (reason: PortfolioExit, kind: Parameters<typeof exitWords>[0] = reason) => {
        pos.plan = { reason, qty: pos.qty, words: exitWords(kind, pos.strategy, p) };
      };
      const bars = input.bars.get(pos.code)!;
      if (pos.strategy === "SL") {
        const avg = average(bars, at.i, p.shortlistAverageSessions);
        if (avg !== null && at.bar.closeMicro < avg) {
          planAll("strategy_exit");
          continue;
        }
      } else if (input.closeSignals.get(`${pos.strategy}|${pos.code}`)?.has(d) === true) {
        planAll("strategy_exit");
        continue;
      }
      const signalled = input.signalDays.get(pos.code)?.has(d) === true;
      if (pos.held >= pos.timeFrame && !signalled) {
        planAll("time_frame");
        continue;
      }
      const avg = average(bars, at.i, p.weakAverageSessions);
      const quiet = (() => {
        const sig = input.signalDays.get(pos.code);
        if (sig === undefined) return true;
        for (let j = at.i; j >= 0 && j > at.i - p.weakQuietSessions; j -= 1)
          if (sig.has(bars[j]!.d)) return false;
        return true;
      })();
      if (at.bar.closeMicro < pos.entryMicro && avg !== null && at.bar.closeMicro < avg && quiet)
        planAll("weak");
    }
    // 6. trims: a strategy more than the band over its share sells part of its largest holding
    const v = value();
    for (const share of alloc.shares) {
      const have = exposure(share.strategy);
      const over = have - part(v, share.targetPpm);
      if (over * BIG_PPM <= BigInt(prof.bandPpm) * v) continue;
      const candidates = open
        .filter(
          (x) =>
            x.strategy === share.strategy &&
            x.plan === null &&
            x.held >= prof.minHoldSessions &&
            lastClose.has(x.code),
        )
        .sort((a, b) => {
          const va = a.qty * priceOf(a);
          const vb = b.qty * priceOf(b);
          return vb > va ? 1 : vb < va ? -1 : cmp(a.code, b.code);
        });
      const pos = candidates[0];
      if (pos === undefined) continue;
      const price = priceOf(pos);
      let qty = divCeil(over, price);
      if (qty > pos.qty) qty = pos.qty;
      if ((pos.qty - qty) * price < p.minParcelMicro) qty = pos.qty;
      const amount = qty * price;
      if (qty <= 0n || !costOk(feeFor(p.costProfile, amount, "sell"), amount, 2n)) continue;
      pos.plan = {
        reason: "rebalance",
        qty,
        words: trimWords(share.strategy, ppmOf(have, v), share.targetPpm, prof.bandPpm, p),
      };
    }
    let holdings = 0n;
    for (const pos of open) holdings += pos.qty * priceOf(pos);
    const total = cash + holdings;
    if (total > peak) peak = total;
    days.push({
      d,
      cashMicro: cash,
      holdingsMicro: holdings,
      valueMicro: total,
      holdings: open.length,
      fallPpm: ppmOf(total - peak, peak),
    });
  }
  trades.sort((a, b) => a.seq - b.seq);
  const holdings: PortfolioHolding[] = open
    .map((pos) => ({
      pos: pos.pos,
      code: pos.code,
      strategy: pos.strategy,
      pubD: pos.pubD,
      entryD: pos.entryD,
      entryMicro: pos.entryMicro,
      qty: pos.qty,
      costMicro: pos.cost,
    }))
    .sort((a, b) => a.pos - b.pos);
  return { trades, holdings, days, splits, skipped };
}
