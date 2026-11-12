# M19 exit evidence: market-profile refactor (V3)

Design: `docs/M19_design.md`. Requirements: `docs/M19_requirements.md`. Each section below is filled by the task that owns it; a section that is still a placeholder is not yet evidence. Sections 1 and 8 are filled by the orchestrator on the exit tree.

## §1 Literal count (AT-67)

Placeholder (orchestrator). To record: the 80-file list at `2d1bdd4` by the D-991 rule, the exit run of `node scripts/ci/market-literals.mjs --count` (expect "0 files with a literal outside the allow-list" and "0 files hold a quoted AU"), and the allow-list contents. Stream E's measurement on the integrated `build` (`8ed6a6eb`) plus stream E is in D-1078: nine classes, 197 hits in 70 files before the carve-outs of D-1075, 82 in 38 after them, 0 after D-1077 and the 18 entries of D-1076 (126 hits in the allowed folders and files, 1,080 files scanned). The allow-list is `src/lib/market/**`, the two files of `src/lib/market/seed/allow.mjs` and the entries of `EXTRA_ALLOW` in `scripts/ci/market-literals.mjs` (each with its reason).

## §2 Tasks

Placeholder (orchestrator): the stream and task table with merge commits and test files (the M18 format). Stream E commits on `v3/m19-e`: E1 `00306605` (scan, residual replacements), E2 `9a725e92` (AT-68 suite, e2e, production shape, CI steps), then the E3 commits (test map, reports, docs, decisions D-1075 to D-1085).

| Task | Files (tests first) | Result |
| --- | --- | --- |
| E1 AT-67 scanner | `scripts/ci/market-literals.mjs`, `.d.mts`, `scripts/ci/market-literals.test.mjs`, `tests/static/marketLiterals.test.ts`, `package.json` (`test:market-literals`), `ci.yml` step | 0 literals outside the allow-list |
| E2 AT-68 suite, e2e, states | `tests/acceptance/v3/at68.test.ts`, `worker/test/at68Worker.test.ts`, `e2e/market-off.spec.ts`, `e2e/support/leaks.ts`, `e2e/seed/states/markets-dev.mjs`, `e2e/prepare-db.mjs`, `scripts/e2e-day/assert-production-shape.mjs` (+ test), `tests/e2e/marketsDev.test.ts`, `ci.yml` steps, `scripts/ci/e2e-listing.test.mjs` | unit clauses pass locally; the Playwright spec and the recorded-day step run in CI |
| E3 Matrix, test map, reports, docs | `docs/test-map.md`, `tests/test-map.baseline.json`, `docs/test-reports/AT-67.md`, `AT-68.md`, `AT-75.md` (+ AT-32, AT-50, AT-85), `docs/owner-guide/operations.md`, `docs/runbooks/gates.md`, decisions D-1075 to D-1085 | test map: 0 findings |

## §3 Identity

Placeholder (orchestrator): the AT-32 and AT-50 baseline hashes and the exit hashes (equal), the AU constants snapshot diff (empty), the AU slot snapshot diff (empty), Fable's review notes per F task. The three identity tests are `tests/acceptance/v3/replayHash.test.ts`, `tests/market/auConstants.test.ts` and `worker/test/auSlots.test.ts`; none of the three baseline files is rewritten by stream E.

## §4 Profile

Placeholder (orchestrator): the seeded field table per market (values, `verify`, `evidence_ref`), the completeness result (AU complete; IN and US incomplete with counts), the `market` projection check. Matrix fixtures: `tests/market/profiles/AU.json`, `IN.json`, `US.json` equal their seeds (`node scripts/market/gen-fixtures.mjs --check`, D-1085).

## §5 Off in production

Report: [test-reports/AT-68.md](test-reports/AT-68.md). Stream E's part: (a) `worker/test/at68Worker.test.ts` and the script and workflow cases of `tests/acceptance/v3/at68.test.ts`; (b) the planted `price_bar` insert and the nightly invariant in the same file; (c) the unit clauses there and the walk `e2e/market-off.spec.ts` (empty lane, CI). The production-shape check on the recorded day's database is `scripts/e2e-day/assert-production-shape.mjs`, the step before the network assertion of job `recorded-day` (D-1079). To record by the orchestrator: the CI run of the walk and of that step, and the production read-only check `SELECT code, enabled, mode FROM market` after the deploy (AU `1 full`, IN `0 off`, US `0 off`), taken from the maintenance route's run record, never by hand.

## §6 UI and e-mail

Placeholder (orchestrator): the Markets row rendering per role (`tests/acceptance/v3/at68.test.ts`, `tests/settings/pages.test.tsx`), the e-mail snapshots unchanged, the three currency formats (`tests/view/format.test.ts`). The Markets table now carries a `data-markets-table` attribute (D-1077) so the e2e walk can cut it out.

## §7 Acceptance

| AT | Report | Home |
| --- | --- | --- |
| AT-67 | [test-reports/AT-67.md](test-reports/AT-67.md) | CI |
| AT-68 | [test-reports/AT-68.md](test-reports/AT-68.md) | CI and CI recorded-day |
| AT-75 (AU) | [test-reports/AT-75.md](test-reports/AT-75.md) | CI |
| AT-32, AT-50 | [test-reports/AT-32.md](test-reports/AT-32.md), [test-reports/AT-50.md](test-reports/AT-50.md) | CI |
| AT-85 | [test-reports/AT-85.md](test-reports/AT-85.md) | CI |

## §8 Constraints

Placeholder (orchestrator): Turso at or below 20 per cent (Usage page figure on the exit day; the guard's probe cost measured on one night), zero `OFFSET`, no staging path, `ASX_LIVE` off, `$0`, gitleaks clean, decision index, config reference and architecture model regenerated and checked, migration count tests at 35.

## §9 Owner steps for the PR

None new in M19 beyond the standing V3 list. The PR lists D-994 (`PRAXIS_MARKETS_ENABLED` is unset in production, meaning `["AU"]`; the Owner sets it only with the M20 switch-on), D-1003 (currency labels on money keys now read "market currency"), D-1005 (numbering) and, from stream E, D-1075 (the Owner's zone, locale and the word "Melbourne" are not scanned as market facts).

## §10 BUILD_SETUP §9

Placeholder (orchestrator): "V3 current milestone" = M19 done; "V3 last step done / next step" = M19 exit / M20 requirements extract.
