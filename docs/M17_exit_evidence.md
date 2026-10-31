# M17 exit evidence: intraday watch and pick alerts (V2)

_2026-11-01 (Melbourne time). Design: `docs/M17_design.md`; requirements: `docs/M17_requirements.md`; decisions D-381…D-478. Built on `build` from the M16 line; WP1 to WP9 merged, WP10 on `v2/m17-wp10`. V2 ships in one PR at the end (O-73); nothing here is pushed or deployed yet._

## 1. Work packages
| WP | What | Merge | Tests |
|---|---|---|---|
| requirements, design | M17 extract, design with D-381…D-396, architect review D-397…D-400 | 6e644f0, dd49b23, 1f47c43 | none (documents) |
| WP1 quote source | delayed quote parser, fetcher, budget, synthetic fixture; delay-aware freshness (D-441) | 9cb472e | `tests/quotes/contract.test.ts`; AT-61 c |
| WP7 confidence, order, badge | `chanceDisplay`, sort, dormant floor, single family badge table (D-393) | 80613eb | `tests/picks/wp7.test.ts`; AT-64 a, b, c; AT-65 c, d |
| WP2 schema and keys | migration 0020 (four tables, `email_message` rebuild D-443), M17 keys, `yahoo_delayed` source (pending, D-398), quote-source state reader | 1ef6814 | `tests/db/0020_intraday.test.ts`, `tests/config/m17Keys.test.ts`; AT-60 c |
| WP3 + WP5 alert state machine, scan, Worker slots | `evaluateAlert`, arming, `pick-alerts` route; `intraday-scan` route, candidate rule, gates, levels; the two Worker slots; AT-60 order-boundary guard | d0f1948 | `tests/alerts/*`, `tests/intraday/*`, `worker/test/m17Slots.test.ts`, `tests/security/at60OrderBoundary.test.ts`; AT-60 a, c, e; AT-61 a, b, c |
| WP6 hand-over and outcome | `recordOutcomes` read-after-run, one call in the evening-review handler (D-456…D-459) | 7c3e5e1 | `tests/acceptance/v2/at61.test.ts`; AT-61 d, e |
| WP9 measurement | `measureCandidates`, VAL-118 evaluator, stream-state writer, monthly alerts report (D-462…D-467) | a709c11 | `tests/acceptance/v2/at63.test.ts`; AT-63 a to d |
| WP4 pick e-mails | EML-038…042, own cap, batching, quiet-hours digest, Evening Review lines, candidate mail, preferences (D-448…D-455); crash-safe batch key and atomic cap (D-470) | 42f95fd, e793fb6 | `tests/email/pickAlerts.test.ts`, `tests/acceptance/v2/at60Mail.test.ts`; AT-60 b; AT-62 c, d, e |
| WP8 UI | Tonight's picks and Intraday watch, alert chip, My alerts, Settings > Alerts, Home rows, company header, sort toggle (D-471…D-478) | 03d36eb | `tests/picks/wp8.test.tsx`, `e2e/picks-sections.spec.ts`; AT-62 a, b; AT-64 d, e; AT-65 a |
| WP10 exit | architecture model (pages, actions, host), order-boundary extension (WP4/6/8/9 files), `tests/security/noBrokerLinks.test.ts` (no broker link, no buy-now wording, NFR-041 wording), AT-60…AT-65 reports, this document | commit on `v2/m17-wp10` (hash in the merge) | `tests/security/at60OrderBoundary.test.ts` (17), `tests/security/noBrokerLinks.test.ts` (14) |

Decisions: D-381…D-396 (design), D-397…D-400 (architect review), D-441…D-478 as adopted per package; see `docs/M17_design.md`.

## 2. Acceptance
| Test | Result | Report |
|---|---|---|
| AT-60 alert state machine | pass locally (a, b, c, d, e) | `docs/test-reports/AT-60.md` |
| AT-61 intraday scan | pass locally (a, b, c, d, e) | `docs/test-reports/AT-61.md` |
| AT-62 UI and e-mail | pass locally for b, c, d, e and NFR-041; (a) e2e spec written, not yet run | `docs/test-reports/AT-62.md` |
| AT-63 measurement | pass locally (a, b, c, d) | `docs/test-reports/AT-63.md` |
| AT-64 confidence display and ordering | pass locally (a, b, c, d, e) | `docs/test-reports/AT-64.md` |
| AT-65 family badge | partial: a, d pass; (b) contrast per badge x theme is not evidenced; (c) sheet DOM not asserted; e2e theme walk written, not yet run | `docs/test-reports/AT-65.md` |

## 3. Gates (local, Windows build machine, 2026-11-01, branch `v2/m17-wp10`)
- Acceptance files `at60Mail`, `at61`, `at63`, `at64`: 4 files, 17 tests pass.
- `tests/email/pickAlerts.test.ts`, `tests/quotes`, `tests/db/0020_intraday.test.ts`, `tests/alerts`, `tests/intraday`: 13 files, 229 tests pass. `worker/test/m17Slots.test.ts`: 13 of 13.
- `tests/security`: 8 files, 447 tests pass. `tests/picks`: 15 files, 132 tests pass.
- `npm run test:architecture`, `npm run test:routes`, `npm run test:hygiene`, `npx tsc --noEmit -p .` and eslint on the touched files: see the WP10 commit message for the final run.
- The full Vitest, smoke and e2e suites were not re-run for this package; remote CI has not run.

