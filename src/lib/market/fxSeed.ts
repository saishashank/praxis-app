// The FX close a market's starting capital converts with (ARN-119, D-1107, D-1192; M20 S1). The profile's
// `seed_amount` is `fx_rounded` for IN and US: A$600 times the RBA daily close of the activation day. The close is a
// `macro_series` row (source `rba`); this module reads the newest row on or before the activation day and hands it to
// `seedForMarket` as `{ rate, date, source }`. Nothing is guessed: no row, no seed, and the switch to `full` is refused.
import type { Client } from "@libsql/client";
import type { FxRow } from "@/lib/arena/seed";
import { addDays } from "@/lib/data/calendar";

/** The RBA F11 series of each market's currency against the Australian dollar (spec gap D-1192, listed). */
export const FX_SERIES: Readonly<Record<string, string>> = Object.freeze({
  IN: "FXRINR",
  US: "FXRUSD",
});

const MICRO_DIGITS = 6; // threshold-ok: value_micro holds the rate x 1,000,000

/** value_micro -> a decimal text with no trailing zeros ("55123456" -> "55.123456"). */
export function rateText(valueMicro: bigint | number): string {
  const v = BigInt(valueMicro);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(MICRO_DIGITS, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/** A close older than this many days before the activation day is stale: the seed is refused, never converted (D-1192). */
export const FX_MAX_AGE_DAYS = 5; // threshold-ok: covers a long weekend and a bank holiday

/** The newest RBA close of the market's currency on or before `day` and at most 5 days old, or null. */
export async function readSeedFx(
  db: Pick<Client, "execute">,
  market: string,
  day: string,
): Promise<FxRow | null> {
  const series = FX_SERIES[market];
  if (series === undefined) return null;
  // rows-ok: one primary-key range probe, newest row first, limit 1
  const r = await db.execute({
    sql: `SELECT d, value_micro FROM macro_series
          WHERE source = 'rba' AND series_id = ? AND d <= ? AND d >= ? ORDER BY d DESC LIMIT 1`,
    args: [series, day, addDays(day, -FX_MAX_AGE_DAYS)],
  });
  if (r.rows.length === 0) return null;
  const micro = BigInt(r.rows[0]!.value_micro as number | bigint);
  if (micro <= 0n) return null;
  return { rate: rateText(micro), date: String(r.rows[0]!.d), source: `rba:${series}` };
}
