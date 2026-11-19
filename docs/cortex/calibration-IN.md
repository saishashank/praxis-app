# India calibration (CXA-002 j): status, 2026-11-13

**Status: not run.** The India calibration is not feasible on the build machine at M20 for two recorded reasons. No family was calibrated, no number below is a result, and the profile keeps every India family in shadow (D-949).

## What the run is

CXA-002 (j) is the M15 research programme (WP1 to WP6) run per market on that market's DEVELOPMENT split only (D-1114): no validation or holdout read, no `holdout_look` row (the registry table exists for M23's UI and takes no M20 row), every family shadow, the survivorship haircut attached to the report (D-1115, `docs/cortex/data-limits-IN.md`). `tools/m20/calibrate/index.mjs --market IN --split development` is the entry point in the data repository.

## Why it was not run

1. **The calibration is a skeleton.** The CLI in the data repository fixes the contract and the refusal and nothing else: its own header says the real calibration (the M15 library modules generalised by `--market`, reading the profile seed for the cut-off, settlement, parcel floor, costs, tick table and calendar) "comes later, after the IN/US readers exist". Run on 2026-11-13 it prints `skeleton only, nothing computed yet` (exit 0) and refuses `--split holdout` (exit 2): the refusal works and is the part that matters for CXA-015. Generalising the M15 modules is a research task of its own (days, not a task of IN1), and it needs the India readers that this track has only just built.
2. **The extract has no index or volatility series (D-1132, D-1173).** Yahoo is refused by robots.txt, so the Nifty 50 and India VIX were "not pulled". The M15 programme's regime gate, relative-strength angles and the global risk gate (A-D5-08) read those series; on this extract they are unmeasured, so a family run would score every index-dependent angle as "not measured" and the calibration would not be comparable with the AU one. India's price history itself is complete for the purpose (the NSE bhavcopy archive: 1,975 sessions, 2018-11-12 to 2026-11-12, 4,524 codes; see `docs/history-coverage-IN.md`).

## What is ready when the two gaps close

- the price history, the band files from 2026-09-28 and the per-day ASM and GSM lists (a single snapshot, as of 2026-11-12) are in the extract, and the fixtures of the AT-M4 window were recorded from them (`praxis-app-fixtures/recorded/IN/`, five sessions 2026-11-05 to 2026-11-12);
- the money engines take the market's tick grid, settlement lag, parcel floor, cost profile and seed (D-1170), so a calibration replay over `replayCohorts({ market: "IN" })` is T+1, Rs 25,000-parcel and IN-P1-costed from the profile, not from the AU constants;
- the replay accepts a band-lock source (`bandLocked`, D-1175).

## Hand-off

Task for a later stream (M21 or a calibration task of its own): (a) a manual NSEI and INDIAVIX CSV (`in_nse_indices_manual`, enabled; `sources/in/index.mjs` parses it) or a robots-permitted index source; (b) the M15 modules generalised; (c) run `calibrate --market IN --split development`, replace this page with the figures, keep the survivorship caveat.
