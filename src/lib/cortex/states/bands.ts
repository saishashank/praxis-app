// India price bands (M20 A5; DAT-243 f, ARN-117, D-1109 F). The exchange publishes a daily band per code (band_pct,
// a whole percent; NULL = no band, the F&O stocks) and the limits are the previous close x (1 +/- band), on the tick
// grid: the upper limit rounds DOWN, the lower limit rounds UP (both inward, so a limit is a price the exchange can
// actually show). A session whose close sits at or beyond a limit is "band-locked": the market is one-sided and the
// fill model refuses any fill that session (`arena/fills.ts`, cancel reason `band_locked`). Pure over its inputs;
// `loadPriceBand` is the one read of the `price_band` row.
import type { Client } from "@libsql/client";
import { divCeil, divFloor, makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { roundToTick } from "@/lib/money/round";
import { tickFor, type TickBand } from "@/lib/money/tick";

/** One `price_band` row (DAT-243 f); the limits are the file's own when it carries them. */
export type PriceBandRow = {
  readonly market: string;
  readonly code: string;
  readonly d: string;
  /** Whole percent (1..100); null = no band. */
  readonly bandPct: number | null;
  readonly lowerMicro: bigint | null;
  readonly upperMicro: bigint | null;
  readonly source: string;
};

export type BandLimits = { readonly lowerMicro: bigint; readonly upperMicro: bigint };

/**
 * The limits for a previous close and a band: `prevClose x (100 + pct) / 100` rounded down onto the tick grid of the
 * band the result falls in, `prevClose x (100 - pct) / 100` rounded up (re-rounded on a coarser band's grid if the
 * round-up crosses into one). The lower limit never falls below one tick of the lowest band.
 */
export function bandLimits(
  prevCloseMicro: bigint,
  bandPct: number,
  tickTable: readonly TickBand[],
): BandLimits {
  if (prevCloseMicro <= 0n) throw new RangeError("previous close must be positive");
  if (!Number.isInteger(bandPct) || bandPct < 1 || bandPct > 100) {
    throw new RangeError("band must be a whole percent from 1 to 100");
  }
  if (tickTable.length === 0) throw new RangeError("tick table is empty");
  const pct = BigInt(bandPct);
  const prev = makeRational(prevCloseMicro);
  const upRaw: Rational = mulRat(prev, makeRational(100n + pct, 100n));
  const loRaw: Rational = mulRat(prev, makeRational(100n - pct, 100n));

  const upperTick = tickFor(divFloor(upRaw.num, upRaw.den) || 1n, tickTable);
  const upper = roundToTick(upRaw, upperTick, "down");

  const floorPrice = tickTable[0]!.tickMicro;
  let lower: bigint;
  if (loRaw.num <= 0n) {
    lower = floorPrice;
  } else {
    let tick = tickFor(divCeil(loRaw.num, loRaw.den) || 1n, tickTable);
    lower = roundToTick(loRaw, tick, "up");
    for (;;) {
      const next = tickFor(lower, tickTable);
      if (next <= tick) break;
      tick = next;
      lower = roundToTick(loRaw, tick, "up");
    }
    if (lower < floorPrice) lower = floorPrice;
  }
  return { lowerMicro: lower, upperMicro: upper };
}

/** A session is band-locked when its close is at or beyond a limit (D-1109): `close >= upper || close <= lower`. */
export function bandLocked(bar: { readonly closeMicro: bigint }, limits: BandLimits): boolean {
  return bar.closeMicro >= limits.upperMicro || bar.closeMicro <= limits.lowerMicro;
}

/**
 * The limits of a session from its `price_band` row and the previous close: the file's own limits when it carries
 * both, else computed from the percent; null when the code has no band that day (a row with no percent and no limits,
 * or no row at all).
 */
export function limitsOfRow(
  row: PriceBandRow | null,
  prevCloseMicro: bigint | null,
  tickTable: readonly TickBand[],
): BandLimits | null {
  if (row === null) return null;
  if (row.lowerMicro !== null && row.upperMicro !== null) {
    return { lowerMicro: row.lowerMicro, upperMicro: row.upperMicro };
  }
  if (row.bandPct === null || prevCloseMicro === null) return null;
  return bandLimits(prevCloseMicro, row.bandPct, tickTable);
}

/**
 * The value for `FillOrderEnv.bandLocked` (arena/fills.ts): true when the session's `price_band` row gives limits and
 * the close sits at one. No row, no band (null percent) or no previous close = not locked (the fill model then runs
 * as it does for AU: nothing is refused on a missing file; the missing file itself is a data-quality matter, DAT-210).
 */
export function bandLockedForSession(
  row: PriceBandRow | null,
  prevCloseMicro: bigint | null,
  bar: { readonly closeMicro: bigint },
  tickTable: readonly TickBand[],
): boolean {
  const limits = limitsOfRow(row, prevCloseMicro, tickTable);
  return limits !== null && bandLocked(bar, limits);
}

const asMicro = (v: unknown): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as number | bigint);

/** The `price_band` row of one code on one day, or null. */
export async function loadPriceBand(
  db: Pick<Client, "execute">,
  market: string,
  code: string,
  d: string,
): Promise<PriceBandRow | null> {
  const r = await db.execute({
    // rows-ok: one row through the primary key (market, code, d)
    sql: "SELECT market, code, d, band_pct, lower_micro, upper_micro, source FROM price_band WHERE market = ? AND code = ? AND d = ?",
    args: [market, code, d],
  });
  const x = r.rows[0];
  if (x === undefined) return null;
  return {
    market: String(x.market),
    code: String(x.code),
    d: String(x.d),
    bandPct: x.band_pct === null ? null : Number(x.band_pct),
    lowerMicro: asMicro(x.lower_micro),
    upperMicro: asMicro(x.upper_micro),
    source: String(x.source),
  };
}
