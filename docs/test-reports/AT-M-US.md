# AT-M-US: the five market acceptance tests for the United States (M20, development mode)

Reference: V3 spec ch. 20 §20.7 (AT-M1 to AT-M5), D-1120. This file is written by hand by task US1 because `scripts/market/at-m-report.mjs` (IN1) is not merged yet; the generated report replaces it at integration (`node scripts/market/at-m-report.mjs --market US`). It states what was proven offline in development mode and what could not be, by name. The US is **off in production** (PRD-040); nothing here switches it on.

## Home environment

Local run on the Windows build machine, migrated libSQL files, no network. The US data is the synthetic set of `scripts/ingest/us/synthetic.mjs` (fictional codes, `source: synthetic_fixture`, D-1188); the build has no US price source (D-1132) and no EDGAR contact (D-1094).

## The five rows

| Test | Evidence | Status |
| --- | --- | --- |
| **AT-M1** source report and `complete` | the A3 verification pass (build-machine run of `scripts/market/source-report.mjs`, D-1143): Yahoo and Stooq disallow automated clients (D-1132), the SEC hosts were not probed (no contact), FRED needs the Owner key; the profile's completeness under the seed names its unverified fields (`tests/market/completeness.test.ts`) | **open**: the profile is not `complete` (fields stay [VERIFY]; no price source) |
| **AT-M2** calendar rules, DST tests, review step | `calendarRules/us.mjs` year rows for 2026 and 2027, rows written only when the market is enabled (`tests/data/calendarRules.us.test.ts`, `calendarEnable.test.ts`, A3); `worker/test/localtime.test.ts` New York DST; the day module reads the rows (`tests/markets/us/day.test.ts`) | **proven offline** (A2, A3, US1) |
| **AT-M3** cost tests | US-P1 known answers and the dated schedule (`tests/markets/us/costs.test.ts`, `feeQuantity.test.ts`) | **proven offline** (A4, US1) |
| **AT-M4** five recorded `data_only` days with green verdicts, rolling-start replay | the five synthetic sessions run through the real batch-1 day, each `ok` with a `complete` marker and the quality hook (`tests/markets/us/day.test.ts`, "five sessions in a row"); the same sessions are in the fixtures repo `recorded/US/<date>/` for the `recorded-day-dev` job (S1) | **proven offline on synthetic data only**; the rolling-start replay needs price history: not run (D-1132) |
| **AT-M5** isolation hash and the `data_only` to `full` next-day opening | the isolation hash (`tests/market/isolation.test.ts`, IN1) and the first `full` day need the settlement lag and the tick grid threaded by IN1 (D-1154 item 1): the fixture-night guard test is an `it.todo` naming IN1 | **open**, waiting on IN1 |

## Not proven, by name

- A real US price, filing or fact: none was fetched (no price source, no contact). Every US number in the tests is made up.
- The US calibration: not run, no price history ([calibration-US.md](../cortex/calibration-US.md)).
- The switch-on checklist item `at_m_evidence` cannot pass for the US until a price source exists.

Nothing in this file claims a result that has not happened.
