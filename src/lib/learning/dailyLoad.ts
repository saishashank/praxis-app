// D-921: the database reads of the daily learning loop. Every read is bounded by codes and dates and
// batched by code (no OFFSET, D-903). Rows read a night (Turso free plan, D-904; aim < 300k):
//   universe snapshot, newest day            ~2,500   (all active shares; U1/U2 are the liquid ~450)
//   price_bar of D and of the previous day   ~5,000   (every code, for the mover ranking)
//   price_bar history, liquid + 40 movers    ~165,000 (about 460 codes x 330 sessions: 200-day average,
//                                                      52-week high and 40 sessions of next-day moves)
//   price-sensitive announcements            ~15,000  (liquid codes, 70 days; by (market, code, time))
//   instrument_class, index_bar, instrument ~3,000
//   signals, blocked trades, ledger rows     < 500
// about 190,000 rows. The bars stop at D, so nothing after the decision is read.
import type { Client } from "@libsql/client";
import { addDays } from "@/lib/data/calendar";
import { benchmarkIndexOf } from "@/lib/market/staticProfile.mjs";
import { industryUnknown } from "@/lib/data/referenceData";
import type { LBar, LShare } from "./dailyFeatures";
import type { News } from "./dailyMovers";

type Db = Pick<Client, "execute">;

const WINDOW_DAYS = 480; // threshold-ok: calendar days of bars: 200-session average, 52-week high and the window
const ANN_DAYS = 70; // threshold-ok: calendar days of announcements covering 40 sessions
const CHUNK = 200; // threshold-ok: codes per batched read
const LIQUID = ["U1", "U2"];
const PPM = 1_000_000; // threshold-ok: parts per million
export const MOVERS_PER_SIDE = 20; // threshold-ok: D-921 the 20 biggest gainers and the 20 biggest losers

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v); // money-float-ok: price and volume read for ratios and indicators only

export type MoveRow = { code: string; tier: string; movePpm: number };

export type SignalFact = {
  readonly family: string;
  readonly blocked: readonly string[];
  readonly traded: boolean;
};

export type World = {
  readonly d: string;
  readonly prev: string;
  readonly tierOf: ReadonlyMap<string, string>;
  /** every active, unhalted U1/U2/U3 share with a bar on both sessions, biggest gainer first */
  readonly moves: readonly MoveRow[];
  readonly indexMovePpm: number | null;
  readonly sectorOf: ReadonlyMap<string, string>;
  /** bars of the liquid shares (U1/U2) and of the movers, up to and including d */
  readonly shares: ReadonlyMap<string, LShare>;
  readonly liquidCodes: readonly string[];
  /** price-sensitive announcements of the liquid shares, by code */
  readonly sensitive: ReadonlyMap<string, readonly News[]>;
  readonly names: ReadonlyMap<string, string>;
  /** previous evening's strategy signals by code */
  readonly signals: ReadonlyMap<string, readonly SignalFact[]>;
};

export async function chunked<T>(
  codes: readonly string[],
  run: (part: readonly string[]) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < codes.length; i += CHUNK) out.push(...(await run(codes.slice(i, i + CHUNK))));
  return out;
}

const marks = (xs: readonly unknown[]): string => xs.map(() => "?").join(", ");

export async function loadBars(
  db: Db,
  market: string,
  codes: readonly string[],
  from: string,
  to: string,
): Promise<Map<string, LBar[]>> {
  const rows = await chunked(codes, async (part) => {
    const r = await db.execute({
      sql: `SELECT code, d, o, h, l, c, volume FROM price_bar
            WHERE market = ? AND code IN (${marks(part)}) AND d >= ? AND d <= ?
            ORDER BY code, d`,
      args: [market, ...part, from, to],
    });
    return r.rows;
  });
  const out = new Map<string, LBar[]>();
  for (const x of rows) {
    const b: LBar = {
      d: str(x.d),
      o: num(x.o),
      h: num(x.h),
      l: num(x.l),
      c: num(x.c),
      v: num(x.volume),
    };
    if (!(b.c > 0) || !(b.o > 0)) continue; // a bad bar is unusable evidence (the data-gap check counts it)
    const k = str(x.code);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(b);
  }
  return out;
}

