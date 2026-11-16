# M21 exit evidence: UI residuals and Owner tools (V3)

Design: `docs/M21_design.md`. Requirements: `docs/M21_requirements.md`. The section headings below are the exit checklist of the design (section "Exit checklist"). This file was completed by task Z on the branch `v3/m21-z` (`build` with every M21 task merged). **"to be filled at push"** marks the only values that need a push and a CI run; nothing else is open in this file. **Every Playwright spec was written against the seed states and the page registries and was NOT run locally**: a Next production build fails inside `wt-*` worktrees (the node_modules junction), so each e2e spec is verified by the CI `e2e` job only (section 11).

## §0 Gate

The CI run that proved M20 green on `build` before the first M21 merge (D-1200): run **43347157615** on commit `6c556e7a`. The final CI run on the pushed head: **to be filled at push**.

## §1 Cross-check (UXN-319, D-1201)

`docs/M21_ui_crosscheck.md`: 35 rows, every `[PROPOSED]` id of v1 ch. 16 once, with a verdict. The D-1201 amendment gave **5 accepted, 7 superseded, 23 rejected** (the first draft was 2, 12 and 21; after the U0 challenge `d60b7d15`, UXN-062, 154 and 255 moved to accepted as task C7 and 109, 117, 205, 250 and 252 from superseded to rejected, D-1201 amended). `scripts/ci/ui-crosscheck.test.mjs` (3 tests, written by Z, D-1329) checks that every id has one verdict in the allowed set, that the amended D-1201 rulings cover the 35 as 5, 7 and 23, and that each accepted id names an existing test.

| Accepted | Where it landed | Task | Proof |
| --- | --- | --- | --- |
| UXN-008 skeleton loading | `SectionLoading` in `src/app/(app)/market/sections.tsx` renders a shaped skeleton | C1 (D-1206, D-1232) | `tests/market/sectionLoading.test.tsx` |
| UXN-010 offline badge | `src/components/pwa/OfflineBadge.tsx` (root layout, client only) | P1 (D-1282) | `tests/pwa/components.test.tsx`, `e2e/m21-pwa.spec.ts` |
| UXN-062 Leaderboard factual card | `src/app/(app)/strategies/leaderboard/ControlsSummary.tsx`, above "Matched controls", from the loaded rows | C7 (D-1305) | `tests/strategies/controlsSummary.test.tsx`, `e2e/m21-crosscheck-accepted.spec.ts` |
| UXN-154 donut or treemap beside the concentration bars | `src/components/charts/ConcentrationChart.tsx` (hand-drawn SVG, a screen-reader table, masked labels) on the Risk page | C7 (D-1306) | `tests/charts/concentrationChart.test.tsx`, the same e2e spec |
| UXN-255 "Group by family" | `src/app/(app)/strategies/FamilyGroups.tsx` above the Strategies grid; the full grid stays visible | C7 (D-1307) | `tests/strategies/familyGroups.test.tsx`, the same e2e spec |

Superseded (7): UXN-011, 018, 105, 124, 153, 156, 215, each by a named UXR item or an existing built feature. Rejected (23): UXN-003, 014, 109, 117, 151, 155, 162, 164, 165, 202, 204, 205, 207, 209, 211, 252 (each needs a new data path), 250 (conflicts with UXR-020), 107, 108, 112, 116, 125 (need a new LLM path or budget state) and 169 (conflicts with D-884). The reasons are in the design's section F and the cross-check table.

## §2 Tasks

Merge commits are `git log --merges --oneline 6c556e7a..HEAD` of `build`, oldest first. The decision ranges are the lines in `docs/M21_design.md`.

