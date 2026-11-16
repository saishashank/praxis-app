# M20 exit evidence: India and the US, built and off in production (V3)

Design: `docs/M20_design.md`. Requirements: `docs/M20_requirements.md`. The section headings below are the exit checklist of the design (section "Exit checklist"). This file was completed on the integration branch `v3/m20-int` (D-1159). **"pending CI"** marks the only values that need a CI run on the final PR head or the production deploy; nothing else is open in this file. IN and US are built and **off in production** (PRD-040): nothing in the build switches either on.

## §0 Gate

The CI run that proved M19 green on `build` before the first M20 merge (D-1126): run **43205552193** on commit `6f4d2a6d`.

## §1 Extract

Fill runs 2026-11-12 (the IN and US pulls) and 2026-11-13 (the A3 verification pass), on the build machine; the outputs sit in `D:\Projects\Praxis\data\history\{in,us}\` and are never committed. The coverage reports are `docs/history-coverage-IN.md` and `docs/history-coverage-US.md` (counts and dates only).

| Source | IN | US |
| --- | --- | --- |
| Price source | the NSE bhavcopy archive (primary; Yahoo `.NS` files not used) | **none**: Yahoo, Stooq and the Nasdaq API disallow automated clients in robots.txt and the polite client never bypasses it (D-1132) |
| Codes with bars | 4,524 (3,427 with at least 250 bars; 943 stale; 1,323 with a gap) | 0 |
| Sessions | 1,975 sessions in the NSEI calendar, 2018-11-12 to 2026-11-12; archive files 1,975, 114 weekday dates with no file | "not pulled" (no index file) |
| Delisted share per year (IN) | 2018 0.4 %, 2019 4.2 %, 2020 4.0 %, 2021 5.1 %, 2022 4.3 %, 2023 6.3 %, 2024 4.6 %, 2025 4.6 %, 2026 3.3 % | not reported: the symbol directories list today's issues only, so every US history carries the upward survivorship caveat |
| Universe | not capped in the extract | 5,622 candidates from the symbol directories; capped universe (60-session median traded value, max 2,500): **0**, honestly, for want of a price (D-1187) |
| Other files | classification, bands, ASM and GSM files as the A1 report lists | FINRA daily short-sale files 2,010, FINRA short-interest files 186, Nasdaq halt snapshots 1; EDGAR submissions, company facts and index quarters 0 (no contact, D-1094) |

"Not pulled" lines and their reasons: the NIFTY 50 and India VIX series (Yahoo only, disallowed: D-1173, the clause is proven on the readers and the "unmeasured" behaviour); every US price, index and EDGAR file (D-1132, D-1094); FRED (no key, D-1094); the RBI and MOSPI macro tables (JavaScript shells with no data table in the served HTML, D-1143). The US calibration is "not run: no price history" (`docs/cortex/calibration-US.md`); the IN calibration was not run (`docs/cortex/calibration-IN.md`, D-1179).

`buckets.json` (IN, A4, D-1104, D-1151): the slippage ADV edges are 791.7M / 271.5M / 122M / 66.5M and the tier edges 189.2M / 88.7M / 48.1M, rounded to Rs 100,000, read off the IN extract by `buckets.mjs` with the AU percentile positions (the AU extract's percentiles are the definition; the IN edges are the same percentiles of the IN extract). The US edges could not be read (no price); they are AU's at A$1 = US$0.65 rounded half-up to US$10,000 (3,250,000 / 650,000 / 160,000 / 70,000 and 650,000 / 160,000 / 70,000), pending a price source (D-1151, D-1132).

## §2 Tasks

Merge commits are the `git log --merges --oneline 3e5ab096~5..HEAD` of the integration branch, oldest first.

| Task | Merge commit | Test files |
| --- | --- | --- |
| A2 follow-ups, migration 0036, Worker zones, batch-1 dispatcher | `16270885` (Merge M20 A2) | `tests/db/0036_m20_markets_data.test.ts`, `worker/test/{localtime,slotZones,killSlot}.test.ts` |
| A1 extract tooling and coverage reports | not in this repository (data repo `Requirement/v3/tools/m20/**`, branch `v3/requirements`); reports `docs/history-coverage-{IN,US}.md` | `Requirement/v3/tools/m20/**` (data repo, `node --test`) |
| A3 source rows, hosts, report, calendars | `e6a8b212` (Merge v3/m20-a3, Fable accepted with fixes) | `tests/data/{sourceRegister.m20,calendarRules.in,calendarRules.us,calendarEnable}.test.ts`, `tests/http/sourceHosts.test.ts` |
| A5 Cortex rule sets, as-filed reader, data limits, labels | `c80e8f32` (Merge v3/m20-a5, Fable accepted with fixes) | `tests/markets/{in,us}/{categoryMap,bands,luld,asFiled}.test.ts`, `tests/labels/*.test.ts` |
| A4 money engines per market | `3ac29dd5` (Merge v3/m20-a4, Fable accepted with fixes; `af035fe8` merged build into it) | `tests/markets/{in,us}/costs.test.ts`, `tests/arena/{slippage.markets,settlement.t1,seed.fx,profileParams}.test.ts` |
| S1 switch-on, rollback, projection, UI, e-mail, CI job | `bb179553` (Merge v3/m20-s1, Fable accepted with fixes) | `tests/market/checklist.test.ts`, `tests/data/controls.switch.test.ts`, `tests/data/calendarEnabledMarkets.test.ts`, `tests/arena/closeBooks.kill.test.ts`, `tests/usage/projection.test.ts`, `tests/usage/projectionSection.test.tsx`, `tests/settings/marketSwitch.test.tsx`, `tests/email/perMarket.test.ts`, `scripts/arena/arena-close.workflow.test.mjs`, `scripts/ci/ci.workflow.test.mjs`, `scripts/ci/e2e-listing.test.mjs`, `scripts/e2e-day/recorded-day.test.mjs` |
| US1 EDGAR, FINRA, halts, batch 1, fixtures, AT-M, calibration | `4347de40` (Merge v3/m20-us1, Fable accepted with fixes) | `tests/markets/us/*.test.ts`, `tests/acceptance/v3/at70NoRequest.test.ts` |
| IN1 fetchers, batch 1, fixtures, AT-M, calibration | `9b7ece89` (Merge v3/m20-in1, Fable accepted with fixes; `29b030de` and `c09c74b3` merged build into it) | `tests/markets/in/*.test.ts`, `tests/market/isolation.test.ts` |
| Integration (this branch) | `ec765633` (Merge origin/build: the two market-off e2e fixes, D-1196) | `tests/db/0037_m20_macro_sources.test.ts` and the macro and switch tests of D-1147 and D-1148, `scripts/market/at-m-report.test.mjs` (D-1149) |

## §3 Identity and Fable review notes

AT-32 and AT-50 hashes equal the step-0 baseline (`tests/acceptance/v3/replay-hash.baseline.json`, not rewritten; `schemaSha` of the AU night unchanged, D-1116); the AU constants snapshot (`tests/market/au-constants.snapshot.json`) and the Worker slot snapshot (`worker/test/fixtures/au-slots.snapshot.json`) are unchanged: `git diff 3e5ab096 --stat` over the three files is empty (integration gate, below). The AU-only e-mail output is byte-identical (the M19 snapshots in `tests/email/templates.test.ts`; `tests/email/perMarket.test.ts`).

Fable's review notes per **F** task (each task was accepted with fixes; the decisions carry the fixes):

- **A2** (migration 0036, Worker): the Worker reads `market.rollback_at` and `deploy-production.yml` deploys the Worker before the migration, so cold ticks fail with `statement-error` until 0036 has run (D-1129, Owner step 6 below); the kill slot needs no `slots_enabled` listing because the Owner's click is the authorisation (D-1130); IN and US slippage buckets are `null` after A2 and come from A4 (D-1131); the kill input is `market_off`, not `"1"`.
- **A1** (`buckets.mjs`): edges are percentiles of the AU extract's ADV located on each market's extract and rounded to Rs 100,000 / US$10,000; the US could not be read for want of a price (D-1104, D-1151).
- **A3** (sources, calendars): statuses follow D-1096; a disabled source gets neither a probe nor a terms-page request (D-1125); results of the verification pass are D-1143.
- **A4** (money): the `components` rule kind rounds the exact total once (IN, `total_half_up_cent`) or per item (US, `per_item_half_up_cent`) in exact rationals (D-1153); the US fee constants were superseded by the FY2026 SEC advisory and the 2026 TAF schedule, still `verified: false` (D-1150); the settlement lag is passed, not defaulted, at every site (D-1113, D-1154); `seedForMarket` refuses a zero seed (D-1155).
- **A5** (rule sets): the halt model adapter leaves the M15 machine and the AU hashes unchanged (D-1162); an entry on a band-locked session is cancelled `band_locked` and an exit waits like a halt (D-1163); locks are symmetric, the conservative rule (D-1169).
- **IN1** (night): the shared A4 carry-over is closed in one module `marketMoney.ts`, AU passing the very constants it always used (D-1170); the ARN-119 first posting reads the FX close stored by the switch (D-1157); a band lock has no clock, an exit stuck at a lower circuit waits indefinitely (D-1158, Owner list).
- **US1** (night): US-P1 is selected by date, four versions, the selector is `effective_from` (D-1181); a Form 4 with any unreadable transaction writes no notice and an amendment without both percents is skipped (D-1184); the capped universe is empty with no price source (D-1187); the recorded US days are synthetic (D-1188).
- **S1** (kill, projection): the kill cancels every pending order and sells every open position at the open with the profile's own cost model, only on an enabled, off market with `rollback_at` (D-1194); the projection rounds up in BigInt and a figure exactly on the line fits (D-1195).

## §4 Profile

`profile_version = 2` for IN and US (the seeds in `src/lib/market/seed/{IN,US}.mjs` and `seed/{in,us}/*`). Completeness per `staticProfile(code)` and `completeness()`: **IN incomplete, US incomplete**, no missing field and 35 named unverified fields each (the lists are printed in `docs/test-reports/AT-M-IN.md` and `AT-M-US.md`; every field keeps `verify = 1` with its evidence reference where one was read, DAT-242). The switch-on item `profile_complete` therefore stays open for both markets; it is the Owner's step to decide the pending sources and verify the fields before a switch (the checklist names each). `verified_at` and `evidence_ref` are set on the values A3 confirmed against a public page (IN-P1 and the IN tick table D-1144; US-P1 D-1150), not on the rest.

## §5 Sources

Register rows (seed, written on enable by `switchMarket` through `ensureMarketSources`, D-1128, D-1193; read by the checklist item `licence_rows`, D-1191):

| Market | enabled | pending | disabled | Pending ids |
| --- | --- | --- | --- | --- |
| IN (16) | 4 | 10 | 2 (`in_nse_announcements`, `in_bse_announcements`) | `in_yahoo_ns`, `in_nse_bhavcopy`, `in_nse_classification`, `in_nse_fo_oi`, `in_nse_slb`, `in_sebi_pit_sast`, `in_nse_bands`, `in_nse_asm_gsm`, `in_nse_board_meetings`, `in_nse_bse_xbrl` |
| US (9) | 4 | 5 | 0 | `us_yahoo`, `us_stooq`, `us_finra_short`, `us_nasdaq_halts`, `us_fred` |

Source-report summaries (build machine, 2026-11-16, `scripts/market/source-report.mjs`, through the polite client): **IN 16 sources, 7 probed ok, 3 skipped, 6 refused**; **US 9 sources, 3 probed ok, 4 skipped, 2 refused**. The US EDGAR rows report `contact_missing` (no contact set on the build machine, D-1094): expected. Refused rows are robots.txt disallows or disabled sources (no request, D-1125). Hosts added: tagged by market and register id in `SOURCE_SITES` (D-1095; link allow-listing unchanged). Variable names, no value: `PRAXIS_EDGAR_CONTACT`, `FRED_API_KEY` (`scripts/ci/env-names.mjs`, `.env.example`).

## §6 Off in production

| Item | Evidence |
| --- | --- |
| AT-68 reports unchanged | [test-reports/AT-68.md](test-reports/AT-68.md); the three proofs (`tests/acceptance/v3/at68.test.ts`, `worker/test/at68Worker.test.ts`, `e2e/market-off.spec.ts`) are green; `e2e/market-off.spec.ts` is unchanged by M20 (D-1196: the helper `withoutMarketsTable` cuts the two Owner market surfaces) |
| The switch cannot succeed in production | the production seed is refused `checklist_open` for IN and US (`tests/data/controls.switch.test.ts`); no code path sets `markets_enabled`, `market.enabled` or `PRAXIS_MARKETS_ENABLED` outside `switchMarket` and the scratch databases of the dev job |
| The dev variable does not leak | `PRAXIS_MARKETS_ENABLED` is on one step of the job `recorded-day-dev` and in no other `ci.yml` job, package script or Playwright config (`scripts/ci/e2e-listing.test.mjs`) |
| The 0036 trigger count | **29** `CREATE TRIGGER` statements in `0036_m20_markets_data.sql` (18 market guards, `_market_guard_ins` and `_market_guard_upd` on each of 9 tables, plus 11 append-only, no-delete and resume-only triggers); `node scripts/db/gen-market-guard.mjs --check` passes. Migration 0037 (D-1147) adds **2** triggers: the source guards on `macro_series`, which refuse an `rbi`, `mospi` or `fred` row for a market that is not enabled (`MarketNotEnabled macro_series`), also for `INSERT OR IGNORE` and the upsert form; the rba and abs rows (the home market) are never refused |
| `recorded-day` production-shape and network-assertion outputs | CI run **43347157615** on commit `6c556e7a` was green on every job, including `recorded-day` (production shape, network assertion last) and e2e; the final PR head re-runs it: pending CI |
| `recorded-day-dev` outputs for IN and US | the same run 43347157615 on `6c556e7a`: `recorded-day-dev` green for IN and for US (five days each, tiers 3, green 1, marker 1 per day). Local run on the integration branch (2026-11-16): `PRAXIS_MARKETS_ENABLED=AU,<M> node scripts/e2e-day/recorded-day.mjs run --fixtures D:/Projects/Praxis/praxis-app-fixtures --market <M> --mode data_only`: IN exit 0 (sessions 2026-11-05, -06, -09, -11, -12, bars 15 each), US exit 0 (sessions 2026-11-02 to -06, bars 4 each, synthetic data). Final PR head: pending CI |
| The production read-only check `SELECT code, enabled, mode FROM market` after the deploy | pending CI (the deploy): expected AU `1 full`, IN `0 off`, US `0 off`, from the maintenance route's run record |

## §7 Acceptance

| AT | Report | Result |
| --- | --- | --- |
| AT-69 (IN) | [test-reports/AT-69.md](test-reports/AT-69.md) | proven offline on the IN fixtures and five real bhavcopy sessions; the Results block carries the gate counts |
| AT-70 (US) | [test-reports/AT-70.md](test-reports/AT-70.md) | proven offline on hand-made and synthetic fixtures; 0 EDGAR or FINRA requests in the production shape; no real US datum exists (D-1132) |
| **AT-71** switch-on and rollback | [test-reports/AT-71.md](test-reports/AT-71.md) | code and unit proofs green; the Owner performs the switch after the merge |
| AT-38 | [test-reports/AT-38.md](test-reports/AT-38.md) | proven on the DAT-226 fixture pair (`tests/markets/us/asFiled.test.ts`, `at70NoRequest`) |
| AT-75 (IN and US) | [test-reports/AT-75.md](test-reports/AT-75.md) | the IN and US fixture nights (`tests/markets/{in,us}/fixtureNight.test.ts`) and `tests/labels/*` |
| AT-M-IN | [test-reports/AT-M-IN.md](test-reports/AT-M-IN.md) | generated 2026-11-16 by `scripts/market/at-m-report.mjs`: **all five rows pass** (M1 16 sources reported; M2 24 tests in 2 files; M3 11 tests; M4 five of five recorded days green and the rolling-start replay over 5 sessions; M5 2 tests). The profile stays incomplete, so the `at_m_evidence` stamp is the Owner's step on a development database, never written by the build |
| AT-M-US | [test-reports/AT-M-US.md](test-reports/AT-M-US.md) | generated 2026-11-16: **M1, M2, M3, M5 pass, M4 NOT YET**. The recorded days are **SYNTHETIC** (D-1188, D-1149); the report says so and claims no real-data evidence; the rolling-start replay is not run (no US price history, D-1132) |
| AT-68 | [test-reports/AT-68.md](test-reports/AT-68.md) | appended by S1 |
| AT-85 | [test-reports/AT-85.md](test-reports/AT-85.md) | the M20 line appended by S1; `docs/test-map.md` and its baseline regenerated (1,102 ids) |
| AT-32 / AT-50 | existing reports | unchanged |

## §8 Constraints

| Constraint | Evidence |
| --- | --- |
| Turso at or under 20 % of the free plan | the projection for AU, IN and US (`/usage#projection`, `src/lib/usage/projection.ts`, hand-computed edges in `tests/usage/projection.test.ts`); no production row is written for IN or US while they are off; the measured Usage figure on the production deploy: pending CI (Owner, read-only) |
| Zero `OFFSET` | `tests/security/noOffsetPaging.test.ts` at zero exceptions; every new statement is a key probe or a bounded key-range read with a `rows-ok:` comment (the 0037 copy is a one-off migration) |
| No staging path, `ASX_LIVE` off, $0, no secret | no staging workflow touched; `worker/src/asx/*` not edited; no new provider; names only in `scripts/ci/env-names.mjs`; gitleaks on the remote run: pending CI (run 43347157615 on `6c556e7a` was green on every job) |
| Decision index, config reference, architecture regenerated | `node scripts/ci/decision-index.mjs` (739 decisions in `docs/V2_decisions.md`), `node scripts/ci/config-reference.mjs --check`, `node scripts/architecture/generate.mjs` (529 elements, 629 edges), all re-run on the exit tree with D-1149 and D-1159 |
| Schema-count tests at 37, `history` paths absent | the schema count is 37 since 0037 (D-1147); no committed data and no `history` path in the tree (`test:hygiene`) |
| Market literals at 0 | `npm run test:market-literals`: 0 |
| AU identity | `git diff 3e5ab096 --stat` over the three AU identity files: empty |

## §9 Owner steps for the PR

1. The section 20.6 steps: the Owner performs the switch after the merge (Settings > Region & markets > Switch on a market); nothing in the build does (owner guide, "Switching on India or the US, and rolling back").
2. **D-1094**: set `PRAXIS_EDGAR_CONTACT` and `FRED_API_KEY` in the Owner store (GitHub, Vercel, Cloudflare stores; never a file) before switching the US on.
3. **D-1096 and D-1191**: decide each `pending` source of a market, accept or disable, as a status change in `src/lib/market/seed/{in,us}/sources.mjs`, including `in_nse_bhavcopy` (the IN price source, "off until checked", DAT-121); without it the checklist step cannot be complete (IN 10 pending, US 5 pending).
4. **D-1129**: deploy order of migrations 0036 and 0037: approve the production deploy, then expect at most one tick window of `statement-error` incidents, or run the migrations first; `deploy-production.yml` is not edited.
5. **D-1132**: there is no robots-permitted free US price source (Yahoo, Stooq and the Nasdaq API disallow automated clients). Recommendation: a free keyed daily-bar API (the Owner takes the key and the terms) or a paid vendor; the US stays off, the checklist item `at_m_evidence` cannot pass for the US, and the US calibration is not run until a price file exists (the seam takes the `[{ code, date, open, high, low, close, volume, source }]` input file, D-1188).
6. **D-1100 and D-994**: set `PRAXIS_MARKETS_ENABLED` by hand after a switch (the nightly `markets_enabled_mismatch` alarm reminds).
7. **D-1105**: ten latency samples (production `data_only` nights) before `full`.
8. **D-1192**: the RBA F11 series ids `FXRINR` and `FXRUSD` are assumed; confirm them and store the rows in `macro_series` for the activation day (`full` is refused `fx_missing` without one).
9. **D-1184**: 13D/13G amendments are skipped and counted because no holder-percent store exists (a direction is never guessed); only a first filing writes `sh_new`.
10. **D-1158**: the band lock has no clock; an exit stuck at a lower circuit waits indefinitely at the locked mark. Recommended follow-up: a `band_lock_sessions` counter feeding the halt mark, with the by-side refinement of D-1169.
11. **D-1098, D-1106, D-1108** (spec findings) and the S1 findings **D-1191, D-1192, D-1194** (the open price when the market was off) and **D-1195** (the Worker and host budgets are assumed free-plan figures, re-checked in the monthly $0 check): listed in the PR description.
12. Push, from the Owner account: the fixtures repo `praxis-app-fixtures` (commit `5b62ba8`: the recorded IN days and the synthetic US days) and the data repo `praxis-app-data` (branch `v3/requirements`: the M20 extract tooling and the spec). The bot pushes only to `praxis-app`; the `recorded-day-dev` job reads the fixtures repo.

## §10 BUILD_SETUP section 9

"V3 current milestone" = M20 done; "V3 last step done / next step" = M20 exit / M21 requirements extract. Written by the orchestrator after the exit tree is green on the final PR head: pending CI.
