# M6 exit evidence (AT-22, AT-23, AT-24, carried AT-20 sections 4 to 6)

Status date: 2026-10-20. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.4. Test files are listed in [test-map.md](test-map.md) (M6 rows). Requirements: [M6_requirements.md](M6_requirements.md). Design: [M6_design.md](M6_design.md).

Overall: the learning loop and the knowledge base are built and pass their local tests with a mock LLM and synthetic data. Every AT has an automated check through the real code paths: the nightly `learn` and `words` phases, Lane A, the challenger lifecycle with the VAL-110 wrapper, the Critic verdict, the promotion writer at the real group restart, the document renderers and the KB archive against an in-process fake GitHub. The parts that need the Owner, staging or production are **pending**, not faked. M6 exit is **met locally, not yet on staging or in production**. Nothing runs in production yet: A6 and the KB archive stay off until the Owner enables them, and migrations 0007 to 0010 are not applied anywhere.

## Commits

Range `a56edee^..HEAD` (26 commits). T18 (acceptance tests, test map, this page, D-127) is uncommitted.

| Commit | Task | Decision |
|---|---|---|
| a56edee | M6 requirements extract | |
| eb8d0fe | M6 design and architect decisions | D-110 |
| 0c98234 | T1 + T2 migration 0010 and auth 0005, learning keys, KB version, rule schema, v1 seed | D-111 |
| d67ad7b, 3c1eaf1, 8bc368e | T15 bake-off harness, golden set, dispatch-only `llm-bakeoff.yml` (never run) | D-112 |
| efafa4d | 30 s test timeout for local and CI runs | |
| b1dc79c | T3 attribution | D-113 |
| 1a54804 | `.gitattributes`, LF line endings | |
| e84d2b5 | T5 comparisons | D-114 |
| 7884f14 | T8 rule versions in the money path | D-115 |
| 88ddc46 | T13 KB documents, archive script, dispatch-only `kb-archive.yml` | D-116 |
| 1dc38c6 | decisions D-113 to D-116 | |
| f7db61a | T4 lesson engine | D-117 |
| 9945900 | T7 Lane A | D-118 |
| 3421172, 8fa2be9 | T9 challenger lifecycle, decisions D-117 to D-119 | D-119 |
| 0c9172d | T6 Critic | D-120 |
| 5d97849 | T11 A6 `learn` and `words` phases, review sections 4 to 6 | D-123 |
| 823e4e3 | T10 promotion, force-apply, rollback | D-121 |
| edf611d | T17 picks back end | D-122 |
| 9fdf87a | decisions D-120 to D-123 | |
| a87983c | T12 weekly learning run (`replay.yml` mode `learning`) | D-124 |
| edacc2f, 33463c1 | T14 Owner and Editor routes and pages, decisions D-124 and D-125 | D-125 |
| dceda95 | T16 time, job and look-ahead tests | D-126 |
| (uncommitted) | T18 acceptance tests, test map, this page, KB mapping fix | D-127 |

CI status: remote CI on `build` is green for the last pushed commit (dceda95, run 39353465961). The five runs before it that `gh run list` shows are green too. Remote CI for the T18 change has not run, because nothing is committed or pushed yet.

## Test counts

Full suite (`npx vitest run`, local): **250 files, 4,714 tests: 4,712 passed, 2 skipped** (the skips are the real-fixture tests that run only in the `fixtures` CI job; about 16 minutes on this machine). T18 adds 4 test files and 46 tests in `tests/acceptance/m6/` (AT-22 13, AT-23 23, AT-24 6, AT-20 sections 4 to 6 4; about 12 s wall time together) plus the shared builder `arenaWorld.ts`, one extra routing test in `tests/kb/documents.test.ts`, and `tests/kb/fakeGithub.ts` (moved out of `tests/kb/archive.test.ts`, no change in behaviour). The Worker tests (`worker/test/*`) run in the Worker package and are not in this total.

## AT checklist

