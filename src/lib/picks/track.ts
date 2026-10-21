// ARN-095 pick tracking. Every published pick (and its luck-check twin) is followed on paper,
// separately from the 12 Strategies: "bought" at the open of a session inside its validity window
// only if that open is inside the buy zone (otherwise "missed", recorded, never a win or a loss),
// then closed at the stop-loss (the gap rule of ARN-021: an open at or below the stop fills at the
// open), the aim, or the end of the time frame (a close-signal exit at the next open), with the same
// fills, slippage and brokerage as the arena (ARN-031/032, `src/lib/arena/fills.ts`).
//
// The simulation is a pure function of the published numbers and the bars after publication. The
// database step recomputes it from scratch every night, so a re-run writes nothing new, and a
// stored state the recomputation contradicts raises. A session without a stored bar is skipped.
// Splits, consolidations and bonus issues inside the window are re-based (M7 T4, decision 33): from
// the ex-date the levels are divided by the exact M3 quantity ratio and a held position's shares are
// multiplied by it and rounded down (`rebaseQty`), cash unchanged, as the arena does. Known limit
// (D-122): no dividends and no other corporate action (mergers, delistings); the Picks page says
// "price only - dividends not included".
import type { Client, InStatement } from "@libsql/client";
import { priceMicro } from "@/lib/arena/marketData";
import {
  fillEntryAtOpen,
  fillCloseSignalExit,
  fillIntradayStop,
  type Bar,
} from "@/lib/arena/fills";
import { feeFor, getCostProfile, type CostProfile } from "@/lib/arena/costs";
import { quantityRatio, type CorpActionRecord } from "@/lib/arena/corpActions";
import { loadConfirmedActions } from "@/lib/arena/corpActionWriter";
import { rebaseQty } from "@/lib/arena/ledger";
import { divFloor, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import type { Micro } from "@/lib/money/micro";
import { PicksError } from "./types";

type Db = Client;
const PPM = 1_000_000n; // threshold-ok: parts per million
const text = (v: unknown): string => String(v);

export type ExitReason = "stop" | "gap" | "aim" | "time_frame";
export type TrackState = "waiting" | "bought" | "missed" | "closed";

export type Levels = {
  readonly buyMaxMicro: Micro;
  readonly stopMicro: Micro;
  readonly aimMicro: Micro;
  readonly timeFrameSessions: number;
  readonly validUntilD: string;
  /** Suggested size, used only to fix the share count (and so the brokerage). */
  readonly sizeMicro: Micro;
};

export type DatedBar = Bar & { readonly d: string };

export type Outcome = {
  readonly state: TrackState;
  readonly entryD: string | null;
  readonly entryMicro: Micro | null;
  readonly exitD: string | null;
  readonly exitMicro: Micro | null;
  readonly exitReason: ExitReason | null;
  readonly netMicro: Micro | null;
  readonly netPpm: number | null;
};

const EMPTY: Outcome = {
  state: "waiting",
  entryD: null,
  entryMicro: null,
  exitD: null,
  exitMicro: null,
  exitReason: null,
  netMicro: null,
  netPpm: null,
};

/** The levels of a luck-check twin: the pick's levels in proportion to the twin's own price. */
export function scaleLevels(l: Levels, pickRef: Micro, twinRef: Micro): Levels {
  const f = makeRational(twinRef, pickRef);
  const sc = (v: Micro): Micro => {
    const r = roundHalfAwayFromZero(mulRat(makeRational(v), f));
    return r < 1n ? 1n : r;
  };
  return {
    ...l,
    buyMaxMicro: sc(l.buyMaxMicro),
    stopMicro: sc(l.stopMicro),
    aimMicro: sc(l.aimMicro),
  };
}

/** A confirmed quantity-changing action inside the window: shares x ratio, prices / ratio, from `exD`. */
export type PickAction = { readonly exD: string; readonly ratio: Rational };

type SimEnv = {
  readonly advMicro: Micro;
  readonly profile: CostProfile;
  readonly asOfD: string;
  /** Confirmed splits, consolidations and bonus issues after publication, ordered by ex-date. */
  readonly actions?: readonly PickAction[];
};

/** A published level in the terms of the session after the actions so far: level / factor, at least 1. */
function levelAt(v: Micro, factor: Rational): Micro {
  const r = roundHalfAwayFromZero(mulRat(makeRational(v), makeRational(factor.den, factor.num)));
  return r < 1n ? 1n : r;
}

export function simulateOutcome(base: Levels, bars: readonly DatedBar[], env: SimEnv): Outcome {
  let levels = base;
  let factor: Rational = makeRational(1n);
  let nextAction = 0;
  const actions = env.actions ?? [];
  let entry: { d: string; fill: Micro; qty: bigint; brokerage: Micro; cost: Micro } | null = null;
  let held = 0;
  const fillEnv = (bar: DatedBar) => ({ bar, advMicro: env.advMicro, profile: env.profile });
  const close = (d: string, exit: Micro, brokOut: Micro, reason: ExitReason): Outcome => {
    const e = entry!;
    const cost = e.cost; // fixed at entry: a re-base changes shares, never what was paid
    const net = e.qty * exit - brokOut - cost;
    const netPpm = Number(roundHalfAwayFromZero(makeRational(net * PPM, cost))); // money-float-ok: ppm fits a safe integer
    return {
      state: "closed",
      entryD: e.d,
      entryMicro: e.fill,
      exitD: d,
      exitMicro: exit,
      exitReason: reason,
      netMicro: net,
      netPpm,
    };
  };
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    // actions with ex-date on or before this session: levels move into post-event terms; a position
    // bought BEFORE the ex-date has its shares re-based (a fill on the ex-date is already post-event)
    let moved = false;
    while (nextAction < actions.length && actions[nextAction]!.exD <= bar.d) {
      const a = actions[nextAction]!;
      nextAction += 1;
      factor = mulRat(factor, a.ratio);
      moved = true;
      if (entry !== null && entry.d < a.exD) entry.qty = rebaseQty(entry.qty, a.ratio);
    }
    if (moved) {
      levels = {
        ...base,
        buyMaxMicro: levelAt(base.buyMaxMicro, factor),
        stopMicro: levelAt(base.stopMicro, factor),
        aimMicro: levelAt(base.aimMicro, factor),
      };
    }
    if (entry !== null && entry.qty === 0n) {
      // a consolidation left no whole share: the position is written off (as M3), net = minus its cost
      return close(bar.d, bar.openMicro, 0n, "time_frame");
    }
    if (entry === null) {
      if (bar.d > levels.validUntilD) return { ...EMPTY, state: "missed" };
      if (bar.openMicro <= levels.buyMaxMicro) {
        const qty = divFloor(levels.sizeMicro, bar.openMicro) || 1n;
        const fill = fillEntryAtOpen(fillEnv(bar), qty);
        entry = {
          d: bar.d,
          fill: fill.fillPriceMicro,
          qty,
          brokerage: fill.brokerageMicro,
          cost: qty * fill.fillPriceMicro + fill.brokerageMicro,
        };
        held = 0;
      } else {
        continue;
      }
    }
    held += 1;
    const e = entry;
    const stop = fillIntradayStop(fillEnv(bar), e.qty, levels.stopMicro, {
      afterOpen: bar.d === e.d,
    });
    if (stop !== null) {
      return close(
        bar.d,
        stop.fillPriceMicro,
        stop.brokerageMicro,
        stop.rule === "gap_open" ? "gap" : "stop",
      );
    }
    if (bar.highMicro >= levels.aimMicro) {
      const price = bar.openMicro > levels.aimMicro ? bar.openMicro : levels.aimMicro;
      return close(bar.d, price, feeFor(env.profile, e.qty * price, "sell"), "aim");
    }
    if (held >= levels.timeFrameSessions) {
      const next = bars[i + 1];
      if (next === undefined) break; // the exit session has not happened yet
      const out = fillCloseSignalExit(fillEnv(next), e.qty);
      return close(next.d, out.fillPriceMicro, out.brokerageMicro, "time_frame");
    }
  }
  if (entry !== null) {
    return {
      ...EMPTY,
      state: "bought",
      entryD: entry.d,
      entryMicro: entry.fill,
    };
  }
  // never bought: missed once the whole validity window has passed
  return env.asOfD >= levels.validUntilD ? { ...EMPTY, state: "missed" } : EMPTY;
}

