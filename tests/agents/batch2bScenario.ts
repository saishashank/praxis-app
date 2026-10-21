// The golden scenario of the batch 2b tests (M4 T8): 36 synthetic U1 codes on a calendar of 330
// weekday sessions. Session 300 is the decision night.
//   ZZD1  oversold dip on 300 (-8 %, recovers)             -> F4 candidate, ranked first
//   ZZD2  oversold dip on 300 (-5 %, recovers)              -> F4 candidate, ranked second
//   ZZD3  falls 3 %, 3 %, 7 % on 302-304                    -> bought on 303 (cash is free once ZZD1 is
//         sold), stopped out on 304, signalled again on 304 (blocked by FAM-002)
//   ZZUP  strongest 126-session return, breakout on a volume spike on 300, rallies, then a -12 %
//         day on 311                                         -> F1 candidate, trailing stop level
//   the rest rise 0.3 % a day with distinct zigzag amplitudes (distinct 20-session volatility)
import type { Client } from "@libsql/client";
import { buildNight, DATES, trend, type CodeDef, type NightOptions } from "./batch2bHarness";

export const D = 300;
export const FILLERS = Array.from({ length: 33 }, (_, j) => `ZZ${String(j).padStart(2, "0")}`);

/** Falls of `drops[i]` percent on the listed sessions from D on; a 3 % a day recovery to the trend. */
export const shape =
  (base: (i: number) => bigint, drops: Record<number, number>) =>
  (i: number): bigint => {
    const raw = base(i);
    if (i < D) return raw;
    const prev = shape(base, drops)(i - 1);
    const pct = drops[i];
    if (pct !== undefined) return (prev * BigInt(100 - pct)) / 100n;
    const up = (prev * 103n) / 100n;
    return up < raw ? up : raw;
  };

export function goldenCodes(zzd1SplitAt?: number): CodeDef[] {
  const upBase = trend(900_000n, 3_000n, 1_500n);
  const up = (i: number): bigint => {
    if (i < D) return upBase(i);
    let c = upBase(D - 1);
    for (let k = D; k <= i; k++) c = k === 311 ? (c * 88n) / 100n : (c * 1012n) / 1000n;
    return c;
  };
  const codes: CodeDef[] = [
    {
      code: "ZZD1",
      close: shape(trend(1_000_000n, 3_000n, 2_000n), { 300: 8 }),
      splitAt: zzd1SplitAt,
    },
    { code: "ZZD2", close: shape(trend(1_010_000n, 3_000n, 2_100n), { 300: 5 }) },
    // three falls in a row: signalled from 302, bought on 303, stopped out on 304
    { code: "ZZD3", close: shape(trend(1_000_000n, 3_000n, 2_200n), { 302: 3, 303: 3, 304: 7 }) },
    {
      code: "ZZUP",
      close: up,
      volume: (i) => (i === D ? 8_000_000n : 2_000_000n),
    },
  ];
  FILLERS.forEach((code, j) => {
    codes.push({
      code,
      close: trend(1_000_000n + 30_000n * BigInt(j), 3_000n, 1_000n + 250n * BigInt(j)),
    });
  });
  return codes;
}

export async function buildGolden(
  db: Client,
  over: Partial<NightOptions> = {},
  zzd1SplitAt?: number,
): Promise<void> {
  await buildNight(db, { codes: goldenCodes(zzd1SplitAt), ...over });
}

export const DATE = (i: number): string => DATES[i]!;
