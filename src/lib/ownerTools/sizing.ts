// The Owner's own sizing of a night pick (M21 B1, UXN-315, D-1217, F: it is money maths). The night's sizing maths is
// `sizeForAmount` (src/lib/picks/generate.ts), extracted unchanged and called here with the Owner's capital instead of the
// profile's example amount. Everything is exact integer micro: no float, no `Number` on a money value. Pure: no I/O.
import { divFloor } from "@/lib/money/rational";
import { sizeForAmount } from "@/lib/picks/generate";

const MICRO = 1_000_000n; // threshold-ok: micro per unit
const HUNDRED = 100n; // threshold-ok: percent base
const BP = 10_000n; // threshold-ok: basis points per whole
const TWO = 2n; // threshold-ok: half-up rounding

/** The fee of one fill: its value, side and whole shares (a per-share item, such as the US TAF, needs the shares). */
export type FeeFn = (notionalMicro: bigint, side: "buy" | "sell", quantity: bigint) => bigint;
export type Caps = { maxPct: string; riskPct: string };

export type Parcel =
  | { kind: "no_amount" }
  | { kind: "too_small" }
  | {
      kind: "ok";
      shares: bigint;
      /** shares x limit price. */
      valueMicro: bigint;
      /** shares x (limit - stop) + the fees of both sides. */
      riskMicro: bigint;
      /** The risk as basis points of the capital (150 = 1.50 %). */
      riskBp: bigint;
    };

/**
 * One pick sized for the Owner's capital. `capitalWhole` is whole home-currency units (0 = not set). The limit price is
 * the pick's "buy up to" price. The parcel is whole shares at the limit; one under the market's parcel floor is "too
 * small". The risk at the stop adds the buy fee at the limit and the sell fee at the stop (the market's cost profile).
 */
export function sizeParcel(args: {
  capitalWhole: number;
  caps: Caps;
  limitMicro: bigint;
  stopMicro: bigint;
  parcelFloorMicro: bigint;
  fee: FeeFn;
}): Parcel {
  const { capitalWhole, caps, limitMicro, stopMicro, parcelFloorMicro, fee } = args;
  if (!Number.isInteger(capitalWhole) || capitalWhole <= 0) return { kind: "no_amount" };
  const capitalMicro = BigInt(capitalWhole) * MICRO;
  const perShareRisk = limitMicro - stopMicro;
  if (limitMicro <= 0n || stopMicro <= 0n || perShareRisk <= 0n) return { kind: "too_small" };
  const sized = sizeForAmount(
    { amountMicro: capitalMicro, maxPct: caps.maxPct, riskPct: caps.riskPct },
    limitMicro,
    perShareRisk,
  );
  if (sized === null) return { kind: "too_small" };
  const shares = divFloor(sized.size, limitMicro);
  const valueMicro = shares * limitMicro;
  if (shares <= 0n || valueMicro < parcelFloorMicro) return { kind: "too_small" };
  const riskMicro =
    shares * perShareRisk +
    fee(valueMicro, "buy", shares) +
    fee(shares * stopMicro, "sell", shares);
  const riskBp = divFloor(riskMicro * BP + capitalMicro / TWO, capitalMicro);
  return { kind: "ok", shares, valueMicro, riskMicro, riskBp };
}

/** Basis points as percent text with two decimals: 150 -> "1.50 %". */
export function formatBp(bp: bigint): string {
  const whole = divFloor(bp, HUNDRED);
  const frac = bp - whole * HUNDRED;
  return `${whole.toString()}.${frac.toString().padStart(2, "0")} %`;
}

export type SectorValue = { sector: string | null; valueMicro: bigint };

/** The label of a company with no stored sector. */
export const NO_SECTOR_WORD = "Not classified yet";

/**
 * The concentration line of a set of sized parcels: the largest single-sector share of their total value, rounded half up
 * to a whole percent ("Largest sector: Materials, 50 % of the amount"). Null when there is no parcel. A tie is broken by
 * the sector name so the line never depends on the order of the picks.
 */
export function sectorLine(parcels: readonly SectorValue[]): string | null {
  const by = new Map<string, bigint>();
  let total = 0n;
  for (const p of parcels) {
    if (p.valueMicro <= 0n) continue;
    const k = p.sector ?? NO_SECTOR_WORD;
    by.set(k, (by.get(k) ?? 0n) + p.valueMicro);
    total += p.valueMicro;
  }
  if (total === 0n) return null;
  let best: [string, bigint] | null = null;
  for (const [k, v] of [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (best === null || v > best[1]) best = [k, v];
  }
  const pct = divFloor(best![1] * HUNDRED + total / TWO, total);
  return `Largest sector: ${best![0]}, ${pct.toString()} % of the amount`;
}