## 4. Open items for the Owner
1. **D-398: accept the `yahoo_delayed` source and the two Worker slots.** Both are off until the Owner accepts the source in Settings > Data sources (licence note O-26 extended for the request pattern) and lists the slots. Until then both routes skip with a System Health line and nothing is requested, armed or written.
2. **D-443: `email_message` rebuild.** Migration 0020 copies all rows of a live table to widen the `kind` CHECK. To be checked on the staging migration before the V2 PR.
3. **D-462: excess is measured against the market index, not a sector index.** No sector series is stored (only `^AXJO`), so the report says "beyond the market". Revisit when a sector series exists.
4. **D-457 / D-459 labelling caveat.** A code the Cortex took in the shadow arm that is not a V1 pick records `rejected:rank` (AGT-144 has three outcomes only). No outcome is recorded before the night has run.
5. **D-473: no per-alert unmute.** Mute is one final `cleared`/`muted` transition (the state machine is append-only); "alerts for all picks" is the way back.
6. **D-470 residual: closed by D-479** (prefix split in `deliver`; an accepted or pending earlier batch keeps its own key). Remaining budget note: D-502 (watch/held codes spend poll budget; the 2,000 cap holds).
7. **e2e not yet run.** `e2e/picks-sections.spec.ts` (AT-62 a, AT-65 theme walk) is written, not run.
8. **AT-65 (b), (c)**: evidenced by `tests/acceptance/v2/at65.test.tsx` (D-501); the six-theme e2e walk is still not run.
9. **Push and remote CI.** `build` is not pushed; remote CI (gitleaks history, e2e, Linux jobs) has not run.

## 5. Final review (Fable)
_2026-11-01 (Melbourne time), worktree `v2/m17-final` from `build` at 4dd9d7b. Decisions D-479 and D-500…D-502 in `docs/M17_design.md`._

**Verdict: MERGE AFTER MY FIXES** (the fixes are on `v2/m17-final`).

| Priority | Finding | State |
|---|---|---|
| 1 D-443 `email_message` rebuild | Table, index and trigger text identical to 0009 except the five added kinds; the copy names every column; the down path lifts only the two prune guards it needs and restores the 0009 text. No `REFERENCES` constraint exists in the main schema (the attempt link is a trigger), so `PRAGMA foreign_keys` has nothing to act on; one libsql `batch("write")` per file. Parity was not asserted by test. | fixed: parity test added to `tests/db/0020_intraday.test.ts` (D-500) |
| 2 AT-60 order boundary | `tests/security/at60OrderBoundary.test.ts` is not vacuous: closure-based import guard with a self-test, SQL allowlist of the four M17 tables with a self-test, triggers, replay hash on vs off with alerts > 0 and candidates > 0, and the WP4/6/8/9 file set. | reviewed, no change |
| 3 Alert delivery | Duplicates, cap, P0 headroom and quiet hours are covered. The D-470 residual was wider than stated: a crash after the provider accepted followed by any new hit before the next tick gave the changed set a fresh key and re-mailed the earlier items. | fixed: prefix split in `deliver` (D-479), two tests |
| 4 Free quota and scheduler | Both routes skip before arming until `yahoo_delayed` is enabled, on and dispatch is on; the claim reserves the tick's count so 2,000/day cannot be exceeded; DST (both changes) and early close (2026-12-24 14:10) are tested. The poll spends budget on watch/held codes every tick, so a busy day can reach the 80 % band early and the 95 % stop before the close. | open for the Owner (D-502), cap holds |
| 5 Shadow honesty | "Unrated", "Unvalidated", "Not enough history yet" and "delayed" everywhere; `intraday_stream_state` has one writer (`streamState.ts`, grep-pinned in AT-63); D-462 "beyond the market" is stated on the alerts report page; `streamCost.ts` uses `costPerOrder` (D-311) at the A$1,000 parcel. | reviewed, no change |
| 6 WP10 gaps | No at62/at65 acceptance files; AT-65 (b) and (c) unevidenced; e2e not run. The CI contrast checker already covered the badge hues per theme. | fixed: `tests/acceptance/v2/at62.test.tsx` (4) and `at65.test.tsx` (12) added (D-501); e2e stays with the orchestrator's full gate |

Gates on `v2/m17-final` (2026-11-01): `npx vitest run tests/acceptance/v2 tests/security tests/email tests/picks tests/intraday tests/db tests/review tests/worker tests/alerts tests/quotes` → 74 files, 1,463 tests pass; `npx tsc --noEmit -p .` clean; eslint clean on the touched files. Not run here: the full Vitest suite, smoke, e2e, remote CI.