// ---- database step -------------------------------------------------------------------------------------

async function loadBars(db: Db, market: string, code: string, after: string, upTo: string) {
  const r = await db.execute({
    sql: `SELECT d, o, h, l, c FROM price_bar WHERE market = ? AND code = ? AND d > ? AND d <= ?
          ORDER BY d`,
    args: [market, code, after, upTo],
  });
  const out: DatedBar[] = [];
  for (const x of r.rows) {
    const bar = {
      d: text(x.d),
      openMicro: priceMicro(x.o),
      highMicro: priceMicro(x.h),
      lowMicro: priceMicro(x.l),
      closeMicro: priceMicro(x.c),
    };
    const ok =
      bar.openMicro > 0n &&
      bar.highMicro > 0n &&
      bar.lowMicro > 0n &&
      bar.closeMicro > 0n &&
      bar.lowMicro <= bar.openMicro &&
      bar.lowMicro <= bar.closeMicro &&
      bar.highMicro >= bar.openMicro &&
      bar.highMicro >= bar.closeMicro;
    if (ok) out.push(bar); // a malformed bar is unusable evidence and is skipped
  }
  return out;
}

async function advAt(db: Db, market: string, code: string, d: string, window: number) {
  const r = await db.execute({
    sql: `SELECT c, volume FROM price_bar WHERE market = ? AND code = ? AND d <= ?
          ORDER BY d DESC LIMIT ?`,
    args: [market, code, d, window],
  });
  if (r.rows.length === 0) return 0n;
  let v = 0n;
  for (const x of r.rows) v += priceMicro(x.c) * BigInt(text(x.volume));
  return divFloor(v, BigInt(r.rows.length));
}

