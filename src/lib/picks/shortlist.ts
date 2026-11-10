// D-920 (Owner 2026-11-10: "we need picks every day"): the nightly shortlist. The strategies raise only
// a handful of signals a night (one on 10 Nov, none in a mixed market for most rules), so picks built
// only from them leave most nights empty. The shortlist ranks every liquid share (U1/U2, active, not
// halted) by one published trend rule and offers the best few as pick candidates, next to the strategy
// signals, through the same pick builder (profiles, sizing, luck twins, tracking, History, portfolio).
//
// Rule SL.v1 ("trend continuation"), decided at the close of session D:
//   - close above its 50-session and 200-session averages, and the 50 above the 200 (an uptrend);
//   - close at or above its 20-session average (not breaking down);
//   - rise over the last 63 sessions in the top fifth of the liquid shares that night, and at least 5 %;
//   - stop-loss 2 x ATR(14) below the close, and that distance between 3 % and 10 % of the price
//     (the strategies' most common block was a stop too far away);
//   - ranked by the 63-session rise divided by its 20-session volatility (steady rises first).
// Evidence: the same rule replayed over the window before D on the same shares, the top TAKE_PER_DAY
// each past session, each bought at the next open if it opens at or below the buy limit, held to the
// stop (intraday, a gap below fills at the open) or TIME_LIMIT sessions, with brokerage both ways.
// Only trades that finished by D count (no look-ahead). Their net returns give the three cases, the
// median holding time becomes the time frame, the median drop from the buy the risk check, and the
// share reaching the good case the aim-reach figure. Pure: the same bars give the same candidates.
import type { CostProfile } from "@/lib/arena/costs";
import { feeFor } from "@/lib/arena/costs";
import { slippageFill } from "@/lib/arena/slippage";
import type { PickInput, Tier } from "./types";

export const SHORTLIST_RULE = "SL.v1";
const SMA_FAST = 20; // threshold-ok: D-920 rule, 20-session average
const SMA_MID = 50; // threshold-ok: D-920 rule, 50-session average
const SMA_SLOW = 200; // threshold-ok: D-920 rule, 200-session average
const ATR_N = 14; // threshold-ok: D-920 rule, ATR(14)
const RISE_N = 63; // threshold-ok: D-920 rule, about three months of sessions
const VOL_N = 20; // threshold-ok: D-920 rule, volatility window
const STOP_ATR = 2; // threshold-ok: D-920 rule, stop 2 x ATR below the close
const STOP_MIN = 0.03; // threshold-ok: D-920 rule, stop at least 3 % away
const STOP_MAX = 0.1; // threshold-ok: D-920 rule, stop at most 10 % away
const TOP_SHARE = 0.2; // threshold-ok: D-920 rule, top fifth by the 63-session rise
const MIN_RISE = 0.05; // threshold-ok: D-920 rule, at least +5 % over the 63 sessions (a real rise, not only a relative rank)
export const TAKE_PER_DAY = 5; // threshold-ok: D-920 candidates per night (and per past session in the evidence)
export const TIME_LIMIT = 20; // threshold-ok: D-920 evidence holding limit in sessions
const MIN_N = 30; // threshold-ok: scenario_min_n (D-908), fewer past trades give no scenario
const PPM = 1_000_000; // threshold-ok: parts per million
const NOTIONAL_MICRO = 1_000_000_000n; // threshold-ok: A$1,000 evidence position for brokerage

export type DayBar = {
  readonly d: string;
  readonly openMicro: bigint;
  readonly highMicro: bigint;
  readonly lowMicro: bigint;
  readonly closeMicro: bigint;
  readonly volume: number;
};

export type ShortlistCode = {
  readonly code: string;
  readonly tier: Tier;
  readonly bars: readonly DayBar[];
};

type Series = {
  code: string;
  tier: Tier;
  bars: readonly DayBar[];
  close: number[];
  smaF: (number | null)[];
  smaM: (number | null)[];
  smaS: (number | null)[];
  atr: (number | null)[];
  rise: (number | null)[];
  vol: (number | null)[];
  index: Map<string, number>;
};

const f = (m: bigint): number => Number(m) / PPM; // money-float-ok: indicators and ordering only, never a price we store

function sma(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = [];
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) {
    s += xs[i]!;
    if (i >= n) s -= xs[i - n]!;
    out.push(i >= n - 1 ? s / n : null);
  }
  return out;
}

