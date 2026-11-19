// The trade log against the paper picks (M21 B2, ARN-121, D-1221, D-1275 to D-1277). Pure: stored rows in, comparisons out;
// nothing here reads a database or writes anything. Exact integer micro and ppm maths, rounded half away from zero once.
//   matching pick  = same market and code, pick date before the trade date, the trade date within `maxSessions`
//                    sessions after the pick date, the newest such pick (ties: lowest rank, then profile name)
//   paper fill     = that pick's paper entry (entry_micro, entry_d); a pick that never filled is "not bought on paper"
//   slippage       = (price - paper) / paper in ppm; for a sell the paper exit takes the place of the paper entry
//   round trips    = FIFO within the log (src/lib/tax/fifo.ts, B3), a sale compared with the pick that matched the
//                    oldest lot it closed; realised = proceeds after the sell fee less cost with the buy fee; paper
//                    = the pick's net in ppm of cost, applied to the same cost (the same parcel)
import { addDays, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";
import { divTrunc, makeRational } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { fifoMatch } from "@/lib/tax/fifo";
import type { Split, TaxFill } from "@/lib/tax/types";

const PPM = 1_000_000n; // threshold-ok: parts per million
/** Trade ids sort as text in the matcher, so they are zero-padded to a fixed width (as src/lib/tax/fromLog.ts). */
const ID_WIDTH = 12; // threshold-ok: width of a padded trade id
/** The window is at most ten sessions (the key's ceiling); sixty calendar days hold ten sessions and any holiday run. */
const WINDOW_DAYS = 60; // threshold-ok: D-1275 cheap pre-filter, never narrower than the window

export type LogTrade = {
  id: number;
  market: string;
  code: string;
  side: "buy" | "sell";
  d: string;
  qty: bigint;
  priceMicro: bigint;
  feesMicro: bigint;
  note: string | null;
  source: "typed" | "csv";
  voidReason: string | null;
};

/** A stored pick with its paper outcome. `state` is the outcome's state; the paper fields are null until reached. */
export type PaperPick = {
  d: string;
  profile: string;
  rank: number;
  code: string;
  state: "waiting" | "bought" | "missed" | "closed" | null;
  entryD: string | null;
  entryMicro: bigint | null;
  exitD: string | null;
  exitMicro: bigint | null;
  netPpm: bigint | null;
};

export const padId = (id: number): string => String(id).padStart(ID_WIDTH, "0");

/** The newest pick this trade could have come from, or null. */
export function matchingPick(
  trade: Pick<LogTrade, "code" | "d">,
  picks: readonly PaperPick[],
  maxSessions: number,
  calendar: readonly CalendarRow[],
): PaperPick | null {
  let best: PaperPick | null = null;
  for (const p of picks) {
    if (p.code !== trade.code || p.d >= trade.d || trade.d > addDays(p.d, WINDOW_DAYS)) continue;
    // sessions after the pick date, up to and including the trade date
    const after = sessionsBetween(p.d, trade.d, calendar).filter((x) => x > p.d).length;
    if (after > maxSessions) continue;
    if (
      best === null ||
      p.d > best.d ||
      (p.d === best.d && (p.rank < best.rank || (p.rank === best.rank && p.profile < best.profile)))
    ) {
      best = p;
    }
  }
  return best;
}

/** (price - paper) / paper in ppm, rounded half away from zero once; null when there is no paper price. */
export function slippagePpm(priceMicro: bigint, paperMicro: bigint | null): bigint | null {
  if (paperMicro === null || paperMicro <= 0n) return null;
  return roundHalfAwayFromZero(makeRational((priceMicro - paperMicro) * PPM, paperMicro));
}

/** A signed percentage with two decimals from ppm ("+0.25 %", "-1.50 %"); integer maths only. */
export function pctFromPpm(ppm: bigint): string {
  const hundredths = roundHalfAwayFromZero(makeRational(ppm, 100n)); // 100 ppm = 0.01 %
  const neg = hundredths < 0n;
  const a = neg ? -hundredths : hundredths;
  const frac = (a % 100n).toString().padStart(2, "0");
  const sign = neg ? "-" : hundredths === 0n ? "" : "+";
  return `${sign}${divTrunc(a, 100n).toString()}.${frac} %`;
}

export type Paper =
  | { kind: "none" } // no pick matches
  | { kind: "not_bought"; pick: PaperPick } // the paper pick never filled
  | { kind: "no_exit"; pick: PaperPick } // a sell whose paper pick has not closed
  | { kind: "ok"; pick: PaperPick; paperMicro: bigint; paperD: string };

export type TradeRowView = {
  trade: LogTrade;
  paper: Paper;
  slippagePpm: bigint | null;
  /** A sale with no earlier buy in the log (or too few): no cost, no gain. */
  unmatchedQty: bigint;
  /** For a sell: realised net after both fees, and the paper net for the same cost, when both exist. */
  realNetMicro: bigint | null;
  paperNetMicro: bigint | null;
  costMicro: bigint | null;
};

export type MonthRow = {
  month: string;
  /** Trades that have a paper price to compare with. */
  compared: number;
  meanSlippagePpm: bigint | null;
  /** Sales with both a real and a paper net: how many, and the sums. */
  roundTrips: number;
  realNetMicro: bigint;
  paperNetMicro: bigint;
};

export type LogView = { rows: TradeRowView[]; months: MonthRow[] };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The comparison of every live (not voided) trade of one market, oldest first, and the monthly table. */
export function compareLog(
  trades: readonly LogTrade[],
  picks: readonly PaperPick[],
  maxSessions: number,
  calendar: readonly CalendarRow[],
  splits: readonly Split[] = [],
): LogView {
  const live = trades.filter((t) => t.voidReason === null);
  const pickOf = new Map<number, PaperPick | null>();
  for (const t of live) {
    if (t.side === "buy") pickOf.set(t.id, matchingPick(t, picks, maxSessions, calendar));
  }
  const byCode = new Map<string, TaxFill[]>();
  for (const t of live) {
    const fill: TaxFill = {
      id: padId(t.id),
      d: t.d,
      code: t.code,
      side: t.side,
      qty: t.qty,
      valueMicro: t.qty * t.priceMicro,
      feeMicro: t.feesMicro,
    };
    byCode.set(t.code, [...(byCode.get(t.code) ?? []), fill]);
  }
  // per sale: what its disposals add up to, and the buy that made the oldest lot it closed
  const gain = new Map<string, { cost: bigint; net: bigint; firstLot: string | null }>();
  const unmatched = new Map<string, bigint>();
  for (const [code, fills] of byCode) {
    const r = fifoMatch(
      fills,
      splits.filter((s) => s.code === code),
      { buysFirst: true },
    );
    for (const x of r.disposals) {
      const g = gain.get(x.sellId) ?? { cost: 0n, net: 0n, firstLot: null };
      g.cost += x.costMicro;
      g.net += x.gainMicro;
      if (g.firstLot === null) g.firstLot = x.lotId;
      gain.set(x.sellId, g);
    }
    for (const u of r.unmatched) unmatched.set(u.sellId, u.qty);
  }

  const rows: TradeRowView[] = [...live]
    .sort((a, b) => cmp(a.d, b.d) || a.id - b.id)
    .map((t): TradeRowView => {
      if (t.side === "buy") {
        const pick = pickOf.get(t.id) ?? null;
        const paper: Paper =
          pick === null
            ? { kind: "none" }
            : pick.entryMicro === null || pick.entryD === null
              ? { kind: "not_bought", pick }
              : { kind: "ok", pick, paperMicro: pick.entryMicro, paperD: pick.entryD };
        return {
          trade: t,
          paper,
          slippagePpm: paper.kind === "ok" ? slippagePpm(t.priceMicro, paper.paperMicro) : null,
          unmatchedQty: 0n,
          realNetMicro: null,
          paperNetMicro: null,
          costMicro: null,
        };
      }
      const g = gain.get(padId(t.id)) ?? null;
      const lotPick =
        g === null || g.firstLot === null ? null : (pickOf.get(Number(g.firstLot)) ?? null);
      let paper: Paper = { kind: "none" };
      if (lotPick !== null) {
        paper =
          lotPick.state === "closed" && lotPick.exitMicro !== null && lotPick.exitD !== null
            ? { kind: "ok", pick: lotPick, paperMicro: lotPick.exitMicro, paperD: lotPick.exitD }
            : lotPick.entryMicro === null
              ? { kind: "not_bought", pick: lotPick }
              : { kind: "no_exit", pick: lotPick };
      }
      const paperNet =
        g !== null && lotPick !== null && lotPick.state === "closed" && lotPick.netPpm !== null
          ? roundHalfAwayFromZero(makeRational(lotPick.netPpm * g.cost, PPM))
          : null;
      return {
        trade: t,
        paper,
        slippagePpm: paper.kind === "ok" ? slippagePpm(t.priceMicro, paper.paperMicro) : null,
        unmatchedQty: unmatched.get(padId(t.id)) ?? 0n,
        realNetMicro: g === null ? null : g.net,
        paperNetMicro: paperNet,
        costMicro: g === null ? null : g.cost,
      };
    });

  const acc = new Map<
    string,
    { n: number; sum: bigint; rt: number; real: bigint; paper: bigint }
  >();
  for (const r of rows) {
    const month = r.trade.d.slice(0, 7);
    const a = acc.get(month) ?? { n: 0, sum: 0n, rt: 0, real: 0n, paper: 0n };
    if (r.slippagePpm !== null) {
      a.n += 1;
      a.sum += r.slippagePpm;
    }
    if (r.realNetMicro !== null && r.paperNetMicro !== null) {
      a.rt += 1;
      a.real += r.realNetMicro;
      a.paper += r.paperNetMicro;
    }
    acc.set(month, a);
  }
  const months = [...acc.entries()]
    .sort((a, b) => cmp(b[0], a[0])) // newest month first
    .map(([month, a]): MonthRow => ({
      month,
      compared: a.n,
      meanSlippagePpm: a.n === 0 ? null : roundHalfAwayFromZero(makeRational(a.sum, BigInt(a.n))),
      roundTrips: a.rt,
      realNetMicro: a.real,
      paperNetMicro: a.paper,
    }));
  return { rows, months };
}
