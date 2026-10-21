// Synthetic cohort simulator for the ledger property tests (TST-104) and the DB round-trip tests.
// Test support only (not a *.test.ts file): a seeded random walk of prices, random buys and sells
// sized against AVAILABLE cash under `matched` or `conservative`, T+2 settlement through the real
// calendar (random holidays), occasional dividends, and a daily NAV computed INCREMENTALLY (running
// balances and positions), which the tests then compare with the from-scratch recomputation and
// with an independent cash-flow oracle. Everything is deterministic in `seed`.
import { COST_PROFILES, feeFor } from "@/lib/arena/costs";
import {
  fillCloseSignalExit,
  fillEntryAtOpen,
  type FillEnv,
  type SimulatedFill,
} from "@/lib/arena/fills";
import {
  availableCash,
  divAccrueTxn,
  divPayTxn,
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
  type SettlementMode,
} from "@/lib/arena/ledger";
import { computeNavDay, type CohortBooks, type Mark, type NavDay } from "@/lib/arena/nav";
import { addDays, sessionsBetween, type CalendarRow } from "@/lib/data/calendar";

export const CODES = ["ZZA", "ZZB", "ZZC", "ZZD"] as const;
const ADV: Record<string, bigint> = {
  ZZA: 6_000_000_000_000n,
  ZZB: 2_000_000_000_000n,
  ZZC: 400_000_000_000n,
  ZZD: 150_000_000_000n,
};

/** Small deterministic PRNG (xorshift32). */
export function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  return {
    /** Integer in [lo, hi]. */
    int: (lo: number, hi: number) => lo + (next() % (hi - lo + 1)),
    chance: (p: number) => next() % 10_000 < p * 10_000,
  };
}

export type Sim = {
  cohortId: string;
  mode: SettlementMode;
  seedMicro: bigint;
  calendar: CalendarRow[];
  dates: string[];
  txns: LedgerTxn[];
  rows: LedgerRow[];
  fills: LedgerFill[];
  simFills: Map<string, SimulatedFill>;
  days: NavDay[];
  oracleNav: Map<string, bigint>;
  books: CohortBooks;
};

const START = "2026-01-05"; // a Monday

export function makeCalendar(r: ReturnType<typeof rng>, sessions: number): CalendarRow[] {
  const rows: CalendarRow[] = [];
  const horizon = Math.ceil(sessions * 1.5) + 60;
  for (let i = 0; i < horizon; i++) {
    const d = addDays(START, i);
    const weekday = sessionsBetween(d, d, []).length === 1;
    if (weekday && r.chance(0.04)) rows.push({ d, kind: "holiday", close_time: null });
  }
  return rows;
}

const roundTick = (v: bigint): bigint => (v / 10_000n) * 10_000n;