export async function loadWorld(
  db: Db,
  o: { market: string; d: string; prev: string },
): Promise<World | null> {
  const uni = await db.execute({
    sql: `SELECT code, tier FROM universe_snapshot
          WHERE market = ? AND halted = 0 AND status = 'active'
            AND d = (SELECT MAX(d) FROM universe_snapshot WHERE market = ? AND d <= ?)
          ORDER BY code`,
    args: [o.market, o.market, o.d],
  });
  const tierOf = new Map(uni.rows.map((r) => [str(r.code), str(r.tier)]));
  if (tierOf.size === 0) return null;
  const closeOn = async (d: string): Promise<Map<string, number>> => {
    const r = await db.execute({
      sql: "SELECT code, c FROM price_bar WHERE market = ? AND d = ?",
      args: [o.market, d],
    });
    return new Map(r.rows.map((x) => [str(x.code), num(x.c)]));
  };
  const [cNow, cPrev] = [await closeOn(o.d), await closeOn(o.prev)];
  const moves: MoveRow[] = [];
  for (const [code, tier] of tierOf) {
    const a = cNow.get(code);
    const b = cPrev.get(code);
    if (a === undefined || b === undefined || !(a > 0) || !(b > 0)) continue;
    moves.push({ code, tier, movePpm: Math.round(((a - b) * PPM) / b) });
  }
  moves.sort((x, y) => y.movePpm - x.movePpm || (x.code < y.code ? -1 : 1));
  if (moves.length === 0) return null;

  const ix = await db.execute({
    sql: "SELECT d, c_micro FROM index_bar WHERE market = ? AND index_code = ? AND d IN (?, ?)",
    args: [o.market, benchmarkIndexOf(o.market), o.d, o.prev],
  });
  const ic = new Map(ix.rows.map((r) => [str(r.d), num(r.c_micro)]));
  const [i1, i0] = [ic.get(o.d), ic.get(o.prev)];
  const indexMovePpm =
    i1 !== undefined && i0 !== undefined && i0 > 0 ? Math.round(((i1 - i0) * PPM) / i0) : null;

  const cls = await db.execute({
    sql: `SELECT code, industry FROM instrument_class WHERE market = ? AND as_of <= ? ORDER BY code, as_of`,
    args: [o.market, o.d],
  });
  const sectorOf = new Map<string, string>();
  for (const r of cls.rows) {
    const code = str(r.code);
    if (!tierOf.has(code)) continue;
    const ind = str(r.industry);
    if (industryUnknown(ind)) sectorOf.delete(code);
    else sectorOf.set(code, ind); // a later as_of overwrites
  }

  const liquidCodes = [...tierOf.entries()]
    .filter(([, t]) => LIQUID.includes(t))
    .map(([c]) => c)
    .sort();
  const gainers = moves.filter((m) => m.movePpm > 0);
  const losers = moves.filter((m) => m.movePpm < 0);
  const moverCodes = [...gainers.slice(0, MOVERS_PER_SIDE), ...losers.slice(-MOVERS_PER_SIDE)].map(
    (m) => m.code,
  );
  const barCodes = [...new Set([...liquidCodes, ...moverCodes])].sort();
  const bars = await loadBars(db, o.market, barCodes, addDays(o.d, -WINDOW_DAYS), o.d);
  const shares = new Map<string, LShare>();
  for (const [code, list] of bars)
    shares.set(code, { code, tier: tierOf.get(code) ?? "U3", bars: list });

  // price-sensitive announcements of the liquid shares (the "news after the close" feature)
  const annRows = await chunked(liquidCodes, async (part) => {
    const r = await db.execute({
      sql: `SELECT code, published_at, title FROM announcement
            WHERE market = ? AND code IN (${marks(part)}) AND published_at >= ? AND published_at < ?
              AND price_sensitive = 1
            ORDER BY code, published_at`,
      args: [
        o.market,
        ...part,
        `${addDays(o.d, -ANN_DAYS)}T00:00:00.000Z`,
        `${addDays(o.d, 1)}T00:00:00.000Z`,
      ],
    });
    return r.rows;
  });
  const sensitive = new Map<string, News[]>();
  const moverAnn = moverCodes.filter((c) => !LIQUID.includes(tierOf.get(c) ?? ""));
  for (const r of annRows) {
    const k = str(r.code);
    if (!sensitive.has(k)) sensitive.set(k, []);
    sensitive.get(k)!.push({ publishedAt: str(r.published_at), title: str(r.title) });
  }
  // the U3 movers are not in the liquid read: their own announcements, 2 days
  if (moverAnn.length > 0) {
    const r = await db.execute({
      sql: `SELECT code, published_at, title FROM announcement
            WHERE market = ? AND code IN (${marks(moverAnn)}) AND published_at >= ? AND published_at < ?
              AND price_sensitive = 1 ORDER BY code, published_at`,
      args: [
        o.market,
        ...moverAnn,
        `${addDays(o.prev, -1)}T00:00:00.000Z`,
        `${addDays(o.d, 1)}T00:00:00.000Z`,
      ],
    });
    for (const x of r.rows) {
      const k = str(x.code);
      if (!sensitive.has(k)) sensitive.set(k, []);
      sensitive.get(k)!.push({ publishedAt: str(x.published_at), title: str(x.title) });
    }
  }

  const names = new Map<string, string>();
  if (moverCodes.length > 0) {
    const r = await db.execute({
      sql: `SELECT code, name FROM instrument WHERE market = ? AND code IN (${marks(moverCodes)})`,
      args: [o.market, ...moverCodes],
    });
    for (const x of r.rows) names.set(str(x.code), str(x.name));
  }

  const signals = new Map<string, SignalFact[]>();
  if (moverCodes.length > 0) {
    const r = await db.execute({
      sql: `SELECT s.id, s.code, s.family, b.reason FROM signal s
            LEFT JOIN blocked_trade b ON b.signal_id = s.id
            WHERE s.market = ? AND s.d = ? AND s.code IN (${marks(moverCodes)})
            ORDER BY s.code, s.family, s.id`,
      args: [o.market, o.prev, ...moverCodes],
    });
    const ids = [...new Set(r.rows.map((x) => str(x.id)))];
    const led =
      ids.length === 0
        ? { rows: [] as Record<string, unknown>[] }
        : await db.execute({
            sql: `SELECT signal_id FROM ledger_row WHERE signal_id IN (${marks(ids)})`,
            args: ids,
          });
    const traded = new Set(led.rows.map((x) => str(x.signal_id)));
    const by = new Map<
      string,
      { code: string; family: string; blocked: Set<string>; traded: boolean }
    >();
    for (const x of r.rows) {
      const key = `${str(x.code)}|${str(x.family)}`;
      const f = by.get(key) ?? {
        code: str(x.code),
        family: str(x.family),
        blocked: new Set<string>(),
        traded: false,
      };
      if (x.reason !== null && x.reason !== undefined) f.blocked.add(str(x.reason));
      if (traded.has(str(x.id))) f.traded = true;
      by.set(key, f);
    }
    for (const f of by.values()) {
      signals.set(f.code, [
        ...(signals.get(f.code) ?? []),
        { family: f.family, blocked: [...f.blocked].sort(), traded: f.traded },
      ]);
    }
  }
  return {
    d: o.d,
    prev: o.prev,
    tierOf,
    moves,
    indexMovePpm,
    sectorOf,
    shares,
    liquidCodes,
    sensitive,
    names,
    signals,
  };
}

/** Blocked trades and signals of the last sessions, for the improvement list (counts only). */
export async function loadBlocked(
  db: Db,
  market: string,
  from: string,
  to: string,
): Promise<{ signals: number; byReason: ReadonlyMap<string, number> }> {
  const s = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM signal WHERE market = ? AND d >= ? AND d <= ?",
    args: [market, from, to],
  });
  const b = await db.execute({
    sql: `SELECT reason, COUNT(DISTINCT signal_id) AS n FROM blocked_trade WHERE market = ? AND d >= ? AND d <= ?
          GROUP BY reason ORDER BY reason`,
    args: [market, from, to],
  });
  return {
    signals: num(s.rows[0]?.n ?? 0),
    byReason: new Map(b.rows.map((r) => [str(r.reason), num(r.n)])),
  };
}