/** The confirmed split, consolidation and bonus-issue ratios of `code` with ex-date after `pubD`, by ex-date. */
export function pickActions(
  confirmed: readonly CorpActionRecord[],
  code: string,
  pubD: string,
): PickAction[] {
  return confirmed
    .filter(
      (a) =>
        a.code === code &&
        a.exDate > pubD &&
        (a.type === "split" || a.type === "consolidation" || a.type === "bonus_issue"),
    )
    .map((a) => ({ exD: a.exDate, ratio: quantityRatio(a) }))
    .sort((a, b) => (a.exD < b.exD ? -1 : a.exD > b.exD ? 1 : 0));
}

export type TrackOptions = {
  readonly market: string;
  /** The night: bars after publication up to and including D are used, nothing later. */
  readonly d: string;
  /** The arena's cost profile for the paper trade (ARN-031); the arena default P5. */
  readonly costProfile?: string;
  /** ADV window in sessions (AgentParams windows.adv). */
  readonly advWindow: number;
};

export type TrackSummary = { bought: number; missed: number; closed: number; open: number };

export async function trackPicks(db: Db, o: TrackOptions): Promise<TrackSummary> {
  const profile = getCostProfile(o.costProfile ?? "P5");
  const rows = await db.execute({
    sql: `SELECT o.d AS pub_d, o.profile, o.rank, o.kind, o.code, o.state, o.entry_d, o.entry_micro,
                 p.code AS pick_code, p.reference_micro, p.buy_max_micro, p.stop_micro, p.aim_micro,
                 p.size_micro, p.time_frame_sessions, p.valid_until_d
          FROM pick_outcome o JOIN pick p
            ON p.market = o.market AND p.d = o.d AND p.profile = o.profile AND p.rank = o.rank
          WHERE o.market = ? AND o.state IN ('waiting', 'bought') AND o.d < ?
          ORDER BY o.d, o.profile, o.rank, o.kind`,
    args: [o.market, o.d],
  });
  const sum: TrackSummary = { bought: 0, missed: 0, closed: 0, open: 0 };
  const confirmed = await loadConfirmedActions(db, o.market, o.d);
  for (const r of rows.rows) {
    const pubD = text(r.pub_d);
    let levels: Levels = {
      buyMaxMicro: BigInt(text(r.buy_max_micro)),
      stopMicro: BigInt(text(r.stop_micro)),
      aimMicro: BigInt(text(r.aim_micro)),
      timeFrameSessions: Number(r.time_frame_sessions), // money-float-ok: SQL integer column
      validUntilD: text(r.valid_until_d),
      sizeMicro: BigInt(text(r.size_micro)),
    };
    const code = text(r.code);
    if (text(r.kind) === "luck") {
      const ref = await db.execute({
        sql: "SELECT c FROM price_bar WHERE market = ? AND code = ? AND d = ?",
        args: [o.market, code, pubD],
      });
      if (ref.rows.length === 0) continue; // no price to hold the twin to: it stays waiting
      levels = scaleLevels(levels, BigInt(text(r.reference_micro)), priceMicro(ref.rows[0]!.c));
    }
    const bars = await loadBars(db, o.market, code, pubD, o.d);
    const adv = await advAt(db, o.market, code, pubD, o.advWindow);
    const actions = pickActions(confirmed, code, pubD);
    const sim = simulateOutcome(levels, bars, { advMicro: adv, profile, asOfD: o.d, actions });
    const stored = text(r.state);
    if (stored === "bought") {
      if (
        sim.entryD !== text(r.entry_d) ||
        sim.entryMicro === null ||
        sim.entryMicro !== BigInt(text(r.entry_micro))
      ) {
        throw new PicksError(
          `pick outcome ${pubD}/${text(r.profile)}/${text(r.rank)} changed its entry`,
        );
      }
    }
    const key = [o.market, pubD, text(r.profile), Number(r.rank), text(r.kind)]; // money-float-ok: SQL integer column
    const where = "WHERE market = ? AND d = ? AND profile = ? AND rank = ? AND kind = ?";
    const stmts: InStatement[] = [];
    if (sim.state === "missed" && stored === "waiting") {
      stmts.push({
        sql: `UPDATE pick_outcome SET state = 'missed', updated_d = ? ${where}`,
        args: [o.d, ...key],
      });
      sum.missed += 1;
    }
    if ((sim.state === "bought" || sim.state === "closed") && stored === "waiting") {
      stmts.push({
        sql: `UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = ?, updated_d = ? ${where}`,
        args: [sim.entryD, sim.entryMicro, o.d, ...key],
      });
      sum.bought += 1;
    }
    if (sim.state === "closed") {
      stmts.push({
        sql: `UPDATE pick_outcome SET state = 'closed', exit_d = ?, exit_micro = ?, exit_reason = ?,
                net_micro = ?, net_ppm = ?, updated_d = ? ${where}`,
        args: [sim.exitD, sim.exitMicro, sim.exitReason, sim.netMicro, sim.netPpm, o.d, ...key],
      });
      sum.closed += 1;
    }
    if (sim.state === "bought" || sim.state === "waiting") sum.open += 1;
    if (stmts.length > 0) await db.batch(stmts, "write");
  }
  return sum;
}
