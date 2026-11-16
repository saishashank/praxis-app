# AT-M-US: market acceptance in development mode

Generated 2026-11-16 by `scripts/market/at-m-report.mjs --market US` from the build's evidence files. Counts, test names and dates only.

Result: **not complete: M4**

**The recorded days of this market are SYNTHETIC** (fictional codes, source `synthetic_fixture`; no real price source exists, D-1132, D-1188). This report claims no real-data evidence: the rows show the pipeline runs end to end on generated data, nothing about real prices, filings or facts.

Evidence folder: `evUS` (the build machine path is not recorded)

- `recorded-days-US.json` sha256 4fd14f99c1b1
- `source-report-US.json` sha256 7e822ab182ce
- `vitest-root.json` sha256 ed7d111c9c0e
- `vitest-worker.json` sha256 b6e1bc658d74

| Row | What | Result | Evidence |
|---|---|---|---|
| M1 | Source report and profile completeness | pass | 9 sources reported (the report's own date, UTC: 2026-11-15); profile incomplete, unverified fields named below |
| M2 | Calendar rules, DST and the recorded-day review step | pass | 2 files, 24 tests passed; review step taken |
| M3 | Cost formula known answers | pass | 1 files, 7 tests passed |
| M4 | Five recorded data_only days and the rolling-start replay | NOT YET | SYNTHETIC data only, no real-data evidence: 5 of 5 days green; replay not_run over 0 sessions; labels computed or not reachable with a reason |
| M5 | Market isolation | pass | 1 files, 2 tests passed |

Unverified profile fields (named, PRD-039):

- announcement_hours
- bar_latency_p95_min
- batch_schedule
- benchmark_index
- category_map
- classification_scheme
- control_instrument
- cost_formula
- currency
- decision_cutoff
- dividend_imputation
- exchange
- forward_results_dates
- fundamentals_source
- fx_source
- halt_model
- index_change_source
- insider_notice_kind
- known_time_rules
- macro_series
- parcel_floor
- preopen_recheck_min
- regime_index
- review_date_rule
- seed_amount
- settlement_days
- short_data_kind
- sleeve_reality_cap
- slippage_buckets
- tick_table
- tiers
- tz
- universe_max
- volatility_index
- yahoo_suffix

## M1 detail

- us_yahoo: pending; terms ok; probe refused
- us_stooq: pending; terms refused; probe refused
- us_edgar: enabled; terms skipped; probe skipped
- us_finra_short: pending; terms ok; probe ok
- us_nasdaq_halts: pending; terms ok; probe ok
- us_sec_suspensions: enabled; terms skipped; probe skipped
- us_sp_dji_russell_manual: enabled; terms none; probe skipped
- us_fred: pending; terms ok; probe skipped
- us_nyse_holidays: enabled; terms ok; probe ok

## M4 detail

- 2026-11-02: ok, complete, quality green 1, marker 1 (recorded-day.mjs run, US, data_only)
- 2026-11-03: ok, complete, quality green 1, marker 1 (recorded-day.mjs run, US, data_only)
- 2026-11-04: ok, complete, quality green 1, marker 1 (recorded-day.mjs run, US, data_only)
- 2026-11-05: ok, complete, quality green 1, marker 1 (recorded-day.mjs run, US, data_only)
- 2026-11-06: ok, complete, quality green 1, marker 1 (recorded-day.mjs run, US, data_only)
- label all: not_reachable (no US price history exists, D-1132)