function series(c: ShortlistCode): Series {
  const close = c.bars.map((b) => f(b.closeMicro));
  const tr: number[] = c.bars.map((b, i) => {
    const h = f(b.highMicro);
    const l = f(b.lowMicro);
    const pc = i > 0 ? close[i - 1]! : close[i]!;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  });
  const atr = sma(tr, ATR_N);
  const rise = close.map((x, i) =>
    i >= RISE_N && close[i - RISE_N]! > 0 ? x / close[i - RISE_N]! - 1 : null,
  );
  const lr = close.map((x, i) =>
    i > 0 && close[i - 1]! > 0 && x > 0 ? Math.log(x / close[i - 1]!) : 0,
  );
  const vol = close.map((_, i) => {
    if (i < VOL_N) return null;
    const w = lr.slice(i - VOL_N + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const v = w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1);
    return Math.sqrt(v);
  });
  return {
    code: c.code,
    tier: c.tier,
    bars: c.bars,
    close,
    smaF: sma(close, SMA_FAST),
    smaM: sma(close, SMA_MID),
    smaS: sma(close, SMA_SLOW),
    atr,
    rise,
    vol,
    index: new Map(c.bars.map((b, i) => [b.d, i])),
  };
}

type Setup = { s: Series; i: number; score: number; stopMicro: bigint; rise: number };

/** Codes passing every condition except the top-fifth rank at index i of each series (pure). */
function passing(all: readonly Series[], d: string): Setup[] {
  const out: Setup[] = [];
  for (const s of all) {
    const i = s.index.get(d);
    if (i === undefined) continue;
    const c = s.close[i]!;
    const [fa, mi, sl, atr, rise, vol] = [
      s.smaF[i],
      s.smaM[i],
      s.smaS[i],
      s.atr[i],
      s.rise[i],
      s.vol[i],
    ];
    if (fa == null || mi == null || sl == null || atr == null || rise == null || vol == null)
      continue;
    if (!(c > mi && c > sl && mi > sl && c >= fa)) continue;
    const dist = (STOP_ATR * atr) / c;
    if (dist < STOP_MIN || dist > STOP_MAX) continue;
    const closeMicro = s.bars[i]!.closeMicro;
    const stopMicro = closeMicro - BigInt(Math.round(STOP_ATR * atr * PPM)); // money-float-ok: ATR distance rounded to whole micro-dollars
    if (stopMicro <= 0n) continue;
    out.push({ s, i, score: vol > 0 ? rise / vol : 0, stopMicro, rise });
  }
  return out;
}

/** The top fifth by rise among all codes with a bar and a rise on d, then the rule, best score first. */
function selectOn(all: readonly Series[], d: string, take: number): Setup[] {
  const rises = all
    .map((s) => {
      const i = s.index.get(d);
      return i === undefined ? null : s.rise[i];
    })
    .filter((x): x is number => x != null)
    .sort((a, b) => b - a);
  if (rises.length === 0) return [];
  const cut = rises[Math.max(0, Math.ceil(rises.length * TOP_SHARE) - 1)]!;
  return passing(all, d)
    .filter((x) => x.rise >= cut && x.rise >= MIN_RISE)
    .sort((a, b) => b.score - a.score || (a.s.code < b.s.code ? -1 : 1))
    .slice(0, take);
}

type Outcome = { netPpm: number; hold: number; dropPpm: number };

/** One evidence trade: buy at the next open (if at or below the buy limit), stop or time limit. */
function replayTrade(
  x: Setup,
  profile: CostProfile,
  advMicro: bigint,
  lastD: string,
): Outcome | null {
  const { s, i } = x;
  const entry = s.bars[i + 1];
  if (entry === undefined || entry.d > lastD) return null;
  const buyMax = slippageFill(s.bars[i]!.closeMicro, "buy", advMicro).fillMicro;
  if (entry.openMicro > buyMax) return null;
  const buy = entry.openMicro;
  let low = buy;
  for (let k = i + 1; k < s.bars.length && k <= i + TIME_LIMIT; k += 1) {
    const b = s.bars[k]!;
    if (b.d > lastD) return null; // no look-ahead: a trade still open at D is not counted
    if (b.lowMicro < low) low = b.lowMicro;
    const out =
      b.openMicro <= x.stopMicro && k > i + 1
        ? b.openMicro // a gap below the stop fills at the open
        : b.lowMicro <= x.stopMicro
          ? x.stopMicro
          : k === i + TIME_LIMIT
            ? b.closeMicro
            : null;
    if (out !== null) return net(buy, out, k - i, low, profile);
  }
  return null; // still open at D: not counted
}

function net(buy: bigint, sell: bigint, hold: number, low: bigint, profile: CostProfile): Outcome {
  const qty = NOTIONAL_MICRO / buy || 1n;
  const cost = qty * buy + feeFor(profile, qty * buy, "buy");
  const back = qty * sell - feeFor(profile, qty * sell, "sell");
  return {
    netPpm: Number(((back - cost) * BigInt(PPM)) / cost), // money-float-ok: ppm of exact micro amounts
    hold,
    dropPpm: Number(((buy - low) * BigInt(PPM)) / buy), // money-float-ok: ppm of exact micro amounts
  };
}

