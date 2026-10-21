# M4 exit evidence (AT-14, AT-15, AT-16, AT-17)

Status date: 2026-10-19. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.4. Test files are listed in [test-map.md](test-map.md) (M4 rows). Requirements: [M4_requirements.md](M4_requirements.md). Design: [M4_design.md](M4_design.md).

Overall: agents A2 to A5, the six families, batch 2b and batch 3, Decision Cards and the replay engine with the VAL-102 statistics are built and pass their local tests. The engine checks of AT-17 are met on synthetic data. The staging run (TST-115), the real-data null runs and the evidence run (labels per family) are **pending**. M4 exit is **met locally, not yet on staging or on real data**.

## Commits

Range `9e3ab60^..HEAD` (30 commits). T17 (acceptance tests, test map, this page) is uncommitted.

| Commit | Task | Decision |
|---|---|---|
| 9e3ab60 | M4 requirements extract | |
| 3cc18d3 | M4 design | D-078 |
| 44dbe66 | T1 + T2 migration 0008, config keys | D-079 |
| aba3c58, ac6304d | T12 statistics library | D-080 |
| b8b3e28 | T5 indicators and candle patterns | D-081 |
| e3cca73 | T3 index bars and ASIC short positions in Batch 1 | D-082 |
| bb3d7ed | T6 DecisionView, regime, events, insider/flow | D-083 |
| c5372b7 | T10 LLM router core | D-084 |
| 2a5e29a, 58ea02f | hygiene allowance for the synthetic ASIC fixture; Yahoo index symbol fix | D-082..D-084 |
| 95955fd | T7 family rule interpreter | D-085 |
| 1808472, 66de28a | T4 price-history backfill and snapshot builder | D-086 |
| 37a471f | T8 batch 2b, stops, C2/C3 selection, `arena-signals` workflow | D-087 |
| 1753c22, a22d93c, 1216408 | T11 signal ledger, control library | D-088 |
| b602ce9 | T9 Decision Cards, thesis-breaker catalogue | D-089 |
| d14b60f, d9f2856 | T13 splits, trial ledger, VAL-110, labels, survivorship | D-090 |
| 4a8a2a1, bd15462 | T14 rolling-start replay, CIFs, scorecards | D-091 |
| c36141a | T16a TA-Lib reference and price-history workflows | D-092 |
| 0554f9d, 6af4678, 0f04797 | T15 batch 3, kill switch; replay matches the live engine | D-093 |
| 04aca9d | batch 2b honours `arena_control` | D-094 |
| 6d85619, 598daf6 | T16 replay workflow, null runs, compute report | D-095 |
| (uncommitted) | T17 acceptance tests, coverage matrix test, test map, this page | |

CI status: remote CI on `build` is green for the last pushed commit (598daf6, run 39175957368, 6 min 51 s). Remote CI for the T17 change has not run, because nothing is committed or pushed yet.

## Test counts

Full suite (`npx vitest run --testTimeout=60000`, about 8.5 minutes): **171 files, 3,164 tests: 3,162 passed, 2 skipped** (the skips are the real-fixture tests that run only in the `fixtures` CI job). T17 adds 2 files and 45 tests: `tests/agents/acceptanceM4.test.ts` (39 tests, about 12 s with its three database nights) and `tests/agents/coverageMatrix.test.ts` (6 tests, under 1 s).

## AT checklist

