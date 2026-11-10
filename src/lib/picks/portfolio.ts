// "Follow the picks" portfolio (Owner 2026-11-10, D-913): the practice portfolio the Owner would have by
// trading exactly the published picks of one risk profile, run as if it were the Owner's own money.
//
//   Buy   a pick when its paper trade is bought (the pick tracking's entry day and fill, ./track.ts),
//         if a slot is free: at most `slots` holdings, each about value / slots, never more than the
//         cash, never under the ASX minimum parcel. Several fills on one day: by publication, then rank.
//         A stock already held is not bought twice; a new pick of it refreshes the holding instead.
//   Sell  at the stop-loss (intraday, the gap rule), at the aim, at the next open when the time frame
//         ends with no support (not picked again and no strategy signal that session), or at the next
//         open when the holding is weak: below its buy price and its N-session average, with no
//         signal for M sessions and no new pick. Otherwise keep it.
//   Cash  waits uninvested (no interest) until the next pick fills.
//
// Pure: the same picks, bars and signals give the same trades and values; the database step rebuilds
// it every night from scratch (./portfolioStore.ts). Money is bigint micro-AUD; fills, slippage and
// brokerage are the arena's (ARN-031/032), as in the pick tracking. Splits, consolidations and bonus
// issues re-base shares and levels from the ex-date (as ./track.ts); dividends are not credited.
import { fillCloseSignalExit, fillIntradayStop, type Bar } from "@/lib/arena/fills";
import { feeFor, type CostProfile } from "@/lib/arena/costs";
import { rebaseQty } from "@/lib/arena/ledger";
import { divFloor, mulRat, makeRational, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import type { Micro } from "@/lib/money/micro";

export type PortfolioExit = "stop" | "gap" | "aim" | "time_frame" | "weak";

export type PortfolioPick = {
  readonly pubD: string;
  readonly rank: number;
  readonly code: string;
  /** The pick tracking's buy (null while waiting or missed). */
  readonly entryD: string | null;
  readonly entryMicro: Micro | null;
  readonly stopMicro: Micro;
  readonly aimMicro: Micro;
  readonly timeFrameSessions: number;
};

export type DatedBar = Bar & { readonly d: string };

export type PortfolioParams = {
  readonly seedMicro: Micro;
  readonly slots: number;
  readonly minParcelMicro: Micro;
  /** Sessions of the average a weak holding closes under. */
  readonly weakAverageSessions: number;
  /** Sessions without any strategy signal before a weak holding is sold. */
  readonly weakQuietSessions: number;
  readonly costProfile: CostProfile;
};

export type PortfolioInput = {
  readonly picks: readonly PortfolioPick[];
  /** Bars per code, oldest first (enough history before the first pick for the average). */
  readonly bars: ReadonlyMap<string, readonly DatedBar[]>;
  /** Sessions on which any strategy signalled the code. */
  readonly signalDays: ReadonlyMap<string, ReadonlySet<string>>;
  /** Confirmed share re-bases per code (ex-date, quantity ratio), by ex-date. */
  readonly actions?: ReadonlyMap<string, readonly { exD: string; ratio: Rational }[]>;
  /** Average daily value traded per code (for slippage), micro-AUD. */
  readonly advMicro: ReadonlyMap<string, Micro>;
  /** The night: nothing after it is used. */
  readonly asOfD: string;
};

export type PortfolioTrade = {
  readonly pubD: string;
  readonly rank: number;
  readonly code: string;
  readonly entryD: string;
  readonly entryMicro: Micro;
  /** Shares now held (after any re-base). */
  readonly qty: bigint;
  /** What was paid, brokerage included. */
  readonly costMicro: Micro;
  readonly exitD: string | null;
  readonly exitMicro: Micro | null;
  readonly exitReason: PortfolioExit | null;
  /** Sale proceeds after brokerage minus the cost; null while held. */
  readonly netMicro: Micro | null;
};

export type PortfolioDay = {
  readonly d: string;
  readonly cashMicro: Micro;
  /** Holdings at the session's close. */
  readonly holdingsMicro: Micro;
  readonly valueMicro: Micro;
  readonly holdings: number;
};

export type PortfolioResult = {
  readonly trades: PortfolioTrade[];
  readonly days: PortfolioDay[];
  /** Picks that filled while every slot was taken or the cash was short (their own row stays in History). */
  readonly skipped: {
    pubD: string;
    rank: number;
    code: string;
    reason: "full" | "cash" | "held";
  }[];
};

type Position = {
  pubD: string;
  rank: number;
  code: string;
  entryD: string;
  entryMicro: Micro;
  qty: bigint;
  cost: Micro;
  stop: Micro;
  aim: Micro;
  timeFrame: number;
  held: number;
  exitNextOpen: PortfolioExit | null;
};

/** A price level in post-event terms (as ./track.ts): divided by the quantity ratio, half away, at least 1. */
function levelAt(v: Micro, ratio: Rational): Micro {
  const r = roundHalfAwayFromZero(mulRat(makeRational(v), makeRational(ratio.den, ratio.num)));
  return r < 1n ? 1n : r;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Mean close of the last `n` bars up to index `i` (inclusive); null with fewer bars. */
function average(bars: readonly DatedBar[], i: number, n: number): Micro | null {
  if (n <= 0 || i + 1 < n) return null;
  let s = 0n;
  for (let j = i - n + 1; j <= i; j += 1) s += bars[j]!.closeMicro;
  return divFloor(s, BigInt(n));
}

export function simulatePortfolio(input: PortfolioInput, p: PortfolioParams): PortfolioResult {
  if (p.slots < 1) throw new RangeError("slots must be at least 1");
  const picks = [...input.picks].sort((a, b) => cmp(a.pubD, b.pubD) || a.rank - b.rank);
  const firstD = picks[0]?.pubD;
  const trades: PortfolioTrade[] = [];
  const days: PortfolioDay[] = [];
  const skipped: PortfolioResult["skipped"] = [];
  if (firstD === undefined) return { trades, days, skipped };

  // index of each code's bar by date, and the sessions after the first publication up to the night
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
  const lastClose = new Map<string, Micro>();
  let cash = p.seedMicro;
  let open: Position[] = [];

  const barOf = (code: string, d: string): { bar: DatedBar; i: number } | null => {
    const i = barAt.get(code)?.get(d);
    return i === undefined ? null : { bar: input.bars.get(code)![i]!, i };
  };
  const envOf = (code: string, bar: DatedBar) => ({
    bar,
    advMicro: input.advMicro.get(code) ?? 0n,
    profile: p.costProfile,
  });
  const close = (pos: Position, d: string, price: Micro, fee: Micro, reason: PortfolioExit) => {
    const proceeds = pos.qty * price - fee;
    cash += proceeds;
    trades.push({
      pubD: pos.pubD,
      rank: pos.rank,
      code: pos.code,
      entryD: pos.entryD,
      entryMicro: pos.entryMicro,
      qty: pos.qty,
      costMicro: pos.cost,
      exitD: d,
      exitMicro: price,
      exitReason: reason,
      netMicro: proceeds - pos.cost,
    });
  };
  /** Stop, then aim, on the session's bar; true when the position was sold. */
  const exitOnBar = (pos: Position, d: string, bar: DatedBar): boolean => {
    const stop = fillIntradayStop(envOf(pos.code, bar), pos.qty, pos.stop, {
      afterOpen: d === pos.entryD,
    });
    if (stop !== null) {
      close(
        pos,
        d,
        stop.fillPriceMicro,
        stop.brokerageMicro,
        stop.rule === "gap_open" ? "gap" : "stop",
      );
      return true;
    }
    if (bar.highMicro >= pos.aim) {
      const price = bar.openMicro > pos.aim ? bar.openMicro : pos.aim;
      close(pos, d, price, feeFor(p.costProfile, pos.qty * price, "sell"), "aim");
      return true;
    }
    return false;
  };
  const value = (): Micro => {
    let v = cash;
    for (const pos of open) v += pos.qty * (lastClose.get(pos.code) ?? pos.entryMicro);
    return v;
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
      }
    }
    // 2. exits of the holdings on this session's bar
    const kept: Position[] = [];
    for (const pos of open) {
      const at = barOf(pos.code, d);
      if (at === null) {
        kept.push(pos);
        continue;
      }
      if (pos.qty === 0n) {
        close(pos, d, at.bar.openMicro, 0n, "time_frame"); // a consolidation left no whole share
        continue;
      }
      if (pos.exitNextOpen !== null) {
        const out = fillCloseSignalExit(envOf(pos.code, at.bar), pos.qty);
        close(pos, d, out.fillPriceMicro, out.brokerageMicro, pos.exitNextOpen);
        continue;
      }
      if (!exitOnBar(pos, d, at.bar)) kept.push(pos);
    }
    open = kept;
    // 3. buys: the picks the tracking bought on this session, if a slot and the cash allow
    for (const k of entriesOn.get(d) ?? []) {
      const at = barOf(k.code, d);
      if (at === null || k.entryMicro === null) continue;
      if (open.some((x) => x.code === k.code)) {
        skipped.push({ pubD: k.pubD, rank: k.rank, code: k.code, reason: "held" });
        continue;
      }
      if (open.length >= p.slots) {
        skipped.push({ pubD: k.pubD, rank: k.rank, code: k.code, reason: "full" });
        continue;
      }
      const slot = divFloor(value(), BigInt(p.slots));
      const budget = slot < cash ? slot : cash;
      let qty = divFloor(budget, k.entryMicro);
      let fee = qty > 0n ? feeFor(p.costProfile, qty * k.entryMicro, "buy") : 0n;
      while (qty > 0n && qty * k.entryMicro + fee > cash) {
        qty -= 1n;
        fee = qty > 0n ? feeFor(p.costProfile, qty * k.entryMicro, "buy") : 0n;
      }
      if (qty === 0n || qty * k.entryMicro < p.minParcelMicro) {
        skipped.push({ pubD: k.pubD, rank: k.rank, code: k.code, reason: "cash" });
        continue;
      }
      const cost = qty * k.entryMicro + fee;
      cash -= cost;
      const pos: Position = {
        pubD: k.pubD,
        rank: k.rank,
        code: k.code,
        entryD: d,
        entryMicro: k.entryMicro,
        qty,
        cost,
        stop: k.stopMicro,
        aim: k.aimMicro,
        timeFrame: k.timeFrameSessions,
        held: 0,
        exitNextOpen: null,
      };
      // the buy session's own range can already reach the stop or the aim (as the pick tracking)
      if (!exitOnBar(pos, d, at.bar)) open.push(pos);
    }
    // 4. the close: values, new picks of a held stock, and tomorrow's planned sales
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
      const signalled = input.signalDays.get(pos.code)?.has(d) === true;
      if (pos.held >= pos.timeFrame && !signalled) {
        pos.exitNextOpen = "time_frame";
        continue;
      }
      const bars = input.bars.get(pos.code)!;
      const avg = average(bars, at.i, p.weakAverageSessions);
      const quiet = (() => {
        const days = input.signalDays.get(pos.code);
        if (days === undefined) return true;
        for (let j = at.i; j >= 0 && j > at.i - p.weakQuietSessions; j -= 1)
          if (days.has(bars[j]!.d)) return false;
        return true;
      })();
      if (at.bar.closeMicro < pos.entryMicro && avg !== null && at.bar.closeMicro < avg && quiet)
        pos.exitNextOpen = "weak";
    }
    let holdings = 0n;
    for (const pos of open) holdings += pos.qty * (lastClose.get(pos.code) ?? pos.entryMicro);
    days.push({
      d,
      cashMicro: cash,
      holdingsMicro: holdings,
      valueMicro: cash + holdings,
      holdings: open.length,
    });
  }
  for (const pos of open)
    trades.push({
      pubD: pos.pubD,
      rank: pos.rank,
      code: pos.code,
      entryD: pos.entryD,
      entryMicro: pos.entryMicro,
      qty: pos.qty,
      costMicro: pos.cost,
      exitD: null,
      exitMicro: null,
      exitReason: null,
      netMicro: null,
    });
  trades.sort((a, b) => cmp(a.entryD, b.entryD) || cmp(a.pubD, b.pubD) || a.rank - b.rank);
  return { trades, days, skipped };
}
