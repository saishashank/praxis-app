# M13-lite exit evidence: expert seed import and screening (V2)

_2026-11-01 (Melbourne time). Design: `docs/M13L_design.md`; requirements: `docs/M13L_requirements.md`; decisions D-510…D-536, D-540…D-543, D-550, D-570, D-571, D-590…D-599, D-600…D-609, D-610…D-619, D-620…D-624, D-630…D-636, D-640…D-646, D-650…D-659 (all in the design document, D-657). Built on `build` from the M11-lite line; WP1 to WP7 merged, WP8 on `v2/m13l-wp8` from `build` at 6fc21df. V2 ships in one PR at the end (O-73); nothing here is pushed, imported or deployed yet. Every number in this document is a count; no expert name, URL or text from the private seed appears in the public repository (SEC-110)._

## 1. Work packages
| WP | What | Merge | Tests |
|---|---|---|---|
| requirements, design | M13-lite extract; design with D-510…D-536 | before WP1 | none (documents) |
| WP1 schema, register rows, keys | migration 0022 (sixteen STRICT append-only tables, KB-073 status edges by trigger, every TEXT column capped, PRD-036), eight `source_register` rows (D-522), four config keys (D-528) | b08f55b | `tests/db/0022_experts.test.ts` (22); key-parity; `licence-register.mjs --check`; `config-reference.mjs --check` |
| WP3 seed import | format `praxis-expert-seed/1`, validator, importer (dry run, counts only, one transaction, idempotent), ZZ seed; private converter and reviewer fit list (D-540…D-543, D-570, D-571) | 73c07a4 | `tests/experts/import.test.ts` (37); AT-39 (b)(c) |
| WP2 domain layer | types, store, status edges, `fitCheck`, scorecard, vocabulary gaps (D-550) | 87e9c92 | `tests/experts/{status,fit,scorecard,vocabularyGaps,store}.test.ts` (40) |
| WP4 screening | development view, excess-over-controls statistic, BH once per run, confirmed clusters only, one transaction (D-590…D-599) | bb7d13b | `tests/experts/{screenStats,screen}.test.ts` (23); AT-40 (a)–(d) |
| WP5 proposals, F7, weekly stage | `createChallenger` as the one path to trading, expert cap exempt from the v1 generator cap (D-620), F7 gate by maximum matching (D-621), stage last and never blocking (D-600…D-609, D-620…D-624) | 29a4cf4 | `tests/experts/{proposals,f7,weeklyStage}.test.ts` (23); AT-40 (e)(f); `tests/replay/learningMode.test.ts` |
| WP6 pages, queue, roles | directory, detail, techniques, claims queue; `review_claims` role; audit-first actions; cluster confirm and merge; SEC-016 safe links; masked edit refused server-side (D-610…D-619, D-630…D-636) | 4fd0ae7 | `tests/experts/review.test.ts` (19), `tests/ui/expertsPages.test.tsx` (17), `tests/auth/permissions.test.ts`, `e2e/m13l-experts.spec.ts` (written, not run) |
| WP7 calls, KB mirror, guards | paper tracker vs market with luck share, KB mirror under `knowledge/common`, boundary test, AT-41 complement replay hash, health line, architecture model (D-640…D-646) | 816864f | `tests/experts/{calls,kbDocs}.test.ts` (23), `tests/security/expertBoundary.test.ts` (26), `tests/acceptance/v2/at41Replay.test.ts` (3), `tests/health/experts.test.ts` (8) |
| fix | expert sources off by design are not a data weakness (D-522); migration-0010 test timeout for 22 migrations | 64e5d3f | `tests/learning/migration0010.test.ts` |
| architecture | spec-map rules for the expert pages and claim-queue actions | 6fc21df | `npm run test:architecture` |
| WP8 exit | WP7 review, boundary-test fixes and tightening (D-651), health-line date masking (D-652), architecture ids (D-653), seed dry run (D-654), AT-39…AT-41 reports, this document (D-650…D-659) | commit on `v2/m13l-wp8` (hash in the merge) | section 3 |

