# M19 exit evidence: market-profile refactor (V3)

Design: `docs/M19_design.md`. Requirements: `docs/M19_requirements.md`. Each section below is filled by the task that owns it; a section that is still a placeholder is not yet evidence. Sections 1 and 8 are filled by the orchestrator on the exit tree.

## §1 Literal count (AT-67)

Exit tree `d476057d`: `node scripts/ci/market-literals.mjs --count` prints "market-literals: 0 files with a literal outside the allow-list (0 hits)" and "market-literals: 0 files hold a quoted AU (D-991 count)". The measurement path is D-1078: nine classes, 197 hits in 70 files before the carve-outs of D-1075, 82 in 38 after them, 0 after the replacements of D-1077 and the 18 entries of D-1076 (126 hits in the allowed folders and files, 1,080 files scanned). The allow-list is `src/lib/market/**`, the two files of `src/lib/market/seed/allow.mjs` and the entries of `EXTRA_ALLOW` in `scripts/ci/market-literals.mjs`, each with its reason; an unused entry fails the scan. Facts the scan does not see (numeric duplicates, four session times, allow-listed per-market facts) are recorded for M20 in D-1090.

## §2 Tasks

Merge commits on `build`: A1 `bc56ab9a`, C `6acbbdf0`, D `181622ef`, B `bfb9c7b8`, A2 `f45b8c8e`, E `a7bc2658`. Integration fixes after the merges: `794b3a61` (e2e state `market-built-off` asserts the M19 shape), `1d83e788` (Worker clock test accepts a dispatch with inputs), `b11c1f23` (batch 1 and the calendar draft write no run record for a market with no row, D-1050), the watchdog slot-time test (D-1053), a Prettier pass, and `d476057d` (Fable exit review). Stream E's own commits: E1 `00306605`, E2 `9a725e92`, E3 `33f50c3c`.

| Task | Files (tests first) | Result |
| --- | --- | --- |
| E1 AT-67 scanner | `scripts/ci/market-literals.mjs`, `.d.mts`, `scripts/ci/market-literals.test.mjs`, `tests/static/marketLiterals.test.ts`, `package.json` (`test:market-literals`), `ci.yml` step | 0 literals outside the allow-list |
| E2 AT-68 suite, e2e, states | `tests/acceptance/v3/at68.test.ts`, `worker/test/at68Worker.test.ts`, `e2e/market-off.spec.ts`, `e2e/support/leaks.ts`, `e2e/seed/states/markets-dev.mjs`, `e2e/prepare-db.mjs`, `scripts/e2e-day/assert-production-shape.mjs` (+ test), `tests/e2e/marketsDev.test.ts`, `ci.yml` steps, `scripts/ci/e2e-listing.test.mjs` | unit clauses pass locally; the Playwright spec and the recorded-day step run in CI |
| E3 Matrix, test map, reports, docs | `docs/test-map.md`, `tests/test-map.baseline.json`, `docs/test-reports/AT-67.md`, `AT-68.md`, `AT-75.md` (+ AT-32, AT-50, AT-85), `docs/owner-guide/operations.md`, `docs/runbooks/gates.md`, decisions D-1075 to D-1085 | test map: 0 findings |

## §3 Identity

AT-50 baseline `2d14c0033689c291f6a881c48ec818d75948b94d45cf0207e396b873ede885c2` and AT-32 combined `e49410a749c6aa5b3a3d195452ea070a24dcd51cf9606da936274522d1d3883f` (`tests/acceptance/v3/replay-hash.baseline.json`, written at step 0, never rewritten); `tests/acceptance/v3/replayHash.test.ts` is green on the exit tree, so the exit hashes equal them, and AT-32 also asserts the AU `market` row columns. `tests/market/auConstants.test.ts` and `worker/test/auSlots.test.ts` are green; the two snapshot files changed once since step 0, in A1's commit `f3853c6e`, by a Prettier reflow of array wrapping only (values identical, verified by the Fable review), before they were added to `.prettierignore`. Fable exit review (2026-11-12): B, A2, C1, E and byte identity ACCEPTED; follow-ups D-1086 to D-1090 for M20; D-1020 corrected (the script and Worker clients are not yet wrapped; the trigger still refuses).

## §4 Profile

Three seeded markets, 40 profile fields each (`tests/market/profile.test.ts`). Completeness (`tests/market/completeness.test.ts`): AU complete; IN and US incomplete by design, 36 of 40 fields valued (four are set at M20: `tiers`, `slippage_buckets`, `sleeve_reality_cap`, `bar_latency_p95_min`) and 0 of 40 verified (every [VERIFY] value awaits its evidence). The `market` projection is checked by `tests/market/projection.test.ts` (AU `slots_json` equals the recorded Worker slots). Matrix fixtures `tests/market/profiles/AU.json`, `IN.json`, `US.json` equal their seeds (`node scripts/market/gen-fixtures.mjs --check`, D-1085).

