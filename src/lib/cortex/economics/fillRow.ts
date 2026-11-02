// The `fill.rule` value of a Cortex limit-order entry fill (M15 C3a; review S3, decision D-307).
//
// The 0007 `fill.rule` CHECK admits open | level | gap_open | close_signal and 0019 alters no CHECK,
// so a D-288 trade-through (filled at the limit exactly, `SimulatedLimitFill.rule === "limit"`) is
// written as rule `level` with `arena_order.limit_micro` set on its order; an open fill (open ≤ limit,
// capped at the limit or not) stays `open`. P2 (closeBooks) and P3 (cohortReplay) call this before
// writing a row; the in-memory fill keeps `limit` so the would-have scoring can tell the two apart.
import { LIMIT_FILL_RULE, type LimitFillOutcome, type SimulatedLimitFill } from "@/lib/arena/fills";

export type FillRowRule = "open" | "level";

export function fillRowRule(outcome: LimitFillOutcome | SimulatedLimitFill): FillRowRule {
  const fill = "status" in outcome ? (outcome.status === "filled" ? outcome.fill : null) : outcome;
  if (fill === null) throw new RangeError("an unfilled limit order writes no fill row");
  if (fill.rule === LIMIT_FILL_RULE) return "level";
  if (fill.rule === "open") return "open";
  throw new RangeError(`not an entry fill rule: ${fill.rule}`);
}