## 2. Acceptance
| Test | Result | Report |
|---|---|---|
| AT-39 expert ingestion | **partial by D-527**: (a) schema holds metadata only, (b) rejection names file and field, (c) idempotent on URL plus hash, (d) manual-only platforms disabled: pass locally (0022 22 of 22, import 37 of 37, register and config checks green). Deferred with DAT-228 and LLM-067: feed, robots, conditional request, daily cap, hostile text | `docs/test-reports/AT-39.md` |
| AT-40 claims to screening | pass locally, all clauses: (a) checked claims of a confirmed cluster only, (b) BH once at 0.10, (c) planted clusters first, (d) development split only and no trial (spy), (e) proposals capped at 2 per week through `createChallenger` with +1 trial each, (f) F7 dormant at 2, one dormant row at 3 | `docs/test-reports/AT-40.md` |
| AT-41 scorecard and no trade path | pass locally, all clauses: (a) order by evidence and "not enough tested claims" at 2, (b) calls paper-tracked vs market with luck share, (c) replay hash identical with expert data absent and present (complement of a three-item allowlist, non-vacuous) plus the static boundary (26) | `docs/test-reports/AT-41.md` |
| Seed import (extra) | dry run opens no database; refusals name file and field; in-repo folder refused; idempotent; counts only; schema floor 22 | `tests/experts/import.test.ts` |
| Config | the four keys present with bounds in area "Learning and knowledge"; the four deferred keys absent; `config-reference: ok (84 tags = 84 rows, doc current)` | key-parity tests |
| Private seed dry run (counts only) | exit 0, nothing written: 100 experts, 23 red flags, 275 items, 60 clusters, 347 claims, 976 claim-item links, 375 claim-cluster links, 0 calls. **Fits: 3 of 60** (K-011 F4, K-021 F1, K-024 F3; D-571); **57 parked**. Name grep over the repository (100 names): 0 hits | `scripts/experts/import.mjs --dry-run`; D-654 |

## 3. Gates (local, Windows build machine, 2026-11-01, branch `v2/m13l-wp8`)
- `npx vitest run tests/experts tests/security tests/acceptance/v2 tests/health tests/kb tests/picks tests/replay/learningMode.test.ts tests/learning/weekly tests/shell tests/ui/pageGuard.test.ts tests/blueprint`: 103 files, 1,481 tests pass (603 s).
- AT run with a JSON report (`tests/db/0022_experts.test.ts`, `tests/experts`, `at40Screen`, `at40Proposals`, `at41Replay`, `tests/replay/learningMode.test.ts`, `tests/security/expertBoundary.test.ts`, `tests/ui/expertsPages.test.tsx`, `tests/health/{experts,controlRoom}`, `tests/loaders/loadersPart2.test.ts`, `tests/picks/isolation.test.ts`): 25 files, 312 tests pass; per-file counts in the three AT reports.
- `npx tsc --noEmit -p .` clean; eslint clean on `src/lib/experts`, `tests/experts`, `tests/security/expertBoundary.test.ts`, `tests/acceptance/v2/at41Replay.test.ts`, `src/lib/health/experts.ts` and the WP8 files; prettier clean on the touched files.
- `npm run test:architecture`: model complete and up to date (after D-653). `npm run test:hygiene`: OK (after D-658). `node scripts/ci/licence-register.mjs --check`: up to date. `node scripts/ci/config-reference.mjs --check`: ok.
- Not run here: the full Vitest, smoke and e2e suites (the orchestrator runs the full gate) and remote CI (`build` is not pushed). `e2e/m13l-experts.spec.ts` is written and not run (D-636 d).

## 4. Decisions
D-510…D-536 (design), D-540…D-543 (WP3), D-550 (WP2), D-570, D-571 (WP3 review and reviewer fit list), D-590…D-599 (WP4 and review), D-600…D-609 (WP5), D-610…D-619 (WP6), D-620…D-624 (WP5 review), D-630…D-636 (WP6 review), D-640…D-646 (WP7), D-650…D-659 (WP7 review and WP8 exit). All in `docs/M13L_design.md` (D-657: V2 milestones keep their decisions in the design document; `docs/07_decision_log.md` ends at D-252).

