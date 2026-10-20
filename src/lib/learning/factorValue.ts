// Numeric value of a stored factor text ("a/b" exact ratio or a plain decimal), for descriptive
// bucket assignment only. Lives in learning so the weekly factor buckets need nothing from
// src/lib/picks (picks may read it; learning, ranking and trading never import picks, D-122).

/** "a/b" or a decimal → number; anything else (or a zero denominator) → null. */
export function numericValue(text: string): number | null {
  const m = /^(-?\d+)\/(\d+)$/.exec(text);
  if (m) {
    const den = BigInt(m[2]!);
    if (den === 0n) return null;
    return Number(m[1]) / Number(m[2]); // money-float-ok: descriptive bucket assignment
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  return Number(text); // money-float-ok: descriptive bucket assignment
}