| Task | Merge commit | Decisions | Test files (main ones) |
| --- | --- | --- | --- |
| A1 migration 0038, keys, preferences, seed states | `79345acf` (Opus accepted with fixes) | D-1236, D-1240 to D-1245 | `tests/db/0038_m21_owner_tools.test.ts`, `tests/config/m21Keys.test.ts`, `tests/acceptance/v3/{at76,at77Hash}.test.ts` |
| A2 hidden routes in the proxy **F** | `a3c6aea2` (Opus accepted with fixes) | D-1210, D-1214, D-1215, D-1246, D-1247 | `tests/http/{hiddenRoutes,appRoutes}.test.ts`, `tests/auth/ownerToolsGuard.test.ts`, `tests/security/ownerToolsLazy.test.ts`, `tests/acceptance/v3/at77.test.ts` |
| U0 UXN-319 cross-check | `28ae5db7` (with the C7 re-rule) | D-1201 (amended) | `scripts/ci/ui-crosscheck.test.mjs` (written by Z, D-1329: U0 had left it out) |
| C1 review frame, title case, index table, skeletons **F** | `797cfc86` (Opus accepted with fixes) | D-1203, D-1206, D-1255 to D-1259 | `tests/review/{pages,reviewFrame}.test.tsx`, `tests/view/displayName.test.ts`, `tests/market/indexTable.test.tsx` |
| B3 tax report **F** | `c59f9892` (Opus accepted with fixes) | D-1222, D-1223, D-1265 to D-1269 | `tests/tax/*`, `tests/acceptance/v3/at78Tax.test.ts` |
| E1 real target exit, engine **F** | `9e8a9fb2` (Opus accepted with fixes) | D-1224, D-1250, D-1251 | `tests/agents/families/{targetExit,targetRebase}.test.ts`, `tests/agents/cardsTarget.test.ts`, `tests/learning/targetChallenger.test.ts` |
| B1 recommendations, tiers, broker links, holdings **F** | `1ca6b77b` (Opus accepted with fixes) | D-1216 to D-1220, D-1260 to D-1264 | `tests/ownerTools/*`, `tests/security/{noBrokerLinks,noCredentialField,noBrokerRequest}.test.ts`, `tests/acceptance/v3/at78Holdings.test.ts` |
| C3 per-alert unmute, stop-hit e-mail | `dd3de197` | D-1207, D-1226, D-1270 to D-1274 | `tests/alerts/{unmute,stopHit}.test.ts`, `tests/email/stopHitMail.test.ts`, `e2e/m21-unmute.spec.ts` |
| P1 domain, PWA, offline badge | `8893c2d0` | D-1230 to D-1232, D-1280 to D-1283 | `tests/selfcheck/domain.test.ts`, `tests/pwa/*`, `tests/security/noPush.test.ts`, `e2e/m21-pwa.spec.ts` |
| C2 Size column rule, target display | `20b764a9` | D-1204, D-1225, D-1285 to D-1287 | `tests/strategies/{stopTarget,tradesTable}.test.tsx`, `tests/market/sizeColumn.test.tsx` |
| B2 Owner trade log | `82d08cfd` | D-1221, D-1275 to D-1279 | `tests/ownerTools/tradeLog.test.ts`, `tests/security/ownerTablesReaders.test.ts`, `tests/acceptance/v3/at78TradeLog.test.ts` |
| CI fixes (review frame height, axe on srcdoc, unmute seed id, coverage tests, app job time) | `16650c96` | D-1290 | `e2e/m21-review-frame.spec.ts`, `e2e/m21-unmute.spec.ts` |
| L1 golden-set labelling page | `8438dee6` | D-1227, D-1300 to D-1303 | `tests/labels/{golden,page}.test.ts(x)`, `e2e/m21-labels.spec.ts` |
| R1 shadow short, deferred stubs | `52db0374` | D-1228, D-1229, D-1295 to D-1297 | `tests/shortShadow/*`, `tests/deferred/instruments.test.ts`, `tests/acceptance/v3/at78Short.test.ts` |
| C5 theme emulation, muted bands | `7abe403e` | D-1202, D-1205, D-1315 to D-1318 | `scripts/ci/contrast-check.test.mjs`, `tests/ui/banner.test.tsx`, `e2e/m21-theme-emulation.spec.ts` |
| C4 cut steelman subjects | `6ecd6a5d` | D-1208, D-1310 to D-1312 | `tests/steelman/cutSubjects.test.ts` |
| C7 accepted UXN-319 items | `ef0c1da3` | D-1305 to D-1309 | `tests/strategies/{controlsSummary,familyGroups}.test.tsx`, `tests/charts/concentrationChart.test.tsx`, `e2e/m21-crosscheck-accepted.spec.ts` |
| C6 Blueprint keyboard, export evidence | `d2226c75` | D-1209, D-1211, D-1320 to D-1324 | `tests/blueprint/keyboard.test.tsx`, `e2e/m21-blueprint-keyboard.spec.ts` |
| Z D-922 scan, AT-82 walk, reports, exit (this branch) | the merge of `v3/m21-z` | D-1233, D-1234, D-1325 to D-1329 | `scripts/ci/internal-codes.test.mjs`, `e2e/m21-at82.spec.ts` |

