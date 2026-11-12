// The India (NSE) market profile seed (M19 A1; DAT-241, MKT-114, D-998, D-999, D-1001). Built, not complete:
// work status `built`, enabled 0, mode `off`. Every value is the spec 20.1 [VERIFY] figure provisional until
// M20 records its evidence: `verify = 1`, `verifiedAt` null, so `isComplete` is false by construction.
// `null` = "set at M20" (tiers, slippage buckets, sleeve reality cap, bar latency). Nothing in M19 reads an
// IN value on any production path (MKT-110).
const unverified = (value, evidenceRef = null) => ({
  value,
  verify: 1,
  verifiedAt: null,
  evidenceRef,
});
// M20 A3 (DAT-241/242, D-1104 to D-1107): a field whose value a public source states is marked verified with the
// date and the source; every other field stays [VERIFY] (verify 1) until its evidence is recorded.
const VERIFIED_AT = "2026-11-13";
const EVIDENCE = {
  exchange: "NSE market timings page: the National Stock Exchange of India equity segment",
  session_open: "NSE market timings page: normal market opens 09:15 IST",
  session_close: "NSE market timings page: normal market closes 15:30 IST",
  opening_auction_window:
    "NSE pre-open session page: order entry 09:00 to 09:08, call auction ends before 09:15",
  calendar_source:
    "NSE public holiday list read in the A3 verification pass (source report row in_nse_holidays)",
};
function markVerified(fields, evidence) {
  const out = { ...fields };
  for (const [name, ref] of Object.entries(evidence)) {
    out[name] = { value: out[name].value, verify: 0, verifiedAt: VERIFIED_AT, evidenceRef: ref };
  }
  return out;
}
const PROPOSED = "D-947 [PROPOSED]";

export default Object.freeze({
  code: "IN",
  name: "India (NSE)",
  workStatus: "built",
  enabled: 0,
  mode: "off",
  profileVersion: 2,
  statusChangedAt: "2026-11-12",
  builtAt: "2026-11-12",
  evidenceRecordedAt: null,
  updatedAt: "2026-11-12T00:00:00.000Z",
  costProfileCodes: Object.freeze(["IN-P1"]),
  fields: Object.freeze(
    markVerified(
      {
        exchange: unverified("NSE"),
        tz: unverified("Asia/Kolkata"),
        session_open: unverified("09:15"),
        session_close: unverified("15:30"),
        closing_auction: unverified({ kind: "none" }),
        opening_auction_window: unverified({
          kind: "single",
          at: "09:15",
          call_auction: { from: "09:00", to: "09:08" },
        }),
        announcement_hours: unverified({
          kind: "continuous",
          note: "NSE/BSE filings 24 h, bulk after close",
        }),
        decision_cutoff: unverified({ time: "17:30", zone: "Asia/Kolkata" }),
        known_time_rules: unverified({
          filings: "publication_time",
          bars: "close_plus_latency",
          index_global: { local: "09:00", zone: "Australia/Melbourne", lag_days: 1 },
        }),
        batch_schedule: unverified(
          { kind: "after_close", b1: 60, b2a: 80, b2b: 100, late_2a_after: 130 },
          "spec 20.1 close + 60 / + 100 / + 130 min; b2a = b1 + 20 [PROPOSED] as in AU",
        ),
        review_date_rule: unverified({
          kind: "latest_session_with_marker",
          by: "au_review_time",
          offset_days: -1,
        }),
        currency: unverified("INR"),
        seed_amount: unverified({
          kind: "fx_rounded",
          from_amount: 600,
          from_currency: "AUD",
          fx_source: "rba_daily",
          round_to: 1000,
        }),
        parcel_floor: unverified(25_000_000_000n, PROPOSED),
        settlement_days: unverified(1),
        tick_table: unverified([{ fromMicro: 0n, tickMicro: 50_000n }]),
        slippage_buckets: unverified(null),
        tiers: unverified(null),
        cost_formula: unverified("IN-P1"),
        benchmark_index: unverified({ code: "NSEI", yahoo: "^NSEI", name: "Nifty 50" }),
        regime_index: unverified({ code: "NSEI", yahoo: "^NSEI", name: "Nifty 50" }),
        volatility_index: unverified({ code: "INDIAVIX", yahoo: "^INDIAVIX", name: "India VIX" }),
        control_instrument: unverified({ kind: "broad_index_etf", index: "NSEI" }),
        classification_scheme: unverified("nse_level2"),
        short_data_kind: unverified("fo_open_interest_slb_proxy"),
        insider_notice_kind: unverified("sebi_pit_sast"),
        halt_model: unverified("in_bands"),
        index_change_source: unverified("nse_indices_rebalance_notices"),
        forward_results_dates: unverified({
          kind: "board_meeting_intimations",
          min_working_days_ahead: 2,
        }),
        fundamentals_source: unverified({ kind: "nse_bse_xbrl_or_yahoo_ns" }),
        macro_series: unverified(["RBI", "MOSPI", "NSEI", "INDIAVIX"]),
        dividend_imputation: unverified(false),
        sleeve_reality_cap: unverified(null),
        calendar_source: unverified("nse_holiday_list"),
        fx_source: unverified("rba_daily"),
        yahoo_suffix: unverified(".NS"),
        bar_latency_p95_min: unverified(null),
        preopen_recheck_min: unverified(5),
        category_map: unverified({ kind: "headline_categories" }),
        universe_max: unverified(2000),
      },
      EVIDENCE,
    ),
  ),
});
