// M17 WP1: synthetic ZZ chart payloads (SEC-110: never a real capture). Mirrors the [VERIFY at build]
// chart `meta` shape; used by the contract test and by AT-61 recorded sessions.
export type SyntheticMeta = {
  price?: number | null;
  timeS?: number | null;
  volume?: number | null;
  prevClose?: number | null;
  currency?: string | null;
  symbol?: string | null;
};

const CODE_MOD = 100; // threshold-ok: two-digit code suffix

/** Code of the form ZZnn, never a listed ticker. */
export const zzCode = (n: number): string => `ZZ${String(n % CODE_MOD).padStart(2, "0")}`;

export function syntheticChart(m: SyntheticMeta): unknown {
  const meta: Record<string, unknown> = { exchangeName: "ASX" };
  if (m.currency !== null) meta.currency = m.currency ?? "AUD";
  if (m.symbol != null) meta.symbol = m.symbol;
  if (m.price != null) meta.regularMarketPrice = m.price;
  if (m.timeS != null) meta.regularMarketTime = m.timeS;
  if (m.volume != null) meta.regularMarketVolume = m.volume;
  if (m.prevClose != null) meta.chartPreviousClose = m.prevClose;
  return { chart: { result: [{ meta, timestamp: [], indicators: { quote: [{}] } }], error: null } };
}

/** A synthetic session: per code, one payload per tick, deterministic from the code index. */
export function syntheticSession(
  codes: readonly string[],
  startS: number,
  ticks: number,
  stepS = 300, // threshold-ok: 5-minute tick
): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  codes.forEach((code, i) => {
    const prev = 10 + i;
    const series: unknown[] = [];
    for (let k = 0; k < ticks; k++) {
      series.push(
        syntheticChart({
          price: Math.round((prev + (k - ticks / 2) * 0.01) * 100) / 100,
          timeS: startS + k * stepS,
          volume: 1000 * (k + 1) * (i + 1), // threshold-ok: synthetic volume
          prevClose: prev,
        }),
      );
    }
    out.set(code, series);
  });
  return out;
}
