// Economics (M15 C3a): cost per order by tier (CTX-022a), gap-risk cap (CTX-022b), ranking (CTX-022),
// break-even card line (CTX-021). The limit formula and the trade-through fill live in
// src/lib/arena/fills.ts (`limitPriceMicro`, `fillEntryLimit`) so the arena, the replay and the
// offline tools share one fill model (D-278); they are re-exported here for the night path.
export * from "./cost";
export * from "./gapCap";
export * from "./rank";
export * from "./breakEven";
export {
  fillEntryLimit,
  LIMIT_FILL_RULE,
  limitPriceMicro,
  type LimitFillOutcome,
  type LimitFillRule,
  type SimulatedLimitFill,
} from "@/lib/arena/fills";
