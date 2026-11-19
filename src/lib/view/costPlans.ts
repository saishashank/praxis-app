// Brokerage cost profiles in plain words (D-919): a broker-style name and the exact fee as detail.
// Pages show these instead of the internal profile codes (P0 to P6, "stress"), which also collide with
// the alert severities P0/P1. The exact rules live in src/lib/arena/costs.ts; this is only wording.
// M20 A2 (D-1090): the wording is a market fact and lives with the market's cost-profile table
// (src/lib/market/seed/<code>/costPlans.mjs, resolved through `costPlansOf`), keyed by the profile code of the
// market's `cost_formula`; this module holds none.
import { HOME_MARKET } from "@/lib/market/homeMarket.mjs";
import { costPlansOf } from "@/lib/market/staticProfile.mjs";

export type CostPlan = { title: string; detail: string };

/** The plain plan for a profile key of a market (default: the home market); an unknown key reads as "Other costs". */
export function costPlan(key: string, market: string = HOME_MARKET): CostPlan {
  const plan = costPlansOf(market)[key];
  return plan === undefined ? { title: "Other costs", detail: "" } : { ...plan };
}
