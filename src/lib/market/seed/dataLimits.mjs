// The data limits a report must state per market (M20 A5; CXA-012, CXA-013, D-1115, D-1132). Plain data keyed by
// market code: `survivorship` is the caveat attached to every report of that market (`reportCaveats`,
// src/lib/cortex/survivorship.ts); `until_own_snapshots` says it lapses once the market's own snapshots satisfy
// ARN-082; `matched_controls` is how the control group reads (US: "unmatched", the free price history has no
// delisted codes to match). `matched_from` (AU) says matched controls exist only from the market's first own universe
// snapshot. `director_trades` and `fundamentals` record a BLOCKED-DATA limit with its reason (AU, M23 R4, D-1741,
// D-1743). The AU record is read by research reports (CXA-012, CXA-013); no AU figure of the live product changes.
export const DATA_LIMITS = Object.freeze({
  AU: Object.freeze({
    survivorship: Object.freeze({
      id: "survivorship_au",
      ref: "CXA-012",
      text: "Survivorship: the offline ASX history holds only the codes listed today, so codes delisted earlier are missing and measured returns are biased upward. The delisting loss is assumed (survivorship_loss_assumed_pct), not measured; read every figure with the haircut, and industry before the first own snapshot as static industry.",
      until_own_snapshots: true,
      matched_controls: "unmatched",
      matched_from: "first_own_universe_snapshot",
    }),
    director_trades: Object.freeze({
      status: "BLOCKED-DATA",
      ref: "CXA-012; ASX Appendix 3Y",
      text: "The Appendix 3Y notice carries no trade type (purchase, sale, grant, exercise), so a purchase-only director signal cannot be built for the ASX. The split is blocked for AU only; Form 4 (US) and the NSE disclosures (IN) carry it.",
    }),
    fundamentals: Object.freeze({
      status: "BLOCKED-DATA",
      ref: "CXA-013; FAM-102",
      variant: "F2-no-fundamentals",
      text: "No free point-in-time fundamentals source for the ASX passes the source check, so the fundamentals conditions of F2 stay blocked and F2 runs as the F2-no-fundamentals variant.",
      source_check: Object.freeze({
        rule: "DAT-101",
        checked_on: "2026-11-17",
        result: "FAIL",
        basis:
          "Desk check of the source register and the data on hand; no new fetch. Free candidates give today's figures or scanned filings, never the value as first filed.",
      }),
    }),
  }),
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
