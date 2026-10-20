# M7 exit evidence (AT-25, AT-26, AT-27)

Status date: 2026-10-21. Branch `build`. Source rows: [spec/14_system_acceptance.md](../spec/14_system_acceptance.md) section 14.4. Test files are listed in [test-map.md](test-map.md) (M7 rows). Requirements: [M7_requirements.md](M7_requirements.md). Design: [M7_design.md](M7_design.md).

Overall: every page of chapter 09 is built — the six tabs (Home, Strategies, Picks, Market, News, Reviews), the Control Room and the gear-menu pages — role-aware and masked for Editors and Viewers, on one shell with six themes. They pass their local unit, component and page tests on synthetic data. The parts that need the Owner, staging or production are **pending**, not faked. M7 exit is **met locally, not yet on staging or in production** (the AT-25…AT-27 staging run waits for the release that applies main 0007…0011 and auth 0004…0006, D-022).

> DRAFT — the T20 rows marked *pending T20* are filled when the acceptance builders finish.

## Commits

Range `c790f98^..HEAD`. Tasks ran in seven parallel groups (design §7); each group was integrated and passed the full gate on `build` before it was pushed.

| Commit | Task | Decision |
|---|---|---|
| c790f98 | M7 requirements extract | |
| ee88b68 | M7 design and architect decisions (60, all option A) | D-128 |
| d721aba | T2 masking module, unmask grants, auth 0006, main 0011; existing leaks fixed on `/cards`, `/reviews`, `/api/alerts` | D-129 |
| 0eede41 | T1 design tokens, fonts, breakpoints, contrast and CSP checks | D-130 |
| 011bf1e | T3 test and CI harness, page registry and guard test, E2E seeds | D-131 |
| b802ad9 | T4 back-end rows for pages | D-132 |
| f285e8e | group 1 integration | |
| 0d49449 | T5 UI primitives | D-133 |
| a2eba11 | T6 charts (Lightweight Charts island, SVG charts) | D-134 |
| c751e91 | T7 loaders part 1, opaque `ck:` card refs | D-135 |
| 413b7ad | T8 loaders part 2 and JSON routes | D-136 |
| e4bf189, 5908e68 | group 2 integration, decisions | |
| 8752479 | T9 app shell and role-aware navigation; single clock read for unmask grants | D-137 |
| aae3fdc | T10 Control Room | D-138 |
| ff541a5 | group 3 integration | |
| 3d2d17a | T11 Home | D-140 |
| 37eca47 | T12 Strategies | D-141 |
| 262d287 | T13 Risk overview, trade ideas, Decision Card, Owner pause/kill | D-142 |
| 56e6eee, 9891447 | T14 Picks, masked `pk:` refs | D-143 |
| d0ca082 | group 4 integration; Opus-review safety fixes: a kill always wins in batch 2b, keyed opaque refs | D-139 |
| 88bf932 | T15 Market, company page, watchlist star | D-144 |
| 2a66066 | T16 News and alert inbox | D-145 |
| a6559e0 | T17 Reviews and Glossary | D-146 |
| 3ac1437 | T18 What the system learned (`/learning` → `/reviews/learned`) | D-147 |
| 3138453 | group 5 integration | |
| a51f302 | T19a Settings | D-148 |
| 4352c2d | T19b Ops checklist, What-if, Usage LLM section | D-149, D-150, D-151 |
| e4c8d28, b51ab89 | T19c restyle of Users, Configuration, Data review | D-151 |
| 5064929 | group 6 integration | |
| *pending T20* | T20a licence, bundle, readability and Lighthouse checks; T20b bundle fixes; T20c readability fixes and AT-25…27 E2E suites | |

## Test counts

Full suite at group 6 (`npx vitest run`, local): **307 files, 5,669 tests: 5,646 passed, 23 skipped** in the combined run (one file, `tests/risk/pages.test.tsx`, failed to start a worker under machine load and passed alone, 21/21); route coverage 81/81; smoke 246/246; build and type check clean. *Final counts pending T20.*

## AT checklist