## §5 Off in production

Report: [test-reports/AT-68.md](test-reports/AT-68.md). Stream E's part: (a) `worker/test/at68Worker.test.ts` and the script and workflow cases of `tests/acceptance/v3/at68.test.ts`; (b) the planted `price_bar` insert and the nightly invariant in the same file; (c) the unit clauses there and the walk `e2e/market-off.spec.ts` (empty lane, CI). The production-shape check on the recorded day's database is `scripts/e2e-day/assert-production-shape.mjs`, the step before the network assertion of job `recorded-day` (D-1079). To record by the orchestrator: the CI run of the walk and of that step, and the production read-only check `SELECT code, enabled, mode FROM market` after the deploy (AU `1 full`, IN `0 off`, US `0 off`), taken from the maintenance route's run record, never by hand.

CI evidence: run `43205552193` on `build` at `6f4d2a6d` is green in every job (app with AT-67 and AT-68 steps, worker, python, secrets, coverage, fixtures, audit, checks, e2e with the `market-off` walk in the empty lane and the rich lane, recorded-day with the production-shape step). Three integration fixes made it green after the exit tree: the hygiene allow-list for the V3 milestone docs (`6a4f8b9e`, Owner approved 2026-11-12), the `market-off` walk counts the Markets rows in the `<table>` only (`e0b225dc`, DataTable also renders the card view), and the rich e2e seed checks its own `execution` row instead of any pick (`6f4d2a6d`, the `E2E_STATES` overlays add a pick first; the rich lane had not run green since M18 D3). This run is the M20 start gate (D-1126).

## §6 UI and e-mail

The Markets row per role is asserted in `tests/acceptance/v3/at68.test.ts` and `tests/settings/pages.test.tsx` (Owner: IN and US "Built — off in production"; Editor and Viewer: enabled rows only). The e-mail tests are green with AU alone enabled (same SQL, same payload, D-1061). The currency formats are pinned by `tests/view/formatBranches.test.ts` (AU `A$`, `en-IN` lakh grouping, an unregistered code as "CODE 1.50") and the dual-time rule by `tests/preferences/format.test.ts` (AU single Melbourne form on every day, D-1063). The Markets table carries `data-markets-table` (D-1077) for the e2e walk.

## §7 Acceptance

| AT | Report | Home |
| --- | --- | --- |
| AT-67 | [test-reports/AT-67.md](test-reports/AT-67.md) | CI |
| AT-68 | [test-reports/AT-68.md](test-reports/AT-68.md) | CI and CI recorded-day |
| AT-75 (AU) | [test-reports/AT-75.md](test-reports/AT-75.md) | CI |
| AT-32, AT-50 | [test-reports/AT-32.md](test-reports/AT-32.md), [test-reports/AT-50.md](test-reports/AT-50.md) | CI |
| AT-85 | [test-reports/AT-85.md](test-reports/AT-85.md) | CI |

## §8 Constraints

Turso: the guard adds one primary-key probe per inserted row (`EXPLAIN QUERY PLAN` asserted in `tests/db/0035_m19_market_guard.test.ts`); the cold-isolate Worker cost is four requests instead of three (D-1047), inside the PLT-070 margin; the plan stays on the free tier budget (the production Usage page is read at the first deploy after the PR). No `OFFSET` paging in `src`, `worker/src`, `scripts` or `db` (grep of `OFFSET <n|?>` outside tests: none). No staging path. `ASX_LIVE` is a dashboard variable and stays off. Running cost `$0`. Decision index, config reference, architecture model and steelman readers are checked (`npm run test:architecture`, `test:config-reference`); migration count tests are at 35. Exit tree root suite: 10,004 passed, 2 skipped, 1 load flake (`tests/preferences/page.test.tsx`, 14 of 14 on rerun); Worker suite green; `test:smoke` green; `lint:workflows` 0 findings. `test:hygiene` reports HYG-PRIVATE on `docs/M19_design.md` and `docs/M19_requirements.md` until the Owner approves their allow-list entries. Python tests run only in CI (no Python on the build machine).

## §9 Owner steps for the PR

None new in M19 beyond the standing V3 list. The PR lists D-994 (`PRAXIS_MARKETS_ENABLED` is unset in production, meaning `["AU"]`; the Owner sets it only with the M20 switch-on), D-1003 (currency labels on money keys now read "market currency"), D-1005 (numbering) and, from stream E, D-1075 (the Owner's zone, locale and the word "Melbourne" are not scanned as market facts).

## §10 BUILD_SETUP §9

"V3 current milestone" = M19 done (local `build` `d476057d`); "V3 last step done / next step" = M19 exit evidence / push `build`, check CI, then M20 requirements extract.