- **AT-22 Nightly loop: met locally.** `tests/acceptance/m6/at22.test.ts`: the real `learn` phase over the real cohorts with a mock clock at 19:20 Melbourne writes attribution, nightly comparisons labelled "descriptive — not a finding", a grade for every lesson and a plan of at most 5 items, each with reason, lesson id (or `no-lesson:`), lane and measure, plus the review of yesterday's plan; every run record ends before 19:45 and the loop budget is at most 5 minutes. A rerun changes nothing; a missing batch 3 gives a degraded partial run. Lane A changes are in the change ledger with a playbook version and a KB version bump; L0 never reaches a playbook and L1 sits only under "Unproven notes". A property over five random lesson sets shows that rule versions, executions, cohorts and their parameters, orders, splits, challengers and promotions are byte-identical after the night. `words` changes no number, and rules-only and mock runs give identical numbers (AGT-001). No LLM, playbook or review-section module reads annotations. In depth: `tests/learning/learnNights.test.ts` (golden world: attribution of every trade, forward row and blocked signal), `learnStage`, `laneA`, `wordsStage`, `lookAhead` (TST-109), `tests/time/m6Jobs.test.ts`. **Not evidenced:** the recorded staging run (TST-115), any live R3 wording (no model is assigned yet).
- **AT-23 Challenger lifecycle: met locally.** `at23.test.ts`: a seeded challenger goes proposed, replay (VAL-110 on the validation split, holdout untouched), shakedown (ten finished sessions from the run history), review. Each VAL-110 component failing is a rejection, a real (ii) failure rejects it with the trial slot used, and "insufficient" charges nothing. A failing Critic check 2, 3, 4 or 6 keeps it in review, not ready, and the approval edge is closed. A passing one, once the Owner has approved it, promotes only at the real group restart: the ending cohort keeps v1, successors start with the new version, other families are untouched, the ledger row carries the Owner audit reference. The weekly cap holds it for a later restart; force-apply gives an UNVALIDATED "forced by Owner" version; rollback is a new version and history stays. 8 concurrent challengers, a killed family and an exhausted budget are refused; the generator can only see the development split. In depth: `challengerLifecycle`, `challengerEvidence`, `challengerGenerator`, `promotion`, `critic`. **Not evidenced:** the staging run; the Owner's approval of any real promotion.
- **AT-24 KB archive: met locally.** `at24.test.ts`: every record of a real `learn` night and of earlier days maps to a regenerated markdown document; documents carry the KB-003 front matter; versions grow only when a record changes. The archive makes one fast-forward commit of the changed files under `knowledge/` in the data repo, and a re-run makes no commit. Every request goes to the data repo on api.github.com; none goes to the code repo, Vercel, workflows or deployments; the code repo cannot be configured as the target. Archived bytes equal the markdown regenerated from the database. `kb-archive.yml` is dispatch-only with the data token in one step; the Worker slot is disabled. This test found a real gap, fixed in D-127: the Lane A change-ledger rows (target `playbook/<agent>`, lessons as `{added, removed}`) were not routed to any document. **Not evidenced:** a run against the real data repo, the confirmation that the data repo has no Vercel project and no workflows, and production evidence after the Owner enables the slot.
- **AT-20 sections 4 to 6 (carried from M5): met locally.** `at20s46.test.ts`: section 4 lists the lesson with its grade, the Lane A change and the challenger status with the earliest date a promotion could first be possible; section 5 states a finding with its numbers or "no detectable difference (n = ...)"; section 6 shows the plan (at most 5) and the review of yesterday's plan; with no `learn` run, sections 4 to 6 are missing and the review is partial. In depth: `tests/review/sections46.test.ts`. **Not evidenced:** the inbox check and the staging review.

## Decisions

D-110 (design, 48 decisions), D-111 (migrations, keys), D-112 (bake-off), D-113 (attribution), D-114 (comparisons), D-115 (rule versions in the money path), D-116 (KB documents and archive), D-117 (lessons), D-118 (Lane A), D-119 (challengers), D-120 (Critic), D-121 (promotion), D-122 (picks), D-123 (A6 orchestration), D-124 (weekly learning run), D-125 (Owner and Editor routes), D-126 (time, job and look-ahead tests). D-127 (T18, KB mapping fix) is also in [07_decision_log.md](07_decision_log.md).