- **AT-25 Pages and states: met locally (unit and page level); E2E pending T20.** Every page renders its own `<main>` and h1 under the shell; empty, stale and error states use stored text only (no sample rows, UX-102); every page is in the nav model and the page registry, and the page-guard test checks each page's server guard against its registered action. Masking (DAT-124, UX-009): page tests assert no stock code, company name, internal id or exact `YYYY-MM-DD` date in Editor and Viewer HTML (links included) on Home, Strategies, Picks, Risk, Ideas, Decision Card, Market, News, Reviews and Knowledge; Owner and unmask-granted users see real values. Masked users reach cards, picks, alerts and reviews only by keyed opaque references (`ck:`, `pk:`, `mk:`, `rv-`; D-139); a real id from a masked user gives the same 404 as an unknown one. *Pending T20: the AT-25 E2E sweep over all pages and roles.*
- **AT-26 Mobile, accessibility, performance: partly met locally.** Shell: all six tabs fit at 360 px (measured, e2e-guarded), keyboard order with skip link first, Esc closes menus, no positive tabindex, axe clean for all roles with menus open (T9). Component and page axe checks run in jsdom on every new page. Contrast for every text and graphic token pair in all six themes (`scripts/ci/contrast-check.mjs`). Lighthouse on Home (mobile, populated seed, median of 3): performance 92–94, FCP ≈ 0.8 s — pass; LCP ≈ 2.8 s is over the 2.5 s warning line. *Pending T20: bundle budgets (shared first-load 143 KB against 120 KB; `/strategies` 174 and `/news` 178 KB against 150 KB were over before T20b), the readability check (4 failures on `/users` and `/config` before T20c), the full E2E run in a real browser.* **Not evidenced:** the manual keyboard and screen-reader check (AT-26 s11) and the AT-30 walkthrough, both at M8.
- **AT-27 Simulated and reality labels: met locally (page level); E2E pending T20.** Every `[data-money]` value on Home sits in a card with the Simulated label, and real end-of-day prices on Market are plain figures labelled "End-of-day price", never `data-money` (D-144). Picks and track record carry "Price only — dividends not included" (D-143). *Pending T20: the AT-27 label audit over all pages in the E2E run.*

## Decisions

D-128 (design, 60 decisions), D-129 (masking), D-130 (tokens), D-131 (harness), D-132 (back-end rows), D-133 (primitives), D-134 (charts), D-135 (loaders 1), D-136 (loaders 2 and JSON routes), D-137 (shell), D-138 (Control Room), D-139 (a kill always wins; keyed opaque refs), D-140 (Home), D-141 (Strategies), D-142 (Risk, ideas, Decision Card, Owner pause/kill), D-143 (Picks), D-144 (Market), D-145 (News and alerts), D-146 (Reviews and Glossary), D-147 (Knowledge), D-148 (Settings), D-149 (Ops), D-150 (What-if), D-151 (Usage LLM and restyle), all in [07_decision_log.md](07_decision_log.md).

## Open / pending

- (a) **Owner decisions and approvals** (nothing below is faked or done):
  - **Licences (UXN-019):** 16 production packages are outside the allow-list — 14 optional `sharp` platform packages (`@img/sharp-libvips-*` LGPL-3.0-or-later, `@img/sharp-wasm32`, `@img/sharp-win32-*` with LGPL-3.0-or-later in an AND combination), `tslib` (0BSD) and `caniuse-lite` (CC-BY-4.0). Approve exceptions or ask for the `sharp` packages to be excluded. Settings › About marks them "needs Owner approval".
  - approve the new dependencies `lightweight-charts`, `@radix-ui/react-dialog`, `@radix-ui/react-popover`, `server-only` and dev-only `lighthouse`;
  - confirm the UXN-284 deviations (decisions 43–45), the validation-label, scenario and colour-option text (decisions 4–6);
  - confirm the DAT-124 reading for company pages (decision 21, built as written, D-144) and, for delayed prices, the quote source (decision 22, not built);
  - review the changed `ci.yml` (licence, bundle, readability and Lighthouse steps) at the M8 review point;
  - the TST-127 screenshot baselines need a read-only fixtures-repo token for the staging job (decision 20);
  - spec housekeeping: the superseded tab lists (decision 1), "Dashboard" in NFR-010 and ch.09 (decision 14), ROL-102a for snooze, quiet hours and watchlist (decision 9), the mockup file (decision 36);
  - at M8: the manual keyboard and screen-reader check (AT-26 s11) and the AT-30 walkthrough.
- (b) **Migrations main 0011 and auth 0006** (with 0007…0010 and 0004…0005 from M3–M6) are not applied anywhere; they reach staging and production at the M8 review point (D-022).
- (c) **Known limits and follow-ups** (each listed in its decision): no hourly health data, so no per-segment 24 h sparkline (D-138); a Control Room refresh reads about 550 rows (D-138); UXN-046 attention reasons 3–5 shown as badges, not counted (D-141); success-over-time and backtest lines on Picks (D-143); no market cap, P/E, yield or delayed intraday prices (D-144); no per-strategy holders on news items (D-145); the T8 `loadKnowledge` model still carries raw dates for masked users (D-147); `times_in` stored but with no display effect while only AU exists (D-148); the PLT-022b 40-day offsite reminder (D-149); challenger answers in What-if (D-150).
- (d) **Carried from [M6_exit_evidence.md](M6_exit_evidence.md), still open:** every item in its section "Open / pending".
