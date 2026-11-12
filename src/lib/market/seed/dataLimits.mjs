// The data limits a report must state per market (M20 A5; CXA-012, CXA-013, D-1115, D-1132). Plain data keyed by
// market code: `survivorship` is the caveat attached to every report of that market (`reportCaveats`,
// src/lib/cortex/survivorship.ts); `until_own_snapshots` says it lapses once the market's own snapshots satisfy
// ARN-082; `matched_controls` is how the control group reads (US: "unmatched", the free price history has no
// delisted codes to match). A market with no entry (the home market) states nothing: its reports are unchanged.
export const DATA_LIMITS = Object.freeze({
  IN: Object.freeze({
    survivorship: Object.freeze({
      id: "measured_on_bhavcopy_archive",
      ref: "CXA-012",
      text: "Measured on the NSE bhavcopy archive: it lists the codes that traded on each day, so delistings are present, but its price history does not adjust for later corporate actions.",
      until_own_snapshots: false,
      matched_controls: "matched",
    }),
  }),
  US: Object.freeze({
    survivorship: Object.freeze({
      id: "survivorship_us",
      ref: "CXA-012; DAT-130/131",
      text: "Survivorship: the free US history holds only the codes listed today, so delisted codes are missing and measured returns are biased upward. Read every figure with the haircut for the assumed delisting loss.",
      until_own_snapshots: true,
      matched_controls: "unmatched",
    }),
  }),
});

/** The data limits of one market, or undefined (the home market has none). */
export function dataLimitsOf(code) {
  return Object.prototype.hasOwnProperty.call(DATA_LIMITS, code) ? DATA_LIMITS[code] : undefined;
}