## Open / pending

- (a) **Owner prerequisites** (nothing below is faked or done):
  - the golden-set spot check (at least 10 items) before the first bake-off, then the first bake-off run;
  - after a passing bake-off: the R3 chain and `llm_classifier_model`, and the dated `trains_on_prompts` values;
  - confirm the Lane-A list and the reading of the promotion boundary (decisions 11 and 18);
  - approve the new dispatch-only workflows `kb-archive.yml` and `llm-bakeoff.yml`, and the changed `replay.yml` (mode `learning`);
  - confirm that the data-repo token may be used for the KB archive, and that the data repo has no Vercel project and no workflows;
  - at run time, approve each promotion, force-apply and rollback;
  - enable the slots, which ship disabled: `kb-archive` (22:15) and the weekly learning run (the A6 phases ride the batch 3 workflow);
  - the staging run of AT-22 to AT-24 once a release carries the workflows.
- (b) **Migrations main 0007, 0008, 0009 and 0010 and auth 0004 and 0005 are not applied anywhere.** They reach staging and production at the next review point (D-022); the staging runs of AT-14 to AT-24 wait for it.
- (c) **Known limits and follow-ups:**
  - D-113: arena trades exclude dividends; legacy trades are final with net NULL; corporate-action exits use the stored proceeds;
  - D-121: holdout dates beyond the data end are weekday estimates; `rollAfterPromotion` runs inside the weekly learning run only;
  - D-122: the Conservative and Balanced picks filters are constants without ch.15 keys, Balanced is empty until attribution history exists, pick tracking ignores corporate actions and dividends, section 7a is read but not rendered, `beatsLuck` is a Wilson-bound draft;
  - D-123: no A6 notes, no twin, filter or cost comparison pairs, no coverage-below-90 % weakness, no health rows for the new phases; ARN-075 still has no definition;
  - D-124: holdout confirmations that fall due are listed but not run weekly; the lesson Critic runs nightly only, not weekly; stress excess and blocked rows are not fed to lessons; the Worker's Saturday mode map is unchanged;
  - D-125: annotations live at `/api/learning/annotations`, the spec says `/api/annotations` (align in M7); the plan and document GET routes and the real pages are M7;
  - D-126: no mutation tool is installed, so TST-130 mutation testing is not configured; the look-ahead test over the whole `learning` run is only partly meaningful (the snapshot yields no ledger rows);
  - D-112: the bake-off harness has never run, so no model is assigned to a role and the classifier stays `none`;
  - there is no runtime test that builds an LLM context pack with an annotation present (KB-051); the static check and the route masking tests are the evidence.
- (d) **Carried from [M5_exit_evidence.md](M5_exit_evidence.md), still open:**
  - the Resend keys and `OWNER_EMAIL` check, the Gmail filter and SPF/DKIM check, the `watchdog.yml` approval and cron lines, O-23 and `asx_enabled` with `ASX_LIVE` and `ASX_USER_AGENT`, a recorded ASX feed fixture, one forced production watchdog run, the inbox checks for AT-05 and AT-20, the deliberate-failure test, the credential expiry dates, the `email_mode` switch and the six M5 Worker slots (all disabled);
  - the T7 thesis-breaker alert sink is not wired to the T6 tiers (D-102); no caller yet for the ledger-invariant incident (D-105); the real ASX feed format is unknown (D-100); the ARN-011 promotional keyword list is still the Owner's (D-103);
  - the M4 items: the AT-14 to AT-17 staging run and real-data null runs, the Owner approvals of the four M4 workflows and slots, O-26 Yahoo, the proposed config keys still missing (ARN-011 thresholds, F5 volume-exit numbers, `code_reuse_gap_sessions`, CIF horizons, `LINEAGES_FLOOR_MIN`, `llm_injection_phrases`, `dsr_default_sr_variance`), the M4 known limits and the M2 ASX by-date backfill.