## 5. Deferred (D-510, listed for the V2 PR)
| Item | Why |
|---|---|
| DAT-228 polling (RSS, YouTube feeds, own sites) | no fetcher in M13-lite; the register rows are `pending` with terms `[VERIFY]` until the Owner enables one (DAT-120, D-522) |
| DAT-229 discovery, UXN-296 candidates | needs polling; the `candidate` status exists in the model |
| DAT-230 priority wiring | nothing is polled; the function is not written |
| LLM-067 extraction, LLM-068 budget key | no new items and no LLM call (O-64, $0) |
| Four polling and extraction config keys | an unused key fails the reference check (D-528) |
| AT-39 fetch-dependent clauses (feed, robots, conditional request, daily cap, hostile text) | D-527; go-live gate item |
| Calls as structured data | the 28 seed `call` claims carry no code, direction, date or horizon (D-543); the tracker is dormant until a person or a later converter supplies `calls.json` |

## 6. Fit count and what it means
3 of 60 clusters are parameter sets of a v1 family (D-514, D-571): K-011 → F4, K-021 → F1 (the one approximation: its SMA(50) exit is the widest F1 trailing stop), K-024 → F3. The other 57 are stored and shown with a park reason; the confirmed `testable_eod` ones that need a new structural rule get one `parked_build_change` proposal row each (D-515, D-606). Screening cannot start before the Owner confirms clusters (D-594) and claims (D-512); staging shows the directory, the techniques and a full queue with an empty-but-correct screening state.

## 7. Residuals (accepted, none touches the decision path)
1. **Horizon close one bar early** when the horizon session's bar is not yet ingested at the weekly run (D-655); practice makes it present; insert-once means an early close stands.
2. **Source URLs in the expert documents** are masked as text by `LearningMasker` and rendered without links; a slug with an unknown company name is the shared learning-document residual (D-656).
3. **AT-41 hashes nights, not the weekly learning run with eligible clusters.** By design the learning run may write `challenger` and `trial_ledger` through `createChallenger`; that path is proven by AT-40 (e) (+1 trial per proposal) and the no-op of `learningMode.test.ts` with no expert data, not by the hash.
4. **Boundary test was red on `build`** for 3 of 22 tests between the WP6 + WP7 merge and this package (D-651): the gate of a merge must include the security tests of both sides.
5. **e2e not run** (`e2e/m13l-experts.spec.ts`, D-636 d); the Viewer, masked-Editor and queue walks are proven by `tests/ui/expertsPages.test.tsx` and `tests/experts/review.test.ts`.
6. **The health line shows to every role**; the date is an ISO week for a masked viewer (D-652); counts and fixed words otherwise.
7. **Weekly cap interplay**: a week in which KB-042 slots or the lineage budget block everything writes `refused` proposal rows (D-601); the Owner may see "refused" rows for a while.
8. **Calls are mostly dormant** (D-543, D-524): zero seed calls are structured, so `expert_call` stays empty until supplied; `settle` reports `tracked 0`.
9. **Named people in a private database** (design risk 4): red flags with a source and date only; licence status `unchecked` for every seed expert (D-520); KB documents and every public file carry none of it; the defamation risk is reduced, not zero.
10. **Wallclock columns outside the AT-41 hash** (`schema_migrations.applied_at`, `source_register_history.changed_at`, `cortex_night.runtime_ms`), as AT-32 (D-586).

