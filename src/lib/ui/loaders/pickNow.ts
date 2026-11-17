// The current price of pick codes for the pick cards (Owner 2026-11-16): the newest delayed quote when
// it is from a later day than the last close, else the last close. Display only; stops and exits stay
// at the close (ARN-021). Reads are chunked at 200 codes and use no OFFSET (Turso free quota).
import type { Exec } from "@/lib/cortex/store/common";
import {
  LATEST_READ_MAX,
  newerThanClose,
  quoteTimeMelbourne,
  readLatestQuotes,
} from "@/lib/data/quotes/latest";
import { formatDay } from "@/lib/view/format";
import { soft } from "./common";
import { priceMicro } from "./shell";

export type PickNow = {
  micro: bigint;
  /** Freshness in market words: "Delayed, 13:05" or "End of day, Fri 6 Nov". */
  label: string;
};

/** Level against the reference price in ppm: exact integer arithmetic, rounded half away from zero. */
export function ppmOf(level: unknown, reference: unknown): number | null {
  try {
    const ref = BigInt(String(reference));
    if (ref <= 0n) return null;
    const diff = (BigInt(String(level)) - ref) * 1_000_000n; // threshold-ok: ppm
    const half = ref / 2n;
    return Number(diff >= 0n ? (diff + half) / ref : -((-diff + half) / ref)); // money-float-ok: small ppm integer
  } catch {
    return null;
  }
}

/** The latest price of each code that has one; codes with no bar and no quote are absent. */
export async function loadPickNow(
  db: Exec,
  market: string,
  codes: readonly string[],
): Promise<Map<string, PickNow>> {
  const out = new Map<string, PickNow>();
  const uniq = [...new Set(codes)];
  for (let i = 0; i < uniq.length; i += LATEST_READ_MAX) {
    const chunk = uniq.slice(i, i + LATEST_READ_MAX);
    const closes = await soft(
      async () =>
        (
          await db.execute({
            sql: `SELECT pb.code, pb.d, pb.c FROM price_bar pb
                  WHERE pb.market = ? AND pb.code IN (${chunk.map(() => "?").join(", ")})
                    AND pb.d = (SELECT MAX(x.d) FROM price_bar x WHERE x.market = pb.market AND x.code = pb.code)`,
            args: [market, ...chunk],
          })
        ).rows,
      [],
    );
    const closeD = new Map<string, string>();
    for (const c of closes) {
      const code = String(c.code);
      closeD.set(code, String(c.d));
      out.set(code, {
        micro: BigInt(priceMicro(Number(c.c))), // money-float-ok: stored REAL bar price
        label: `End of day, ${formatDay(String(c.d))}`,
      });
    }
    const quotes = await soft(() => readLatestQuotes(db, market, chunk), new Map());
    for (const code of chunk) {
      const live = newerThanClose(quotes.get(code), closeD.get(code) ?? null);
      if (live)
        out.set(code, {
          micro: live.lastMicro,
          label: `Delayed, ${quoteTimeMelbourne(live.quoteAt)}`,
        });
    }
  }
  return out;
}
