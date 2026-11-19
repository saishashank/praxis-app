// The short-sale facts of each built market for the shadow short stream (M21 R1; VAL-121, D-1228, AT-67). A market fact,
// so it lives here and nowhere else. Every value is an assumption marked [VERIFY] (`verify: 1`): the stream is shadow only
// (no book, no order, no e-mail), so no money depends on it. `shortableTiers` stands in for "borrow is available" (the
// universe tier of the name); `borrowBpsPa` is the borrow fee in basis points a year on the entry value.
// AU: ASX has no naked short selling; borrow is through securities lending (SLB). IN and US rows are recorded for later
// and unused while those markets are off in production.
export const SHORT_RULES = Object.freeze({
  AU: Object.freeze({
    naked: false,
    borrow: "slb",
    shortableTiers: Object.freeze(["U1"]),
    borrowBpsPa: 300,
    verify: 1,
  }),
  IN: Object.freeze({
    naked: false,
    borrow: "slb",
    shortableTiers: Object.freeze(["U1"]),
    borrowBpsPa: 300,
    verify: 1,
  }),
  US: Object.freeze({
    naked: false,
    borrow: "locate",
    shortableTiers: Object.freeze(["U1", "U2"]),
    borrowBpsPa: 300,
    verify: 1,
  }),
});

/** The short-sale rules of a built market. Throws for a market with no row (it is never guessed). */
export function shortRulesOf(market) {
  if (!Object.prototype.hasOwnProperty.call(SHORT_RULES, market)) {
    throw new RangeError(`no short-sale rules for market ${String(market)}`);
  }
  return SHORT_RULES[market];
}

/** True when the market has a short-sale rule row. */
export function hasShortRules(market) {
  return Object.prototype.hasOwnProperty.call(SHORT_RULES, market);
}
