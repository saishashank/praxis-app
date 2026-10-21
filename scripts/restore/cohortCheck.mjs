// Check-cohort replay (TST-108: "replay one cohort to identical NAV"; M8 design 2.5). Pure and
// deterministic: no clock, no randomness except SplitMix64 from a fixed seed, integer micro-units
// (BigInt). A fixed cohort of equal-weight buy-and-hold positions is replayed over the bars of a
// database and a NAV series (one value per session) is produced. The drill replays the cohort over
// (a) the bars inside the verified backup stream and (b) the bars read back from the RESTORED
// database and requires every NAV value to be identical. A restore that loses, alters or reorders
// a bar therefore fails even if a table checksum were somehow equal.
// Limit (recorded): this is the simple check-cohort engine, not the batch 2a/2b trading engine;
// an engine can be injected through `replay` once a stored live cohort is available.
// Results are counts, dates and booleans only; no row content leaves this module.
export const CHECK_SEED = 0x5eed_c0de_2026n;
export const START_MICRO = 100_000_000_000n; // 100 000.000000 across the pool
export const WINDOW = 60; // sessions
export const POSITIONS = 5;
const MASK = (1n << 64n) - 1n;

/** SplitMix64 as a BigInt generator: next() returns the next 64-bit value. */
export function splitmix64(seed) {
  let s = BigInt.asUintN(64, BigInt(seed));
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & MASK;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  };
}

/** @param {number} price */
export const toMicro = (price) => BigInt(Math.round(Number(price) * 1e6));

/**
 * Bars from value arrays [market, code, d, ..., close]; `closeIndex` says where the close is
 * (6 in a price_bar table dump, 3 in the restored-database query). Unusable rows are dropped (the
 * engine then sees fewer bars and the two replays differ: a failure, never a pass).
 * @param {unknown[][]} rows
 * @param {number} closeIndex
 */
export function barsFromValues(rows, closeIndex) {
  const bars = [];
  for (const v of rows) {
    const code = v[1];
    const d = v[2];
    const c = v[closeIndex];
    if (typeof code === "string" && typeof d === "string" && typeof c === "number" && c > 0) {
      bars.push({ market: String(v[0]), code, d, c });
    }
  }
  return bars;
}

/**
 * Replay the check cohort. Returns one { d, nav } per session in the window (nav as a decimal
 * string of micro-units). Empty when there are not enough bars.
 * @param {{ market: string, code: string, d: string, c: number }[]} bars
 * @param {{ seed?: bigint, positions?: number, window?: number, startMicro?: bigint }} [opts]
 */
export function replayNav(bars, opts = {}) {
  const seed = opts.seed ?? CHECK_SEED;
  const positions = opts.positions ?? POSITIONS;
  const window = opts.window ?? WINDOW;
  const startMicro = opts.startMicro ?? START_MICRO;

  /** @type {Map<string, Map<string, bigint>>} market/code -> date -> close micro */
  const byCode = new Map();
  for (const b of bars) {
    const key = `${b.market}/${b.code}`;
    if (!byCode.has(key)) byCode.set(key, new Map());
    byCode.get(key).set(b.d, toMicro(b.c));
  }
  const codes = [...byCode.keys()].sort();
  if (codes.length === 0) return [];
  // Seeded Fisher-Yates over the sorted code list; take the first N.
  const next = splitmix64(seed);
  const order = [...codes];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Number(next() % BigInt(i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = order.slice(0, Math.min(positions, order.length));
  const dates = [...new Set(chosen.flatMap((k) => [...byCode.get(k).keys()]))].sort();
  // Start on the first session on which every chosen code has a bar.
  const start = dates.findIndex((d) => chosen.every((k) => byCode.get(k).has(d)));
  if (start < 0) return [];
  const days = dates.slice(start, start + window);
  const pool = startMicro / BigInt(chosen.length);
  const qty = new Map();
  let cash = startMicro;
  for (const k of chosen) {
    const px = byCode.get(k).get(days[0]);
    const q = px > 0n ? (pool * 1_000_000n) / px / 1_000_000n : 0n;
    qty.set(k, q);
    cash -= q * px;
  }
  const last = new Map(chosen.map((k) => [k, byCode.get(k).get(days[0])]));
  const out = [];
  for (const d of days) {
    let nav = cash;
    for (const k of chosen) {
      const px = byCode.get(k).get(d);
      if (px !== undefined) last.set(k, px);
      nav += qty.get(k) * last.get(k);
    }
    out.push({ d, nav: nav.toString() });
  }
  return out;
}

/** Read the bars of a (restored) database. @param {import("@libsql/client").Client} db */
export async function readBars(db) {
  const r = await db.execute("SELECT market, code, d, c FROM price_bar ORDER BY market, code, d");
  return barsFromValues(
    r.rows.map((row) => [row[0], row[1], row[2], row[3]]),
    3,
  );
}

/**
 * Compare the NAV series replayed over the stream's bars with the one replayed over the restored
 * database. Never returns row content: a boolean, a count and a fixed reason only.
 * @param {{ expectedBars: ReturnType<typeof barsFromValues>, db: import("@libsql/client").Client, replay?: typeof replayNav }} args
 * @returns {Promise<{ ok: boolean, days: number, reason: string }>}
 */
export async function checkCohort({ expectedBars, db, replay = replayNav }) {
  const want = replay(expectedBars);
  if (want.length === 0) return { ok: false, days: 0, reason: "no bars to replay" };
  let got;
  try {
    got = replay(await readBars(db));
  } catch {
    return { ok: false, days: want.length, reason: "restored bars unreadable" };
  }
  if (got.length !== want.length) {
    return { ok: false, days: want.length, reason: "NAV length differs" };
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i].d !== want[i].d || got[i].nav !== want[i].nav) {
      return { ok: false, days: want.length, reason: "NAV differs" };
    }
  }
  return { ok: true, days: want.length, reason: "" };
}
