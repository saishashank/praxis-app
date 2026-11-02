// Break-even card line (M15 C3a; spec ch. 17 CTX-021, CTX-022a, CTX-070; AT-52 "p_be fixture").
// Thin over C2 `stats/breakEven.ts`: the card shows p_be at C = 2.5 %, 5 % and 7.5 % and, beside the
// line, p_be at the candidate's own cost per order. A diagnostic, never a binding test.
import {
  breakEvenLine,
  breakEvenP,
  CARD_COST_LEVELS,
  conditionalGainLoss,
  type GainLoss,
} from "@/lib/stats/breakEven";
import { costFraction, type CostPerOrder } from "./cost";

export type BreakEvenCard = {
  /** `CardFields.breakEven`: p_be at each of the three card cost levels. */
  readonly line: readonly { readonly c: number; readonly pBe: number }[];
  /** p_be at this order's own C (CTX-022a), when a cost was given. */
  readonly atOrderCost: { readonly c: number; readonly pBe: number } | null;
  readonly gain: number;
  readonly loss: number;
};

/**
 * G and L are the conditional mean gross gain and loss over ALL realised outcomes of the matched cell
 * (fractions). AT-52: G 0.10, L 0.06, C 0.025 → 0.531.
 */
export function breakEvenCard(gain: number, loss: number, cost?: CostPerOrder): BreakEvenCard {
  const c = cost === undefined ? null : costFraction(cost);
  return {
    line: breakEvenLine(gain, loss, CARD_COST_LEVELS),
    atOrderCost: c === null ? null : { c, pBe: breakEvenP(gain, loss, c) },
    gain,
    loss,
  };
}

/** The card from the cell's gross outcomes (fractions), through C2 `conditionalGainLoss`. */
export function breakEvenCardFromGross(
  gross: readonly number[],
  cost?: CostPerOrder,
): BreakEvenCard & { readonly gainLoss: GainLoss } {
  const gl = conditionalGainLoss(gross);
  return { ...breakEvenCard(gl.gain, gl.loss, cost), gainLoss: gl };
}