## 8. Owner items (for the V2 PR)
1. **Review the 23 red-flag texts and `fits.json` before the real import** (private folder `Requirement/v2/tools/m13/`, seed at `D:\Projects\Praxis\data\experts\seed\`; D-542, D-571). The three fits are the reviewer's reading of the research; a wrong fit is parked at run time, never screened.
2. **Add regulator and paper hosts to `SOURCE_HOSTS` under DAT-120** (for example asic.gov.au, ssrn.com) so cluster evidence links become links instead of text (D-631); one-line change per host.
3. **Staging: migration 0022, then the import** (`node scripts/experts/import.mjs <seed> --dry-run`, review the counts, then without `--dry-run` with the staging `TURSO_MAIN_URL`/`TURSO_MAIN_TOKEN`); nothing is imported by the build.
4. **Confirm clusters to enable screening** (claims queue, "Groups to confirm"; D-594, D-612) and check claims (bulk confirm per expert); until then the weekly `experts` stage reports `nothing_eligible`.
5. **Decide on the deferred set** (section 5) and on the AT-39 go-live gate wording (D-527).
6. **Push and remote CI.** `build` is not pushed; gitleaks history, e2e and Linux jobs have not run.

## 9. Fable final review
_2026-11-01 (Melbourne time), worktree `v2/m13l-wp8` from `build` at 6fc21df (WP1…WP7 merged). Decisions D-650…D-659 in `docs/M13L_design.md`; the fixes are the WP8 commit on the same branch._

**Verdict: CLOSE M13-lite, MERGE WP8 AFTER THE FULL GATE.** PRD-035 is proven the way PRD-033 was: a replay hash over the complement of a three-item allowlist that is exactly the stage's own writers (D-642), a five-group static boundary with self-tests (D-644, D-651), append-only triggers with no foreign key out, and a picks-isolation line for the one tracker import. The one path from a cluster to trading is `createChallenger`, called from `proposals.ts` only, with +1 trial per created proposal and the expert cap (AT-40 e). Nothing fetches, nothing calls a model ($0, O-64). Honesty of the state is kept: 3 of 60 clusters can be screened, nothing is screened before a person confirms, calls are dormant, AT-39 is partial.

| Priority | Finding | Severity | State |
|---|---|---|---|
| 1 Boundary test red on `build` | WP7's `expertBoundary.test.ts` failed 3 of 22 after the WP6 + WP7 merge (`review.ts` imports and its `app_user` read were not allow-listed; the e2e fixture-name rule read a page heading as an expert). The design's boundary was intact; the proof was not green. | medium (process) | fixed: allow-listed with reasons, e2e rule reads the seed's `NAME_*` constants (D-651); 26 of 26 |
| 2 Write scan case and reach | the write allowlist regex is case-sensitive and scanned `src/lib/experts` only; D-525 named the pages and actions too. | low (nothing slipped; a lower-case `insert into` would have) | fixed: upper-case keyword check with a self-test; pages, actions and loader must hold no write literal (D-651) |
| 3 Health-line date | "last screening 2026-10-16" reached a masked viewer as an exact date; every other masked model shows ISO weeks (D-147, D-615). | low | fixed: the line passes through `maskText` (D-652); loader test |
| 4 Call maths vs picks | entry at the close and a market window from the entry-day level are the right counterpart of the picks' open fill and "last session before"; same total-return series and basis label; short against the negated market; luck share excludes the call's own code. The horizon-bar timing residual is stated (D-655). | none | reviewed, no change |
| 5 KB mirror | `hypothesis` under `knowledge/common`, no `front.kind` (hash stability), no red-flag, licence or audience text, claims as counts, archive paths allowed; URL masking residual stated (D-656). | none | reviewed, no change |
| 6 AT-41 allowlist width | the three excluded places are exactly the stage's writers; `document` under the mirror paths can be written only by `syncDocuments` from the stage file (boundary iii), `replay_stat` metric `experts` only by the weekly runner; the empty world has zero expert rows, the full world 6/21/5/1/3/1/2/7. | none | reviewed, no change |
| 7 Architecture ids | the 6fc21df rules match; UXN-293…295 were missing from the page rule. | low | fixed (D-653), regenerated |
| 8 Private seed | dry run exit 0, counts in section 2; 347 claims not 350 (D-542 drop); 3 fits; name grep 0 hits. | none | recorded (D-654) |
| 9 Decision log | `07_decision_log.md` ends at D-252; the M11L/M17 precedent keeps V2 decisions in the design document. | none | followed (D-657) |
| 10 Hygiene | `docs/M13L_exit_evidence.md` needs its allow-list entry (HYG-PRIVATE). | low | fixed (D-658) |

Checked and found right without change: `settleCalls` is idempotent by the `NOT EXISTS` read and `ON CONFLICT DO NOTHING`; an untracked call is never read; a `no_bars` outcome carries no window and settles at once; `luckPct` rounds half up to a whole percent; `syncExpertDocs` lives in the stage file to avoid the `kb/documents` import cycle; `mappingCompleteness` carries the mirror for the review market only (not market-bound); `buildExpertDocuments` returns `[]` for a world without the seed so no existing document moves; the `experts` stage runs last and each of its six steps is guarded; the wiring imports only `@/lib/experts/weeklyStage`; `createChallenger` appears in `proposals.ts` only.
