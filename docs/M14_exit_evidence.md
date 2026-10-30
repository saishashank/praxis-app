# M14 exit evidence: returns, validation, data and LLM hardening (V2)

_2026-10-30 (Melbourne time). Design: `docs/M14_design.md`; requirements: `docs/M14_requirements.md`; decisions D-213…D-256, D-282…D-287, D-295…D-297. Built on `build` from c2f0f46 (67 commits to 4cc38f1). V2 ships in one PR at the end (O-73); nothing here is deployed or pushed yet._

## 1. Work packages
| WP | What | Commits | Tests |
|---|---|---|---|
| WP0 foundation | migration 0018 (additive, nullable, append-only triggers), config keys and typed params, rule-schema switches, stage stubs, decisions D-213…D-252, test-map rows | 9f5b10a, ffb9ba0, c7ef10f, 1142630, merge 0bef0a7 | migration and config tests; config reference regenerated (a8252f7) |
| WP1 entry gates | FAM-004 stop cap (12 %), FAM-005 cost gate, FAM-006 second position, FAM-008, FAM-009, FAM-007 option at replay stop calls | b80e738, 4398497, merge c2cbea2 | `tests/agents/{entryGates,costGate,stopCap}.test.ts`, `tests/replay/cohortParity.test.ts`; AT-43 |
| WP2 ex-date stops | FAM-007 ex-dividend stop, DAT-233 factor kind and reference close, DAT-235 benchmark guard | bb380e3, merge 421d4e9 | `tests/arena/fills*.test.ts`, `tests/corporateActions/*`, `tests/picks/benchmarkUse.test.ts` |
| WP3 robustness | ARN-106 time-stop comparator, ARN-107 one-tick slip, ARN-108 +-1 stability, ARN-109 settlement; runner wiring | 2595b47, 8305439 | `tests/learning/robustness.test.ts`, `tests/replay/*`; AT-43 clause 3 |
| WP4 validation statistics | VAL-112 alpha spending, VAL-113 power/pattern order, VAL-114 rank IC, VAL-115 MinBTL, VAL-116 lesson pool, O-45 | 771c629, 4395b30, merge 60d3dda | `tests/stats/*`, `tests/learning/alpha*.test.ts`; AT-44 |
| WP5 events | AGT-135/138 `category_detail` and reversal flag, DAT-232 split-adjusted event volume, DAT-237 dedup, split-frequency script | 8924e2a, merge 4cbe823 | `tests/agents/events*.test.ts`, `announcementDedup.test.ts`; AT-45 |
| WP6 variants and wiring | F5 universe, AGT-136/137, DAT-234 index-change rule, KB-081 pre-registered challengers, O-46 cap, events-v2 wiring in candidates and snapshot | 259978c, 50f2501, d3d2a6a, merges 43283fa/484907e | `tests/agents/families/*`, `tests/learning/preRegistered.test.ts`; AT-43/44/45 |
| WP7 LLM hardening | LLM-071 JSON-schema enums, LLM-072 exact labels, LLM-073 datamarking, LLM-074 reservation and field-named repair, LLM-075 dated cut-offs | 5d0e263, 82f31cc | `tests/llm/**`; AT-46 |
| WP8 reference data and UI | reference-data loader and import, Data files card, Wikidata converter, licence register (DAT-234/236), Strategies Robustness section, Decision Card wording | 8e0c91f, 1142630, c02597a, merge d25a960 | `tests/data/referenceData.test.ts`, `tests/loaders/robustness.test.ts`, `e2e/m14-*.spec.ts` |
| WP9 integration | merge order and integration fixes (rank IC stage, cost gate wired, extra settlement stats stage, category_detail column), AT-43…AT-46 tests and reports, architect-review fixes 1…6 and notes, this document | 484907e, 3a8417b (AT-44/45/46 merge), b161e6b, 21b9cea, fa926a7 and the fixes below | see sections 2 and 3 |

Architect-review fixes (Fable, read-only review of M14): b93ab9b (FAM-007 cut-off on `LiveWorld`), 198ba1b (one `costGateRowsOf`), 30f39a4 (`priorTests` required), 3605bf9 (FAM-006 first-leg retry), 0c1f040 (reference data point-in-time), 8ff85b5 (one replay memo), dd1b730 (reference close parsed from decimal text), ca7a884 (rename `isQuantityType`), 21d9c18 (dedup within the 5-session window), 373e0c7 (D-295…D-297). Nothing was re-pinned: no golden moved.

## 2. Acceptance
| Test | Result | Report |
|---|---|---|
| AT-43 sizing and cost gates | 22 tests pass | `docs/test-reports/AT-43.md` |
| AT-44 rank quality and error budget | 9 tests pass | `docs/test-reports/AT-44.md` |
| AT-45 data additions | 12 tests pass; split-day frequency not measured locally | `docs/test-reports/AT-45.md` |
| AT-46 LLM hardening | 18 tests pass | `docs/test-reports/AT-46.md` |

The four files together: 61 of 61 pass in 69.2 s (local, 2026-10-30, `build` at 4cc38f1).

## 3. Gates (local, Windows build machine, 2026-10-30)
- Earlier run, before the review fixes: vitest 6,811 pass + 2 load-only timing failures (`cohortReplay` full default-size 62.6 s against a 60 s budget; the picks pages), both pass alone.
- Full gate on build 55cc7d9 (after all M14 fixes): vitest 6,888 passed, 4 failed, 2 skipped. The 4 failures (`tests/coverage/replayCli.test.ts` x2, `tests/coverage/snapshotWorld.test.ts` x2) were real regressions from review fix 1/2 work: the random-signal source spread lost `decisionCutoffOf`, and the replay CLI read stored splits on null and injected runs. Fixed in 48ed5c8; the two files then passed (45/45).
- Full vitest re-run after 48ed5c8 (2026-10-30 evening, machine shared with builders): 6,890 passed, 2 failed, 2 skipped, 2,267 s. The 2 failures are load-only UI timing (`tests/news/newsPage.test.tsx` dialog, `tests/picks/pages.test.tsx` family sheet); both files pass alone (53/53).
- Worker vitest 469/469. Smoke 674 pass, 0 fail.
- e2e (local production build): 242 passed, 8 skipped (populated/rich-only specs), 0 failed, 15.4 min; the rich-scenario M14 specs 7/7 passed.

## 4. Open items (not blocking local closure)
For the Owner:
- push of `build` (refused by the auto-mode classifier here; the Owner pushes), then remote CI (gitleaks history, e2e and Linux jobs can differ from local);
- staging migrations 0015 to 0018;
- the AT-42 staging row;
- the DAT-232 split-day frequency: `node scripts/data/split-frequency.mjs --db ...` needs the staging database; not measured locally.

Known limits (recorded): `instrument.industry` has no history and is read as current (D-285); the reversal flag is display-only and not reproduced by the cohort replay (D-297); MinBTL's N is conservative (D-296); the director trade-type split is BLOCKED-DATA (D-242).

**M14 closed: yes, pending the Owner items.**