- **AT-14 Rules-only mode: met locally.** `tests/agents/acceptanceM4.test.ts` ("AT-14"): with every LLM off, nights 295 to 300 through batch 2a, 2b and 3 produce signals, entry orders, Decision Cards and review numbers (`replay_stat` rows); every router call is `rules-only`; a run with the LLM mock gives byte-identical signals, orders, stops, controls, cards and notes. In depth: `tests/llm/router.test.ts` ("AT-14: mock vs off identity"), `tests/agents/batch2bCards.test.ts`. The staging run (TST-115) is pending.
- **AT-15 Family rules: met locally.** `acceptanceM4.test.ts` ("AT-15"): for each of F1 to F6 a golden world gives exactly one entry and the time exit fires on its session only; the regime gate opens in the stated states and logs `regime_<state>` otherwise (F4 trades in all states, half size in SHOCK); F3 gap cancel; AGT-101 SHOCK at once and 3 sessions to leave; FAM-001 one leg on a database night. Depth: `tests/agents/families/*`, `regime.test.ts`, `batch2b.test.ts`. **Limit:** the indicator check compares with a hand-verified fixture only; the real TA-Lib reference fixture is not committed (see Open (b)).
- **AT-16 Decision Cards: met locally.** `acceptanceM4.test.ts` ("AT-16"): every entry order (also the rejected ones) has a card; every card has 3 to 5 thesis-breakers and a scenario table or "insufficient history" and passes the validator; n = 12 gives "insufficient history", n = 30 gives the 10th/50th/90th percentiles; the schema refuses a probability or a note field; the LLM mock changes no card byte. Depth: `cards.test.ts`, `batch2bCards.test.ts`. Card screens are M7.
- **AT-17 Replay engine, engine checks: met on synthetic data.** `acceptanceM4.test.ts` ("AT-17"): injected edge detected; 60-run size check inside the 99 % bounds with uniform p-values; fewer than 15 blocks gives "insufficient independent blocks"; B formula and MDE; DSR with one trial and PBO n/a below 5 variants; ledger one open row per code, re-entry block, one row per event, 20 controls per row; C2 exit mapping; CIFs and effective N; survivorship missing-share series and delisting sensitivity; a light replay with a compute report within budget. Depth: `tests/replay/nullRuns.test.ts` (200-run size check, injected-edge power, working level 0.000417 with B = 48,000), `tests/replay/runner.test.ts` (full, evidence, over-budget, CLI), `tests/stats/*`. **Not evidenced:** the >= 2,000 random-signal null runs on real ASX data, and the evidence run (a label with n and MDE for every family). Both wait for the DAT-125 backfill and the Owner approvals below (BLD-022).
- **TST-109 over batch 2b: met locally.** `acceptanceM4.test.ts` ("TST-109"): a database whose rows after D are poisoned (bars 1000x, index, a late announcement, a late short-interest point) gives byte-identical signals, orders, stops, controls, cards and notes for D; DecisionView refuses later dates and instants and does not return the late announcement. Also `batch2bLookAhead.test.ts`, `decisionView.test.ts`, `ledger.test.ts`.
- **TST-110 coverage matrix: met.** `tests/agents/coverageMatrix.test.ts`: every DAT-150 entity and every migration 0008 table is a matrix row, "stored, not used" or not market information. Note: DAT-150's indicative list has no benchmark index, event, regime or indicator entity; the 0008 tables for them map to matrix rows.

## Decisions

D-078 (design), D-079 (migration 0008, config keys), D-080 (statistics), D-081 (indicators, patterns), D-082 (Batch 1 index bars, ASIC), D-083 (DecisionView, regime, events, insider/flow), D-084 (LLM router), D-085 (families), D-086 (price history, snapshot), D-087 (batch 2b), D-088 (signal ledger), D-089 (Decision Cards), D-090 (validation), D-091 (rolling-start replay), D-092 (data workflows), D-093 (batch 3, kill switch), D-094 (2b honours `arena_control`), D-095 (replay pipeline). All are in [07_decision_log.md](07_decision_log.md).

## Open / pending

- (a) **Staging and real-data runs wait for the next review point (D-022).** The AT-14 to AT-17 staging run (TST-115) and the real-data null runs need a release. Migrations 0007 and 0008 are not applied anywhere yet.
- (b) **Owner approvals needed:**
  - the four new dispatch-only workflows `arena-signals.yml`, `replay.yml`, `talib-reference.yml` and `backfill-prices.yml`, and their Worker slots (all disabled);
  - O-26 Yahoo acceptance (index bars and price-history backfill);
  - the location of the real-data null runs (D-078 #31);
  - the token budget reading (daily or nightly, per market or total; ARN-068 against the ch.15 role budgets);
  - [VERIFY] `^AXJO` as the benchmark symbol;
  - the continuous-trading end time used for event day 0;
  - `c1_etf_code` (still a placeholder, M3);
  - the ARN-011 promotional keyword list;
  - committing the TA-Lib reference fixture after the Owner runs `talib-reference.yml` (only a hand-verified 6-bar fixture is committed).
- (c) **Proposed new config keys still missing** (today reviewed `threshold-ok` constants or arguments):
  - ARN-011 filter thresholds (D-079, D-085);
  - the F5 volume-exit rule numbers (D-085);
  - `code_reuse_gap_sessions`, 120 (D-090);
  - CIF horizons 63/126/252, the 90 % confidence and the progress NAV and sessions buckets (D-091);
  - `LINEAGES_FLOOR_MIN`, 6 (D-095);
  - `llm_injection_phrases` (D-079, D-084);
  - `dsr_default_sr_variance` (D-079).
- (d) **Known limits:**
  - deferral dates are weekday estimates without the holiday calendar (D-090);
  - replay has no group restart (D-093);
  - the replay snapshot has no events or dividends yet, so event coverage is reported absent and ASX/ASIC sources are off in replay (D-095);
  - the incremental `indicator_daily` state is not built, so batch 2b reads about 310 bars per code per night (D-087);
  - batch 3's live outcome uses the terminal liquidation NAV, to be reviewed (D-093 follow-up);
  - the real-data compute time is not measured (the report above is on synthetic data), and the CI minutes re-measure (TST-132) is not done.
- (e) **M2 follow-up still open:** the ASX by-date backfill.
