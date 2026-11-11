// The AU market profile seed (M19 A1; DAT-241, D-992, CXA-001). The single definition of every AU market fact:
// each value is today's v1/V2 constant to the byte (tests/market/au-constants.snapshot.json, recorded before
// the refactor, is compared with this seed by tests/market/auConstants.test.ts). `verify = 0` everywhere:
// the [VERIFY] money constants were approved at the v1 go-live (D-710 sign-off), the rest is live AU behaviour.
// AU is `active`, enabled, and seeded `data_only` like the v1 market row; production's `full` mode is the
// stored `market.mode`, which a migration never changes.
import { AU_COST_PROFILE_CODES } from "./au/costProfiles.mjs";
import { AU_SLIPPAGE, AU_TICK_TABLE, AU_TIERS } from "./au/tickTable.mjs";

const LIVE = "AU live since go-live (v1)";
const MONEY = "D-710 go-live sign-off";
const ok = (value, evidenceRef = LIVE) => ({
  value,
  verify: 0,
  verifiedAt: null,
  evidenceRef,
});

export default Object.freeze({
  code: "AU",
  name: "Australia (ASX)",
  workStatus: "active",
  enabled: 1,
  mode: "data_only",
  profileVersion: 1,
  statusChangedAt: "2026-11-12",
  builtAt: null,
  evidenceRecordedAt: null,
  updatedAt: "2026-11-12T00:00:00.000Z",
  /** The cost-profile codes this market's `cost_formula` may name (resolved through seed/au/costProfiles.mjs). */
  costProfileCodes: AU_COST_PROFILE_CODES,
  fields: Object.freeze({
    exchange: ok("ASX"),
    tz: ok("Australia/Sydney"),
    session_open: ok("10:00"),
    session_close: ok("16:00"),
    closing_auction: ok({ kind: "auction", at: "16:10" }),
    opening_auction_window: ok({ kind: "staggered", from: "10:00", to: "10:09" }),
    announcement_hours: ok({ from: "07:00", to: "19:30", tz: "Australia/Sydney" }),
    decision_cutoff: ok({ time: "18:10", zone: "Australia/Melbourne" }),
    known_time_rules: ok({
      filings: "publication_time",
      bars: "at_cutoff",
      index_global: { local: "09:00", zone: "Australia/Melbourne", lag_days: 1 },
    }),
    batch_schedule: ok({
      kind: "fixed",
      zone: "Australia/Melbourne",
      b1: "17:30",
      b2a: "17:50",
      b2b: "18:10",
      late_2a_after: "18:40",
    }),
    review_date_rule: ok({ kind: "session_d" }),
    currency: ok("AUD"),
    seed_amount: ok({ kind: "fixed", amount: 600 }),
    parcel_floor: ok(500_000_000n, MONEY),
    settlement_days: ok(2, MONEY),
    tick_table: ok(AU_TICK_TABLE, MONEY),
    slippage_buckets: ok(AU_SLIPPAGE, MONEY),
    tiers: ok(AU_TIERS),
    cost_formula: ok("P5", MONEY),
    benchmark_index: ok({ code: "AXJO", yahoo: "^AXJO", name: "S&P/ASX 200" }),
    regime_index: ok({ code: "GSPC", yahoo: "^GSPC", name: "S&P 500" }),
    volatility_index: ok({ code: "VIX", yahoo: "^VIX", name: "VIX" }),
    control_instrument: ok({ kind: "broad_index_etf", index: "AXJO" }),
    classification_scheme: ok("gics_group"),
    short_data_kind: ok("asic_daily_short_positions"),
    insider_notice_kind: ok("appendix_3y_forms_603_605"),
    halt_model: ok("cx16"),
    index_change_source: ok("sp_asx_notices_manual_csv"),
    forward_results_dates: ok({ kind: "none" }),
    fundamentals_source: ok({ kind: "blocked", ref: "FAM-102" }),
    macro_series: ok(["RBA", "ABS", "GSPC", "VIX"]),
    dividend_imputation: ok(true),
    sleeve_reality_cap: ok({ multiple: 5, basis: "ASIC" }),
    calendar_source: ok("asx_published_holidays"),
    fx_source: ok("rba_daily"),
    yahoo_suffix: ok(".AX"),
    bar_latency_p95_min: ok(
      { kind: "at_cutoff" },
      "D-263 interim: a bar is known at the cut-off of its date",
    ),
    preopen_recheck_min: ok(5),
    category_map: ok({ kind: "none" }),
    universe_max: ok({ kind: "none" }),
  }),
});
