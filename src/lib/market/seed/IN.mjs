// The India (NSE) market profile seed (M19 A1; DAT-241, MKT-114, D-998, D-999, D-1001). Built, not complete:
// work status `built`, enabled 0, mode `off`. Every value is the spec 20.1 [VERIFY] figure provisional until
// M20 records its evidence: `verify = 1`, `verifiedAt` null, so `isComplete` is false by construction.
// M20 A4 filled the tick table, slippage buckets, tiers, sleeve cap and bar latency (all still [VERIFY]).
import { IN_SLIPPAGE, IN_TICK_TABLE, IN_TIERS } from "./in/tickTable.mjs";
import { IN_COST_PROFILE_CODES } from "./in/costProfiles.mjs";
const unverified = (value, evidenceRef = null) => ({
  value,
  verify: 1,
  verifiedAt: null,
  evidenceRef,
});

const PROPOSED = "D-947 [PROPOSED]";
const M20_A4 = "M20 A4 (D-1104, D-1118): [VERIFY], see seed/in/tickTable.mjs";

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
  costProfileCodes: IN_COST_PROFILE_CODES,
  fields: Object.freeze({
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
    tick_table: unverified(IN_TICK_TABLE, M20_A4),
    slippage_buckets: unverified(IN_SLIPPAGE, M20_A4),
    tiers: unverified(IN_TIERS, M20_A4),
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
    sleeve_reality_cap: unverified(
      {
        multiple: 1,
        basis: "SEBI cash-segment delivery (IN-P1 is a delivery formula; no MTF assumed)",
      },
      "D-1106: listed for the Owner",
    ),
    calendar_source: unverified("nse_holiday_list"),
    fx_source: unverified("rba_daily"),
    yahoo_suffix: unverified(".NS"),
    bar_latency_p95_min: unverified(
      { kind: "assumed", minutes: 60, basis: "batch b1 = close + 60", measured_nights: 0 },
      "D-1105: measured in production data_only",
    ),
    preopen_recheck_min: unverified(5),
    category_map: unverified({ kind: "headline_categories" }),
    universe_max: unverified(2000),
  }),
});
