# M15 exit evidence: Cortex calibration (V2)

_2026-11-01 (Melbourne time). Design: `docs/M15_design.md`; requirements: `docs/M15_requirements.md`; decisions D-257…D-281, D-288…D-380, D-446, D-461 and D-469. Built on local `build`; V2 ships in one PR at the end (O-73); nothing here is deployed or pushed yet._

## 1. Result first
**No Cortex family is allowed to trade.** The calibration on development history 2000–2021 found no F1 or F4 cell that passes the economic gate (CTX-021): after costs of about 1.6 % per round trip at a A$1,000 parcel, the top-score band's mean net outcome is negative for both families, and its edge over matched same-night controls is 0.04–0.23 percentage points, well below cost. Calibration skill cannot be told apart from zero at the available effective sample size. The test was powerful enough to detect a net edge far smaller than the cost, so the finding is "no economically usable edge at this account size", not "no information" (D-380, D-446, D-461). Every family stays in shadow (CTX-053). V1 keeps trading, and the Cortex writes shadow decisions every night so that live evidence builds up. **V2's go-live condition is not met by M15; this leads the V2 PR.**

## 2. Work packages
| WP | What | Merge | Tests |
|---|---|---|---|
| C1a, C2, P1 | point-in-time view and registry; statistics core; schema 0019, keys, store | 58477f8 | unit suites under `tests/cortex`, `tests/stats` |
| C3a, C3b, C1b/C1c | score and economics; states and gates; angle families D1–D10 | c1548c6, d319a47, 8b30158, 80d6959, fc43447 | `tests/cortex/**`; AT-52, AT-56 |
| C3c | night run (`runNight`), family universes and exits | 6d9c578 | AT-50 |
| P2 to P6 | nightly stage, replay driver, cards and phrase table, status and statements, import script, Cortex page | a851131, 84627ef, cac1585, e6bf814, aad66b4 | AT-50, AT-53, AT-54, AT-55 |
| O1–O6 | offline history build, angle run, measurement, setups, permission (private tools and outputs) | not in the repo (SEC-110) | private tool tests |
| O7 | calibration report: full report private; family-level KB item imported as a `review` document (D-469) | c36b267 | `tests/cortex/import.test.ts` |
| O8 | independent statistician review: pass with notes, no blocking finding (D-461) | ac25dbe | AT-54 |

## 3. Acceptance
| Test | Result | Report |
|---|---|---|
| AT-50 determinism and as-of truth | pass locally, 12 tests | `docs/test-reports/AT-50.md` |
| AT-51 calibration statistics | pass locally, 14 tests | `docs/test-reports/AT-51.md` |
| AT-52 economics and order rules | pass locally, 8 tests | `docs/test-reports/AT-52.md` |
| AT-53 passport, distinctness, ledger | pass locally, 5 tests | `docs/test-reports/AT-53.md` |
| AT-54 statements and statistician pass | pass locally, 13 tests, plus the O8 review | `docs/test-reports/AT-54.md` |
| AT-55 plain words | pass locally, 10 tests | `docs/test-reports/AT-55.md` |
| AT-56 gate fixtures 1–11 | pass locally, 19 tests | `docs/test-reports/AT-56.md` |

## 4. Gates (local, Windows build machine, 2026-11-01)
- `npx vitest run tests/acceptance/v2/at50…at56`: 81 of 81 pass (7 files), 9.6 s.
- `npx vitest run tests/cortex/import.test.ts`: 20 of 20 pass. Dry run of the import on the private artefact: 100 passports, 538 cells, 2 maps, 1 document, 0 families allowed, 2 in shadow; nothing written.
- The full gate (vitest, worker, smoke, e2e) runs once before the V2 PR; remote CI has not run.

## 5. Open items for the Owner
- **Staging import:** run `node scripts/cortex/import.mjs <artefact-folder>` against staging after migrations 0015–0020 are applied there (the artefact is private, on the build machine).
- **CTX-052 LLM organ warm-up in staging:** starts once `build` is deployed to staging. The organs feed no score (AT-50 clause 2).
- **Process notes from O8 (D-461):** two pre-measurement changes (D-340, D-298) were entered late in the freeze change-control list; the D-378 coverage rule came after run 1 was opened (declared, charged, and it lowered the best cell); decile band edges are cut in-sample; O6 had a mid-run patch.
- **Survivorship:** the extract has no delisted codes; the pre-registered 1.5 pp per holding-year haircut is shown in the report and only lowers the figures.
- **KB type (D-469):** the report is a `review` document with `kind: cortex_calibration`, so no rebuild of a live table is needed. The import has no banned-word check (those lists are TypeScript); the report text was checked when it was written.
- Push of `build`, then remote CI.

**M15 closed locally: yes, pending the staging import, the CTX-052 warm-up in staging, and remote CI.**
