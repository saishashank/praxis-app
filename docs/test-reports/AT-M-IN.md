# AT-M-IN: market acceptance in development mode

Generated 2026-11-13 by `scripts/market/at-m-report.mjs --market IN` from the build's evidence files. Counts, test names and dates only.

Result: **all five rows pass**

| Row | What | Result | Evidence |
|---|---|---|---|
| M1 | Source report and profile completeness | pass | 16 sources reported (2026-11-12); profile incomplete, unverified fields named below |
| M2 | Calendar rules, DST and the recorded-day review step | pass | 2 files, 24 tests passed; review step taken |
| M3 | Cost formula known answers | pass | 1 files, 11 tests passed |
| M4 | Five recorded data_only days and the rolling-start replay | pass | 5 of 5 days green; replay completed over 5 sessions; labels computed or not reachable with a reason |
| M5 | Market isolation | pass | 1 files, 2 tests passed |

Unverified profile fields (named, PRD-039):

- announcement_hours
- bar_latency_p95_min
- batch_schedule
- benchmark_index
- category_map
- classification_scheme
- closing_auction
- control_instrument
- cost_formula
- currency
- decision_cutoff
- dividend_imputation
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

- in_yahoo_ns: pending; terms ok; probe refused
- in_nse_bhavcopy: pending; terms ok; probe ok
- in_nse_announcements: disabled; terms skipped; probe skipped
- in_bse_announcements: disabled; terms skipped; probe skipped
- in_nse_classification: pending; terms ok; probe ok
- in_nse_fo_oi: pending; terms ok; probe ok
- in_nse_slb: pending; terms ok; probe ok
- in_sebi_pit_sast: pending; terms ok; probe ok
- in_nse_bands: pending; terms ok; probe ok
- in_nse_asm_gsm: pending; terms ok; probe ok
- in_nse_indices_manual: enabled; terms none; probe skipped
- in_nse_board_meetings: pending; terms ok; probe ok
- in_nse_bse_xbrl: pending; terms ok; probe ok
- in_rbi: enabled; terms ok; probe ok
- in_mospi: enabled; terms ok; probe ok
- in_nse_holidays: enabled; terms ok; probe ok

## M4 detail

- 2026-11-05: ok, complete, quality flags 0
- 2026-11-06: ok, complete, quality flags 0
- 2026-11-09: ok, complete, quality flags 0
- 2026-11-11: ok, complete, quality flags 0
- 2026-11-12: ok, complete, quality flags 0
- label checkpoint 21: not_reachable (the window has 5 sessions, fewer than 21)
- label checkpoint 63: not_reachable (the window has 5 sessions, fewer than 63)
- label checkpoint 126: not_reachable (the window has 5 sessions, fewer than 126)
- label checkpoint 189: not_reachable (the window has 5 sessions, fewer than 189)
