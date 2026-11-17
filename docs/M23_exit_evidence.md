# M23 exit evidence: Cortex research and monitors, time-boxed (V3)

Design: `docs/M23_design.md`. Requirements: `docs/M23_requirements.md`. The section headings below are the exit checklist of the design (section "Exit checklist"). This file was completed by task Z on the branch `v3/m23-z`: base `d991da0f` (`v3/m23` with all 16 tasks merged) plus Z's own commit. **"to be filled at push"** marks the only values that need a push and a CI run. **The Playwright spec `e2e/m23-cortex.spec.ts` was written against the seed state `cortex-research` and the page registries and was NOT run locally** (a Next production build fails inside `wt-*` worktrees); the CI `e2e` job is its only verification. The offline research (CXA-003, CXA-009) was run on the build machine against private history that is not in the repository: only aggregates, hashes and verdicts are committed. Times are Melbourne time. The test counts were observed on 2026-11-18, one folder at a time on a shared machine (`--maxWorkers=2`).

## §0 Gate

- **M22 is pushed.** The CI run that proved M22 green on `build` before the first M23 task (D-1600): run **44105012255** on commit `92032ebb`, all green.
- **Time-box (D-1601).** Day 1 was 2026-11-17 (A1 and the requirements and design commit). The calendar backstop of 21 days ends the box on **2026-12-08**; the plan used the three lanes inside it and every open item has its INCONCLUSIVE report. No cut from the cut list was taken (D-1644): every one of the 16 tasks was merged.
- **Ledger renumbering.** Two merges needed the orchestrator to renumber the append-only ledger `seq` (a position in the file, not part of a plan; no entry was edited otherwise, hashes and figures unchanged): **D-1689** (R2 and T2 both appended from the same base: T2 keeps seq 2 to 24, R2 follows as 25 to 39) and **D-1717** (R3 and M3: R3 keeps 40 and 41, M3's nine plan-only entries follow as 42 to 50). T4's six entries are seq 51 to 56.
- **Final CI run on the pushed head: to be filled at push.**

## §1 Tasks

Merge commits are `git log --merges --oneline 9986b15f..HEAD` of this branch, oldest first (T2 has no merge line of its own: its commits reached the integration branch under the R2 merge; the task commits are named). The decision ranges are the lines in `docs/M23_design.md`.

| Task | Commit or merge | Decisions | Test files (main ones) |
| --- | --- | --- | --- |
| R1 research engine and report writer **F** | `ba8d2892`, merge `b78db151` | D-1655 to D-1657 | `tests/research/{eventStudy,report,sectorIcStat}.test.ts`, `tests/acceptance/v3/at72Exits.test.ts`, `scripts/research/report.test.mjs` |
| A1 migration 0040, five keys, night seam **F** | `ce9051df`, merge `2de179a6` | D-1650 | `tests/db/0040_m23_research.test.ts`, `tests/config/m23Keys.test.ts`, `tests/acceptance/v3/at32Research.test.ts`, the schema-pin tests (39 to 40) |
| T1 CXA-008 paraphrase harness and agreement | `f31d1424`, merge `2a08eab7` | D-1660 to D-1664 | `tests/labels/{paraphrase,agreement}.test.ts`, `tests/acceptance/v3/at75Labels.test.ts` |
| A2 registry gate, writers on the gate, offline ledger, names **F** | `c013c73c`, merge `8f43aa90` | D-1665 to D-1669 | `tests/research/{registry,lookSync}.test.ts`, `tests/security/{holdoutWriters,researchBoundary}.test.ts`, `tests/acceptance/v3/at72Registry.test.ts`, `scripts/research/registry-check.test.mjs` |
| S1 sector index series **F** | `4ae2924b`, merge `4d788a1f` | D-1670 to D-1674 | `tests/research/sectorSeries.test.ts`, `tests/acceptance/v3/at75Series.test.ts` |
| M1 monitors 1 to 4 | `e2cf12b0`, merge `9beded69` | D-1675 to D-1679 | `tests/cortex/monitors/{promotion,permission,slope,twoBasis}.test.ts`, `tests/acceptance/v3/at74.test.ts` |
| R2 CXA-003 plan, runner and looks **F** | `e0778a9c` (plan), `ba08288a` (runner), `37c6e287` (looks), merge `d8c8145e` | D-1685 to D-1689 | `tests/research/cxa003.test.ts`, `scripts/research/run-lineage.test.mjs` |
| T2 CXA-004 trigger, session counter, one look per angle at 252 sessions | `4a765de7` (plan), `bd6fe2fc` (code) | D-1690 to D-1694 | `tests/research/annAngles.test.ts` |
| M2 monitors 5 to 8 | `1e4cf4e7`, merge `38a8ae3c` | D-1700 to D-1703 | `tests/cortex/monitors/{regimeSplit,lens,stall,fillExclusion}.test.ts`, `at74.test.ts` |
| R3 CXA-009 sector IC look (PASS) **F** | `596cec24` (plan), `e9263f2b` (runner), `f8730066` (look), merge `28965647` | D-1710 to D-1717 | `tests/research/sectorIc.test.ts` |
| R4 CXA-012 and CXA-013 records | `6d5ca8cc`, merge `bf8ef2c2` | D-1740 to D-1745 | `tests/cortex/survivorship.test.ts` |
| M3 meters and automatic evaluations **F** | `1e958b25` (plans), `7857f842`, `2a090b4a` (fix), merge `783b4f43` | D-1720 to D-1729 | `tests/research/meters/*.test.ts`, `tests/labels/labelEval.test.ts`, `tests/intraday/evaluator.test.ts` |
| T3 CXA-007 shadow proposals **F** | `d7da376d`, `17fe3a82`, merge `731d7ad1` | D-1730 to D-1739 | `tests/research/proposals/*.test.ts`, `tests/acceptance/v3/at73Shared.test.ts` |
| T4 CXA-011 SHOCK stop comparator | `3613bd19` (plan), `6a0bf4f8`, merge `d991da0f` | D-1750 to D-1759 | `tests/research/shockStops.test.ts` |
| M4 Cortex page, health line, seed state, e2e | `77d7ac2b`, merge `3da314dd` | D-1760 to D-1769 | `tests/ui/cortexResearch.test.tsx`, `tests/research/pageView.test.ts`, `tests/health/research.test.ts`, `e2e/m23-cortex.spec.ts` (CI only) |
| Z reports, gate, exit evidence (this commit) | this commit | D-1770, D-1771 | `docs/test-reports/{AT-72,AT-73,AT-74,AT-75,CXA-004,CXA-005,CXA-007,CXA-008,CXA-009,CXA-010,CXA-011,CXA-014,VAL-120}.md` |

**Decision ranges, in one line each** (all in `docs/M23_design.md`, indexed in `docs/V2_decisions.md`): A1 D-1650; R1 D-1655 to D-1657; T1 D-1660 to D-1664; A2 D-1665 to D-1669; S1 D-1670 to D-1674; M1 D-1675 to D-1679; R2 D-1685 to D-1689; T2 D-1690 to D-1694; M2 D-1700 to D-1703; R3 D-1710 to D-1717; M3 D-1720 to D-1729; T3 D-1730 to D-1739; R4 D-1740 to D-1745; T4 D-1750 to D-1759; M4 D-1760 to D-1769; Z D-1770 and D-1771. The design's own decisions D-1600 to D-1649 are the plan the tasks transcribed.

**Review notes.** The design marks A1, A2, R1, R2, R3, S1, T3 and M3 as **F** tasks and requires the orchestrator (Opus) to review each and every pre-registration file against the design before its runner runs (D-1646). Task Z did not witness those reviews and records no verdict on them; the orchestrator's own fixes after the reviews are the decisions **D-1689** and **D-1717** (ledger renumbering). The commit order of each pre-registration before its code is in section 3.

**Z's own fixes (the full gate found two real failures and fixed them):**

- **D-1770**: after A1 added migration 0040, `tests/golive/v2steps.test.tsx` and `docs/runbooks/rollback-v2.md` still named 0039 as the newest migration. The runbook now reads 0015 to 0040 and lists the eight 0040 tables and the two registry triggers among what a rollback deletes; the test expects 0040.
- **D-1771**: `tests/picks/benchmarkUse.test.ts` (DAT-235) now lists the three M23 readers of `index_bar` as non-comparison readers (`lib/cortex/monitors/promotion.ts`, `lib/regime/alt/evaluate.ts`, `lib/research/meters/common.ts`), and `scripts/arena/signals.stages.test.mjs` no longer quotes the picks entry path, so `tests/picks/isolation.test.ts` (D-181) holds.

## §2 Identity

- **AT-32 and AT-50 are not rewritten.** `git diff --stat 9986b15f HEAD --` over `tests/acceptance/v3/replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json` and `worker/test/fixtures/au-slots.snapshot.json` is **empty**; `git diff --stat 9986b15f HEAD -- worker` is empty too. Test run: `replayHash.test.ts`, `tests/acceptance/v2/at50.test.ts`, `at68.test.ts` and `tests/market/auConstants.test.ts`: 36 tests in 4 files, pass.
- **The `at32Research` own-set** (D-1645): the eight 0040 tables plus `trial_ledger` (proposal charges) and `app_log`. With the research night on and off on a recorded AU night, every other table hashes equal. The test runs every step writer of the research night on the golden world (`M23_STEP_WRITERS`, every earlier entry kept): after T4 the real steps write 28 meter rows, nothing in `shock_stop_outcome`, no look, and the AU hash equals the baseline. Test run: `at32Research` with the angle-proposal and research files: 94 tests in 6 files, pass.
- **AU constants and slot snapshots are unchanged** (the empty diff above), and the worker suite is green (26 files, 603 tests).

## §3 Registry

`docs/research/registry.json` is the committed, append-only offline ledger: **56 entries**, seq 1 to 56, checked by `npm run test:research-registry` ("the offline ledger is sound"). Plans were frozen by plan-only entries before any look; the plan hash is the sha256 of the committed file under `docs/research/prereg/`.

| Item | Lineage (plain name in the app) | Market | Plan sha (first 12) | Ledger seq | Verdict | Commit order |
| --- | --- | --- | --- | --- | --- | --- |
| M15 | `f1_v2_mom` | AU | `a87f7508104c` | 1 | NULL (legacy, older look) | before M23 |
| CXA-004 | 22 angle lineages and `ann_labels` | AU | `35345a7f8a2b` | 2 to 24 | no look (about 14 of 252 sessions) | plan `4a765de7`, then code `bd6fe2fc` |
| CXA-003 | six lineages and three `_p5000` variants | AU | `d86dde1578d8` | 25 to 33 (plans) | see below | plan `e0778a9c`, runner `ba08288a`, `6c693c47`, looks `37c6e287` |
| CXA-003 | `cxa003_hi52_vol`, `_p5000`, `cxa003_lowvol`, `_p5000`, `cxa003_short_cover`, `_p5000` | AU | `d86dde1578d8` | 34 to 39 | NULL on all six, looked 2026-11-17 | |
| CXA-009 | `sector_ic` | AU | `2f2cdbf5ece9` | 40 plan, 41 look | **PASS** (311 monthly blocks), looked 2026-11-17 | plan `596cec24`, runner `e9263f2b`, look `f8730066` |
| CXA-014 | `movers_a1`, `a2`, `a3`, `a4`, `a5`, `a8` | AU | `d7e31b914a0d` | 42 to 47 | no look | plan `1e958b25`, code `7857f842` |
| CXA-008 | `text_label_guidance`, `_event_confirm`, `_tone` | AU | `a760cf235117` | 48 to 50 | no look | plan `1e958b25`, code `7857f842` |
| CXA-011 | `shock_stops_F1` to `F6` | AU | `e168b9e77bfe` | 51 to 56 | no look | plan `3613bd19`, code `6a0bf4f8` |

Looks on file in the ledger: the M15 look and **seven M23 looks** (six CXA-003, one CXA-009). Refusal rows: none exist in production data; the refusal path is proved by `tests/research/registry.test.ts` and `tests/acceptance/v3/at72Registry.test.ts` (a second look is refused and audited). The three older writers (short shadow, outside signals, Committee trial) go through the same gate and display their legacy words (D-1650, D-1666).

## §4 Research verdicts

| Item | Lineages | Verdict | Report |
| --- | --- | --- | --- |
| CXA-003 | 12 rows: six with a look | **NULL** on six (three tests, each at the base parcel and the larger one) | `docs/test-reports/CXA-003.md` |
| CXA-003 | three with no history (earnings drift, index inclusion, director clusters) | **INCONCLUSIVE** x 3, no look spent | same |
| CXA-004 | 22 angles and the labels | **INCONCLUSIVE**: about 14 of 252 sessions; the look is automatic at 252 | `docs/test-reports/CXA-004.md` |
| CXA-005 | six families, two lines each | meters only | `docs/test-reports/CXA-005.md` |
| CXA-007 | proposals | **INCONCLUSIVE**: no live model; job and validator proven on 20 fixtures | `docs/test-reports/CXA-007.md` |
| CXA-008 | three label kinds | **INCONCLUSIVE**: below the golden floor | `docs/test-reports/CXA-008.md` |
| CXA-009 | `sector_ic` | **PASS**; the holdout-only figure from 2022 was lower (19.26 against 48.41 thousandths before); it is reported, not a gate | `docs/test-reports/CXA-009.md` |
| CXA-010 | monitors 1 to 8 | built; first quarter not yet closed (D-1615 to D-1622, D-1675 to D-1679, D-1700 to D-1703) | `docs/test-reports/CXA-010.md` |
| CXA-011 | six plans frozen, seq 51 to 56 | **INCONCLUSIVE**: meters 0 of 30 | `docs/test-reports/CXA-011.md` |
| CXA-012 | survivorship record | **INCONCLUSIVE** (a record) | `docs/test-reports/CXA-012.md` |
| CXA-013 | fundamentals source check | **INCONCLUSIVE** (a record) | `docs/test-reports/CXA-013.md` |
| CXA-014 | six rules | **INCONCLUSIVE** for all six; A2, A4 and A5 have no forward record | `docs/test-reports/CXA-014.md` |
| VAL-120 | intraday cells | meters only | `docs/test-reports/VAL-120.md` |

Acceptance reports: `AT-72.md` (new), `AT-73.md` (M23 part added), `AT-74.md` (new), `AT-75.md` (M23 part added). The CXA-004 report's runner-commit line names the code commit `bd6fe2fc2b31`.

## §5 Monitors and meters

- **Monitors.** All eight are built, written once a quarter on the first night after the quarter closes. **The first quarter (2026-Q4) is not yet closed**, so no quarterly row exists; the calibration rows of monitors 2 and 6 appear when the step first runs after the merge. Thresholds are proved at and either side of each line in `tests/cortex/monitors/*` and `at74` (51 tests in 9 files, pass).
- **Meters.** The nightly step writes research meter rows (about 28 a night on the golden world: 12 live-tested lines, 6 mover rules, the intraday cell, 3 label meters, the CXA-004 session counter, 6 SHOCK comparators, minus those blocked). The latest n of target: CXA-004 about 14 of 252 sessions; CXA-011 0 of 30 in each of six families; CXA-008 below 500 golden items per kind; CXA-014 A1, A3, A8 collecting, A2, A4, A5 blocked at 0; CXA-005 and VAL-120 are read from the database (no production figure is committed to the repository).
- **Page.** The Cortex page shows the tests, what is waiting, the eight monitors and the sector series; System Health shows one line ("N open alarms, M second looks refused"). `tests/ui/cortexResearch.test.tsx`, `tests/research/pageView.test.ts`, `tests/health/research.test.ts`, `tests/loaders/cortexPage.test.tsx` pass. The Playwright spec runs in CI only.

## §6 Constraints

| Constraint | Evidence |
| --- | --- |
| Turso at or under 20 % of the free plan | **108** added lines carry a `rows-ok:` comment in the M23 diff of `src/` and `scripts/` (`git diff 9986b15f HEAD`); the D-1641 estimate (about 25 sector rows, about 22 to 28 meter rows, under 5 comparator rows a night; 8 monitor rows a quarter; at most 3 proposals a month; about 200 keyed or range-bounded rows read a night) is not exceeded by design; the page adds nine bounded statements (D-1769) and the control-room test budget becomes 101 statements; the measured Usage figure after the deploy is read by the Owner |
| Zero `OFFSET` | `tests/security/noOffsetPaging.test.ts` is in the green `security` folder (27 files, 686 tests) |
| LLM budget unchanged | `tests/llm/budgetBuckets.test.ts` is in the green `llm` folder; no new bucket, no change to `llm_daily_budget_total` (D-1642); no model is live for M23 |
| No staging path, `ASX_LIVE` off, $0, no secret | no staging workflow touched; the only workflow change is one added step in `ci.yml` (the registry check, A2); no locked production workflow was edited; no new key or secret name (`npm run test:env-names` ok, 4 pre-existing warnings); gitleaks on the remote run: to be filled at push |
| Schema pins at 40 | `tests/backup/core.test.ts`, `tests/db/0040_m23_research.test.ts` and the pin tests of the older migrations; the rollback runbook and its test name 0040 (D-1770) |
| `worker/` untouched | `git diff --stat 9986b15f HEAD -- worker` is empty; the worker suite is green |
| Decision index, config reference, architecture regenerated | `node scripts/ci/decision-index.mjs --check` exit 0 (1,139 decisions); `npm run test:config-reference` exit 0; `npm run test:architecture` (model complete and up to date; the generator reports 579 elements, 681 edges); `node scripts/db/gen-market-guard.mjs --check`, `node scripts/routes/gen-app-routes.mjs --check`, `node scripts/llm/bakeoff-index.mjs --check`, `node scripts/ci/test-map.mjs --check` (1,179 baseline ids, 1,179 current) all exit 0 |
| Market literals at 0 | `npm run test:market-literals`: 0 hits in 0 files outside the allow-list (127 allowed, 1,437 scanned) |
| No internal code in Owner-read text | `npm run test:internal-codes`: 0 hits outside the allow-list (48 allowed, 354 files scanned) |
| Repo hygiene, no private data | `npm run test:hygiene`: OK; nothing from `data\` is in the repository, reports hold aggregates only |
| IN and US off | `at68.test.ts` green; every step loops over the enabled markets only; every 0040 table has both guard triggers (`gen-market-guard.mjs --check`) |

**Full gate, observed 2026-11-18.** One `tests/*` folder at a time (`timeout 1500 npx vitest run <dir> --maxWorkers=2`):

- 81 folders with tests: **958 test files, 13,240 tests passed**, plus `tests/pages.test.tsx` (1 file, 21 tests, pass). `tests/fixtures`, `tests/routes` and `tests/timing` have no runnable tests ("No test files found"; `tests/timing` is excluded by the Vitest config).
- Two real failures were fixed (D-1770 `golive`, D-1771 `picks`) and both folders were rerun green (`golive` 7 files, 80 tests; `picks` 27 files, 206 tests).
- **Two load flakes, noted:** in the first run a Vitest worker crashed with exit code 3221225477 on `tests/config/actions.test.ts` and on `tests/data/asxToken.test.ts`; each passed alone (8 and 33 tests). The `config` folder is then 21 files, 289 tests and `data` 25 files, 385 tests.
- `npx vitest run --root worker`: 26 files, 603 tests, pass. `npm run test:smoke`: 992 tests, 0 failed.
- `npx tsc --noEmit`: exit 0, no output. `npx prettier --check .`: all matched files use Prettier code style. `npx eslint .`: 0 errors, 4 warnings (unused variables, not in a locked file).
- The nine `npm run` checks (`test:architecture`, `test:market-literals`, `test:hygiene`, `test:internal-codes`, `test:env-names`, `test:tokens`, `test:config-reference`, `lint:workflows` (29 workflows, 0 findings), `test:research-registry`) and the five generator `--check` runs: all exit 0.

## §7 Findings and Owner steps

Listed, not asked (PRD-048: nothing in M23 prompts the Owner; every open point is decided with the spec's recommended default).

**Findings**

1. **Optimistic bootstrap p-values on short series.** With a 20-session outcome and a 20-session block, a holdout of about 76 sessions holds about four blocks, so the block-bootstrap p-values are optimistic (**D-1694** for CXA-004). The same holds for the movers: A1 has 40 events with block 5, A8 has block 1 on about 60 sessions (**D-1728**). The plans are frozen as written (a changed plan is a new lineage); the review of the first look should weigh it.
2. **D-1732: the spec text "any field naming a size" cannot mean the grammar's required size action.** The rule grammar requires exactly one size action, so refusing it would refuse every valid rule. The validator refuses a field (a key naming a weight, threshold, size, active set or rule version) and carries the grammar action unchanged.
3. **D-1703, D-1700, D-1702: the floors that M2 chose.** Monitor 8's exclusion status is the fill model's `unfilled` outcome with 20 scored setups in each quarter (D-1703); monitor 5's "one regime only" label needs 30 setups in the quarter and compares in whole counts (D-1700); monitor 7 had no stored expected stall rate, so the expected rate is the shadow arm's rate over the earlier four quarters, and a side below 20 cohorts never alarms (D-1702). None of these numbers came from the spec.
4. **D-1619: the 90 % threshold is still [PROPOSED].** The share at which a family is labelled "one regime only" was proposed, not specified.
5. **D-1722: the strata floor of 30 is [PROPOSED].** The minimum of announcements per stratum in the CXA-008 evaluation was chosen by the builder; the spec gave none. The harness and agreement thresholds (D-1636: 0.90, 0.80, 0.70) and the movers' sample sizes and directions (D-1625) are [PROPOSED] too.
6. **PanelLoader not wired.** The CXA-004 look and the late `ann_labels` look need a point-in-time replay of angle values before about 252 sessions, roughly a year away; no loader exists, so neither look can be taken today (D-1722, D-1729).
7. **Forward records missing.** Movers A2, A4 and A5 need a stored forward record (a results-window note, a short-risk flag, a young-listing grid point). That is a Cortex-night change and is not built; the three meters are blocked at 0 (D-1721, D-1729).
8. **T4 variant cap.** The CXA-011 comparator counts as one stop variant per quarter against a cap of 3, but the challenger lifecycle's own check was not changed, so a later challenger registered in the same quarter can still fill the cap (D-1755).
9. **Static industry.** The "static industry" label is unconditional for AU: the page does not search for a first own snapshot of the instrument classes, so the label stays until a later task supplies the date (D-1763, D-1742).
10. **R2 live role.** Listing R2 in `llm_live_roles` is an Owner step, after a PASS in the bake-off; until then the proposal job and the CXA-008 harness do nothing in production (D-1637, D-1737, D-1738).
11. **Proposals are not screened in M23.** The existing offline screen (KB-076) is not run; a stored proposal is only a proposal, charged as one trial (D-1637).
12. **CXA-003 data limits.** Dividends are not added to a setup or its controls, and the publication time of a short-position report is assumed (the end of a fixed number of weekdays after its date), not observed. The history holds survivors only, so a haircut of one percentage point per 60 sessions held is assumed and shown beside each figure (D-1626, D-1686, D-1687).
13. **CXA-003 time-box.** The box ends on **2026-12-08** (D-1601). Three lineages have no history and stay INCONCLUSIVE with their one look unspent.
14. **Index basis of the research readers (found by the gate, D-1771).** The monitor, the regime-alt evaluation and the meters form market-adjusted returns from the index level, not the total-return series that Owner-facing comparisons use (DAT-235). To confirm; shadow only.
15. **Holdout reuse.** The M15 holdout window has served F1.v2-mom already; Bonferroni across the new looks and the published development figures are the guards (D-1628). The CXA-009 holdout-only figure is weaker than the development figure and is reported, not gated.

**Owner steps after the merge**

1. Review the CXA-009 PASS before the sector tilt enters the CTX-053 path in shadow; nothing moves by itself.
2. Run the bake-off for the proposal and label role and list R2 in `llm_live_roles` if it passes (finding 10).
3. Label 500 golden items per kind and market for CXA-008.
4. Optional: upload a historical index-change list so `cxa003_index_incl` can be run under its frozen hash; director-notice and announcement history have no free source.
5. Read the eight monitor alarms each quarter; the demotion signal (D-1615) and the stall item (D-1621) ask for a decision.
6. Review the [PROPOSED] values: D-1619, D-1625, D-1627, D-1636, D-1722.
7. **Before approving the V3 production deploy (D-1773):** run `node scripts/db/migrate.mjs --db main` against production, approve outside 10:00 to 19:30 Melbourne on a trading day, then run smoke stage 2. To roll back, follow the corrected runbook (D-1772): app, Worker and approved commit together.
8. Later work, not M23: wire a `PanelLoader` for CXA-004 and the late label look (finding 6); store forward records for movers A2, A4 and A5 (finding 7).

## §8 BUILD_SETUP section 9 (rows for the orchestrator to write)

- "V3 current milestone": **M23 done** (written after the final CI run on the pushed head is green: to be filled at push).
- "V3 last step done / next step": **M23 exit / open the V3 PR** (then "V3 PR opened").
- Notes to carry: the M22 gate run 44105012255 on `92032ebb`; the final M23 CI run (to be filled at push); the ledger renumberings D-1689 and D-1717; Z's fixes D-1770 and D-1771; the findings of section 7; the two flaky workers on first run (config actions and data ASX token tests, pass alone).

## §9 Not verified locally

Playwright cannot run in a `wt-*` worktree here, so `e2e/m23-cortex.spec.ts` was written and listed but **not run**; CI is its only verification. Also CI-only: the production `next build` and the bundle budgets, gitleaks, Lighthouse, and the full `npm test` suite on the remote. `test:diffcov`, `test:bundle`, `test:lighthouse`, `test:licences` and `test:e2e` were not run here.
