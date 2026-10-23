// Vendor number normalisation (D-172). Lives in the data layer, not in src/lib/money: it inspects a
// vendor's floating-point encoding, and the money code does no floating-point work (noFloatMoney test).

/** The most a stored double may differ from its float32 (relative): only printing loss, ~1e-16. */
const FLOAT32_MATCH = 1e-9;
const MAX_SIGNIFICANT = 9; // a float32 round-trips through at most 9 significant digits

/**
 * The short decimal a vendor value encodes when the vendor carried it as a 32-bit float.
 * Yahoo's prices pass through float32, so A$0.12 arrives as 0.119999997317791: the float32 nearest
 * to 0.12, printed in 15 digits. Returns the shortest decimal (at most 9 significant digits) that
 * maps to the same float32, or null when the value is not (within printing loss) a float32 at all.
 * No rounding to a guess: the decimal is recovered from the float32 bits exactly.
 */
export function float32Decimal(value: number): string | null {
  if (!Number.isFinite(value) || value === 0) return null;
  const f = Math.fround(value);
  if (!Number.isFinite(f) || Math.abs(f - value) > Math.abs(value) * FLOAT32_MATCH) return null;
  for (let p = 1; p <= MAX_SIGNIFICANT; p++) {
    const candidate = Number(f.toPrecision(p));
    if (Math.fround(candidate) === f) return String(candidate);
  }
  return null;
}