Opus review notes for each **F** task: the review fixes of A1, A2, B1, B3, E1 and C1 are recorded in their decisions (the "accepted with fixes" merges above); the security review of C1 is D-1203 (the frame has `allow-same-origin` and no `allow-scripts`).

## §3 Identity

- AT-32 and AT-50: `tests/acceptance/v3/replay-hash.baseline.json` is **not rewritten**; `git diff 6c556e7a --stat` over the three identity files (`replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`) is **empty** on this branch.
- `tests/acceptance/v3/at77Hash.test.ts`: the AT-32 golden world dumps identically with the Owner switch on and off (except `config_version`). `tests/acceptance/v3/at78Short.test.ts`: every table of the world identical with the shadow short on and off except its two tables. `tests/acceptance/v3/at78Holdings.test.ts` and `at78TradeLog.test.ts`: identical except the Owner tables.
- `worker/` is not edited by M21: `git diff 6c556e7a --stat -- worker` is empty.

## §4 Hidden routes

`tests/http/hiddenRoutes.test.ts` (the predicate truth table), `tests/acceptance/v3/at77.test.ts`, and the e2e specs `e2e/m21-owner-tools-access.spec.ts` (tools off: the three pages and `/api/owner-tools/*` equal `/zz-missing` for html, RSC, prefetch, HEAD and a server-action POST, every role), `e2e/m21-owner-tools-on.spec.ts` (tools on: Viewer and Editor still equal it, the pinned Owner gets 200) and `e2e/m16-blueprint-access.spec.ts` (rewritten without the residual branches). The D-831 residual is **retired** in code and tests (D-1210); whether Next adds another header to rewritten RSC responses on a production build is confirmed only by the CI e2e run (the fallback of D-1210 applies if it differs).

## §5 Owner tools

- Key defaults, read from a fresh migrated database (`tests/config/m21Keys.test.ts`, `tests/acceptance/v3/at77.test.ts`): `owner_real_money_tools` off, `intraday_sweep_enabled` off, `stop_hit_email_default` off, `pwa_push_enabled` off, `committee_enabled` off, `app_public_domain` empty.
- The pages reached by the pinned Owner with the switch on: `e2e/m21-owner-tools-on.spec.ts` (200 for `/recommendations`, `/holdings`, `/trades`) and, with the page checks, `e2e/m21-at82.spec.ts`.
- Static tests: `tests/security/ownerToolsLazy.test.ts` (no static import outside the section), `noCredentialField.test.ts`, `noBrokerRequest.test.ts`, `noBrokerLinks.test.ts`, `ownerTablesReaders.test.ts`.

## §6 Money

- Tax: the hand-computed fixture book (two overlapping lots, a partial sale, a split, brokerage, the financial-year boundary, 12 months exactly and 12 months and a day, franked and unfranked dividends) in `tests/tax/fixtureBook.ts`; figures in the comments of `tests/tax/{lots,fifo,report,csv}.test.ts` and `tests/acceptance/v3/at78Tax.test.ts` (the CSV parses back to the same figures; the fixed words are carried).
- Sizing known answers: `tests/ownerTools/sizing.test.ts` and `tests/picks/sizeForAmount.test.ts` (the extracted function equals the old inline maths on the AT-32 golden picks).
- Target exit: the E1 known answers (`f1_target_r`, the challenger-only rule key that no seed rule carries) and `tests/learning/targetChallenger.test.ts`.
- Shadow short: known-answer setups in `tests/shortShadow/*`; the "no look yet" state; the evaluation takes **one** `holdout_look` (D-1297, see §9).

