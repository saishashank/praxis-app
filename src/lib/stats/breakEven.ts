// Break-even probability (M15 C2; spec ch. 17 CTX-021, CTX-022a, CTX-070; AT-52).
//
//   p_be = (L + C) / (G + L)
// with G and L the conditional mean gross gain and loss over ALL realised outcomes (time exits
// included) and C the round-trip cost per order from CTX-022a. All three in the same unit (a fraction
// or a percentage of the entry notional). AT-52: G 10, L 6, C 2.5 → 53.1 %. The card shows p_be at
// C = 2.5 %, 5 % and 7.5 % (CTX-022a). p_be is a diagnostic shown on the card, never a binding test.
//
// Money arrives as micro-dollar integers and is converted to float fractions at the boundary here
// (`grossReturnFromMicro`); every statistic below is a float.
import type { Prng } from "./rng";
import {
  type BlockLayout,
  type BootCi,
  type BootstrapOptions,
  bootstrapCiMany,
  isUndefined,
  type StatUndefined,
} from "./stationaryBootstrap";

/** The three card cost levels, as fractions (CTX-022a: 2.5 %, 5 %, 7.5 %). */
export const CARD_COST_LEVELS: readonly number[] = [0.025, 0.05, 0.075];

/** p_be = (L + C) / (G + L); G and L are magnitudes (L ≥ 0), C ≥ 0. */
export function breakEvenP(gain: number, loss: number, cost: number): number {
  if (!(gain >= 0) || !(loss >= 0) || !(cost >= 0)) throw new RangeError("G, L, C must be >= 0");
  if (gain + loss === 0) throw new RangeError("G + L must be positive");
  return (loss + cost) / (gain + loss);
}

export type GainLoss = {
  /** Conditional mean gross gain over outcomes > 0 (0 when none). */
  readonly gain: number;
  /** Conditional mean gross loss magnitude over outcomes ≤ 0 (0 when none). */
  readonly loss: number;
  readonly nGain: number;
  readonly nLoss: number;
};

/**
 * G and L from gross outcomes (fractions of entry notional) over all realised outcomes: gains are the
 * outcomes > 0, losses the outcomes ≤ 0 — a flat exit (gross = 0) counts on the loss side with
 * magnitude 0 (D-301; it lowers L and so p_be slightly, the conservative side for a diagnostic).
 */
export function conditionalGainLoss(gross: readonly number[]): GainLoss {
  let sg = 0;
  let sl = 0;
  let ng = 0;
  let nl = 0;
  for (const g of gross) {
    if (!Number.isFinite(g)) throw new RangeError("gross outcomes must be finite");
    if (g > 0) {
      sg += g;
      ng += 1;
    } else {
      sl += -g;
      nl += 1;
    }
  }
  return { gain: ng > 0 ? sg / ng : 0, loss: nl > 0 ? sl / nl : 0, nGain: ng, nLoss: nl };
}

/** The card line: p_be at each cost level (`CardFields.breakEven`, docs/M15_design.md §3a). */
export function breakEvenLine(
  gain: number,
  loss: number,
  costs: readonly number[] = CARD_COST_LEVELS,
): readonly { readonly c: number; readonly pBe: number }[] {
  return costs.map((c) => ({ c, pBe: breakEvenP(gain, loss, c) }));
}

/** Gross return as a float fraction from micro-dollar integers (the money → statistics boundary). */
export function grossReturnFromMicro(grossMicro: bigint, notionalMicro: bigint): number {
  if (notionalMicro <= 0n) throw new RangeError("notional must be positive");
  // Statistics are floats: both micro amounts are well inside 2^53 for any arena notional.
  return Number(grossMicro) / Number(notionalMicro);
}

export type BreakEvenCi = {
  readonly gain: BootCi;
  readonly loss: BootCi;
  /** p_be at `cost` with the interval from the same replicate draws. */
  readonly pBe: BootCi;
};

/**
 * G, L and p_be at one cost with block-bootstrap intervals (all three from the same replicate draws).
 * `gross` is aligned with `layout.sessions`.
 */
export function breakEvenCi(
  gross: readonly number[],
  cost: number,
  layout: BlockLayout,
  prng: Prng,
  opts: BootstrapOptions = {},
): BreakEvenCi | StatUndefined {
  if (gross.length !== layout.sessions.length)
    throw new RangeError("gross must have one entry per row");
  const full = conditionalGainLoss(gross);
  if (full.nGain === 0 || full.nLoss === 0) return { undefined: "need both gains and losses" };
  // Influence values (delta method on the conditional means and p_be = (L + C)/(G + L)).
  const n = gross.length;
  const gInf = new Float64Array(n);
  const lInf = new Float64Array(n);
  const pInf = new Float64Array(n);
  const dG = -(full.loss + cost) / (full.gain + full.loss) ** 2;
  const dL = (full.gain - cost) / (full.gain + full.loss) ** 2;
  for (let i = 0; i < n; i += 1) {
    const g = gross[i]!;
    if (g > 0) gInf[i] = ((g - full.gain) * n) / full.nGain;
    else lInf[i] = ((-g - full.loss) * n) / full.nLoss;
    pInf[i] = dG * gInf[i]! + dL * lInf[i]!;
  }
  const stats = (rows: Int32Array): readonly number[] => {
    let sg = 0;
    let sl = 0;
    let ng = 0;
    let nl = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const g = gross[rows[i]!]!;
      if (g > 0) {
        sg += g;
        ng += 1;
      } else {
        sl += -g;
        nl += 1;
      }
    }
    if (ng === 0 || nl === 0) return [NaN, NaN, NaN];
    const G = sg / ng;
    const L = sl / nl;
    return [G, L, (L + cost) / (G + L)];
  };
  const [gain, loss, p] = bootstrapCiMany(layout, stats, [gInf, lInf, pInf], prng, opts);
  if (isUndefined(gain!)) return gain;
  if (isUndefined(loss!)) return loss;
  if (isUndefined(p!)) return p;
  return { gain, loss, pBe: p };
}
