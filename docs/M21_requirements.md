# M21 requirements: UI residuals and Owner tools

Delta extract from `Requirement/v3/spec/` (V3 draft, session V3-1, 2026-11-11). Source chapters: ch. 12 V3 (M21 row, BLD-048…BLD-055), ch. 24 (whole: UXN-318…UXN-324, §24.6, AT-82), ch. 21 §21.3–§21.7 (EML-043, ARN-121, FAM-010, UX-131, UXN-314…317, AGT-148 text read for the boundary, §21.7 table: VAL-121, ARN-124 a–c, PLT-078, PLT-079, ARN-122; AT-76…AT-78), ch. 14 V3 (AT-76, AT-77, AT-78, AT-82 rows and the Owner-executed list), ch. 15 V3 (§15.11.2 keys), ch. 00 V3 (O-82, D-930…D-933, D-943, D-944), ch. 01 V3 (PRD-039…PRD-049, read for the constraints). Also read for the ids the M21 rows name but the V3 files do not define: v1 `spec/16_ui_next_level.md` (the UXN-319 item set, read as a whole), V2 `spec/16_ui_redesign_delta.md` (UXR-001…058), v1 `spec/09_ui_ux.md` (UX-053, UX-130), V2 `spec/17_praxis_cortex.md` (CTX-040), V2 `spec/19_intraday_watch_and_pick_alerts.md` (VAL-119, EML-038, UXN-307), V2 `spec/18_blueprint_page.md` (SEC-112). Build decisions in this milestone are **D-1200…D-1239** (M20 ended at D-1199, `docs/M20_design.md`). Continues from M20 on `build` (M20 merged at `11c6d0d8`; CI green on `6c556e7a`, run 43347157615).