## §7 UI

- **The D-922 scan** (`npm run test:internal-codes`, D-1233, D-1325): first run 69 hits in 22 files; after the SQL rule and the rewording below, **0 hits outside the allow-list, 48 allowed, 345 files scanned**. Its self-test has 7 tests on a synthetic tree (a JSX code and a string code fail, a comment, a `data-*` value, a module specifier and SQL pass, an allow entry passes, an unused entry is stale, an entry without a reason fails, the real tree is clean).
- **Files the scan made Z fix** (outside M21's ownership table; no behaviour change): `src/app/(app)/health/page.tsx` (BLD-024, O-23, O-26 removed from the words; `tests/health/controlsPage.test.tsx` quotes the new words), `src/app/(app)/health/NightsCheck.tsx` (PLT-073), `src/app/(app)/health/EmailControlsSection.tsx` (P0 alert emails now urgent alert emails), `src/app/(app)/picks/text.ts` (quiet hours help: "(P0)" now "Urgent alerts are never held"), `src/app/(app)/settings/appearance/ThemePicker.tsx` (D-884), `src/app/(app)/settings/region.ts` (the built-market gate item lost "(MKT-105)"; `tests/acceptance/v3/at68.test.ts` and `tests/settings/pages.test.tsx` follow, expectation strings only), `src/components/charts/Bars.tsx` (NAV now Value in the aria label and "Strategy value" in the table row; `tests/ui/__snapshots__/charts.test.tsx.snap` re-recorded, 3 snapshots), `src/components/ui/Pill.tsx` (the tier fallback text is Urgent, Important, FYI; every site already passes its own words). No AU e-mail snapshot and no identity test changed.
- **Allow-list** (`scripts/ci/internal-codes.allow.json`, 11 entries, each with its reason in the file): the Control Room spec-reference table and its fallback (UXN-283, on purpose); the alert tier identifier in `home/HomeContent.tsx`, `news/page.tsx`, `shell/AlertBell.tsx`, `ui/Badges.tsx`, `review/sections.ts` and `email/templates/review.ts` (compared, never printed; the reader sees Urgent, Important, FYI); the stored exit-type codes in `email/templates/reviewWords.ts`; the alert e-mail subject, headings and "of NAV" in `email/templates/alerts.ts` (pinned by the AU e-mail snapshots, A-20); the glossary lookup keys "NAV" and "P0 / P1 / P2" in `view/terms.ts` (shown as "Official term", UXN-001).
- **Seen, not matched by the design's patterns, left alone:** the Owner Markets row text "AT-M evidence: not recorded" (pinned by the market-off proof `at68.test.ts`).
- **The AT-82 walk** (`e2e/m21-at82.spec.ts`, D-1327): 6 tests (3 roles × 2 widths); the Owner opens 15 surfaces (stored review, strategy detail, Market, My alerts, Decision Card, Settings alerts, Strategies, Leaderboard, Risk, Blueprint, labelling, tax, recommendations, holdings, trades), Editor and Viewer 9 (the pages that are not Owner-only): **66 page loads** (15 × 2 + 9 × 4, plus one lookup of the stored review per role and width). Each page: status 200, no horizontal scroll, axe (WCAG 2.2 AA) clean, rendered text free of the scan's patterns. The six themes rotate over the pages (every theme meets every page across the matrix; **not** six themes on every page: a deviation, D-1327). Text exceptions with reasons: the Blueprint and the steelman evidence markers (D-1328). **Not run locally; CI only.**
- The e2e specs M21 added (each in one lane of `ci.yml`, listing checked by `scripts/ci/e2e-listing.test.mjs`): `m21-owner-tools-access`, `m21-owner-tools-on`, `m21-pwa`, `m21-theme-emulation` (empty lane), `m21-blueprint-keyboard`, `m21-crosscheck-accepted`, `m21-labels`, `m21-review-frame`, `m21-unmute` (rich lane) and `m21-at82` (rich lane with `all,owner-tools-on`).

## §8 Constraints

| Constraint | Evidence |
| --- | --- |
| Turso at or under 20 % of the free plan | every new statement is a key probe or a bounded keyset read with a `rows-ok:` comment; the proxy's one cached config read per instance per 60 s (D-1215); the measured Usage figure after the deploy: Owner, read-only |
| Zero `OFFSET` | `tests/security/noOffsetPaging.test.ts` at zero exceptions |
| No staging path, `ASX_LIVE` off, $0, no secret | no staging workflow touched; `worker/` not edited; no new provider; no credential field (`noCredentialField.test.ts`); gitleaks on the remote run: to be filled at push |
| Decision index, config reference, architecture regenerated | `node scripts/ci/decision-index.mjs` (848 decisions in `docs/V2_decisions.md`), `node scripts/ci/config-reference.mjs --check`, `node scripts/architecture/generate.mjs` (548 elements, 648 edges), all re-run on the exit tree |
| Schema pins at 38 | the schema pins read 38 since 0038 (`tests/backup/core.test.ts`, `tests/db/0038_m21_owner_tools.test.ts`) |
| Market literals at 0 | `npm run test:market-literals`: 0 |
| AU identity | §3 |
| No internal code in Owner-read text | §7 |

## §9 Owner steps for the PR (D-1239) and deviations

Owner steps after the merge: (1) the Owner tools switch (Settings, off by default) and the broker link templates (none ship, D-1218); (2) the domain check (`app_public_domain`, PLT-078) and the PWA note (it keeps the last Home or Picks page of a shared device until sign-out, D-1231; push is off); (3) the D-473 reversal (UXN-322, bounded to `muted`, D-1207); (4) the shadow short assumptions (borrow cost, ASX short rules [VERIFY]; D-1228); (5) the spec findings listed in the design's section "Risks and spec findings".

Deviations from the design, each decided and recorded:

- **D-1280 (no page cache).** D-1231 had the service worker cache the `/` and `/picks` pages; D-1280 caches no page at all (a signed-in page carries user data), keeps only `/_next/static/*` and four icon files on an allow-list, and gives a failed page navigation a built-in plain offline page that is never stored. The shared-device note in D-1239 shrinks to static files.
- **D-1297 (the one `holdout_look` write).** `evaluateShort` takes the ONE look only when at least 60 closed setups on at least 60 sessions exist, as one `holdout_look` row (lineage `short_shadow`), the only write outside the two shadow tables, made at most once ever; a second call is refused before any computation. The scoring details were fixed in D-1296 before any computation (BLD-051).
- **D-1290 (CI `app` job time limit).** The `app` job's `timeout-minutes` goes from 30 to 45 (run 43938393694 was cancelled in `npm run build` after `npm test` took 1,538 s on a slow runner; 45 matches the longest e2e lane).
- **D-1327 (walk matrix).** The AT-82 walk rotates the six themes over the pages instead of crossing every page with every theme.
- **Gaps in the numbering:** D-1246 and D-1247 were cited by A2's code and tests before they had a line; both are now written out in the design. D-1290 and D-1291 are the two CI fixes (the app job time limit; the PWA no-prompt proof and the Blueprint edge-hover floor). D-1252 to D-1254, D-1284, D-1288, D-1289, D-1292 to D-1294, D-1298, D-1299, D-1304, D-1313, D-1314 and D-1319 were left unused by the parallel tasks' reserved ranges. The numbers are never reused.

## §10 BUILD_SETUP section 9

"V3 current milestone" = M21 done; "V3 last step done / next step" = M21 exit / M22 requirements extract. Written by the orchestrator after the final CI run is green: **to be filled at push**.

## §11 Not verified locally

Playwright cannot run in a `wt-*` worktree here, so these specs were written and listed but **not run**, and CI is their only verification: `e2e/m21-at82.spec.ts`, `m21-owner-tools-access`, `m21-owner-tools-on`, `m21-pwa`, `m21-theme-emulation`, `m21-blueprint-keyboard`, `m21-crosscheck-accepted`, `m21-labels`, `m21-review-frame`, `m21-unmute`, and the rewritten `m16-blueprint-access`. Also CI-only: the production `next build` and the bundle budgets, gitleaks, Lighthouse, and the full `npm test` suite (the orchestrator runs it after the merge).