export function simulate(options: {
  seed: number;
  days: number;
  mode: SettlementMode;
  seedMicro?: bigint;
  cohortId?: string;
}): Sim {
  const r = rng(options.seed);
  const cohortId = options.cohortId ?? "K1";
  const seedMicro = options.seedMicro ?? 600_000_000n;
  const calendar = makeCalendar(r, options.days);
  const dates = sessionsBetween(START, addDays(START, options.days * 2 + 90), calendar).slice(
    0,
    options.days,
  );
  const profile = COST_PROFILES.P5;

  const txns: LedgerTxn[] = [];
  const rows: LedgerRow[] = [];
  const fills: LedgerFill[] = [];
  const simFills = new Map<string, SimulatedFill>();
  const days: NavDay[] = [];
  const closes = new Map<string, bigint>();
  const oracleNav = new Map<string, bigint>();
  const balances: Record<string, bigint> = { ...zeroBalances() };
  const held = new Map<string, bigint>();
  const price = new Map<string, bigint>(
    CODES.map((c) => [c, roundTick(BigInt(r.int(200, 5_000)) * 10_000n)]),
  );
  const pendingDividends: { payD: string; refId: string; amount: bigint }[] = [];
  let oracleCash = 0n;
  let fillCount = 0;
  let divCount = 0;

  const post = (txn: LedgerTxn) => {
    txns.push(txn);
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

  const seedD = dates[0];
  post(seedTxn(seedD, seedMicro));
  oracleCash += seedMicro;

  const recordFill = (d: string, code: string, fill: SimulatedFill) => {
    fillCount += 1;
    const lf: LedgerFill = {
      id: `F${String(fillCount).padStart(5, "0")}`,
      d,
      code,
      side: fill.side,
      qty: fill.qty,
      valueMicro: fill.valueMicro,
      brokerageMicro: fill.brokerageMicro,
    };
    fills.push(lf);
    simFills.set(lf.id, fill);
    const cost = replayCostBasis(fills, [], d).saleCostByFillId.get(lf.id);
    for (const t of fillTxns(lf, cost)) post(t);
    held.set(code, (held.get(code) ?? 0n) + (fill.side === "buy" ? fill.qty : -fill.qty));
    oracleCash +=
      fill.side === "buy"
        ? -(fill.valueMicro + fill.brokerageMicro)
        : fill.valueMicro - fill.brokerageMicro;
  };

  for (const d of dates) {
    // 1. settlements due (start of session) and dividends payable
    for (const t of settlementsDue(pendingNow(), d)) post(t);
    for (const div of pendingDividends.filter((x) => x.payD <= d)) {
      post(divPayTxn({ d, refId: div.refId, amountMicro: div.amount }));
      pendingDividends.splice(pendingDividends.indexOf(div), 1);
    }
    // 2. dividends on holdings of the prior close
    for (const code of CODES) {
      const qty = held.get(code) ?? 0n;
      if (qty > 0n && r.chance(0.03)) {
        divCount += 1;
        const refId = `D${divCount}`;
        const amount = qty * BigInt(r.int(10, 200) * 1_000);
        post(divAccrueTxn({ d, refId, amountMicro: amount }));
        oracleCash += amount;
        const payD = dates[Math.min(dates.indexOf(d) + 3, dates.length - 1)];
        pendingDividends.push({ payD, refId, amount });
      }
    }
    // 3. today's bars
    const envs = new Map<string, FillEnv>();
    for (const code of CODES) {
      const prev = price.get(code) ?? 2_000_000n;
      const open = roundTick(prev + (prev * BigInt(r.int(-150, 150))) / 10_000n);
      const o = open < 2_000_000n ? 2_000_000n : open;
      const close0 = roundTick(o + (o * BigInt(r.int(-200, 200))) / 10_000n);
      const c = close0 < 2_000_000n ? 2_000_000n : close0;
      const high = (o > c ? o : c) + BigInt(r.int(0, 5)) * 10_000n;
      const low = (o < c ? o : c) - BigInt(r.int(0, 5)) * 10_000n;
      envs.set(code, {
        bar: { openMicro: o, highMicro: high, lowMicro: low, closeMicro: c },
        advMicro: ADV[code],
        profile,
      });
      price.set(code, c);
      closes.set(`${d}|${code}`, c);
    }
    // 4. random sells, then a random buy sized against available cash
    for (const code of CODES) {
      const qty = held.get(code) ?? 0n;
      if (qty > 0n && r.chance(0.2)) {
        const sell = BigInt(r.int(1, Number(qty)));
        const exit = fillCloseSignalExit(envs.get(code) as FillEnv, sell);
        // a sale whose fee exceeds its proceeds would overdraw settled cash: the engine's sizing
        // buffer (ARN-024a) exists for that; the generator simply does not make such sales
        if (exit.valueMicro > exit.brokerageMicro) recordFill(d, code, exit);
      }
    }
    if (r.chance(0.6)) {
      const code = CODES[r.int(0, CODES.length - 1)];
      const env = envs.get(code) as FillEnv;
      const avail = availableCash({
        mode: options.mode,
        balances: balances as LedgerBalances,
        pending: pendingNow(),
        sessionD: d,
      });
      const unit = fillEntryAtOpen(env, 1n).fillPriceMicro;
      let qty = (avail * BigInt(r.int(20, 100))) / 100n / unit;
      while (qty > 0n) {
        const value = qty * unit;
        if (value + feeFor(profile, value, "buy") <= avail) break;
        qty -= 1n;
      }
      if (qty > 0n) recordFill(d, code, fillEntryAtOpen(env, qty));
    }
    // 5. NAV at the close, incremental
    const marks = (code: string): Mark => ({
      closeMicro: closes.get(`${d}|${code}`) as bigint,
      advMicro: ADV[code],
    });
    const positions = new Map([...held].filter(([, q]) => q > 0n));
    days.push(
      computeNavDay({
        cohortId,
        d,
        balances: { ...(balances as LedgerBalances) },
        positions,
        markFor: marks,
        profile,
      }),
    );
    let mv = 0n;
    for (const [code, qty] of positions) mv += qty * marks(code).closeMicro;
    oracleNav.set(d, oracleCash + mv);
  }

  const books: CohortBooks = {
    cohortId,
    rows,
    fills,
    markFor: (d, code) => {
      const c = closes.get(`${d}|${code}`);
      return c === undefined ? undefined : { closeMicro: c, advMicro: ADV[code] };
    },
    profile,
  };
  return {
    cohortId,
    mode: options.mode,
    seedMicro,
    calendar,
    dates,
    txns,
    rows,
    fills,
    simFills,
    days,
    oracleNav,
    books,
  };
}