Source of truth: the V3 spec in `D:\Projects\Praxis\wt-v3-req\Requirement\v3\spec\` (read-only). Quotes are copied from that text. Code paths are files in `D:\Projects\Praxis\wt-m21-req` (branch `v3/m21-req`, `build` at `6c556e7a` merged in, M20 complete); every path and line below was read in that tree (first pass 2026-11-13, re-checked 2026-11-16 after the merge: the two later commits touch only `e2e/support/leaks.ts`, `MarketSwitch.tsx`, `ProjectionSection.tsx`, `at68.test.ts` and `docs/M20_design.md`, none cited below); "new" marks a file that does not exist. Items marked **F** are the M21 row's: UX-131/UXN-314…317 **F** (security), ARN-122 **F** (money maths), FAM-010 **F**.

## Scope

M21 is "UI residuals and Owner tools". It is **8 build-agent days** in the estimate (ch. 12 V3). Its exit is **AT-77, AT-78, AT-82** and the M21 part of **AT-76** ("reflections part waits for M22"), plus AT-68, AT-67, AT-32/AT-50, AT-85 kept green (every CI run).

The ch. 12 M21 row, verbatim: "UXN-319 cross-check table + accepted set · UXN-320, UXN-321 (walk items) · UXN-322, UXN-323 · UXN-324 (Blueprint) · UXN-318 (labelling page) · UX-131 switch + UXN-314…317 (Phase R, off by default; broker deep links) **F** (security) · ARN-121 (trade log) · ARN-122 (tax report) **F** (money maths) · FAM-010 (target exit as challenger) **F** · EML-043 (stop-hit opt-in) · VAL-121 (shadow short lineage) · ARN-124 a–c (re-deferred stubs with tests) · PLT-078 (domain-ready) · PLT-079 (PWA) · ch. 15 §15.11.2 keys".

It has five kinds of work:

1. **UI residuals** (ch. 24 §24.1–§24.4): the UXN-319 cross-check and its accepted set, the walk items UXN-320/321, alerts and steelman UXN-322/323, Blueprint UXN-324.
2. **Owner tools, default off** (ch. 21 §21.5, PRD-041): the `owner_real_money_tools` switch, risk-tier labels, the recommendations page, holdings upload, broker deep links; the Owner trade log (§21.3) and the paper tax report (§21.7).
3. **Exits, alerts, shadow and stubs** (ch. 21 §21.3, §21.4, §21.7): the family target exit as a counted challenger, the stop-hit e-mail opt-in, the shadow short lineage, the three re-deferred stubs.
4. **Platform** (§21.7): custom-domain readiness and the installable PWA.
5. **The labelling page** (ch. 24 §24.6, UXN-318) on the M20 label stores.

Facts that bind every M21 task:

- **Money-path items are off by default behind an Owner switch and read-only (PRD-041, D-931).** `owner_real_money_tools = false` in production; `/recommendations`, `/holdings`, `/trades` return 404 for every role while off, and for Editors and Viewers with it on (AT-77).
- **Nothing in M21 changes a book, order, signal, rule version or alert by itself.** AT-77: "switching `owner_real_money_tools` on changes no book, order, signal, rule or alert (AT-32 hash before/after)". The trade log and holdings are "never read by any trading, learning or Cortex path (AT-32 boundary)" (ARN-121). The AT-32 baseline `tests/acceptance/v3/replay-hash.baseline.json` is never rewritten.
- **AU byte-identical, IN and US off in production.** The three identity files (`tests/acceptance/v3/replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`) are not rewritten; every new market-keyed table carries the 0035/0036 guard triggers (D-1022); production `markets_enabled` stays `["AU"]` (AT-68).
- **Plain words everywhere the Owner reads (D-884, D-919, D-922).** AT-82's last clause: "no internal code appears in any text an Owner reads (D-922 scan)". No D-922 scan exists in the tree (see Gap 7); `tests/security/displayText.test.ts` is the SEC-016 markup-sink sweep, not a code scan.
- **$0, Turso ≤ 20 %, no OFFSET, no staging, ASX Worker off, no secrets.** Every new list read is keyset-paged with a `rows-ok:` comment; the PWA adds no paid service; broker links hold no credentials (UXN-317).
- **No Owner question (O-82, PRD-048).** Every open point is decided by the spec's recommended default, recorded as D-1200…D-1239 and listed in the single V3 PR.

---

## Hard constraints that apply to every M21 item

- **PRD-039 Everything in the backlog is built.** A stub carries a recorded reason (D-nnn) and a test (ARN-124 a–c, the OCR stub of D-944).
- **PRD-041 / PRD-033 / AGT-011a.** "No LLM output may create, size, change or cancel an order, a thesis-breaker or a rule." The recommendations page uses "LLM-034 text rules; no LLM numbers" (UXN-315); the labelling page "never shows an LLM-proposed label before the Owner answers" (UXN-318).
- **PRD-045 Cost ceilings.** 20 % of the Turso free plan; keyset paging, never OFFSET (`tests/security/noOffsetPaging.test.ts` at zero exceptions).
- **PRD-046 No staging.** Verification is CI (unit, e2e on the e2e seed states, the recorded-day job) and prod-safe flags.
- **PRD-047 ASX Worker live fetch off.** M21 does not touch `worker/`.
- **PRD-048 One pull request.** M21 opens no PR.
- **MKT-107 / AT-67.** No literal market code, timezone, currency, parcel or tick outside `src/lib/market/**` and the allow-list (`src/lib/market/seed/allow.mjs:4-7`; `EXTRA_ALLOW` in `scripts/ci/market-literals.mjs`). The tax-year start per market, the short-sale rules per market and the risk-tier words are per-market or product facts and must live where the scan allows them (Gap 9).
- **SEC-112 pattern for hidden routes (UX-131).** "with it off the pages 404 for every role (SEC-112 pattern) and no module of this section is loaded". In the tree the only 404-for-a-role route is the Blueprint (`src/lib/auth/blueprintGuard.ts:72,83` call `notFound()`; the proxy marks and `next.config.ts:58-70` rewrites); every other Owner page uses `requireUser("admin")` and answers 403 (`src/lib/auth/guard.ts:64-74`).
- **AT-32 boundary.** The replay hash tests compare whole-table dumps (`tests/acceptance/v3/replayHash.test.ts:131-153`, `tests/acceptance/v2/at32Steelman.test.ts:112-144`); a table a night writes moves the hash. New M21 tables must be written only outside the night (trade log, holdings, labels, short shadow) or be excluded deliberately with a decision.
- **O-54 masking.** Money figures for Editors and Viewers go through `maskContext` (`src/lib/view/mask.ts:42-48`) and `<Masked/>` (`src/components/ui/Values.tsx:20-26`). Every Owner-tool figure is Owner-only (UXN-315 "Masking (O-54) holds for non-Owners"; ARN-121 "Masked for every other role").
- **Research honesty (BLD-051, CXA-015).** VAL-121 "measured as a labelled shadow lineage (VAL-121) with its own pre-registered test": pre-registered hypothesis, one look, no re-tuning.

---

## A. Build rules (ch. 12 V3, BLD-048…BLD-055)

- **BLD-048 One PR.** M21 opens none; decisions are listed for the PR.
- **BLD-049 Order of value.** M21 runs after M20 exits; "≤ 5 Sonnet + ≤ 5 Haiku; never two sub-agents on the same files".
- **BLD-051 Research honesty.** VAL-121 pre-registers its hypothesis and split before any computation.
- **BLD-053 Progress recording.** BUILD_SETUP §9 "V3" rows after every task.
- **BLD-054 Decision numbering.** Live rule D-1005/D-1126: M21 decisions are **D-1200…D-1239** in `docs/M21_design.md`; `docs/07_decision_log.md` is not edited; `scripts/ci/decision-index.mjs` (npm `test:architecture`) owns the index.
- **BLD-055 Milestone package.** This extract → `docs/M21_design.md` → tasks with tests first → Haiku review → Fable acceptance of the **F** items → `docs/M21_exit_evidence.md` → §9 rows.

---

## B. UI residuals (ch. 24 §24.1–§24.4; AT-82)

### B.1 UXN-319 Cross-check and decide, then build the accepted set
- **Full text:** "At the start of M21 a Haiku extract lists every still-[PROPOSED] v1 ch. 16 item (UXN-003, 008, 010, 014, 062, 107–109, 124/125, 151…165, 202…255 and any other P2/P3 id) with its one-line intent, and marks each as: **superseded** by the V2 redesign (cite the UXR id that covers it), **accepted** for V3 (built in M21, test per AT-82), or **rejected** with a one-line reason (conflicts with a later Owner decision such as D-884/D-922, needs data the system does not have, or duplicates an accepted item). The table is `docs/M21_ui_crosscheck.md`; nothing is left undecided and the accepted set ships in M21. Default when in doubt: accept if it is pure presentation on data the pages already load; reject if it needs a new data path."
- **The item set (read from v1 ch. 16, status tags as written there).** Still `[PROPOSED]`: UXN-003 (density modes, P2), 008 (skeleton loading, P2), 010 (offline badge, P3), 011 (responsive bottom tab bar / left rail, P2), 014 (Web Push P0/P1, P3), 018 (icon system with labels, P2), 062 (arena-vs-controls summary card, P2), 105 (mobile long-press glossary, P2), 107 (execution Q&A panel, P2), 108 (suggested-question chips, P2), 109 (evidence citation popovers, P2), 112 (explanation-budget indicator, P2), 116 (rank-score provenance badge, P2), 117 (actionable data-gap message, P2), 124 ("what would change this view", P2), 125 (plain-English narrative by R3, P2), 151 (sleeve utilisation meter, P2), 153 (discrete scenario picker, P3), 154 (concentration donut/treemap, P2), 155 (regime history strip, P2), 156 (kill-switch visual state, P2), 162 (expandable event log, P2), 164 (source-type tag, P2), 165 (P/L sparkline on news cards, P2), 169 (dark-mode-safe e-mail CSS, P2), 202 (performance heatmap, P2), 204 (version diff in history panel, P2), 205 (review archive filters and read dot, P2), 207 (uptime timeline, P2), 209 (usage meter tiles with trend, P2), 211 (regime config with live preview, P2), 215 (grade filter in Glossary, P2), 250 (regime-responsive layout, P2), 252 (score breakdown card, P2), 255 (asset-class menu for Arena tiles, P3): **35 items**. Already decided in v1 and therefore outside UXN-319: every `[ACCEPTED, O-38] (P1)` item (152, 157, 158, 160, 161, 163, 203, 206, 208, 251 and the P1 set) and the two `[WITHDRAWN s12]` (253, 254).
- **V2 ids to cite for "superseded":** UXR-001…012 (rules), UXR-020…030 (pages), UXR-040…046 (components; UXR-046 toasts with undo), UXR-050 (walks), UXR-051…058 (palette and vibrancy) in `Requirement/v2/spec/16_ui_redesign_delta.md`.
- **Tags:** none [VERIFY]. The classification is a build decision (Section O, Gap 1).
- **Acceptance:** AT-82 "the accepted UXN-319 set renders as decided".
- **Files:** `docs/M21_ui_crosscheck.md` (new). The accepted items' files are named in that table (each must be a file no other M21 task owns, or the item is built at integration; Gap 1).

### B.2 UXN-320 M8.1 walk L-items
- **Full text:** "(a) Reviews: the iframe/preview area reserves its height from the content so no empty band shows while a review loads; (b) the Size column on picks and strategy tables is hidden when every row would be empty (masked role or no sizing yet) and otherwise shows the value; (c) dark mode is tested on a real `prefers-color-scheme` emulation **and** the header theme toggle (D-171) in e2e, both sizes, six themes; (d) muted status bands meet the vibrancy rule (UXR-051…058, ≥ 3 meaningful hues) while staying AA."
- **Current state (verified):**
  - (a) `src/app/(app)/reviews/[date]/page.tsx:117-123`: `<iframe title sandbox="" srcDoc={model.html} className="h-[80vh] w-full …" />`, a fixed `80vh`, no `onLoad` sizing, no loading state (no `loading.tsx` under `src/app`); masked users get `MaskedBody` (line 137). `e2e/reviews.spec.ts:1-5` says the e2e seed holds no stored review, so e2e never renders the frame. Tests `tests/review/pages.test.tsx:136-187`, `tests/review/reviewsPages.test.tsx:466` assert the `<iframe`.
  - (b) No picks table has a Size column (`src/app/(app)/picks/HistoryBody.tsx:126-140`, `TrackRecordBody.tsx:88-105`); the pick tile shows "Suggested size:" as text and `<Masked/>` when masked (`PickCard.tsx:134-139`, `picks/[id]/page.tsx:119-131`). The strategy trades table has a `Size` header (`src/app/(app)/strategies/[execution]/StrategyChart.tsx:544`) and prints `t.qty` to every role (`:591`; `src/lib/ui/loaders/strategies.ts:559` `qty: num(r.qty)` while only prices are masked at `:563`). The Market company table defines `sizeBadge` "Size" (`src/app/(app)/market/MarketTable.tsx:109-113`), drops it for masked roles (`:185-186`) but still shows it when every `sizeGroup` is null.
  - (c) Six themes `THEMES` at `src/lib/preferences/service.ts:33` (dark, light, system, midnight, dim, high_contrast); two text sizes `TEXT_SIZES` at `:39`; `data-theme` set in `src/app/layout.tsx:36-43`. **There is no header theme toggle:** `src/components/shell/AppHeader.tsx:1-3` "There is no theme toggle here; Settings > Appearance owns the theme" (UXR-004/005); D-171 (`docs/07_decision_log.md`) said the toggle "stays for now (UXR-004 moves it into Settings later)". e2e: `e2e/a11y.spec.ts:16-22` emulates `colorScheme` for `/signin` only; `:39-60` sets the stored theme; `e2e/picks-sections.spec.ts:27-34` loops role × `[1280, 375]` × `THEMES`; no spec combines `data-theme="system"` with an emulated scheme while signed in; "sizes" in every e2e means viewport widths.
  - (d) Tokens `src/styles/palette.tokens.json` → `src/styles/themes.css` (generated by `scripts/ui/gen-tokens.mjs`, npm `test:tokens`); `--tint-band` per theme (`themes.css:225,438,651,863,1074`); `BAND_BG` in `src/components/ui/hue.ts:15-16`; `StatusStrip` (`src/components/ui/StatusStrip.tsx:1-13`); `Banner` tones use text colours only (`src/components/ui/States.tsx:50-54`); the vibrancy e2e `e2e/vibrancy.spec.ts:90-115` asserts ≥ 3 meaningful hues above the fold (minimum 1 for light/system, D-884) and AA via axe (`:117-140`); `scripts/ci/contrast-check.mjs:63-80` checks the status hues. No rule or test names "muted status bands".
- **Tags:** none. (c) names a control that no longer exists (Gap 2).
- **Acceptance:** AT-82 "no empty review band; Size column rule; dark mode via emulation and toggle identical".

### B.3 UXN-321 V1 walk items 11 and 13
- **Full text:** "(11) Company and strategy names render in title case from the stored name with the exception list for acronyms (ASX codes, "ETF", "REIT"); (13) the Market tab's index table has a screen-reader caption, row headers and a one-line summary (axe clean)."
- **Current state (verified):** `displayName()` exists at `src/lib/view/format.ts:241-258` with `KEEP_UPPER` (`:211-225`: NL, PLC, ETF, REIT, NZ, UK, US, USA, AI, IT, II–IV) and `SUFFIXES` (`:226-232`); only all-caps names are changed (`:243`); applied in `loaders/company.ts:275`, `market.ts:444,575,641`, `news.ts:236,308`, `review/names.ts:45`, `learning/daily.ts:262`, `MarketTable.tsx:91`, `strategies/movers/page.tsx:69`, `strategies/ideas/page.tsx:98`, `picks/IntradaySection.tsx:68`. **Not applied:** `src/lib/ui/loaders/picks.ts:341` (`company: … String(x.name)`, rendered by `PickCard.tsx:65-66` and `picks/[id]/page.tsx:53`), `src/lib/ui/loaders/pickAlerts.ts:239`, `src/lib/ui/loaders/reviews.ts:800`; strategy names have no casing step (`src/lib/view/terms.ts:180-187` `strategyDisplayName`; rendered raw in `strategies/StrategyTile.tsx:63,69`, `leaderboard/page.tsx:85,241`, `risk/page.tsx:50,141`). The Market "Main index" is a flex strip, not a table (`src/app/(app)/market/sections.tsx:119-147` `IndexSection`); the `Sparkline` carries `role="img"` with an aria-label summary and an sr-only `ChartTable` (`src/components/charts/Sparkline.tsx:51-67`, `ChartTable.tsx:20,24,35`); no visible one-line summary. Axe runs through `axeViolations` (`e2e/helpers.ts:65-80`) and `/market` is in the six-theme run (`e2e/a11y.spec.ts:75`).
- **Acceptance:** AT-82 "title case with exceptions; index table axe-clean with caption".

### B.4 UXN-322 Per-alert unmute (D-473)
- **Full text:** ""My alerts" lets the user unmute a single muted pick and shows "muted" chips with an undo; "alerts for all picks" stays the master toggle (UXN-303)."
- **Current state (verified):** `src/app/(app)/alerts/actions.ts:20` `muteAlertAction` appends a `seq+1` row `state: "cleared", clearReason: "muted"` (`:34-52`) and refuses anything not `armed` (`:33`); `:61` `setAlertsForAllAction` writes the `pick_alerts` preference (the master toggle); **no unmute action**, no chips, no undo. `pick_alert` is append-only (`db/migrations/main/0020_intraday.sql:67-89`, triggers `:91,95`; `state ∈ {armed, hit, cleared}`, `clear_reason` CHECK list `:84-85` includes `muted`). Loader `src/lib/ui/loaders/pickAlerts.ts:455` `loadMyAlerts`, `canMute: chip.state === "armed"` (`:499`); "Muted by you" words at `src/app/(app)/picks/text.ts:173`. The poll clears as `muted` when the user is not a recipient (`src/lib/alerts/pick/poll.ts:406`, `evaluate.ts:26`). A generic Undo exists in `src/components/ui/Toast.tsx:2,17,48`. **D-473 (`docs/M17_design.md:194`) ruled: "there is no per-alert unmute because the state machine is append-only and a cleared alert is final".** The e2e seed state `alerts-muted` exists (`e2e/seed/states.mjs:19`).
- **Acceptance:** AT-82 "per-alert unmute and undo".
- **Gap:** the V3 text reverses D-473 for muted alerts (Gap 3).

### B.5 UXN-323 Empty steelman subjects (D-560)
- **Full text:** "A subject cut by `steelman_daily_cards` gets a zero-item pack row so its card shows "Not written tonight: daily limit reached" instead of nothing; the health line counts cut subjects."
- **Current state (verified):** `src/lib/steelman/night.ts:200-203` `cap = … dailyCards`, `notWritten.limit = subjects.length - cap`, `for (const subject of subjects.slice(0, cap))` — cut subjects never reach the writer, no pack is stored (D-560 `docs/M11L_design.md:125` names this very follow-up). `steelman_pack` (`db/migrations/main/0021_steelman.sql:8-21`): `pack_id` 64-hex PRIMARY KEY, `items_json` array, `item_count ≥ 0` (a zero-item row is already legal), `UNIQUE (market, d, subject_kind, subject_id)`, append-only (`:22,26`). Card: `src/lib/steelman/read.ts:67` `readSteelmanForCard` (no pack → `null` → no section; `nightReason` `:44-60` yields `daily_limit` only when exactly one night counter is non-zero); `src/app/(app)/cards/[id]/Steelman.tsx:13` has the words "the daily limit of written cases was reached" and renders "Not available tonight{: why}." (`:84`). Health: `src/lib/health/steelman.ts:20` `steelmanHealthOf` does not count cut subjects; the Evening Review line does (`src/lib/review/sections.ts:867-880`). The key `steelman_daily_cards` is `src/lib/config/keys.ts:1396` (int, default 8).
- **Acceptance:** AT-82 "cut steelman subjects show the limit text".

### B.6 UXN-324 Blueprint keyboard, header and export check
- **Full text:** "(a) Every node, edge and panel of the Blueprint diagram is reachable and operable by keyboard with a visible focus ring (no mouse-only edges); (b) the RSC header handling of D-831 is replaced by a single server-side check in the proxy that both the page and its RSC payload share (one code path, one test); (c) the manual draw.io check (D-369) becomes an automated structural test: the exported `.drawio` XML parses, node and edge counts equal the model's, and every node id is present (AT-59 automated part)."
- **Current state (verified):**
  - (a) `src/components/blueprint/BlueprintDiagram.tsx`: viewport div `tabIndex={0} role="group" onKeyDown` (`:387-396`; arrows pan, `+/-/0` zoom, `:259-275`); edges `<g data-edge>` with pointer handlers only, no tabIndex (`:417-437`); nodes `role="button"` with `tabIndex={on || (selected === null && i === 0) ? 0 : -1}` (`:450`) — only one node is tabbable and no arrow key moves focus between nodes; no per-node focus ring (the global `:focus-visible` rule `src/app/globals.css:227`). No Export button exists in the page (`src/app/(app)/blueprint/page.tsx`); the Owner guide says "use Export as draw.io" (`docs/owner-guide/owner_checks.md:50-53`).
  - (b) The D-831 mechanism: `src/lib/http/gate.ts:59-63` (`ABSENT_PATH = "/_praxis-absent"`, `HIDE_HEADER = "x-praxis-hide"`), `:166-175` (`hide = !pinned` for a signed-in non-Owner), `:207-209` (strip and set the header); `next.config.ts:58-70` `beforeFiles` rewrite on the header to the absent path. The page guard is the second path: `src/lib/auth/blueprintGuard.ts:72,83` (`notFound()`). Known leak asserted in `e2e/m16-blueprint-access.spec.ts:56-66`: Next adds `x-nextjs-rewritten-path` (and `-query`) on an RSC response for a signed-in non-Owner (`docs/test-reports/AT-57.md:16,37`).
  - (c) `tests/blueprint/drawio.test.ts` (header `:2` cites "UXN-324 (c), M18 TST-135 (c), D-967") already asserts per view: node id|name pairs and edge pairs equal the model's, counts match, cell ids unique, every element exported (`:26-79`); `tests/blueprint/export.test.ts:33-61` parses the XML and checks counts. `docs/test-reports/AT-59.md:17,26` still records "(c) the exported file opened in draw.io desktop | Owner check, not automated (D-369) … not done".
- **Acceptance:** AT-82 "Blueprint keyboard walk reaches every node, RSC and page checks share one test, the draw.io export parses with matching counts".
- **Gap:** (c) is already automated; the evidence rows are stale (Gap 4). (b) is security (**F**, part of the UX-131 security review).

---

## C. Owner tools, Phase R, default off (ch. 21 §21.5; PRD-041, D-931, D-944) **F** (security)

### C.1 UX-131 Owner switch
- **Full text:** "One configuration key `owner_real_money_tools` (default **false**, Owner-editable, audited) gates every item of this section; with it off the pages 404 for every role (SEC-112 pattern) and no module of this section is loaded. The switch never changes any book, signal, order or rule (AT-32 boundary; AT-77)."
- **Current state (verified):** no such key or route exists (grep of `src/`); the key registry `src/lib/config/keys.ts:12-23` (`ConfigKeyDef`: default, unit, editable O/B/fixed, range?, ref, validate) has **no boolean kind**: Owner switches are `"on"/"off"` text (`ON_OFF`, `:420-421`; example `morning_brief_enabled` `:1789-1795`); every Owner edit is audited in `src/lib/config/admin.ts:262-266` (`config.change`); plain-word labels in `CONFIG_META` (`:2303`); the generator `scripts/ci/config-reference.mjs` (npm `test:config-reference`). Per-milestone key tests follow `tests/config/m17Keys.test.ts:85` (`M17_KEY_NAMES` length). Navigation is `src/lib/ui/nav.ts` (`TABS` `:22-35`, `GEAR_ITEMS` `:40-49`, `tabsFor`/`gearFor` filter by `can(role, action)` `:56-59`; `ROUTES` `:72-80`); every page must be in the e2e page registry (`e2e/pages/*.ts`, `PageEntry` `e2e/pages/types.ts:4-17`) or `tests/ui/pageGuard.test.ts` fails.
- **Acceptance:** AT-77.
- **Gaps:** boolean vs on/off text (Gap 5); 404 for the Owner's own page while off (Gap 6).

### C.2 UXN-314 Risk tiers
- **Full text:** "The three pick profiles (Aggressive / Balanced / Conservative, v1 §16.21) are mapped to the Phase R tier names Turbo / Balanced / Steady as **labels** on the existing picks; a tier is a display grouping with the same stop, size and ordering rules as today — no new signal path."
- **Current state (verified):** `pick_profiles` key `src/lib/config/keys.ts:765-775` (aggressive/balanced/conservative with tiers U1…U3, `max_pct_per_pick`, `risk_pct_per_pick`); profile words `src/app/(app)/picks/text.ts:18` `profileLabel`, `HomeContent.tsx:27-31` `PROFILE_NAME`, `market/[code]/page.tsx:43-47`; the pick tile `src/app/(app)/picks/PickCard.tsx:36-46` (`pick: PickRowView, masked, beatsLuck, chip`); no "risk tier" text anywhere. `tests/security/noBrokerLinks.test.ts:25-37` scans the picks, alerts and e-mail surfaces and bans broker words and external hrefs (`:51-55`).
- **Acceptance:** AT-77 (off), AT-82 (walk).

### C.3 UXN-315 Recommendations page
- **Full text:** "`/recommendations`: the current night's picks sized for a **user-entered real capital** figure (stored per user, local to the page, never in a book): parcel at the limit price, risk at stop in currency and %, the family's chance of a net gain where calibrated (O-75), the concentration line, and the fixed words "Paper-tested ideas, not advice. Place and manage your own orders." (LLM-034 text rules; no LLM numbers). Masking (O-54) holds for non-Owners."
- **Current state (verified):** picks loader `src/lib/ui/loaders/picks.ts:126` `PickRowView` (`tier`, `size`/`riskAtStop` null when masked `:143-144`, `stop`, `buyUpTo`, `aim`, `chance` from `chanceDisplay` `src/lib/picks/chance.ts:1-12`, UXN-308); per-user storage is `user_preference.prefs_json` (`db/migrations/auth/0003_user_preference.sql`; `Preferences` type `src/lib/preferences/service.ts:56-76`, `ALLOWED` `:102-116`, `updatePreferences` `:209` audited `user.preferences_update`). No route exists.
- **Acceptance:** AT-77, AT-78 (no credential field).

### C.4 UXN-316 Holdings upload
- **Full text:** "Manual table and CSV import of the user's real holdings (code, quantity, average cost); Praxis shows thesis-breakers, pick alerts and exits that would apply to those holdings and the paper position's status, nothing more. **Screenshot OCR is a stub** in V3: no server-side OCR at $0 within the Vercel budget; a client-side OCR library (runs in the browser, no upload) is a [PROPOSED] P3 follow-up listed in the PR [D-944]."
- **Current state (verified):** CSV parsing exists (`src/lib/data/universe/parse.mjs:34` `splitCsv`, reused by `src/lib/data/referenceData.ts:15`; limits `:45-47`); the only upload form is `src/app/(app)/config/DataUploads.tsx:42-44` with actions `src/app/(app)/config/actions.ts:52-102` (role → confirm → size → audit → write). No holdings table; thesis-breakers `src/lib/agents/thesisBreakers.ts`, pick alerts `src/lib/ui/loaders/pickAlerts.ts`, exits per family `src/lib/agents/families/exits.ts`.
- **Acceptance:** AT-77 (`/holdings` 404), AT-78.

### C.5 UXN-317 Broker deep links
- **Full text:** "A per-user list of brokers (name, order-page URL template with `{code}` and `{market}` placeholders; shipped templates for brokers whose public order URL accepts a code parameter [VERIFY per broker at build; none hard-coded as "supported"]). Every pick tile and the recommendations page show an "Open in <broker>" link that opens the broker's own page in a new tab; Praxis **never** holds broker credentials, sessions, tokens or account numbers, never submits an order and never reads a broker page (static test: no outbound request to a broker host from server code). Links are `rel="noopener noreferrer"` and carry no personal data in the URL (privacy rule)."
- **Current state (verified):** `tests/security/noBrokerLinks.test.ts` bans broker names and "brokerage"/"broker link" (`:51-52`), buy-now CTAs (`:54-55`), external links in the pick e-mails (`:77-83`) and requires internal hrefs on the pick surfaces (`:86-95`); `src/lib/http/safeLink.ts:11-37` allows links only to `SOURCE_SITES` hosts; the fetch path is `src/lib/data/sources/politeFetch.mjs` with the host table `src/lib/http/sourceSites.ts:17-20`. Config key `broker_links (per user)` is in ch. 15 §15.11.2 with Edit = "user".
- **Tags:** **[VERIFY per broker at build]** (Section M; needs the internet — Section N).
- **Acceptance:** AT-78 "Broker links open the configured URL with only `{code}`/`{market}` substituted and no other parameter; a static test shows no server-side request to any broker host and no credential field anywhere".

---

## D. Trade log and tax report (ch. 21 §21.3, §21.7)

### D.1 ARN-121 Owner trade log (VAL-119)
- **Full text:** "A private Owner-only table and page (`/trades`, nav under Picks) where the Owner records real trades by hand (market, code, side, date, quantity, price, fees, note; CSV import with the same columns). Praxis computes per trade: the matching pick (if any), the paper fill it would have taken, slippage vs paper, realised vs paper outcome, and a monthly "paper vs real" summary (VAL-119 alert-usefulness report extended). Masked for every other role (O-54); never read by any trading, learning or Cortex path (AT-32 boundary); no broker connection."
- **Current state (verified):** no table or page. The paper-fill recipe for a pick is `src/lib/picks/track.ts:246-265` (`fillIntradayStop`, the "aim" touch, `feeFor`); the VAL-119 report is `src/lib/ui/loaders/alertsReport.ts:38` `loadAlertsReport` (intraday candidates by month) on `src/app/(app)/reviews/alerts/page.tsx:1-3`; pick alerts per user in `pick_alert` (0020). `/alerts` sits under Picks in `ROUTES` (`nav.ts:76`). Audit helper `src/lib/auth/audit.ts:39-49`; `audit_event` table `db/migrations/auth/0001_auth.sql:23-35`.
- **Acceptance:** AT-77 (`/trades` 404), AT-78 "the trade log stores only the Owner's typed rows, is masked for other roles, and a planted trade changes no paper book".

### D.2 ARN-122 Tax report **F** (money maths)
- **Full text (§21.7 row):** "**Report only**: per financial year, per market, a paper-book "realised gains and losses" report (specific-lot and FIFO columns, holding period over/under 12 months flagged, dividends listed, franking shown where recorded) with the fixed words "Paper results, not tax advice"; exportable CSV; Owner-only; never a real-money figure unless the Owner trade log (ARN-121) is used, in which case the same report runs on the log and says so."
- **Current state (verified):** books: `fill` (`db/migrations/main/0007_arena.sql:180-187`, append-only, qty, prices, `brokerage_micro`, `cost_profile`), `trade` (`:222-230`: `entry_fill_id UNIQUE`, `exit_fill_id UNIQUE`, `exit_type`), `cash_ledger` (`:268`, kinds incl. `div_accrue`, `div_pay`, `brokerage`), `corporate_action` (`0004_au_data.sql:157`, franking only in `payload_json`: `frankingPct`, `frankingCreditMicro`, `src/lib/arena/corpActions.ts:167-196`, "Franking stays on the corporate_action payload; no ledger effect" `:7-9`). `src/lib/arena/ledger.ts:246` `replayCostBasis` is **average cost** (`:240-245`); no FIFO, specific-lot, holding-period or financial-year helper exists anywhere in `src`. No `text/csv` route exists; the only attachment route is `src/app/api/blueprint/export/route.ts:16-33`, rate-limited through `EXPORT_ROUTES` (`src/lib/http/gate.ts:53-55`) and `tests/http/gate.test.ts:379-392` requires every `Content-Disposition` route to be in that set.
- **Tags:** the financial-year start per market is a market fact (AU 1 July, IN 1 April, US 1 January) and must live under the AT-67 allow-list (Gap 9).
- **Acceptance:** AT-78 "the tax report reproduces hand-computed specific-lot and FIFO figures for a fixture book and carries the fixed words".

---

## E. Exits and alerts (ch. 21 §21.3, §21.4)

### E.1 FAM-010 Real target exit **F**
- **Full text:** "Every family's exit plan gains an optional **target** leg: `target_r` (multiple of initial risk, default none) or `target_pct`; a hit at the close (or an intraday high ≥ target on the delayed path, display only) exits at the next open with the family's exit slippage. A target is a **pre-registered, counted challenger** per family (KB-081, ≤ 3 variants per quarter, O-46); the indicative 2R line of D-885 is replaced on cards by the family's real target when its rule version has one, otherwise the card says "no target: this strategy exits by its stop, trail or time rule". [D-943]"
- **Current state (verified):** `ExitPlan { initialStops, trails, cs }` at `src/lib/agents/families/types.ts:251-255`; `CsRule` kinds `time_stop`, `close_above_sma`, `negative_event`, `close_below_level`, `volume_dry_up` (`:214-249`); no target kind. Plans `src/lib/agents/families/exits.ts:66-178`, `evaluateExit` `:278` (the first triggered CS rule exits at D+1). `exit_cs` orders are placed by `src/lib/agents/batch2b.ts:801-818` and filled at the next open by `src/lib/arena/closeBooks.ts:841` `fillCloseSignalExit` (`src/lib/arena/fills.ts:191-202`, "next open − slippage (ARN-021)"); slippage is per ADV bucket and cost profile (`fills.ts:77`), not per family. Challengers: `VARIANT_QUARTER_CAP = 3` (`src/lib/learning/challengerLifecycle.ts:197`), `STOP_SIZING_KEY` regex (`:200`) decides which keys count toward O-46 — `target_r`/`target_pct` would not match today; optional structural keys `FAMILY_OPTIONAL_KEYS` (`src/lib/agents/families/ruleSchema.ts:640-671`); `createChallenger` `:356` with the O-46 cap at `:431-441`. Display: `TARGET_R = 2n` (`src/lib/ui/loaders/strategyViews.ts:34`, D-885), `stopTarget` `:41-57`, `targetText` on `strategies/[execution]/page.tsx:199` and `StrategyChart.tsx:29-31,594`. `arena_order.kind` CHECK (`0007_arena.sql:137` area) lists `entry, exit_cs, exit_is, sleeve_open, sleeve_close`.
- **Acceptance:** no AT of its own in ch. 14; FAM-010 is covered by AT-32/AT-50 (AU hash unchanged: no seed rule has a target), AT-41 (challenger path) and the card words in AT-82's D-922 scan (Gap 10).

### E.2 EML-043 Stop-hit e-mail (opt-in, default off; D-933)
- **Full text:** "Settings → Alerts gains "E-mail me when a pick I was alerted on trades under its stop (delayed)" (default **off**, per O-74 the Owner sets their own broker stop); when on, one e-mail per pick per session (EML-038 style, inside `pick_alert_emails_per_day`), reason `stop_hit`, never an order."
- **Current state (verified):** Settings → Alerts: `src/app/(app)/settings/alerts/page.tsx` (three on/off selects) and `actions.ts:14` `FIELDS = ["pick_alerts","cleared_pick_emails","intraday_candidate_emails"]` → `updatePreferences`; defaults `src/lib/preferences/service.ts:87-100`. The evaluator `src/lib/alerts/pick/evaluate.ts:40-42` clears `below_stop` **only before a hit** ("ARN-114 b"); after a hit no stop check runs on the delayed path; the poll `src/lib/alerts/pick/poll.ts:383-410` writes only `pick_alert` and `quote_run`. `pick_alert.clear_reason` CHECK (`0020_intraday.sql:84-85`) has no `stop_hit`; `pick_alert_mail.kind` CHECK (`:105`) lists five kinds; `PICK_MAIL_KINDS` `src/lib/email/keys.ts:67-74`; `PickEvent` `src/lib/email/pickMail.ts:38`; templates `src/lib/email/templates/pickAlerts.ts:129,160` (subject "fell under its stop … (delayed)"); the cap is `pick_alert_emails_per_day` (`keys.ts:1256`, read at `pickMail.ts:97,342`).
- **Acceptance:** AT-77 "stop-hit e-mails off" in a fresh configuration.
- **Gap:** both CHECK lists are closed on append-only tables (Gap 11).

---

## F. Shadow short and re-deferred stubs (ch. 21 §21.7, D-932)

### F.1 VAL-121 Shadow short stream
- **Full text (row "Short selling"):** "**Shadow short stream**: the Cortex's lowest-ranked eligible candidates (and event angles with polarity −1) are scored as would-have short setups with borrow cost and the market's short rules (ASX: no naked shorts, borrow via SLB [VERIFY]); measured as a labelled shadow lineage (VAL-121) with its own pre-registered test; no book, no order, no e-mail."
- **Current state (verified):** ranking `src/lib/cortex/night.ts:1275` `rankCandidates(passers, …)` (`src/lib/cortex/economics/rank.ts:63`, gate-passers only, descending; no lowest-ranked selector); `NightOutput` `:293-310` (decisions, queued, shadow, blocked); `wouldHaveOutcome` `:1408` is long-only (no side, no borrow); polarity `src/lib/agents/schema.ts:471` (`-1 | 0 | 1`), `eventPolarityAt` `src/lib/cortex/states/eventPolarity.ts:121`; `cortex_decision.arm ∈ {live, shadow}`, family F1…F7 (`0019_cortex.sql:145-151`); the book-less lineage template is the VAL-118 intraday stream (`src/lib/intraday/evaluator.ts:1-8`: `cortex_ledger_cell` kind `intraday_stream`, pre-registered hypothesis, one look per quarter, D-670); `holdout_look` exists from 0036 (`:163`) with no `src` reader. Borrow cost: none; nearest analogue `SLEEVE_FINANCING_RATE` (`src/lib/arena/sleeve.ts:64-69`, `[VERIFY]`); `short_interest` (`0008_agents.sql:61`) is a flag input (`src/lib/cortex/states/shortRisk.ts:23`), and the only SLB word is the IN profile string `fo_open_interest_slb_proxy` (`0034_m19_market_profile.sql:165`).
- **Tags:** **[VERIFY]** ASX borrow via SLB (Section M; internet).
- **Acceptance:** AT-78 "the shadow short lineage writes decisions and would-have outcomes only".

### F.2 ARN-124 a–c Re-deferred stubs with tests
- **Full text:** options/futures "no free, licensed option-chain or futures data with history for ASX/NSE/US at $0 (DAT-101 cannot pass); recorded as BLOCKED-DATA with the sources checked"; crypto "outside the equity Cortex (no exchange calendar, 24/7, no announcements model, no settlement)"; FX "same reasons as crypto; FX enters only as the seed-conversion and reporting rate (DAT-010)". All three: `stub`.
- **Current state (verified):** stub patterns: `NotBuiltM20` (`src/lib/cortex/profileReaders.ts:19-25`, tested `tests/cortex/profileReaders.test.ts:84-107`); `BlockedData` (`src/lib/agents/families/types.ts:301-306`, `F2_BLOCKED_DATA` `families/index.ts:43`); `PRE_REGISTERED_BLOCKED` (`src/lib/learning/preRegistered.ts:115-129`); data-limit records per market `src/lib/market/seed/dataLimits.mjs` (D-1167). FX today: `src/lib/market/fxSeed.ts:10-13` (`FXRINR`, `FXRUSD`), `src/lib/arena/seed.ts:11-31` — the seed conversion only.
- **Acceptance:** PRD-039 (a stub carries a reason and a test); no AT of its own.

---

## G. Platform (ch. 21 §21.7)

### G.1 PLT-078 Custom domain, ready
- **Full text:** "**Ready, needs Owner purchase**: `app_public_domain` key, Vercel domain-add and DNS steps in the Owner guide, cookie/CSRF/CSP configuration keyed on the domain; nothing changes until the Owner buys the name and sets the key". Key: `app_public_domain | unset | hostname | O [SETUP: domain purchase]`.
- **Current state (verified):** the app's origin is read only from `APP_BASE_URL`: `src/lib/auth/cookies.ts:14-23` `pinnedOrigin`, `:41-48` `sessionCookieConfig` (`httpOnly, sameSite lax, path /, secure`; no `domain` attribute), `src/lib/auth/config.ts:16-17,26-27`; CSRF is the origin gate `src/lib/http/gate.ts:81-102` (`expectedOrigin`, `sameOrigin`); CSP `src/lib/http/csp.ts:7-22` (no host in any directive; locked by `tests/http/cspLock.test.ts`); the one host-specific rule is `src/lib/selfcheck/checks.ts:82-86` requiring `u.hostname.endsWith(".vercel.app")`. The Owner guide has no domain section (`docs/owner-guide/M0_owner_guide.md:188,204,208`; `docs/owner-guide/operations.md:194-265`).
- **Acceptance:** none named; AT-77's "fresh production configuration" reads the key unset (ch. 15 acceptance).

### G.2 PLT-079 Installable PWA
- **Full text:** "**Installable PWA**: web manifest, icons, offline shell for the signed-in app chrome and the last loaded Picks/Home (read-only cache, no data mutations offline), install prompt in Settings; web push notifications [PROPOSED, off: e-mail stays the alert channel, EML-004]". Key: `pwa_push_enabled | false | bool | O`. Default "on (install is the user's choice)".
- **Current state (verified):** no manifest, service worker, offline page or `viewport` export (`src/app/layout.tsx:27-30` metadata only); icons exist at `public/brand/praxis-app-icon-192.png`, `-512.png`, `src/app/icon.png`, `icon.svg`, `apple-icon.png`; `src/app/robots.ts` disallows all; `next.config.ts:8-15,55-57` static security headers (no Cache-Control); the proxy matcher skips `_next/static|_next/image|favicon.ico|icon.png|icon.svg|apple-icon.png|brand/` (`src/proxy.ts:41-45`); CSP has no `worker-src`/`manifest-src` (both fall back to `default-src 'self'`). Settings page groups `account, appearance, time, region, about` (`src/app/(app)/settings/page.tsx:73-199`; rows in `SettingsRows.tsx`, `SettingsNav.tsx`). `scripts/ci/lighthouse.mjs` exists (npm `test:lighthouse`).
- **Acceptance:** none named; AT-82's walk covers the Settings row; the ch. 15 default `pwa_push_enabled = false`.

---

## H. Golden-set labelling page (ch. 24 §24.6, UXN-318; CXA-008, DAT-247)

- **Full text:** "`/cortex/labels?market=` shows one unlabelled announcement at a time (title, cited span, source link, published time, market), the three enumerated label groups as radio rows, "skip" and "flag as unclear"; progress "n of 500" per market; labels append-only with the labeller and time; keyboard-first (1–4 keys); never shows an LLM-proposed label before the Owner answers (to avoid anchoring)."
- **Current state (verified):** M20 built the store, not the page (D-1121, D-1168): `src/lib/labels/store.ts` (`MIN_LABELS_FOR_EVALUATION = 500` `:10`, `appendLabel` `:24` — refuses a label outside the **11 announcement categories**, `labelsFor` `:58` keyset pages of 500, `labelledCount` `:90`, `evaluationAllowed` `:106`), `src/lib/labels/evaluate.ts` (`LabelsBelowMinimum` `:10`, `evaluateClassifier` `:48`), table `label_item` (`0036_m20_markets_data.sql:142-151`, append-only, market-guarded `:238,244`), tests `tests/labels/{store,evaluate}.test.ts`. The **three CTX-040 enumerations** are elsewhere: `LABEL_ENUMS` `src/lib/llm/textLabels.ts:34-40` (guidance up/same/down/none; event_confirm confirmed/contradicted/unclear; tone negative/neutral/positive), stored by the LLM path in `text_label` (`0019_cortex.sql:309-320`, `cited_span`, `model_id`, `manifest_id`, `validation_id` NOT NULL). `announcement` (`0004_au_data.sql:217-230`) has `title`, `url`, `published_at`, `type`, `price_sensitive` and **no body or span column**. `/cortex` is every-role (`src/app/(app)/cortex/page.tsx:2,111`, loader `src/lib/ui/loaders/cortex.ts:200`, registered at `e2e/pages/strategies.ts:25`); no `cortex/labels` route exists. IN announcements are headline + link only (D-1125).
- **The two texts that define the golden set:** ch. 20 DAT-247 "CTX-040's golden set is per market: ≥ 500 Owner-labelled items per market before a text label may enter that market's score; until then labels are shadow for that market. The labelling page (UXN-318, CXA-008) takes a market filter." Ch. 22 CXA-008: "the **golden-set labelling page** (UXN-318, Owner only; per market; shows the announcement text span, asks for the three enumerated labels, stores Owner labels append-only)". Both name the CTX-040 labels, not the DAT-245 categories. The 500 is the fixed key `label_golden_min` (ch. 15 line 50, not in the §15.11.2 table; absent from `src/`, M20 used the constant).
- **Decisions:** D-1121 ("the page UI is M21"), D-1168 (count = distinct labelled items per market).
- **Acceptance:** AT-82 "the labelling page stores labels append-only and shows none before answering"; AT-75's label clause (proven in M20 on the store) stays green.
- **Gap:** two label vocabularies (Gap 8); "cited span" without a body (Gap 8).

---

## I. Acceptance tests

### I.1 AT-76 Committee and reflections (M21 part only)
- **Text (ch. 21):** "Fresh production configuration: `committee_enabled = false` and the switch is disabled until a planted health count shows 10 nights ≥ 98 %; with the switch on in a recorded-day CI run the AT-36 synthetic trial behaves as V2 states; reflections write only `pick_reflection`, queue under budget, and the AT-32 hash of a recorded night is identical with reflections on and off." Ch. 12: M21 exit "AT-76 (reflections part waits for M22)". Ch. 14: milestone "M21/M22".
- **Current state (verified):** `committee_enabled` is absent from `src/` (grep); the steelman health count exists (`src/lib/health/steelman.ts:20` `steelmanHealthOf`, qualifying nights at 98 %); the Committee (AGT-145), its switch UI (UXN-289…291) and reflections (AGT-146) are M22 rows (ch. 12).
- **M21 part:** the key default (§15.11.2) and the "switch disabled" predicate on the planted health count; the trial and reflections clauses are M22 (Gap 12).

### I.2 AT-77 Money-path off by default (M21)
- **Text:** "Fresh production configuration: `owner_real_money_tools = false`, `intraday_sweep_enabled = false`, stop-hit e-mails off, Workers-AI route disabled, `/recommendations`, `/holdings`, `/trades` return 404 for every role; switching `owner_real_money_tools` on changes no book, order, signal, rule or alert (AT-32 hash before/after); a Viewer and an Editor still get 404 with it on."
- **Current state (verified):** "fresh production configuration" is `freshDb` (`tests/db/helpers.ts:37-41`, every migration applied, no `config_version` rows) as `tests/acceptance/v3/at68.test.ts:348-368` uses it; route 404s are asserted with `envFor(...)` rejecting `NEXT_NOT_FOUND` (`at68.test.ts:359-365`) and in e2e (`e2e/market-off.spec.ts:74-89`); the hash-on/off pattern is `tests/acceptance/v2/at32Steelman.test.ts:262-302` (`world(mode)`, `differing`). `intraday_sweep_enabled` (AGT-147, M22) and the Workers AI route (LLM-078, M22) have no code in the tree (Gap 12).

### I.3 AT-78 Read-only money tools (M21)
- **Text:** "Broker links open the configured URL with only `{code}`/`{market}` substituted and no other parameter; a static test shows no server-side request to any broker host and no credential field anywhere; the trade log stores only the Owner's typed rows, is masked for other roles, and a planted trade changes no paper book; the tax report reproduces hand-computed specific-lot and FIFO figures for a fixture book and carries the fixed words; the shadow short lineage writes decisions and would-have outcomes only."

### I.4 AT-82 UI residual walk (M21)
- **Text:** "Six themes × two sizes × three roles: the accepted UXN-319 set renders as decided; no empty review band; Size column rule; dark mode via emulation and toggle identical; title-case names with acronym exceptions; index table axe-clean with caption; per-alert unmute and undo; cut steelman subjects show the limit text; Blueprint keyboard walk reaches every node, RSC and page checks share one test, the draw.io export parses with matching counts; the labelling page stores labels append-only and shows none before answering; no internal code appears in any text an Owner reads (D-922 scan)."
- **Current state (verified):** the matrix template is `e2e/picks-sections.spec.ts:22-60` (role × `[1280, 375]` × `THEMES`, masking, no horizontal scroll, axe); helpers `e2e/helpers.ts` (`signIn` 16-39, `setTheme` 41-63, `axeViolations` 65-80, `THEMES` 82, `ROLE_LIST` 84, `axeAllThemes` 98-113); seed states `e2e/seed/states.mjs:15-22` (picks-two-sections, experts-queue, steelman-cards, alerts-muted, market-built-off, blueprint-full). No D-922 scan exists; the closest regexes are `tests/email/templates.test.ts:156-175` (e-mail review only: `E\d{2}`, `F\d-[UL]`, `C\d-F\d`, `ARN-\d+`, `P[012]`, `NAV`). `docs/test-map.md:299-305` holds placeholder rows for AT-76…AT-82 ("no test cites this ID yet").

### AT coverage table (M21)

| Acceptance test | Covers |
|---|---|
| **AT-77** Money-path off by default | UX-131, §15.11.2 defaults (`owner_real_money_tools`, `intraday_sweep_enabled`, `stop_hit_email_default`), EML-043 (off), the three routes, roles with the switch on, AT-32 hash before/after |
| **AT-78** Read-only money tools | UXN-317, ARN-121, ARN-122 (**F**), VAL-121 |
| **AT-82** UI residual walk | UXN-319 accepted set, UXN-320 (a–d), UXN-321 (11, 13), UXN-322, UXN-323, UXN-324 (a–c), UXN-318, D-922 scan |
| **AT-76** (M21 part) | `committee_enabled` default and the "switch disabled until 10 nights ≥ 98 %" predicate |
| **AT-32 / AT-50, AU identity** (kept) | FAM-010 (no seed rule has a target), VAL-121 (writes its own tables only), UX-131 (hash with the switch on/off) |
| **AT-68, AT-67, AT-85** (kept, every CI run) | new market-keyed tables guarded; no literal outside the allow-list; every new AT named in the test map |
| **AT-41** (kept) | FAM-010 challenger counting (O-46) through the existing path |

---

## J. Configuration keys M21 registers, sets or changes (ch. 15 V3 §15.11.2)

| Key | Default | Bounds | Edit | Ref | M21 work |
|---|---|---|---|---|---|
| committee_enabled (V2) | false; switch disabled until BLD-041 is met | bool | O | AGT-145, D-938 | register (AT-76 M21 part); UI switch is M22 |
| intraday_sweep_enabled | false | bool; requires the batch-endpoint acceptance | O | AGT-147 | register (AT-77 reads it); reader is M22 |
| intraday_sweep_requests_per_slot | 5 | 0–20 | O | AGT-147 | register; reader is M22 |
| stop_hit_email_default | false (per-user setting defaults to this) | bool | O | EML-043, D-933 | register and read (E.2) |
| owner_real_money_tools | false | bool | O (audited) | UX-131, PRD-041 | register and read (C.1) |
| broker_links (per user) | none | list of {name, url_template} | user | UXN-317 | per-user preference, not a config key (Gap 5) |
| target_r / target_pct (family rule params) | none | 1.0–5.0 R / 5–50 % | — (challenger only) | FAM-010, D-943 | optional structural rule keys, not config keys (E.1) |
| app_public_domain | unset | hostname | O [SETUP: domain purchase] | PLT-078 | register and read (G.1) |
| pwa_push_enabled | false | bool | O | PLT-079 | register; no push code path |
| expert_poll_items_daily (V2) | 150, polled only with licence status enabled / owner-accepted-risk | 0–500 | O | KB-082, KB-083, D-939 | register (it is a §15.11.2 row and the ch. 12 M21 row says "ch. 15 §15.11.2 keys"); the poller that reads it is M22 KB-082; absent from `src/` today |
| llm_proposals_per_month | 3 | 0–10 | O | CXA-007 | register; reader is M23 |

- **Current state (verified):** none of `committee_enabled`, `intraday_sweep_enabled`, `intraday_sweep_requests_per_slot`, `stop_hit_email_default`, `owner_real_money_tools`, `broker_links`, `app_public_domain`, `pwa_push_enabled`, `llm_proposals_per_month`, `llm_budget_workers_ai_daily`, `expert_poll_items_daily`, `target_r`, `target_pct` exists in `src/` (grep, substrings included). The registry has no boolean kind (C.1).
- **Rule (ch. 15 acceptance):** "Given a fresh production configuration, then every default in §15.11.2 and §15.11.3 reads as listed (AT-77, AT-80)".

---

## K. Decisions linked to M21 (ch. 00 V3)

| D-nnn | Decision (short) | M21 part |
|---|---|---|
| D-930 | A11 is not an order path; measurement + promotion request only | boundary: nothing in M21 lets a figure reach an order (ARN-121, UXN-315) |
| D-931 | Phase R tools behind `owner_real_money_tools = false`; broker integration is deep links only; every page 404s while off | C.1…C.5 |
| D-932 | v1 non-goal safe forms: shorting = shadow lineage; options, crypto, FX re-deferred stubs; domain ready; PWA (push off); tax = paper report | F.1, F.2, G.1, G.2, D.2 |
| D-933 | Stop-hit e-mail opt-in, off by default (O-74) | E.2 |
| D-943 | Real target exit = per-family counted challenger; cards show the real target or the "no target" words; D-885 line retired on such cards | E.1 |
| D-944 | Holdings OCR is a stub (no server-side OCR at $0); manual table + CSV built; client-side OCR a [PROPOSED] P3 follow-up | C.4 |

**Build decisions M21 must record (D-1200…D-1239, in `docs/M21_design.md`):** the UXN-319 classification (Gap 1), the theme-toggle reading (Gap 2), the D-473 reversal for muted alerts (Gap 3), the AT-59 evidence (Gap 4), bool vs on/off keys and the per-user keys (Gap 5), the 404 shape of UX-131 (Gap 6), the D-922 scan (Gap 7), the label vocabulary and the span (Gap 8), the market facts of the tax year and short rules (Gap 9), FAM-010's acceptance home and order kind (Gap 10), the stop-hit storage (Gap 11), the AT-76/AT-77 M22 clauses (Gap 12), the broker templates (Gap 13), the borrow cost (Gap 14), the PWA cache scope and CSP (Gap 15), the domain key vs `APP_BASE_URL` (Gap 16), the tax engine's lot rules (Gap 17), the RSC one-code-path shape (Gap 18).

---

## L. M20 follow-ups that land in M21

Grep of `docs/M20_design.md` for "M21": only **D-1121** ("the page UI is M21 (UXN-318)"). M20 hand-offs addressed to the orchestrator and **not** to M21 (recorded here so no M21 task starts them): the `macro_series.source` CHECK widening for India macro and FRED (D-1171, D-1189), the 13D/G holder percent store (D-1184), `datedCostProfileRows` writer on enable (D-1181), the band-lock session counter (D-1158), the US price source (D-1132). `docs/M20_exit_evidence.md:89` names the next step "M21 requirements extract"; its §0 CI run id is TBD (Gap 19).

Stale pointers found while reading: `docs/M8.1_requirements.md:68` cites `AppHeader.tsx:72` and `ThemeCycle.tsx` (both gone); `docs/test-reports/AT-59.md:17,26` says the draw.io check is manual although `tests/blueprint/drawio.test.ts` automates it.

---

## M. [VERIFY] and [PROPOSED] items for M21 (every one the spec marks)

| # | Item | What must be verified | Spec source |
|---|---|---|---|
| M1 | UXN-317 broker templates | "[VERIFY per broker at build; none hard-coded as 'supported']" | ch. 21 §21.5 |
| M2 | VAL-121 ASX short rules | "no naked shorts, borrow via SLB [VERIFY]" | ch. 21 §21.7 |
| M3 | PLT-079 web push | "[PROPOSED, off: e-mail stays the alert channel, EML-004]" | ch. 21 §21.7 |
| M4 | D-944 client-side OCR | "[PROPOSED] P3 follow-up listed in the PR" | ch. 21 §21.5, ch. 00 |
| M5 | ARN-124 a sources checked | "recorded as BLOCKED-DATA with the sources checked" (option-chain / futures history for ASX, NSE, US at $0) | ch. 21 §21.7 |
| M6 | UXN-319 classification | "nothing is left undecided" | ch. 24 §24.1 |
| M7 | PLT-078 domain | "[SETUP: domain purchase]" (Owner step; nothing to verify in the build) | ch. 15 §15.11.2 |
| M8 | AGT-147 batch endpoint | "[VERIFY whether the batch endpoint is covered]" — **M22**, not M21 (the key only is registered here) | ch. 21 §21.3 |

---

## N. Items whose data needs an internet source

| # | Source | Items it feeds | Needs internet | Offline option the spec gives |
|---|---|---|---|---|
| N1 | Broker public order-page URLs and their terms | UXN-317 shipped templates (M1) | yes | "none hard-coded as 'supported'": ship no template; the Owner enters templates (the list is per user) |
| N2 | ASX SLB / short-sale rules (ASIC, ASX) | VAL-121 short rules (M2) | yes | record the rule as the spec states it with `[VERIFY]` in the seed constant; shadow only, so no money depends on it |
| N3 | Option-chain / futures data sources (ASX, NSE F&O archive, US) | ARN-124 a sources checked (M5) | yes (terms pages) | record the DAT-101 reasoning offline: the spec's own finding ("no free, licensed … at $0"), naming the candidates and their known terms status (NSE archive terms are DAT-121 `pending`, D-1143) |
| N4 | Vercel domain / DNS | PLT-078 | Owner step | the Owner guide text only |

Not M21 (listed so the orchestrator does not start them): KB-083 licence checks (M22), AGT-147 endpoint acceptance (M22), FRED/prediction-market terms (M22), Cortex research looks (M23).

---

## O. Gaps

1. **UXN-319 is a decision table, not a feature.** 35 still-[PROPOSED] items (B.1). Several need a new data path (UXN-107/108/125 LLM Q&A, 112 LLM budget, 116 provenance, 014 Web Push, 010 offline badge — partly met by PLT-079, 202 heatmap, 207 uptime strip, 209 trend tiles, 155 regime history, 062 arena-vs-controls, 151 sleeve meter, 153/154 scenarios and donut, 162 event log, 164/165 tags and sparklines, 204 version diff, 205 read dot, 211 live preview, 215 grade filter, 250 regime layout, 252 breakdown card, 255 asset-class menu, 124 "what would change this view" — these read pages' data differently or need stored state) and several are superseded by the V2 redesign (003 density → UXR-009/012/042; 008 skeletons → UXR-007; 011 navigation → UXR-005 and the TabBar; 018 icons → UXR-055; 105 glossary long-press → UXR-012; 117 data-gap words → UXR-007/D-922; 156 kill-switch state → UXR-044/045; 169 e-mail dark CSS → D-884 and the M8.1 e-mail templates; 109 citation popovers → UXR-024). The design must fix the table and bound the accepted set so a stream can own its files (the accepted items touch files other M21 tasks own).
2. **UXN-320 (c) names the header theme toggle (D-171), which no longer exists** (`AppHeader.tsx:1-3`, UXR-004/005). The clause must be read against the Settings theme control, and "both sizes" against the e2e convention (viewport widths) or the two text sizes.
3. **UXN-322 reverses D-473.** D-473 ruled per-alert unmute out because the state machine is append-only; the V3 text (Owner backlog D39) asks for it. The design must give the unmute a legal transition on the append-only table (a new `armed` row) without touching the CHECK lists.
4. **UXN-324 (c) is already built** (`tests/blueprint/drawio.test.ts`, header cites UXN-324 (c)); only the evidence (`docs/test-reports/AT-59.md`) and D-369 are stale.
5. **ch. 15 says `bool`; the registry has no boolean kind.** Every Owner switch is `"on"/"off"` text (`ON_OFF`); `input: "bool"` exists only for fixed profile fields. `broker_links` is "per user" (Edit = user) and `target_r`/`target_pct` are family rule params: neither is a `CONFIG_KEYS` entry.
6. **"404 for every role while off" includes the Owner.** The SEC-112 pattern (Blueprint) hides a route from non-Owners through the proxy header and a config rewrite; UX-131's pages must 404 for everyone while off and for Editors/Viewers while on, yet appear in the Owner's nav when on. The proxy pattern cannot read a config key cheaply; the page guard (`notFound()`) can.
7. **No D-922 scan exists.** AT-82's last clause needs a static scan of Owner-read text with an allow-list (the pattern of `scripts/ci/market-literals.mjs` and `scripts/ci/readability.mjs`); the e-mail-only regexes in `tests/email/templates.test.ts:156-175` are the seed.
8. **Two label vocabularies and no span.** UXN-318 shows "the three enumerated label groups" (CTX-040: guidance, event_confirm, tone, `LABEL_ENUMS`) with a "cited span"; M20's `label_item` stores one of the **11 announcement categories** (DAT-245) per item and the AT-75 clause was proven on it (D-1168). DAT-247 and CXA-008 (quoted in H) say the golden set is CTX-040's, so the page asks the three CTX-040 groups; `label_item` stays the category store. `announcement` has no body column, so a span can only be chosen from the title (IN: headline only, D-1125).
9. **Market facts in M21.** The tax year start (AU 1 July, IN 1 April, US 1 January), the short-sale rules and borrow cost per market, and the profile→tier words are per-market or product constants; AT-67 forbids them outside `src/lib/market/**` and the allow-list. Adding profile fields would change the seed (profile_version, 0034 rows); a seed table module per market avoids that.
10. **FAM-010 has no AT and `arena_order.kind` is a closed CHECK.** Ch. 14 names no AT for FAM-010; the M21 row marks it **F**. A new order kind would need a table rebuild of an append-only table; the `exit_cs` path already exits at the next open.
11. **EML-043 storage.** `pick_alert.clear_reason` and `pick_alert_mail.kind` are closed CHECK lists on append-only tables; the evaluator stops checking the stop after a hit (`evaluate.ts:40-42`). "one e-mail per pick per session" needs its own idempotency record.
12. **AT-76 and AT-77 cite M22 features.** AT-76's trial and reflections clauses need AGT-145/146 (M22); AT-77's `intraday_sweep_enabled` (AGT-147) and "Workers-AI route disabled" (LLM-078) have no code in M21. M21 can prove the defaults and the absence of the routes; M22 re-runs both tests.
13. **Broker templates cannot be verified offline** (M1, N1).
14. **Borrow cost has no source.** The spec names "borrow cost" and the ASX SLB rule [VERIFY] without a rate; the only analogue is the sleeve financing rate (`[VERIFY]`, 9 % p.a.).
15. **PWA cache and CSP.** The offline shell caches signed-in HTML in the browser; CSP is locked (`tests/http/cspLock.test.ts`) and `worker-src` falls back to `default-src 'self'` (fine for a same-origin `sw.js`); the proxy matcher must let `/sw.js` and `/manifest.webmanifest` through without the auth gate.
16. **`app_public_domain` vs `APP_BASE_URL`.** Cookies, CSRF and CSP already key on the `APP_BASE_URL` origin (an E setting); the new key is Owner-editable in the UI. The selfcheck's `.vercel.app` rule (`checks.ts:84`) would fail on a custom domain.
17. **Tax engine lot rules.** `trade` pairs one entry fill with one exit fill (specific lot = the trade); `replayCostBasis` is average cost; FIFO must be recomputed per cohort and code; proceeds/cost include `brokerage_micro`; "franking where recorded" lives in `corporate_action.payload_json`; dividends are `cash_ledger` `div_pay` rows; the holding period is 12 months by calendar date.
18. **"One code path" for the RSC header.** The gate comment (`gate.ts:59-61`) records that a direct proxy rewrite leaks `x-middleware-rewrite`; the header + config rewrite leaks `x-nextjs-rewritten-path` on RSC requests. The design must choose the shape that leaves no header difference between a hidden route and a missing one.
19. **The M20 gate.** `docs/M20_exit_evidence.md` §0 still says TBD, but BUILD_SETUP §9 "V3" (data repo, commit `b088c55`) records CI green on `build` `6c556e7a` (run 43347157615, every job incl. e2e and `recorded-day-dev`). BLD-049 order is met; the run id goes into M21 exit §0.
20. **Trade log and holdings are user-keyed rows in the main database.** `pick_alert.user_id` is the precedent (main DB, user id from the auth DB); the rows are market-keyed and therefore guarded (an IN/US holding is refused while the market is off — consistent with AT-68).

---

## P. Not in M21

- **AGT-145 Committee, AGT-146 reflections, AGT-147 sweep, AGT-148 opinion measurement, LLM-077…081, KB-082…085, DAT-248…250** (M22); M21 registers only the §15.11.2 keys.
- **VAL-120 intraday meter, CXA-003…015 research, the holdout registry UI** (M23).
- **OCR** (D-944 stub only), **web push** (off), **the Owner's domain purchase and the switch-on of IN/US** (Owner steps after the merge).
- **M20 orchestrator hand-offs** (Section L).
- **Staging, ASX Worker poll, self-hosted infrastructure** (BLD-052, PRD-046, PRD-047).

---

## Q. Carried over (facts the M21 tasks rely on)

- **Identity files never rewritten**: `tests/acceptance/v3/replay-hash.baseline.json`, `tests/market/au-constants.snapshot.json`, `worker/test/fixtures/au-slots.snapshot.json`.
- **Schema position**: last migration `0036_m20_markets_data.sql`; the assertions pinned to 36: `tests/backup/core.test.ts:121,211,327`, `tests/db/0036_m20_markets_data.test.ts:72-73`, `tests/db/0035_m19_market_guard.test.ts:46` (100 guarded tables), `:78` (200 triggers), `:210` (last name), `tests/db/0034_m19_market_profile.test.ts:48`, `tests/cortex/stageTables.test.ts:56-60` (`scan(36)` minus `M20_TABLES`), `worker/test/fakeTurso.ts:4-24`. Guard generator `scripts/db/gen-market-guard.mjs` (`M20_TABLES` `:28`, generated region markers as in 0036:180,307).
- **AT-32 compare sets**: `STEELMAN_OWN` (`tests/acceptance/v2/at32Steelman.test.ts:52-67`, `tests/acceptance/v3/replayHash.test.ts:109-118`), `MIGRATION_OWNED` (`replayHash.test.ts:121`), `CHALLENGER_PATH` (`tests/acceptance/v2/at41Replay.test.ts:265-271`); `STAGE_TABLES` pinned (`src/lib/cortex/stageTables.mjs`, D-1116).
- **Export routes**: `EXPORT_ROUTES` (`gate.ts:55`) and the walk test (`tests/http/gate.test.ts:379-392`).
- **Page registry and guard test**: `e2e/pages/*.ts`, `tests/ui/pageGuard.test.ts`.
- **Per-user preferences**: `user_preference.prefs_json`, `Preferences`/`ALLOWED`/`PICK_FIELDS` in `src/lib/preferences/service.ts:56-116`.
- **Owner-only page pattern**: `requireUser("admin", path)` (403), e.g. `src/app/(app)/usage/page.tsx:122`; hidden-route pattern: `requirePinnedOwner` (404), `src/lib/auth/blueprintGuard.ts:72`.
- **Audit**: `audit(db, env, meta, event)` `src/lib/auth/audit.ts:39-49`; `auditTx` `:52-63`.
- **D-922 words**: `docs/M7_design.md:283` (no E01, F1-U, C2-F1, ARN-xxx, P0/P1, NAV or CS/IS in Owner-read text).