const pct = (xs: number[], q: number): number =>
  xs[Math.min(xs.length - 1, Math.floor(q * (xs.length - 1)))]!;

export type ShortlistOptions = {
  readonly d: string;
  readonly market: string;
  readonly costProfile: CostProfile;
  /** Average daily traded value per code, for slippage (micro-AUD). */
  readonly advMicro: ReadonlyMap<string, bigint>;
  /** Codes already offered by a strategy signal tonight (not offered twice). */
  readonly exclude?: ReadonlySet<string>;
  readonly take?: number;
};

/** Tonight's shortlist candidates as pick inputs, best first; [] when none passes (pure). */
export function shortlistInputs(codes: readonly ShortlistCode[], o: ShortlistOptions): PickInput[] {
  const all = codes.map(series);
  const days = [...new Set(codes.flatMap((c) => c.bars.map((b) => b.d)))]
    .filter((d) => d < o.d)
    .sort();
  // evidence: every past session's top picks under the same rule, finished by D
  const outcomes: Outcome[] = [];
  for (const d of days) {
    for (const x of selectOn(all, d, TAKE_PER_DAY)) {
      const r = replayTrade(x, o.costProfile, o.advMicro.get(x.s.code) ?? 0n, o.d);
      if (r !== null) outcomes.push(r);
    }
  }
  const tonight = selectOn(all, o.d, (o.take ?? TAKE_PER_DAY) + (o.exclude?.size ?? 0)).filter(
    (x) => !(o.exclude?.has(x.s.code) ?? false),
  );
  if (tonight.length === 0) return [];
  const nets = outcomes.map((x) => x.netPpm).sort((a, b) => a - b);
  const holds = outcomes.map((x) => x.hold).sort((a, b) => a - b);
  const drops = outcomes.map((x) => x.dropPpm).sort((a, b) => a - b);
  const enough = nets.length >= MIN_N;
  const good = enough ? pct(nets, 0.9) : 0; // threshold-ok: the good case is the 90th percentile
  const scenario = enough
    ? { n: nets.length, badPpm: pct(nets, 0.1), typicalPpm: pct(nets, 0.5), goodPpm: good } // threshold-ok: 10th and 50th percentiles
    : null;
  const wins = nets.filter((x) => x > 0).length;
  const winPct = nets.length > 0 ? Math.round((100 * wins) / nets.length) : 0; // threshold-ok: percent
  return tonight.slice(0, o.take ?? TAKE_PER_DAY).map((x, rank) => {
    const b = x.s.bars[x.i]!;
    const adv = o.advMicro.get(x.s.code) ?? 0n;
    const risePct = Math.round(x.rise * 100); // threshold-ok: percent
    const stopPct = Math.round(Number(((b.closeMicro - x.stopMicro) * 1000n) / b.closeMicro) / 10); // threshold-ok: per mille to a percent with one decimal
    return {
      signalId: `shortlist:${o.market}:${o.d}:${SHORTLIST_RULE}:${x.s.code}`,
      cardId: null,
      family: "F1",
      ruleVersion: SHORTLIST_RULE,
      variant: "S",
      code: x.s.code,
      tier: x.s.tier,
      // below any strategy signal: the strategies' own picks come first, the shortlist fills the rest
      rankScore: `${TAKE_PER_DAY - rank}/1000000`,
      label: "UNVALIDATED",
      referenceMicro: b.closeMicro,
      stopMicro: x.stopMicro,
      advValueMicro: adv,
      vol: x.s.vol[x.i] ?? null,
      scenario,
      aimReachPpm: enough
        ? Math.round((nets.filter((v) => v >= good).length * PPM) / nets.length)
        : null,
      holdMedianSessions: enough ? Math.max(1, pct(holds, 0.5)) : null, // threshold-ok: median
      medianDropPpm: enough ? pct(drops, 0.5) : null, // threshold-ok: median
      factors: [],
      basedOn: [
        `Nightly shortlist (trend): up ${risePct}% over about three months, in the top fifth of large and mid-size shares, above its 50- and 200-day averages, with a stop-loss ${stopPct}% below (2 x its average daily range).`,
        enough
          ? `History: ${nets.length} similar setups in the last year; ${winPct} % of them ended with a net gain after costs (stop-loss or ${TIME_LIMIT} sessions).`
          : `History: only ${nets.length} similar setups so far, fewer than ${MIN_N}, so no confidence figure yet.`,
      ],
    } satisfies PickInput;
  });
}
