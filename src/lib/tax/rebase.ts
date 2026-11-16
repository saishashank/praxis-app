// Quantity re-base across several lots (M21 B3; D-1268). The book re-bases the AGGREGATE holding: floor(held x ratio)
// (`rebaseQty`, ledger.ts). To keep every lot a whole number of shares and the lot total equal to that aggregate, each
// lot is floored and the shortfall is handed out one share at a time to the lots with the largest dropped fraction,
// oldest first on ties. Cost is never touched.
import { makeRational, mulRat, type Rational } from "@/lib/money/rational";
import { floorRat } from "@/lib/money/round";

export function rebaseLots(qtys: readonly bigint[], ratio: Rational): bigint[] {
  const total = qtys.reduce((a, q) => a + q, 0n);
  const target = floorRat(mulRat(makeRational(total), ratio));
  const exact = qtys.map((q) => mulRat(makeRational(q), ratio));
  const floors = exact.map((r) => floorRat(r));
  let short = target - floors.reduce((a, q) => a + q, 0n);
  // dropped fraction of lot i = (exact.num - floor x exact.den) / exact.den
  const rem = exact.map((r, i) => r.num - floors[i]! * r.den);
  const order = qtys
    .map((_, i) => i)
    .sort((a, b) => {
      const l = rem[a]! * exact[b]!.den;
      const r = rem[b]! * exact[a]!.den;
      return l > r ? -1 : l < r ? 1 : a - b;
    });
  const out = [...floors];
  for (const i of order) {
    if (short <= 0n) break;
    if (rem[i]! > 0n) {
      out[i]! += 1n;
      short -= 1n;
    }
  }
  return out;
}
