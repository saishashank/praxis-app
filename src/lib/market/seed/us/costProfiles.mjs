// US cost profile US-P1: equities, zero commission, regulatory pass-through fees on sells (M20 A4; ARN-117, D-1103).
// Commission 0 (no item). Rates are decimal text; money amounts are US dollars as decimal text. The design's
// first figures (SEC 27.80 per million from 2025-05-14; TAF 0.000166 per share, cap 8.30) were stale: a search
// on 2026-11-13 found the SEC Fee Rate Advisory FY2026 (sec.gov/rules-regulations/fee-rate-advisories/2026-2,
// $20.60 per million for covered sales from 2026-04-04; $0.00 before) and the FINRA TAF at $0.000195 per share,
// min $0.01, max $9.79 from 2026-01-01 (finra.org Section 1 / SR-FINRA-2024-019 fee schedule; the rulebook page
// still showed the earlier rate). D-1150 records the replacement. The pages were read through a search summary,
// not the primary documents, so the profile stays `verified: false` until A3 records the evidence. FINRA filed
// SR-FINRA-2026-021 to pause the TAF for 2026-10-01..2026-12-31; its approval was not confirmed, so the TAF stays.
// Each item is an exact rational, then rounded half-up to the cent PER ITEM (the broker's practice), then summed.
const SPEC = "spec 20 ARN-117 / D-1103 / D-1150";

export const US_COST_PROFILES = Object.freeze({
  "US-P1": Object.freeze({
    code: "US-P1",
    version: 1,
    name: "US equities: zero commission, SEC Section 31 fee and FINRA TAF on sells",
    specRef: `${SPEC} [VERIFY]`,
    verify: true,
    verified: false,
    rule: Object.freeze({
      kind: "components",
      round: "per_item_half_up_cent",
      items: Object.freeze([
        Object.freeze({
          name: "sec31",
          side: "sell",
          basis: "value",
          rate: "0.00206%",
          effective_from: "2026-04-04",
          source_ref: `${SPEC}: SEC Section 31 fee USD 20.60 per million of sale value = 0.00206 %, FY2026 advisory, covered sales from 2026-04-04 (sec.gov/rules-regulations/fee-rate-advisories/2026-2) [VERIFY]`,
        }),
        Object.freeze({
          name: "finra_taf",
          side: "sell",
          basis: "per_share",
          rate: "0.000195",
          min: "0.01",
          max: "9.79",
          effective_from: "2026-01-01",
          source_ref: `${SPEC}: FINRA Trading Activity Fee USD 0.000195 per share sold, min USD 0.01, max USD 9.79 per trade, from 2026-01-01 (finra.org/rules-guidance/guidance/trading-activity-fee) [VERIFY]`,
        }),
      ]),
    }),
  }),
});

export const US_COST_PROFILE_CODES = Object.freeze(["US-P1"]);
