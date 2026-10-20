# M7 requirements extract: UI

Status: draft extract (build agent, 2026-10-20). Not yet verified by the architect; every `[CHECK]` item in §5 needs an architect or Owner decision.

Source: `spec/` in this repo (chapters 02, 03, 04, 05, 06, 07, 08, 09, 10, 12, 13, 14, 15 and 16). `spec/09_ui_ux.md` and `spec/16_ui_next_level.md` were read in full; `spec/14_system_acceptance.md` was read for §14.7 and the cross-references; the other chapters were read by line where they define what a page must show. The existing pages were taken from `src/app/**/page.tsx`, the M5 and M6 exit evidence, `docs/07_decision_log.md` and `docs/test-map.md`. The private data and fixtures repositories were not read. Extract only. Quotes are trimmed with "…". Spec IDs are cited as written. `(l.N)` is a line in the named spec file, and `09` means `spec/09_ui_ux.md`. Where a row names no AT or test, the acceptance column says "gap". Items marked **[CHECK]** are unclear, conflicting or not found in the spec and need an Owner or architect decision. Spec text is the authority; this file does not change it.

## 1. M7 scope (ch.12 §12.3, verbatim)

> M7 | UI | All pages of Ch. 09, role-aware, mobile | AT-25…AT-27

Related items:

- **Ch. 16 P1 items** (`12` l.65, s13): "Accepted P1 items join M7 (pages) and their back-end parts (AGT-112, AGT-113, ARN-095, Market data) join M5/M6; P2/P3 items follow go-live. Design-system items UXN-001–018 are the first task of the first milestone that builds pages." The back-end parts are built in M6 (D-122, D-124). The P1 screens are M7. See §5 item 18 for the design-system timing.
- **O-38** (`00` l.71): "all ch. 16 P1 items accepted for v1 — screens in M7, back-end in M5/M6; P2/P3 after go-live (Q-061) · six tabs Home/Picks/Market/Strategies/News/Reviews (Q-062) · candle charts up to 2Y (Q-060) · delayed intraday prices yes (Q-058; UXN-048 → P1)."
- **AT-26 / AT-30** (`14` l.61, l.69): AT-26 carries the 360 px and accessibility checks in M7. The Owner walkthrough of the six tabs and the gear-menu pages is AT-30, which runs at M8.
- **TST-126 to TST-129** (`10` l.161–164): the UI end-to-end, visual, component and email tests. These are the M7 test rows (§2.17).
- **UXN-284 build stack** (`16` l.324, [OWNER] s13): Next.js 16+, shadcn/ui themed through tokens, Motion, TradingView Lightweight Charts for candlesticks, one dashboard chart library, and a screenshot review on desktop and phone, Dark and Light, for every page before its pull request.
- **Public page rule** (`02` l.9, PLT-004): "Pages MUST be marked non-indexable." (`02` l.49, PLT-036: "`robots` directives MUST disallow indexing.")

## 2. Requirements table

Columns: ID (file l.N) | quote | acceptance test | ch.15 keys. Rows are grouped by page or topic. Pages are numbered in §7.

### 2.1 Platform, tokens, responsive layout and accessibility (ch.09 §9.1, ch.16 §16.1–16.2, §16.17)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-001 (09 l.8) | "Next.js web app on Vercel (PLT-003, PLT-072); fully usable on a phone (≥ 360 px wide) and desktop; dark and light themes (dark default); WCAG 2.2 AA contrast and keyboard navigation." | AT-26; TST-126 | — |
| UX-002 (09 l.9) | "Every monetary result is labelled **"Simulated"**. … Unmeasured values show "not yet measured" (REV-003). A short always-visible explainer states what "Simulated" means …" | AT-27; TST-126 label audit | — |
| UX-003 (09 l.28) | "A market switcher (AU / IN / US) sits in the header; each market shows its **work status** (MKT-106: not started / in build / testing / active / paused) and, until active, its checklist (MKT-102)." | gap (no test named) | — |
| UX-004 (09 l.29) | "Controls a role cannot use are hidden for Viewers **and** visible-but-disabled-with-reason for Editors …; all controls are refused server-side per the role × action matrix (ROL-102a)." | TST-122 (each role allowed vs refused); TST-126 (both roles' views) | — |
| UX-005 (09 l.30) | "First contentful paint < 2 s on a mid-range phone over 4G for Dashboard; API p95 < 500 ms for page data (NFR-010). Pages load from pre-computed nightly tables, not live recomputation." | AT-26 (Lighthouse part); NFR-010 (`10` l.38) | — |
| UX-006 (09 l.31) | "No third-party trackers, no remote images in-app except our own assets (PLT-036)." | gap (no test named) | — |
| UX-007 (09 l.32) | "Every page defines what it shows before the first cohort/data exists and when its data is stale (older than **2×** its expected interval, as PLT-017) — a banner with the last good timestamp." | AT-25; TST-126 (stale state) | — |
| UX-008 (09 l.27) | "LLM text is rendered as plain text (no markdown links/images); links are clickable only if `https:` and their host is in the source register (SEC-016)." | gap (no test named) | — |
| UX-009 (09 l.14) | "Masking for non-Owners (ROL-107). Default when unmasked = off: … Active set = every code appearing in any record visible to that user for that Melbourne date; letters are fixed for the whole date and never re-used within it." | TST-122 (masking) | unmask_expiry 30 days (`15` l.171) |
| UX-009 table (09 l.16–24) | Masking matrix: "Dashboard tiles, Arena, leaderboard … no codes"; "Signals, Decision Cards, Risk Monitor positions … \"Stock A/B…\" … no trade prices, trade-level dates (week only …)"; "News … company items only for unmasked codes"; "Knowledge … rules-only template text for lessons". | TST-122; AT-25 | — |
| UX-101 (09 l.10; errata `13` l.113) | "Store and show headline, source, timestamp, link to the original and a system-written summary (≤ 80 words, labelled). Full third-party text or images are not copied unless the source licence permits (DAT-120)." | gap | — |
| UX-102 (09 l.11) | "Any mockup, seeded demo or empty-state example shows "SAMPLE DATA"." | AT-25 (empty states) | — |
| UX-103 (09 l.12) | "Visual themes (e.g. a "Jarvis-style" System Health look) are optional and never display decorative or invented numbers." | gap | — |
| UX-104 (09 l.13) | "Every page showing a target, signal or result shows the relevant reality panel (PRD-020/021/026) and the validation label (ARN-086)." | AT-27 | — |
| UXN-001 (16 l.21) [ACCEPTED, O-38] | "The design system MUST define a single colour-blind-safe gain/loss pair (teal/amber-orange) used everywhere a monetary result or P/L is shown, always paired with a sign, arrow icon and … a text label. Regime, validation-label and thesis-breaker states MUST use separate, non-gain/loss token families." | AT-26 (contrast); test-map (`docs/test-map.md`) row UXN-001 | — |
| UXN-002 (16 l.22) [ACCEPTED, O-38] | "All numeric display (prices, NAV, %, n, dates) MUST use a tabular-figure font so digits align in columns; body text uses a separate free font. Both fonts MUST be self-hosted or Google Fonts (no remote tracking per UX-006)." | gap | — |
| UXN-005 (16 l.23) [ACCEPTED, O-38] | "All animation (loaders, transitions, number count-ups) MUST respect `prefers-reduced-motion: reduce` by disabling non-essential motion; essential state changes … still convey information without animation." | AT-26; test-map UXN-005 | — |
| UXN-015 (16 l.24) [ACCEPTED, O-38] | "Every interactive control MUST define default/hover/keyboard-focus/active/disabled states, with a always-visible 2px focus ring meeting AA contrast, and a `disabled` state that never removes the reason text required by UX-004." | AT-26; test-map UXN-015 | — |
| UXN-017 (16 l.25) [ACCEPTED, O-38] | "The app MUST define mobile (≥360px, per UX-001)/tablet/desktop breakpoints … so every page in §9.2 reflows without horizontal scroll at 360px, and multi-column tables … switch to a stacked card view below 600px." | AT-26; TST-126 (phone width) | — |
| UXN-019 (16 l.185) [ACCEPTED, O-38] | "Settings → About MUST list every bundled library/font with its licence and required attribution (generated at build from the lockfile), and a CI check MUST fail if a new dependency has a licence outside {MIT, ISC, BSD-2/3-Clause, Apache-2.0, MPL-2.0, OFL-1.1} without an Owner-approved exception." | gap (no About page exists, §7) | — |
| UXN-030 (16 l.191) [ACCEPTED, O-38] | "All owner-facing text (app, emails, alerts) MUST be written for a non-expert … target Flesch–Kincaid grade ≤ 8 for headings, labels and summaries. … Statistical detail (n, intervals, rule versions, IDs) sits behind a "Show details" control, collapsed by default." | gap (CI readability check named in `16` l.219; tool not named) | — |
| UXN-031 (16 l.192) [ACCEPTED, O-38] | "The UI MUST show the friendly name and keep the official term in the hover/tap text (and in exports, logs and the spec). Mapping (config-driven, Owner-editable)…" with the term table (16 l.194–209). | gap | — |
| UXN-032 (16 l.212) [ACCEPTED, O-38] | "Every trading term that stays visible … MUST have a dotted underline and show a 1–2 sentence plain explanation with a tiny example on hover (desktop), tap (phone) and keyboard focus … Hover text MUST NOT exceed 40 words; a "More" link opens the Glossary entry." | gap; `16` l.221 (40-word rule) | — |
| UXN-036 (16 l.216) [ACCEPTED, O-38] | "Requirement IDs, rule versions, agent names (A1–A8, R1–R5), bare family codes (F1–F6) and internal status words MUST NOT be primary text. … Technical names stay available to the Owner under "Show details"." | gap; conflict with UX-091 (§5 item 26) | — |
| UX-071b (09 l.93) | "A searchable Glossary page provides tap-to-define tooltips for CIF, effective N, thesis-breaker, cost drag, validation labels … and effective cohorts." | gap | — |
| UXN-284 (16 l.324) [OWNER] | "Pages MUST be built on: Next.js 16+ …, shadcn/ui components themed only through our tokens (UXN-001, UXN-280), Motion for animation, TradingView Lightweight Charts for candlesticks (with its required NOTICE and on-chart `attributionLogo` link, §16.17) and one chart library for dashboards … MUST run a screenshot review on desktop + phone in Dark and Light for every page before its pull request." | TST-127 (visual, Dark/Light × desktop/phone) | — |
| §16.17 licences (16 l.178–184) | Licence table: MIT, ISC, Apache-2.0 (Lightweight Charts: "the NOTICE attribution and a link to the library author's website MUST appear on every page that shows such a chart"), MPL-2.0 (web-push), OFL-1.1 (Inter, JetBrains Mono). | UXN-019 CI check | — |
| SEC-012 (10 l.75) | "Headers: HSTS, Content-Security-Policy without `unsafe-inline` scripts (nonces allowed), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`; `robots` noindex (PLT-036)." | AT-29 (M8); gap at M7 | — |
| PLT-004 (02 l.9) | "The app MUST be served only on the Vercel-provided `*.vercel.app` address … Pages MUST be marked non-indexable." | gap | — |

### 2.2 Navigation, shell and alert bell (ch.09 §9.2, ch.16 §16.2, §16.19, §16.23, §16.24)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| §9.2 menu (09 l.37–49) | Original menu: "Dashboard \| §9.3 \| all", "Arena \| §9.4 leaderboard + §9.5 execution detail \| all", "Signals", "Risk Monitor", "News", "Knowledge \| … \| all (edit: Owner)", "Reviews", "System Health \| … \| all (details: Owner)", "Usage \| Owner", "Ops checklist \| Owner", "Settings / Admin \| Owner (personal preferences: all)". | superseded by UXN-270 (§5 item 1) | — |
| UXN-033 (16 l.213) [ACCEPTED, O-38] | "Navigation MUST be reduced to four main tabs … Settings, System health, Usage, Ops checklist and Users & roles move to one account (gear) menu. Every page MUST be reachable in at most three levels (Tab → item → detail …) with a back link and a one-line breadcrumb." s13: "Tab list superseded by UXN-270". | AT-26; AT-30 (M8) | — |
| UXN-270 (16 l.302) [ACCEPTED, O-38] | "Navigation becomes six tabs: **Home, Picks, Market, Strategies, News, Reviews** (amends UXN-033/UXN-040; on phones the bottom bar shows icons with short labels and may use a "More" item if the labels do not fit at 360 px)." | AT-25; AT-26 ("six main tabs") | — |
| UXN-040 (16 l.250) [ACCEPTED, O-38] | "Navigation becomes five tabs: **Home, Picks, Strategies, News, Reviews**" — superseded by UXN-270 (s13). | superseded | — |
| UXN-011 (16 l.30) [PROPOSED] (P2) | "On mobile (<600px) the §9.2 menu MUST render as a fixed bottom tab bar (Dashboard, Arena, Signals, Risk Monitor, more) …" — inactive P2 text still names the old tabs (§5 item 1). | P2: not built | — |
| UXN-161 (16 l.82) [ACCEPTED, O-38] | "The header MUST show a persistent bell icon with an unread-count badge (coloured by highest unacknowledged tier) that opens the alert inbox (UX-052); the badge clears only on acknowledgement, not merely on opening the panel …" | AT-25 (inbox page) | — |
| UXN-282 (16 l.321) [ACCEPTED, O-38] | "The header MUST show a region menu (e.g. "AU · ASX · Open 14:32") listing every market in MKT-106 with its status (Active / In build with % / Not started). Only `active` markets can be selected; others are shown disabled with the reason." | gap (§5 item 27) | — |
| UX-016 (09 l.58) | "Market status strip: one chip per market with its work status (MKT-106) and milestone." | AT-25 | — |
| UX-015 (09 l.60) | "Banners: missing recipient email (EML-006), degrade mode (PLT-051), partial review (EML-011), sources switched off (DAT-123), token expiry within 14 days (PLT-074), no Evening Review marked read for 3 days (EML-036)." | AT-25 | unopened_review_banner 3 days (`15` l.165) |
| UXN-046 (16 l.286) [ACCEPTED, O-38] | "The Home "Needs your attention" block (UXN-034) is removed; the Home day-summary line instead says e.g. "4 strategies need a look" linking to Strategies. The **Strategies** tab MUST show a count badge … no badge when zero." | AT-25 | — |

### 2.3 Sign-in, sessions, errors and public pages (ch.09 §9.14, ch.02 §2.5)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-120 (09 l.120) | "Sign-in page with "Sign in with Google" only; non-allowlisted accounts see a neutral "not authorised" message that reveals nothing about the system (PLT-030/031)." | AT-25; ROL-101 tests (M1–M5) | — |
| UX-121 (09 l.121) | "Session expiry returns the user to sign-in and then to the page they were on." | gap | session_lifetime 14 days (`15` l.160) |
| UX-122 (09 l.122) | "Generic error page with a correlation id; details only in Owner logs." | gap | — |
| PLT-031 (02 l.44) | "**Every** page, API route, server action and data endpoint MUST require a valid session of an allowlisted user whose role permits the action (ROL-101/102a). The only unauthenticated surfaces are the sign-in page and a minimal, non-informative liveness response." | TST-122; `docs/test-map.md` ROL rows | — |
| PLT-033 (02 l.46) | "Sessions MUST be HttpOnly, Secure, SameSite cookies with a bounded lifetime (default 14 days) and a sign-out action." | gap | session_lifetime (`15` l.160) |
| SEC-011 (10 l.74) | "State-changing requests require same-origin (Origin/Referer check) plus SameSite cookies; no state change via GET." (applies to "Mark as read" and the Owner action buttons). | TST-122 (CSRF/origin) | — |
| PLT-036 (02 l.49) | "No third-party analytics, ad or tracking scripts. `robots` directives MUST disallow indexing." | gap | — |
| D-016 (`docs/07_decision_log.md` l.22) | Public `/privacy` and `/terms` pages (plain text), built in M1. | `docs/test-map.md` row D-016 / PLT-035 | — |
| NFR-031 (10 l.125) and ROL-106 (10 l.70) | "Disclaimers on every page and email: simulated results, personal information only, not financial advice" and "Every page visible to non-owners carries "Simulation for personal information only — not financial advice"". | AT-27 | — |

### 2.4 Home (ch.09 §9.3 Dashboard, ch.16 §16.3, §16.21, §16.23)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-010 (09 l.52) | "Top strip per active market: date of last completed run, data-quality verdict (DAT-210), regime (AGT-101) with a tap-to-show one-line meaning and its effect on entries, Sentinel status, "Simulated" label." | AT-25 | — |
| UX-012 (09 l.54) | "Today's changes: new entries/exits scheduled for next open, cohorts completed today (target/bust/stalled/timeout), P0/P1 alerts since last review." | AT-25 | — |
| UX-012a (09 l.55) | "Dashboard first visit shows a dismissible welcome banner summarising the 12 executions, the A$1,200 target and A$300 bust line, and what "Simulated" means." | AT-25 | — |
| UX-013 (09 l.56) | "Headline scorecard (ARN-077) showing per-currency totals only, no FX-converted grand total (O-34) and a link to tonight's Evening Review." | AT-27 | — |
| UX-014 (09 l.57) | "Reality panel (PRD-020 odds table, collapsible) and control comparison: best of the 12 executions vs the distribution of the **best of 12 matched control portfolios** …" | AT-27 | — |
| UX-017 (09 l.59) | "Evidence-timeline notice (VAL-102, PRD-028): "Forward rankings need ≥ 5 finished cohorts (effective) per execution and forward labels need ≥ 100 forward signal trades …"" | AT-27 | — |
| UXN-034 (16 l.214) [ACCEPTED, O-38] | "Home MUST show, top to bottom: a one-sentence summary of the day in plain words; total pretend value per currency with today's change; market mood; … tonight's trade ideas (max 5, each opening "Why this trade"); top 3 news items … ; a link to the latest Evening Review; system status as one line". The "Needs your attention" item is removed by UXN-046. | AT-25 | — |
| UXN-050 (16 l.34) [ACCEPTED, O-38] | "The Dashboard MUST show a sticky top summary card with per-currency total simulated value and day change …, and a persistent "Simulated" label per UX-002; loading shows a skeleton (UXN-008), never a blank hero." | AT-27; `16` l.337–338 acceptance | — |
| UXN-041 (16 l.251) [ACCEPTED, O-38] | "Home and Picks MUST show one slim strip: **"Model success: X%"** = share of closed picks that made money after costs, with n, the period and the luck-check comparison …" | AT-25; AT-27 (no uncalibrated probability) | pick_success_min_n 30 (`15` l.213) |
| UXN-044 (16 l.254) [ACCEPTED, O-38] | "Home shows "Today's picks" (top pick per profile, one line each) directly under the day summary …" | AT-25 | picks_per_profile (`15` l.208) |
| UXN-047 (16 l.288) [ACCEPTED, O-38] | "The watchlist is a section on Home ("My watchlist": name, code, last price with its time and "delayed" label, today's change, a Good/Bad/Neutral dot for the latest news) …" | AT-25 | watchlist_max 50 (`15` l.207) |
| UXN-048 (16 l.289) [ACCEPTED, O-38] | "During the market's trading hours the app MAY show **delayed prices** (labelled "Delayed about 20 min" [VERIFY at build]) for watchlist, held and pick companies only (≤ `intraday_codes_max`, default 150), refreshed at most every `intraday_refresh_min` (default 5) minutes …" | AT-25; UXN-048 acceptance (`16` l.296) | intraday_codes_max 150; intraday_refresh_min 5 (`15` l.205–206) |
| UXN-057 (16 l.36) [ACCEPTED, O-38] | "The AGT-101 regime badge (SHOCK/RISK-OFF/RISK-ON/NEUTRAL, exact state names) MUST appear in the same visual form on the Dashboard strip …, on each arena tile, on the leaderboard as a filter, and in the Decision Card header …" | AT-25; `16` l.340 acceptance | — |
| UXN-250 (16 l.144) [PROPOSED] (P2) | "The Dashboard's tile grid and emphasis MAY adjust layout … based on the current market regime" | P2: not built | — |

### 2.5 Strategies, arena leaderboard and execution detail (ch.09 §9.4–9.5, ch.05 metrics, ch.16 §16.3–16.5, §16.22–16.23)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-011 (09 l.53) | "Arena summary: 12 execution tiles (E01–E12) each with family, U/L variant, NAV vs the A$600 seed, A$1,200 target, A$300 bust line and the **stall floor** (≈ A$511, U and L) (progress bar), **progress** = empirical P(target \| NAV, time) with n or "not yet measured" (ARN-071) …" | AT-25; AT-27 | stall_floor (`15` l.12); stall_sessions 5 (`15` l.13) |
| UX-020 (09 l.63) | "Table of (execution, rule version) with: family, variant, resolved cohorts and effective N, CIF of target, bust **and** stalled at 3/6/12 months with CIs, E[NAV end] − seed, each also minus the matched control (ARN-071) …" Below 600 px: "a card view". Sort label order listed in the same row. | AT-25; AT-26 (card view) | — |
| UX-021 (09 l.64) | "Controls C1–C3 rows appear alongside; a "possible luck" flag shows where ARN-086 requires it." | AT-25 | — |
| UX-022 (09 l.65) | "Toggle: cost profile replay (P0–P5, P5b and stress, ARN-034) served from pre-computed nightly per-fill tables (no heavy compute in the request)." | AT-25 | cost_profile_default P5 (`15` l.24) |
| UX-023 (09 l.66) | "U-vs-L twin comparison per family (ARN-050/084) with the reality-adjusted 5× view (ARN-049) and the hypothetical-leverage label." | AT-27 | — |
| UX-030 (09 l.69) | "Page header shows "Cohort N · started [date] · [x] sessions held" above the NAV chart for the current cohort with seed, target and bust lines; list of past cohorts with outcome, TTD, drawdown." | AT-25 | — |
| UX-031 (09 l.70) | "Positions and trade list; each trade links to its Decision Card (§9.6) and costs breakdown." | AT-25 | — |
| UX-032 (09 l.71) | "Rule version in use (link to Knowledge), pending challengers for this execution, sleeve state/history (L only), change ledger entries affecting it. A version-history panel shows date, action, VAL-110 result, and an Owner-only revert button." | AT-25; ROL-102 | — |
| UXN-039 (16 l.268) [ACCEPTED, O-38] | "Every place a strategy appears MUST show its **short name** plus the money type ("Own money" / "With borrowed money") … Strategy lists and cards MUST also show the one-line description below the name (visible, not hover-only)." Table of six names (16 l.270–277). | AT-25; `16` l.280 acceptance | — |
| UXN-046a (16 l.287) [ACCEPTED, O-38] | "Sorting (decided) — "Needs attention" is sorted by the urgency order above … "All strategies" is sorted by default by **change since the start of the current round** (best first) … Owner-selectable sort chips: "Best so far" (default), "Closest to goal", "Most at risk", "A–Z". The chosen sort is remembered per user (UX-110 preferences)." | AT-25 | — |
| UXN-051 (16 l.47) [ACCEPTED, O-38] | "The execution-detail NAV chart (UX-030) MUST support hover/tap scrubbing showing a crosshair and a tooltip with date, NAV, day change and regime-at-that-date; data comes only from the pre-computed nightly series …" | AT-27; `16` l.342 | — |
| UXN-052 (16 l.35) [ACCEPTED, O-38] | "Each of the 12 execution tiles (UX-011) MAY add a small non-interactive sparkline of the last 30 sessions' NAV and a subtle background tint keyed to the tile's regime-at-entry …; empty/insufficient-history tiles show "not yet measured" instead of a sparkline." | AT-25; `16` l.339 acceptance | — |
| UXN-053 (16 l.43) [ACCEPTED, O-38] | "The Arena leaderboard (UX-020) MAY add a small inline sparkline per row and a sticky header row on scroll; sortable columns and their content stay exactly the UX-020 metric set …" | AT-25; `16` l.337 acceptance | — |
| UXN-054 (16 l.48) [ACCEPTED, O-38] | "Entry/exit trades on the NAV/price chart (UX-031) MUST be marked with distinct entry/exit icons; hovering/tapping a marker shows date, price, size, P/L and a link to its Decision Card. A compact chronological trade strip below the chart MUST let the user step between trades … (bidirectional link)." | AT-25; `16` l.343 acceptance | — |
| UXN-055 (16 l.49) [ACCEPTED, O-38] | "Execution detail MAY show a drawdown-from-peak chart alongside the NAV chart, using the amber/orange loss colour token (never red-green), annotated with the max-drawdown figure already reported in UX-020 …" | AT-27; `16` l.344 acceptance | — |
| UXN-068 (16 l.50) [ACCEPTED, O-38] | "Execution detail MUST let the Owner/Editor/Viewer toggle an overlay of the C1–C3 matched controls (UX-021) and the zero-edge benchmark (ARN-071) on the NAV chart …; no external market index or "random control" wording is introduced." | AT-27; `16` l.345 acceptance | zero_edge_seed (`15` §15.7) |
| UXN-053 metric rule (16 l.43) | "no invented metrics (e.g. "Sharpe", generic "Win Rate %") are added as columns. A regime filter chip … MAY be added; no arbitrary "This Week/This Month" toggle is added …" | AT-25 | — |
| UXN-060 (16 l.37) [ACCEPTED, O-38] | "Every place a validation label appears (tiles, leaderboard, Decision Cards) MUST use one shared badge component showing exactly the ARN-086 label set — **UNVALIDATED, PASSED-BACKTEST, CONSISTENT-FORWARD, FAILED, NOT-DEMONSTRATED, UNVALIDATABLE** — plus the separate "possible luck" flag (UX-021); no other label text … MAY be invented." | AT-27; `16` l.341 acceptance | — |
| UXN-104 (16 l.56) [ACCEPTED, O-38] | "Arena tiles and Risk Monitor position rows MUST show the AGT-111 thesis-breaker status using exactly its three states — **green** … **amber** (a monitored value is within 20% of its trigger, or a keyword-based breaker awaits confirmation), **red** (triggered) — with a tap/hover popover naming the breaker and its monitored value …" | AT-25; `16` l.347 acceptance | — |
| ARN-071 (05 l.104) | "**Execution outcomes** as competing-risk cumulative incidence functions (target / bust / stalled / timeout) with censoring, at 3/6/12 months with 90% intervals; P(target) always shown with P(bust) and P(stalled). … Cohort-based intervals use only non-overlapping cohorts (effective N, ARN-053)." | AT-27 (what the leaderboard must show) | — |
| ARN-078 (05 l.111) | "Rankings use (execution, rule version) pairs with effective N ≥ 3 in replay or effective N ≥ 5 resolved forward cohorts; executions whose 90% intervals overlap are shown as **tied** (grouped), never ordered; others "insufficient evidence" …" | AT-25 (tied group, `14` l.60) | — |
| ARN-094 (05 l.128) | ""Cost-infeasible at this seed" label when the development-split gross mean per-trade return at fixed notional … < 2× the round-trip cost of a A$600 trade; it blocks PASSED-BACKTEST (VAL-110 iv-b)." | AT-27 | — |
| ARN-049 (05 l.81) | "Sleeve figures shown at 10× and at the reality-adjusted 5× (ASIC retail CFD cap on shares; …), labelled "hypothetical leverage"; market-specific." | gap (display milestone open, §4) | — |
| ARN-050 (05 l.82) | "Sleeve metrics: trades, win rate, net expectancy, close-outs, gross/net P/L, costs, financing, lock episodes, utilisation, paired effect vs the U twin." | AT-25 | — |
| UXN-062 (16 l.38) [PROPOSED] (P2) | "The Dashboard's existing control comparison … MAY be shown as a compact factual card" | P2: not built | — |
| UXN-151 (16 l.51) [PROPOSED] (P2) | "For L-variant executions, a small gauge or bar MUST show the sleeve's current usage against its configured size …" | P2: not built | sleeve_margin (`15` l.30) |
| UXN-039 Owner-editable table | "Names, one-liners and hover cards come from one Owner-editable config table." | gap (no table key in ch.15, §5 item 29) | — |

### 2.6 Risk Monitor and the "Risk overview" under Strategies (ch.09 §9.7, ch.16 §16.8)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-050 (09 l.79) | "All open positions across executions: code, execution, weight in NAV, unrealised P/L, distance to stop, days held vs time stop, thesis-breaker status (green/amber/red), latest events and alerts for the code. Owner can pause/resume an execution … or per-family kill-switch on/off, with audit logging and status display." | AT-25; TST-122 (kill switch) | — |
| UX-051 (09 l.80) | "Concentration view: exposure by code, sector and tier across the 12 executions (information only; executions are independent)." | AT-25 | — |
| UX-052 (09 l.81) | "Alert inbox (AGT-115): P0/P1/P2 with acknowledge (per user; allowed for all roles per ROL-102a)." | AT-25; AT-19 (M5) | — |
| UX-053 (09 l.82) | "Phase R note: real holdings upload/screenshots are **not** in v1 (§9.15)." | gap (out of scope, §6) | — |
| UXN-150 (16 l.70) [ACCEPTED, O-38] | "Each open position/execution on Risk Monitor MUST show a bar from current capital to the A$300 **bust** threshold (not "liquidation" …), with states for loading, never-reached-bust, stalled (terminal, shown at its final value) and busted (with the bust date …)." | AT-27; `16` l.349 acceptance | — |
| UXN-152 (16 l.71) [ACCEPTED, O-38] | "Risk Monitor MAY show a table of simulated P&L under a small set of pre-computed market shocks (e.g. ASX ±10%/±20%/±30%, a vol-spike scenario), computed during the nightly cost-profile replay pipeline (ARN-034, UX-022) — never live-computed in the request …" | AT-25; `16` l.350 acceptance | — |
| UXN-156 (16 l.74) [PROPOSED] (P2) | "The existing Owner-only pause/resume and per-family kill-switch controls (UX-050) MUST show a clear state indicator … and a confirmation step before pausing" | P2 text (the confirmation rule for kill switches is in UX-050 and UXN-071) | — |
| UXN-157 (16 l.75) [ACCEPTED, O-38] | "The P0/P1/P2 alert inbox (UX-052) MUST group alerts by tier with P0 always visible at top (never auto-collapsed), P1/P2 in collapsible sections with unread counts, and an "Archived" section for acknowledged alerts …" | AT-25; `16` l.351 acceptance | — |
| UXN-156 (see above) | Kill-switch state and confirmation remain Owner-only (UX-004, ROL-102a). | TST-122 | — |

### 2.7 Signals, Decision Cards and "Based on" explainers (ch.09 §9.6, ch.07 AGT-110, ch.16 §16.6–16.7, §16.16, §16.20)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-040 (09 l.74) | "Per market, tonight's signals grouped by family: taken (became orders), not taken (lower rank, filters, data gaps) with reason." | AT-25 | — |
| UX-041 (09 l.75) | "Decision Card view (AGT-110): rules fired with values, rank score, evidence lines with source links, thesis-breakers with live status, exit plan, cost estimate, scenario table (percentile-based, labelled "historical range, not a forecast" with one plain-English sentence …), regime, data-quality status, family validation label, and a reality panel." | AT-25; `09` l.131 acceptance | — |
| UX-042 (09 l.76) | "No button places a real order; the page states "Simulation only — not financial advice" (PRD-001, ROL-106)." | AT-27 (PRD-001 check) | — |
| AGT-110 (07 l.66) | "Decision Card. Every signal that becomes an order has a card: market, code, family/execution, rule version, regime, rules fired with values, rank score, evidence with sources …, thesis-breakers (3–5 machine-checkable conditions), exit plan …, cost estimate and break-even move, and a **scenario table = 10th/50th/90th percentiles** …" | AT-25 (`/cards/[id]` exists, §7) | — |
| AGT-111 (07 l.67) | "Status is reported as: **green** = no thesis-breaker triggered; **amber** = at least one thesis-breaker's monitored value is within 20% of its trigger threshold, or a keyword-based thesis-breaker is awaiting confirmation; **red** = at least one thesis-breaker triggered." | AT-25 | — |
| UXN-100 (16 l.55) [ACCEPTED, O-38] | "The Decision Card's percentile scenario table … MAY be presented collapsed by default with a tap-to-expand, and MAY label the three percentile columns "Downside/Typical/Upside" … it MUST NOT add a probability, confidence % or "bull/base/bear thesis" narrative …" | AT-27; `16` l.346 acceptance | — |
| UXN-102 (16 l.63) [ACCEPTED, O-38] | "A Decision Card MAY offer a "Why?" control opening a panel with a short plain-language restatement of the card's already-stored facts … if the daily LLM budget is exhausted the panel MUST show the deterministic rules-only summary instead, clearly labelled "Rules-only (AI unavailable today)"." | AT-27; `16` l.348 acceptance | llm_budget_r2_daily (`15` l.184) |
| UXN-037 (16 l.229) [ACCEPTED, O-38] | "Every trade idea and every "Why this trade" view MUST open with a heading "Based on" and a numbered list of 2–3 plain-language reasons, one line each (≤ 20 words), generated deterministically from the Decision Card fields … Any reason that comes from a news item … MUST end with a "news" link …" | `16` l.233 acceptance | — |
| UXN-038 (16 l.230) [ACCEPTED, O-38] | "Opening a news item anywhere (Home, News tab, "Based on" links, alerts, Evening Review links) MUST use the same pop-up … on phone it is a bottom sheet. It MUST work from keyboard (Esc closes, focus returns to the link)." | `16` l.234 acceptance | — |
| UXN-120 (16 l.159) [ACCEPTED, O-38] | ""What past similar setups did" summary — Tapping a signal or Decision Card MUST open, at the top, a plain-English summary built only from the AGT-110 scenario table and ARN-070 empirical frequencies … If n < 30 it MUST say "Not enough history to say yet (n = 12)" and show nothing else numeric." | AT-27; `16` l.169 acceptance | factor_min_bucket_n (`15` l.214) |
| UXN-121 (16 l.160) [ACCEPTED, O-38] | "Factor contributions — "pushing it up" / "pulling it down" … Rows with bucket n < `factor_min_bucket_n` (default 30) MUST read "not enough history" instead of a bar. A standing caption MUST say "Historical association in this system's own replays — not cause and effect"." | AT-27; `16` l.170 acceptance | factor_min_bucket_n 30; factor_buckets (`15` l.215) |
| UXN-122 (16 l.161) [ACCEPTED, O-38] | "Rule checklist with margins — every rule condition that fired … as a checklist … Conditions within 10% of their threshold MUST be marked "only just met"." | `16` l.171 acceptance | — |
| UXN-123 (16 l.162) [ACCEPTED, O-38] | ""What could hurt this" block MUST always list, when present: cost drag and break-even move (AGT-110), low liquidity/wide spread …, the current regime if it historically weakens this family …, any amber/red thesis-breaker (AGT-111), data-quality or first-seen flags, small n, and the family's validation label with its plain meaning … the block is never empty." | `16` l.172 acceptance | — |
| UXN-126 (16 l.165) [ACCEPTED, O-38] | "Afterwards: how did it turn out — When the trade closes, the card MUST show the actual simulated result against the range from UXN-120 … and the Signals page MUST show a running tally per family …" | `16` l.173 acceptance | — |
| UXN-125 (16 l.164) [PROPOSED] (P2) | "A "Explain in words" control MAY ask LLM role R3 to write ≤ 120 words using ONLY the numbers already on the card …" | P2: not built | — |
| UXN-104 popover (see §2.5) | Thesis-breaker popover names the breaker and monitored value. | AT-25 | — |
| UXN-123 / UXN-122 / UXN-121 (back end) | AGT-112 (16 l.166): "Results are stored with the Decision Card and versioned with the rule version; they are descriptive and MUST NOT feed ranking or trading." | AT-24 (M6, `14` l.55) for back-end; AT-25 for UI | factor_min_bucket_n |
| UXN-042 explainer (see §2.8) | Used by picks as well. | — | — |
| UXN-109, UXN-116, UXN-117, UXN-124 (16 l.57–59, l.163) [PROPOSED] (P2) | Citation popovers, provenance badge, data-gap message, "What would change this view". | P2: not built | — |
| UXN-252 (16 l.150) [PROPOSED] (P2) | "Evidence-based score breakdown card … a hover/tap interaction MAY open a brief expandable popover" | P2: not built | — |

### 2.8 Picks and track record (ch.16 §16.21, back end AGT-113 and ARN-095)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UXN-040 (16 l.250) [ACCEPTED, O-38] | "Picks tab … Picks opens with a profile switch **Aggressive / Balanced / Conservative** (each with a hover explaining its rules in one sentence) and the model-success strip (UXN-041). Each pick card shows, in plain words: company; "Buy up to A$4.35 (valid until Tue)"; "Stop-loss …"; "Aim …"; "Past similar trades: bad case …, typical …, good case …"; "Suggested size …"; the evidence label …; "Why this pick →"." | AT-25 (`14` l.60 incl. track record); `16` l.257 acceptance | picks_per_profile (`15` l.208); pick_valid_sessions 2 (`15` l.212) |
| UXN-041 (16 l.251) [ACCEPTED, O-38] | "… Until at least `pick_success_min_n` picks are closed for that profile it MUST read "Model success: not measured yet — 7 of 30 picks closed" … The strip also shows the plain status "Model: not proven yet" until …" s13: "Shows a 90% Wilson interval and the count of still-open picks". | `16` l.260–261 acceptance | pick_success_min_n 30 (`15` l.213) |
| UXN-042 (16 l.252) [ACCEPTED, O-38] | "Why this pick — Opens the §16.16/§16.20 explainer for the pick, plus a block "How these numbers were worked out" in plain words …" | AT-25 | — |
| UXN-043 (16 l.253) [ACCEPTED, O-38] | "Track record — A page (Picks → "Track record") listing every closed pick with what was shown at the time (buy zone, stop, aim, range) and what happened … Nothing shown at publication may be changed afterwards." | AT-25 (AT-25 names "incl. track record"); `16` l.262 acceptance | — |
| UXN-044 (16 l.254) [ACCEPTED, O-38] | "Picks on Home and in the email — Home shows "Today's picks" …; the Evening Review adds a "New picks" section (section 7a) …" | AT-25; `16` l.254 | — |
| UXN-045 (16 l.255) [ACCEPTED, O-38] | "Pick honesty line — Every pick card and detail MUST show: "Personal use only · Not financial advice · Model not proven yet" (the last part only until UXN-041's test is passed), and a stop-loss hover that says prices can gap past a stop-loss …" | AT-27 | — |
| AGT-113 (16 l.241–245) [ACCEPTED, O-36/O-38] | "Nightly, after the batch and after AGT-112 … for each profile the system selects up to `picks_per_profile` (default 5) picks … At most `picks_max_per_family` (default 2; 1–5) picks per profile per night come from one family." Profiles: Aggressive / Balanced / Conservative with caps. | AT-25 ("picks never exceed `picks_max_per_family`"); no M6 acceptance test | picks_per_profile; pick_profiles; profile_portfolio_amount; picks_max_per_family 2 (`15` l.208–211) |
| ARN-095 (16 l.246) [ACCEPTED, O-36/O-38] | "Pick tracking (the "model success" record). Every published pick is followed on paper … Each outcome is stored with the numbers shown at publication, so nothing can be edited afterwards. A **luck check** runs alongside …" | AT-27; `16` l.259 acceptance | — |

### 2.9 Market tab, company page and "i" overview (ch.16 §16.23–16.24)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UXN-270 (16 l.302) [ACCEPTED, O-38] | "Market shows: a search box (company name or code, instant results); an index strip …; tabs **Top movers**, **Sectors** (a sector heat grid …) and **All companies** (sortable table …). Every row has a star (UXN-047) and an **"i"** button (UXN-272) …" s13: "If Q-058 is declined … Market and watchlist show the last close labelled 'End-of-day price'. For masked Viewers (ROL-107) 'Our activity' is hidden; public company data stays visible." | AT-25 (`14` l.60); `16` l.311 acceptance | market_list_page_size (not in ch.15, §5 item 30) |
| UXN-271 (16 l.303) [ACCEPTED, O-38] | "Company page (standard layout) — Header: name, code, sector, star, "i", last price with change and its time/"delayed"/"close" label. **Candlestick chart** of daily bars with a volume histogram underneath; range chips 1M / 3M / 6M / 1Y / 2Y; optional overlays (50- and 200-day moving averages) … Below: **Key numbers** … **Our activity** … **News & announcements** …" s13 range chips 1M–2Y; 5Y deferred. | AT-25; `16` l.312 acceptance (states 1M–5Y, §5 item 8) | — |
| UXN-272 (16 l.304) [ACCEPTED, O-38] | ""i" company overview — The "i" icon on any company … opens a panel … **What the company does** …; **SWOT** …; **Recent news** …; **Our view** …; and a "Last updated" date. The description and SWOT are **AI-written summaries of public information** (LLM role R2) … they carry the AI badge and the line "AI summary of public information — may be incomplete or out of date. Not financial advice." …" | AT-27; `16` l.313 acceptance | overview_refresh_days 7; overview_max_per_night 20 (`15` l.203–204) |
| UXN-273 (16 l.305) [ACCEPTED, O-38] | "The Market tab and company pages MUST be served from the nightly tables (DAT-020) plus the UXN-048 delayed quotes; no extra source calls per page view." | `16` l.314 acceptance | — |
| UXN-048 company page (16 l.289) | Delayed prices, display-only, "Prices paused" on source failure. | AT-25 | intraday_* (`15` l.205–206) |
| §16.1 amendment (16 l.306) | "headings and menu labels MUST use the same sans-serif family as body text (heavier weight for hierarchy), not a narrow display serif; one font family for all text plus a monospace for numbers only. Default: **Inter** (OFL) … and **JetBrains Mono** …" | gap (no test named) | — |
| UXN-035 (16 l.215) [ACCEPTED, O-38] | "News tab — … filter chips "My companies / All news / Alerts" …" (News in §2.10). | AT-25 | — |

### 2.10 News, alert inbox and quiet hours (ch.09 §9.8, §9.7 inbox, ch.16 §16.9, §16.15)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-060 (09 l.85) | "Feed per market of stored items (DAT-110): headline, source, time (Melbourne and exchange time), codes tagged, materiality, our summary (≤ 80 words, labelled "AI-generated" when written by role R2 or "rule-based" when deterministic fallback was used) …, and a link to the original." | AT-25 | — |
| UX-061 (09 l.86) | "Filters: market, code, category, materiality, date range; full-text search over headlines and our summaries; retention 400 days (DAT-142)." | AT-25 | — |
| UX-062 (09 l.87) | "Items linked to held positions show which executions hold the code." | AT-25 | — |
| UXN-035 (16 l.215) [ACCEPTED, O-38] | "The News tab MUST combine the news feed (UX-060) and the alerts inbox (UXN-157): filter chips "My companies / All news / Alerts"; each news card shows a plain headline, source, time, a "Good / Bad / Neutral for our trades" tag (hover: how the tag was decided) and which strategies hold the company." | AT-25 | — |
| UXN-158 (16 l.80) [ACCEPTED, O-38] | "News items (UX-060) MAY show the item's own deterministic **rule materiality/polarity** classification … as a small tag on the card; … MUST be labelled as such (e.g. "polarity: positive/negative/neutral, rule-based" …)." | AT-27; `16` l.354 acceptance | — |
| UXN-160 (16 l.81) [ACCEPTED, O-38] | "Settings (UX-110) MAY add a quiet-hours window and a per-alert snooze (1h/4h/until tomorrow); … quiet hours and snooze MUST NOT suppress P0 delivery — only P1/P2. Snoozed items remain visible (dimmed) in the inbox, never hidden." | `16` l.352 acceptance | — |
| UXN-157 (16 l.75) [ACCEPTED, O-38] | see §2.6 (alert inbox). | AT-25; `16` l.351 | — |
| UXN-251 (16 l.148) [ACCEPTED, O-38] | "When the market regime transitions … the system MUST raise a **P1** in-app notice … highlighting the affected executions in a sticky card. … This P1 notification cannot be silenced by quiet hours (UXN-160) …" | AT-25; `16` l.330 acceptance | — |
| UXN-014 (16 l.85) [PROPOSED] (P3) | "The app MAY offer opt-in Web Push … for P0/P1 alerts only" | P3: not built | — |
| UXN-164, UXN-165, UXN-169 (16 l.83–84, 91) [PROPOSED] | Source-type tag, news-card sparkline, dark-mode email CSS. | P2: not built | — |
| Improves UXN-158 (16 l.149) | "aggregate headlines when multiple sources (≥5) report on the same topic within a single day" (optional sentence; no own status). | [CHECK] §5 item 34 | — |

### 2.11 Knowledge (ch.09 §9.9, ch.08 KB rules, ch.16 §16.11)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-070 (09 l.90) | "Browse and search KB documents (KB-070): families (current version, parameters with bounds, version history and diffs), lessons (grade badge), challengers (lifecycle stage, replay and forward results, Critic answers), hypotheses, change ledger." | AT-25; `docs/test-map.md` (M6 pages gap, D-125) | — |
| KB-070 (08 l.52) | "The Knowledge page (Ch. 09 §9.9) lists and full-text searches all KB documents by market, type, date, family, grade and code, with links to the underlying records." | AT-25 | — |
| UX-071 (09 l.91) | "Owner-only actions: create/edit a family version (→ challenger by default, KB-050), approve/reject a challenger, force-apply with confirmation, rollback. Editors can annotate. Every action is audit-logged." | AT-25; TST-122 (`docs/test-map.md` M6 routes: confirm and audit-first) | — |
| KB-050 (08 l.44) | "Only the **Owner** may create or edit a family rule or parameter from the UI (ROL-102). … The Owner MAY force-apply it at the next cohort boundary …" | AT-23 (M6); AT-25 UI | — |
| UX-071a (09 l.92) | "**Annotations.** Editors and Owner can add plain-text annotations (≤ 1,000 chars) to lessons, Decision Cards and hypotheses … On masked content, annotations are visible only to Owner/Editor; a masked Viewer sees 'Note added by <role> on <date>' without text." | AT-25; `docs/test-map.md` (M6, route masking) | — |
| KB-051 (08 l.45) | "Editors may add annotations to lessons, cards and hypotheses (never altering the record). Viewers are read-only (ROL-102). Annotations and any user-entered free text are **never** included in LLM context (LLM-036)." | AT-22 (context builder); M6 static check | — |
| UXN-200 (16 l.95) [ACCEPTED, O-38] | "The Knowledge page (UX-070) MAY present lessons as a card grid (headline, evidence-grade badge, metric, n) using exactly the ARN-063/KB-020 grade set — **L0 Observation, L1 …, L2 …, L3 (adopted)** — with no lesson described more strongly than its grade, per KB-020." | AT-27; `16` l.357 acceptance | — |
| UXN-201 (16 l.96) [ACCEPTED, O-38] | "Knowledge/challenger pages MAY show a table comparing the current version (champion) against its challenger(s) using the metrics the spec actually reports … a "not yet significant" state is shown when the holdout-confirmation α threshold (ARN-086) is not met …" | `16` l.358 acceptance | — |
| UXN-208 (16 l.99) [ACCEPTED, O-38] | "Knowledge/challenger views (UX-070) MAY let the Owner select 2–5 concurrent items (the champion plus challengers at any KB-040 lifecycle stage) for side-by-side display …; stage labels again use the real KB-040 lifecycle names …" | `16` l.359 acceptance | — |
| KB-040 (08 l.38) | "Challenger lifecycle: `proposed` … → `replay` … → `shakedown` … → `review` … → `approved` … → `promoted` / `rejected` / `retired`." | AT-23 (M6); UXN-204 names (P2) | — |
| KB-020 (08 l.30) | "Evidence grades are defined **only** in ARN-063 (L0 Observation; L1 on the first two-thirds of development; L2 on the purged last third under cumulative α-investing; L3 adopted) … No lesson is described more strongly than its grade anywhere …" | AT-27 | — |
| UXN-071b (16 l.93 in 09) and UXN-215 (16 l.100) | Glossary: UX-071b (09 l.93); UXN-215 grade filter [PROPOSED] (P2). | UX-071b gap | — |
| UXN-203 (16 l.105) [ACCEPTED, O-38] | "The Reviews page MAY offer an optional short reflection form per closed trade (thesis vs outcome, one free-text lesson) … stored as an annotation … never included in LLM context." | `16` l.360 acceptance | — |
| UXN-202, UXN-204, UXN-205, UXN-105 (16 l.97–98, 106, 101) [PROPOSED] (P2) | Heatmap, version diff, review filters, long-press glossary. | P2: not built | — |

### 2.12 Reviews, Evening Review and calendar (ch.09 §9.10, ch.04 EML rules, ch.16 §16.10, §16.12)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-080 (09 l.96) | "Evening Review history per date (EML-015), rendered in-app identical to the email, with "partial" markers and delivery status; searchable by date and text. During the 19:30–20:45 pending window, the list shows a "pending" state. A **"Mark as read"** button (POST from the signed-in page) records that the Owner has read the review (EML-036)." | AT-20 (M5), AT-25 | unopened_review_banner 3 days (`15` l.165) |
| EML-015 (04 l.32) | "Every review MUST be stored in the app (Digest history) as markdown/HTML and also as a dated markdown document in the knowledge base (Chapter 08) …" | AT-20, AT-24 | — |
| EML-036 (04 l.48) | "… the email links to the in-app review, where a **"Mark as read" button (POST)** records reading; a review is also marked read when the email link is clicked …" | AT-20 | — |
| EML-012 (04 l.19) | "**Content**, in this order (summary first, then detail): …" (ten sections; section 7a "New picks" per UXN-044). | AT-20 | — |
| UXN-113 (16 l.89) [ACCEPTED, O-38] | "The in-app Evening Review view (UX-080) MUST visibly badge whether its narrative sections (4–6 …) were LLM-written or the deterministic "Written without AI today" fallback …" | `16` l.355 acceptance | — |
| UXN-163 (16 l.90) [ACCEPTED, O-38] | "The email MUST open with a scannable row of 3–4 KPI tiles … single-column at ≤600px width …" | `16` l.356 acceptance (email); TST-129 | — |
| UXN-206 (16 l.107) [ACCEPTED, O-38] | "Reviews MAY add a calendar view where each day's cell is coloured by that day's per-currency P/L (no FX blending, per O-34) with a hover/tap summary and a click-through to that day's Evening Review; masking rules (UX-009) apply to any code shown in the drill-down." | `16` l.361 acceptance | — |
| UXN-044 section 7a (16 l.254) | "'New picks' is Evening Review section 7a (after section 7; numbering 1–10 unchanged) and counts toward the EML-013 size limit." (s13) | AT-20 | — |
| UXN-205 (16 l.106) [PROPOSED] (P2) | Regime filter and read-state dot. | P2: not built | — |

### 2.13 System Health, Control Room and status (ch.09 §9.11, PLT-061, ch.16 §16.13, §16.25)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-090 (09 l.99) | "Shows PLT-061 content: per job (Sentinel, batches 1–3, email, backup, bake-off) last success, duration, next scheduled time, status (success/running/failed shown with status colours) … with staleness defined as 2× the job's expected interval; per source (DAT-120 register) enabled/disabled, last fetch, error rate; per market data-quality score history (DAT-201); LLM provider status and fallbacks; last backup and last restore test." | AT-25; `docs/test-map.md` PLT-061 row (`health/page.tsx`) | — |
| UX-091 (09 l.100) | "An agent panel lists A1–A8 with last run, outputs count, status and link to their latest outputs. A visual "Jarvis-style" theme is optional (UX-103) and MUST NOT display invented or decorative numbers." | AT-25 (conflict with UXN-036, §5 item 26) | — |
| UX-092 (09 l.101) | "Viewers/Editors see status only; Owners also see error details and logs (secrets redacted, PLT-040)." | TST-122; AT-25 | — |
| UXN-283 (16 l.322) [ACCEPTED, O-38] | "The System Health page (PLT-061, UX-090) MUST be presented as a Control Room: a central status ring with one segment per component — Sentinel, Market data, Nightly run, AI models, Evening email, Database, Backups, Security (secrets/release), Free-tier limits — coloured healthy / needs attention / down, with a centre readout "n / 9 healthy" …" | AT-25; `16` l.326 acceptance | attention_reminder_* (`15` l.196–198) |
| UXN-283 status briefing (16 l.322) | "a plain-English **status briefing** generated from the stored health facts by a fixed template (never LLM-written, LLM-034) … Values refresh every 60 s while the page is open …" | AT-27 (no LLM number) | — |
| UXN-283 snooze (16 l.322) | "Each amber item shows a "Snooze reminder" control (1/3/7 days) and "Reminder emailed daily at 08:00 until fixed" (EML-023); red items have no snooze." | AT-20b (M5); AT-25 | attention_snooze_max_days 7; attention_reminder_time 08:00 (`15` l.197–198) |
| UXN-285 (16 l.325) [OWNER] | "(a) **Boot sequence** … ≤ 1.2 s, once per session, skippable by any key/tap. (b) **Live ring** … (c) **Focus** … (d) **Gauges:** free-tier usage shown as radial arc gauges with the 70% / 90% / 95% marks (PLT-051). (e) **Timeline** … last 20 health events. (f) **Look** … (g) **Sound** off by default … (h) **Performance and motion:** ≥ 55 fps on a mid-range phone …" | `16` l.326 acceptance: boot ≤ 1.2 s; no frame over 18 ms; Playwright baselines | — |
| UXN-207 (16 l.111) [PROPOSED] (P2) | "System Health (UX-090) MAY add a 30-day per-job status strip …" | P2: not built | — |
| UX-117 (09 l.116) | "Secrets status (Owner): shows only whether each required secret is present and when it was last verified by the CI smoke test — never values (SEC-101)." | AT-29 / SEC tests | — |

### 2.14 Usage (Owner) (ch.09 §9.12)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-100 (09 l.104) | "Free-tier meters (PLT-050): Vercel, Actions minutes, Turso storage/reads/writes, Cloudflare requests and CPU, each LLM provider, Resend emails, history-file store — current, limit, %, trend, per market (MKT-104); degrade-mode state." | `docs/test-map.md` PLT-050 row; TST-122 | llm_budget_*_daily (`15` l.183–187) |
| PLT-050 (02 l.57) | "The system MUST meter usage …" (free-tier meters from run records). | TST-122 | — |
| PLT-051 (02 l.58) | "Thresholds are measured …" (70 / 90 / 95 % marks used by UXN-285(d)). | gap | — |
| MKT-104 (06 l.19; 13 l.137) | "Quotas are shared; …" — the Usage page MUST show per-market consumption. | gap | — |
| UXN-209 (16 l.112) [PROPOSED] (P2) | Usage meter tiles with trend. | P2: not built | — |

### 2.15 Settings, Users, Sources, Email, Configuration and appearance (ch.09 §9.13, ch.16 §16.2, §16.9, §16.13, §16.25)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| UX-110 (09 l.107) | "Personal (all roles): theme, default market, alert display preferences (per-tier immediate vs digest toggle; P0 cannot be turned off), time format (stored as user_preference …)." | TST-122; `docs/test-map.md` UX-110 row | — |
| UX-111 (09 l.108) | "Users & roles (Owner): allowlist of Google emails with role (default Viewer), add/revoke/change role, audit log (ROL-101…104). The **Add user** button stays disabled until the Owner records the sharing acknowledgement (ROL-107)." | AT-01; `docs/test-map.md` UX-111 row (partial: browser dialog under CSP pending) | — |
| UX-118 (09 l.109) | "Ops checklist (Owner): the OPS-020 tasks with due dates, done ticks and token-expiry dates." | gap | — |
| UX-119 (09 l.110) | "What-if (Owner, Editor): parameter what-ifs run only against pre-computed nightly tables (≤ 2 s); anything heavier is queued for the next nightly batch within the ROL-102 daily budget." | TST-122 | — |
| UX-112 (09 l.111) | "Markets (Owner): activation checklist per market (MKT-102) and the activate/deactivate switch." | AT-M0 | — |
| UX-113 (09 l.112) | "Sources (Owner): licence register (DAT-120) with per-source kill switches (DAT-123) and ASX risk-acceptance record (DAT-122)." | AT-21 (M5); AT-05 | — |
| UX-114 (09 l.113) | "Data review queue (Owner): unconfirmed corporate actions (DAT-221) with evidence and confirm/edit/reject." | `docs/test-map.md` DAT-221 row | — |
| UX-115 (09 l.114) | "Email (Owner): recipient (read-only, from `OWNER_EMAIL`, EML-005), send time, pause, Morning Brief toggle, test email (EML-016, EML-034)." | AT-20a, AT-20b (M5) | — |
| UX-116 (09 l.115) | "Configuration (Owner): view (and edit where allowed) thresholds, budgets, schedules, cost profiles, sleeve settings; every edit is versioned and audit-logged (PLT-041)." | `docs/test-map.md` UX-116 row (`/config`) | all keys (`15`) |
| UX-117 (09 l.116) | see §2.13. | — | — |
| UXN-280 (16 l.319) [ACCEPTED, O-38] | "Settings → Appearance MUST offer six themes: **Dark (default, O-35 preference)**, Light, Match device (follows the OS setting), Midnight (true black for OLED), Dim … and High contrast (white on black, yellow accent, ≥ 7:1 text contrast). … The choice is stored per user (server-side …) and applies immediately without reload. A header shortcut cycles themes." | AT-26 (contrast); TST-126 (six themes); test-map UXN-280 row | — |
| UXN-281 (16 l.320) [ACCEPTED, O-38] | "Appearance MUST offer gain/loss colours "Colour-blind safe" (teal/orange, default, UXN-001) or "Classic green/red"; gains/losses always also carry ▲/▼ and a sign. A "Motion" switch turns off non-essential animation (also honoured automatically when the OS asks for reduced motion)." | gap (conflict, §5 item 6) | — |
| UXN-282 (16 l.321) [ACCEPTED, O-38] | "Settings → Region & markets MUST let the Owner set the region the app opens in and whether times show in Melbourne or exchange-local time, and MUST show the markets table (exchange, currency, hours in Melbourne time, status, build progress). Viewers see only markets the Owner has shared." | gap (§5 item 27) | — |
| UXN-019 (16 l.185) | see §2.1 (Settings → About). | gap | — |
| UXN-283 Settings link | Control Room is the System Health page (UXN-283). | — | — |
| UXN-211 (16 l.113) [PROPOSED] (P2) | Owner-only regime/config section with live preview. | P2: not built | regime keys (`15` l.115) |
| UX-110 (time format) and UXN-160 quiet hours | The quiet-hours and snooze settings are personal settings in Settings. | gap (§5 item 9) | — |

### 2.16 Roles, masking and annotations (ch.10 ROL rules as they apply to pages)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ROL-102a (10 l.53–63) | "Role × action matrix (server-enforced; anything not listed is Owner-only): Read all pages except Usage/Admin/Ops/logs — Owner ✓, Editor ✓, Viewer ✓ (codes masked per ROL-107); Own user_preference; own alert acknowledgement — ✓ ✓ ✓; Annotations on lessons/cards/hypotheses — ✓ ✓ —; What-if … ≤ 5/day per user — ✓ ✓ —; Unmask codes for non-owners — ✓ — —." | TST-122 (each role allowed vs refused); AT-25 | — |
| ROL-102b (10 l.64) | "Annotations. Editors and the Owner may annotate lessons, decision cards and hypotheses with plain-text notes (≤ 1,000 characters) … Visibility: visible to all users (no role masking)." | TST-122; `docs/test-map.md` M6 rows | — |
| ROL-107 (10 l.69) | "Sharing safeguards. Before the first non-Owner is added, the Owner records in Settings → Users & roles an acknowledgement via a **checkbox control** …" | AT-01 | — |
| ROL-106 (10 l.70) | "Every page visible to non-owners carries "Simulation for personal information only — not financial advice"; …" | AT-27 | — |
| DAT-124 (06 l.70) | "Content from any personal-use-only source (ASX, Yahoo) shown to Editors/Viewers is limited to derived numbers, headlines, links and our own summaries; code-level signals are subject to ROL-107." | gap (§5 item 22) | — |
| ROL-104 (10 l.67) | "Every sign-in …, role change, allowlist change and Owner action writes an append-only audit event; revocation takes effect on the next request. **Revocation is confirmed by a modal dialog** …" | AT-01 | — |
| UXN-047 (16 l.288) | "The watchlist star is enabled for Owner and Editor (Editor's list is personal, no alert effect) and hidden for Viewers (UX-004)." (s13) | gap (§5 item 9) | — |

### 2.17 UI tests and environments (ch.10 §10.x, ch.14 AT-25…27)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| TST-126 (10 l.161) | "**UI end-to-end.** Playwright (free) on a production build against the staging test identity (TST-113): every page and tab, both roles' views, empty / stale / error states (UX-007), the six themes (UXN-280) at desktop and phone width, keyboard navigation, and the "Simulated" label audit (AT-27). **Accessibility:** automated axe checks with no serious/critical issues on every page." | TST-126 itself | — |
| TST-127 (10 l.162) | "**Visual regression.** Screenshot comparison of every page × {Dark, Light} × {desktop, phone} and the two email templates; baselines stored in the **private fixtures repo** (never the public repo) …" | TST-127 | — |
| TST-128 (10 l.163) | "**Component tests** for shared UI components (tables, charts, Decision Card, region switcher, Control Room ring) with representative props, including long text and zero/negative/missing values." | TST-128 | — |
| TST-129 (10 l.164) | "**Email tests.** Evening Review, 8am reminder and alerts render from fixtures; size ≤ limits (EML-013) …" | TST-129 | — |
| TST-133 (10 l.168) | "**Test map.** … every MUST in ch. 01–12 and every accepted ch. 16 P1 item has at least one test or is listed as Owner-executed in ch. 14. CI fails if a MUST loses its last test." | TST-133; `docs/test-map.md` | — |
| TST-120 (10 l.155) | "Every pull request … changed lines … < 90% line coverage and < 80% branch coverage" (`diff_coverage_min`, `diff_branch_min`). | every M7 PR | diff_coverage_min 90%; diff_branch_min 80% (`15` l.192–193) |
| TST-121 (10 l.156) | "Overall coverage floors (`coverage_overall_min` 80% lines; **90% on money maths, validation statistics** …)" | UI is not money maths; gap (§5 item 31) | coverage_overall_min (`15` l.194) |
| TST-131 (10 l.166) | "Flaky tests. A test that fails and then passes on retry is flagged …" | CI | — |
| TST-122 (10 l.157) | "Every API route and server action MUST have tests for: success, validation errors, auth required, **each role (Owner/Editor/Viewer/none) allowed vs refused**, masking (ROL-107), rate limits (SEC-014), CSRF/origin (SEC-011) and error shape." | TST-122 | — |
| AT-25 (14 l.60) [s13/s14] | "Page coverage | Every page of Ch. 09 renders with real staging data, empty states and stale banners … Data older than 2× its expected interval shows a stale banner with the last good time, cleared after a fresh run (UX-007); executions with overlapping 90% intervals show as one tied group (ARN-078). **(s14)** The page list includes the accepted ch. 16 P1 pages (O-38): Picks (incl. track record), Market, company page and the Control Room, each meeting its ch. 16 acceptance criteria; picks never exceed `picks_max_per_family` per profile per night." | Ch. 09 | picks_max_per_family |
| AT-26 (14 l.61) | "Mobile & a11y | 360 px width usable; WCAG 2.2 AA automated checks pass; Lighthouse ≥ 80 on Home (ex-Dashboard); **(s11)** Owner performs a manual keyboard + screen-reader check of the six main tabs (UXN-270, s14) at M8" | UX-001, UX-005 | — |
| AT-27 (14 l.62) | "Honesty labels | "Simulated", reality panels, validation labels and "not yet measured" appear where required; no uncalibrated probability anywhere; **(s11)** cites PRD-001/UX-042 to verify no screen or route can place a real order **(s13)** Coverage: Home, each Strategy page, Picks, Market company page, Reviews, Evening Review email and every API response carrying money; an automated check asserts every money/return/NAV element carries the Simulated label; probabilities without a VAL-101 calibration report show 'not yet calibrated'." | UX-002, UX-104, VAL-101, REV-003, PRD-001, UX-042 | — |
| VAL-101 (10 l.129) | "**No uncalibrated forward-looking probabilities.** Any model-predicted probability or "confidence %" MUST come from a model with a stored calibration report on held-out data." | AT-27 | — |
| NFR-010 (10 l.38) | "Dashboard FCP < 2 s (mobile, 4G), Lighthouse performance ≥ 80; API p95 < 500 ms for page data." | AT-26 (Home) | — |
| NFR-005 (10 l.25) | "Graceful degradation: any provider outage leads to degrade mode (PLT-051), never to data corruption; every skipped step is visible in System Health and the review." | gap | — |
| AT-30 (14 l.69) [M8] | "Owner walkthrough of Home, Picks, Market, Strategies, News, Reviews and the gear-menu pages (s14)" | AT-30 (M8) | — |

### 2.18 Chapter 09 and chapter 16 acceptance criteria (verbatim lists)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| 09 acceptance (09 l.127–135) | Viewer and Knowledge or Settings (l.127); Viewer on Signals masked (l.128); phone 360 px (l.129) "every page reachable from the six tabs … fully usable without horizontal scrolling"; no cohort (l.130); Decision Card (l.131); news item (l.132); stale data banner (l.133); Owner force-applies (l.134); Lighthouse on Dashboard (mobile) performance ≥ 80 and FCP < 2 s (l.135). | AT-25; AT-26 | — |
| 16 acceptance (16 l.329–362) | 36 "Given … then …" criteria, one per accepted P1 item in §16.2–16.16 (UXN-251 l.330, UXN-001 l.332, UXN-002 l.333, UXN-005 l.334, UXN-015 l.335, UXN-017 l.336, UXN-053 l.337, UXN-050 l.338, UXN-052 l.339, UXN-057 l.340, UXN-060 l.341, UXN-051 l.342, UXN-054 l.343, UXN-055 l.344, UXN-068 l.345, UXN-100 l.346, UXN-104 l.347, UXN-102 l.348, UXN-150 l.349, UXN-152 l.350, UXN-157 l.351, UXN-160 l.352, UXN-161 l.353, UXN-158 l.354, UXN-113 l.355, UXN-163 l.356, UXN-200 l.357, UXN-201 l.358, UXN-208 l.359, UXN-203 l.360, UXN-206 l.361, UXN-019 l.362). | AT-25; AT-27 | — |
| 16 acceptance §16.16 (16 l.168–173) | Given n = 87 family trades, factor bucket n = 14 "not enough history", RSI 9.5 vs 10 "only just met", UNVALIDATED family, 50 closed trades. | AT-25 | factor_min_bucket_n |
| 16 acceptance §16.19 (16 l.218–223) | Readability grade ≤ 8 (CI), "Not proven yet" with official hover, 40-word hover, six tabs in three taps, "Nothing needs you today". | AT-25; gap for the readability CI | — |
| 16 acceptance §16.20–16.24 (16 l.232–234, 257–262, 279–280, 293–296, 310–314) | Based-on list, news pop-up, Picks buy zone and missed state, track record, Strategies badge 4, watchlist star, Market search "bhp", company chart, "i" overview, 1,000 Market views. | AT-25; AT-27 | — |
| 16 acceptance §16.25 (16 l.326–327) | Control Room boot ≤ 1.2 s; reduced motion no animation; segment focus; usage at 72% amber 70% mark; Playwright baselines Dark/Light × desktop/phone; no frame over 18 ms; six themes contrast; India `in build` disabled; Turso token within 14 days → Security amber, 8 / 9. | AT-25; AT-26; TST-126; TST-127 | — |

## 3. Values to remember (numbers with sources)

- **Money**: A$600 seed per execution; target A$1,200; bust line A$300; stall floor ≈ A$511 (U and L) (`09` UX-011 l.53; `15` l.12). Twelve executions E01–E12, six families F1–F6 (`09` l.53; `16` l.267). Names are "Own money" / "With borrowed money" (UXN-039).
- **Staleness**: "older than **2×** its expected interval" (UX-007 `09` l.32; PLT-017 `02` l.28).
- **Breakpoints and layout**: 360 px minimum width with no horizontal page scroll (UX-001 `09` l.8; UXN-017 `16` l.25); card view below 600 px (UX-020 `09` l.63; UXN-017).
- **Performance**: FCP < 2 s on a mid-range phone over 4G; API p95 < 500 ms; Lighthouse performance ≥ 80 (UX-005 `09` l.30; NFR-010 `10` l.38; AT-26 `14` l.61).
- **Contrast**: WCAG 2.2 AA for text and UI; High contrast ≥ 7:1 text (UXN-280 `16` l.319; `docs/test-map.md` UXN-001 row); focus ring 2 px (UXN-015 `16` l.24).
- **Hover text**: ≤ 40 words (UXN-032 `16` l.212).
- **Readability**: Flesch–Kincaid grade ≤ 8 for headings, labels and summaries (UXN-030 `16` l.191).
- **Notes**: ≤ 1,000 characters (ROL-102b `10` l.64; UX-071a `09` l.92).
- **News summary**: ≤ 80 words, labelled (UX-101 `09` l.10; UX-060 `09` l.85); news retention 400 days (UX-061 `09` l.86).
- **Unmask expiry**: 30 days by default (UX-009 `09` l.26; `15` l.171).
- **Sessions**: 14 days (PLT-033 `02` l.46; `15` l.160).
- **Banners**: unopened review 3 days (EML-036 `04` l.48; `15` l.165); token expiry within 14 days (UX-015 `09` l.60).
- **Delayed prices**: "Delayed about 20 min" [VERIFY at build]; refresh every 5 minutes (`intraday_refresh_min` 5); max 150 codes (`intraday_codes_max`) (UXN-048 `16` l.289; `15` l.205–206).
- **Watchlist**: max 50 codes (`watchlist_max`, `15` l.207). **Overview**: refreshed at most every 7 days; 20 per night (`overview_refresh_days`, `overview_max_per_night`, `15` l.203–204). **Market list page size**: 50 (`16` l.308; not in ch.15, §5 item 30).
- **Picks**: up to 5 per profile (`picks_per_profile`); at most 2 per family (`picks_max_per_family`); valid for 2 sessions (`pick_valid_sessions`); model success needs 30 closed picks (`pick_success_min_n`); profile amount A$10,000 for sizing examples (`profile_portfolio_amount`) (`15` l.208–213).
- **Factor buckets**: rows with n < 30 read "not enough history" (`factor_min_bucket_n`, `15` l.214); "only just met" within 10% of threshold (UXN-122 `16` l.161).
- **Thesis-breaker amber**: monitored value within 20% of its trigger (AGT-111 `07` l.67; UXN-104 `16` l.56).
- **Thresholds**: pick risk caps 2 / 1 / 0.5 % per pick by profile; max share per pick 20 / 10 / 5 % (AGT-113 `16` l.242–244; `15` l.209).
- **Regime**: SHOCK, RISK-OFF, RISK-ON, NEUTRAL; SMA 200; hysteresis 3 sessions (AGT-101 `07` l.39; `15` l.115).
- **Validation labels**: six exact labels (ARN-086 `05` l.120; UXN-060 `16` l.37).
- **Lesson grades**: L0 to L3 (ARN-063; KB-020 `08` l.30).
- **Control Room**: nine components; "n / 9 healthy"; refresh every 60 s; boot ≤ 1.2 s; ≥ 55 fps; no frame over 18 ms on the CI throttled profile; gauge marks 70 / 90 / 95 % (UXN-283 `16` l.322; UXN-285 l.325–326).
- **Attention**: reminder 08:00 Melbourne; snooze 1 / 3 / 7 days; max snooze 7 days (EML-023 `04` l.39; `15` l.196–198); "near limit" 15% (`attention_near_limit_pct` (16 l.291), not in ch.15).
- **Turso history on charts**: 500 sessions (DAT-140 `06` l.102; `turso_recent_sessions` `15` l.141); range chips 1M / 3M / 6M / 1Y / 2Y (UXN-271 s13 note `16` l.303).
- **Evening review KPI row**: 3–4 tiles, single column at ≤ 600 px, ≤ 90 KB (UXN-163 `16` l.90; EML-013 `04` l.30).
- **Colour**: one gain/loss pair, teal and amber-orange; never plain red/green (UXN-001 `16` l.21; §16.1 `16` l.12).
- **Motion**: `prefers-reduced-motion` honoured; "Motion" switch (UXN-005 `16` l.23; UXN-281 `16` l.320).

## 4. Carried over from earlier milestones

Each row is an item an earlier milestone left for M7. Evidence is in `docs/M3_exit_evidence.md` to `docs/M6_exit_evidence.md`, `docs/M4_requirements.md`, `docs/M3_design.md`, `docs/M6_design.md`, `docs/07_decision_log.md` and `docs/test-map.md`.

| Carried item | Source | What M7 must do |
|---|---|---|
| **Annotations route path** | `docs/M6_exit_evidence.md` l.72 ("D-125: annotations live at `/api/learning/annotations`, the spec says `/api/annotations` (align in M7)"); `docs/M6_design.md` l.212 (`POST\|PATCH\|DELETE /api/annotations`); the spec itself names no annotations path (no `/api/annotations` in `spec/`) | Decide the path with the architect (§5 item 11), then align the code and the test map (`docs/test-map.md` l.212). |
| **Plan and document GET routes and real pages** | `docs/M6_exit_evidence.md` l.72; `docs/M6_design.md` l.213 (`GET /api/learning/{lessons,challengers,plan,documents}`); no `plan` or `documents` route exists under `src/app/api/learning/` | Build the GET routes and the Knowledge pages (UX-070, KB-070); the Knowledge pages exist only as minimal `/learning` pages. |
| **Section 7a "New picks" read but not rendered** | `docs/M6_exit_evidence.md` l.69 (D-122: "section 7a is read but not rendered"); UXN-044 (`16` l.254) | Render section 7a on the Picks and Reviews pages with the same numbers as the email. |
| **Picks filter constants and tracking gaps** | `docs/M6_exit_evidence.md` l.69 (D-122: Conservative and Balanced filters are constants without ch.15 keys; Balanced is empty until attribution history exists; pick tracking ignores corporate actions and dividends; `beatsLuck` is a Wilson-bound draft) | The Picks UI must show "not measured yet" for Balanced until history exists; the missing keys are §5 item 29. Corporate actions and dividends: §5 item 33. |
| **Lesson and attribution gaps** | `docs/M6_exit_evidence.md` l.70 (D-123: no A6 notes, no twin, filter or cost comparison pairs; no health rows for the new phases); l.71 (D-124: lesson Critic nightly only) | The Strategies and Knowledge pages must not show a comparison pair or an A6 note that the back end does not produce. |
| **Route-level tests for pages** | `docs/test-map.md` l.12–13 (AT-27 partial: home page only); l.37 (UX-111 partial: browser dialog under CSP pending); l.60 (UXN-001 token blocks built, contrast check built); `docs/M6_exit_evidence.md` l.41 (`tests/acceptance/m6/`) | Add the page tests and the AT-27 money-element audit (the TST-126 accessibility and label checks). |
| **ARN-049 5× display and ARN-048 shadow display** | `docs/M3_design.md` l.155 and l.177 ("display in M4/M6"); `docs/M4_requirements.md` l.307 and l.312 ("[CHECK] milestone not set in `12_build_plan.md`") | Decide whether these displays are M7 (§5 item 19). |
| **Critic and LLM provenance** | `docs/07_decision_log.md` l.118 (D-112: bake-off harness; never run; classifier `none`; no role assigned); `docs/M6_exit_evidence.md` l.16 and l.74 (bake-off not run) | The "AI-generated" and "rule-based" badges (UX-060, UXN-113, UXN-116, UXN-272) can only show the rules-only state until the bake-off runs (§5 item 17). |
| **No A6 notes or Owner-facing LLM Usage page** | `docs/M6_exit_evidence.md` l.70 (D-123: no A6 notes); `docs/M6_requirements.md` §6 (LLM-051 "M7 / M8"); `spec/03` l.60 (LLM-051) | Decide whether the Usage page shows LLM usage in M7 (§5 item 31). |
| **Evening Review sections 4–6 content** | `docs/M6_exit_evidence.md` l.48 (AT-20 sections 4 to 6 met locally) | The in-app `/reviews/[date]` page must render the same sections; the UXN-113 badge must read the stored fallback state. |
| **Owner prerequisites carried from M5 and M6** | `docs/M5_exit_evidence.md` l.53–65 and `docs/M6_exit_evidence.md` l.56–64 (Resend keys, Gmail filter, Worker slots disabled, Owner approvals of new workflows) | Not M7 items. The M7 staging run for AT-25 to AT-27 needs the same release (D-022). |
| **Migrations not applied anywhere** | `docs/M6_exit_evidence.md` l.65 (main 0007–0010 and auth 0004–0005 not applied anywhere) | The staging run of AT-25…AT-27 waits for the same release (D-022). |
| **Public pages already built** | `docs/07_decision_log.md` l.22 (D-016: `/privacy` and `/terms`); `docs/test-map.md` l.12 (PLT-035 public pages) | Reuse for the footer links (AT-27: "links to Privacy and Terms"). |
| **Review and cards pages** | `docs/07_decision_log.md` l.110 (D-104: `/reviews/[date]` with a POST mark-as-read action and read-only `/cards/[id]`) | Reuse. The mark-as-read POST must follow SEC-011 and ROL-102a. |
| **Alert routes without a page** | `docs/07_decision_log.md` l.107 (D-101: `GET /api/alerts`, ack and snooze routes); no alerts page exists in `src/app` | Build the alert inbox (UX-052, UXN-157, UXN-161) on these routes. |
| **Role-aware pages built in M1–M6** | `docs/test-map.md` l.33 (System Health), l.37 (`/users`), l.58 (`/config`), l.85 (DAT-221 review queue) | Reuse; each must pass the masking and role tests of §2.16. |

## 5. Gaps, contradictions and open questions (numbered)

1. **Tab list history.** UXN-033 (`16` l.213) says four tabs; UXN-040 (`16` l.250) says five; UXN-270 (`16` l.302) says six, and the s13 notes name six (Q-062, O-38). The "six tabs" text is the binding one. UXN-011 (`16` l.30, P2) still lists the old bottom bar (Dashboard, Arena, Signals, Risk Monitor, more). **[CHECK]** mark UXN-011 and the §9.2 table as superseded in the spec.
2. **"Needs your attention" on Home.** UXN-034 (`16` l.214) lists the block; UXN-046 (`16` l.286) removes it and moves the count to Strategies. The superseding text is in UXN-046. **[CHECK]** add a supersession note to UXN-034.
3. **Route map missing.** No route paths are given for the six tabs, the strategy pages, Picks, track record, company page, Control Room, alert inbox, About or Appearance. AT-25 names the pages without routes. **[CHECK]** the architect to publish a route list (TST-122 needs it; `docs/test-map.md` needs it).
4. **Validation label text versus friendly text.** UXN-060 (`16` l.37) and its acceptance (`16` l.341) require the exact ARN-086 text ("reads exactly CONSISTENT-FORWARD"). UXN-031 (`16` l.194–202) maps each label to "Not proven yet", "Worked on past data", etc., and the §16.19 acceptance (`16` l.220) requires "Not proven yet" on screen. **[CHECK]** the Owner must choose the visible text. The default here: exact label on the badge, friendly text beside it.
5. **Scenario column labels.** UX-041 (`09` l.75) uses "historical range, not a forecast". UXN-100 (`16` l.55) allows "Downside/Typical/Upside". UXN-031 (`16` l.208) and UXN-042 (`16` l.252) use "Bad case / Typical / Good case". **[CHECK]** pick one label set.
6. **Gain/loss colour option.** UXN-281 (`16` l.320) offers "Classic green/red"; UXN-001 (`16` l.21) and §16.1 (`16` l.12) say never plain red/green. **[CHECK]** Owner decision. Until then, the classic option is out of the design.
7. **Quiet hours and the regime P1.** UXN-160 (`16` l.81) says quiet hours suppress "only P1/P2". UXN-251 (`16` l.148) says the regime P1 "cannot be silenced by quiet hours". UXN-251 also adds a P1 criterion that AGT-115 (`07` l.68) does not define. **[CHECK]** amend AGT-115 or UXN-160.
8. **Chart range.** UXN-271 (`16` l.303) s13 note: range chips 1M / 3M / 6M / 1Y / 2Y. The acceptance (`16` l.312) still says "range chips 1M–5Y". O-38 (`00` l.71) says "candle charts up to 2Y (Q-060)". **[CHECK]** the acceptance text is stale; treat 1M–2Y as binding.
9. **Role matrix not updated for new actions.** ROL-102a (`10` l.53–63) lists only own preferences and alert acknowledgement for Viewers and nothing else. UXN-160 (quiet hours and snooze), UX-080 ("Mark as read" POST), and UXN-047 (Editor watchlist, s13) are not in the matrix. Under the matrix's own rule ("anything not listed is Owner-only") a Viewer could not snooze and an Editor could not star a company. **[CHECK]** amend ROL-102a.
10. **Annotation visibility for masked Viewers.** ROL-102b (`10` l.64) says "visible to all users (no role masking)". UX-071a s13 (`09` l.92) says a masked Viewer sees "Note added by <role> on <date>" without text. **[CHECK]** the two rules conflict for masked content.
11. **Annotation path.** No spec text names `/api/annotations` or `/api/learning/annotations` (grep of `spec/`). M6 built `/api/learning/annotations` (`docs/M6_exit_evidence.md` l.72); M6 design wrote `/api/annotations`. **[CHECK]** architect to choose; the spec should then name the path.
12. **Accessibility gate.** AT-26 (`14` l.61) requires "WCAG 2.2 AA automated checks pass". TST-126 (`10` l.161) requires "no serious/critical issues on every page". These are two different gates. **[CHECK]** which gates M7 exit.
13. **Manual check timing.** AT-26 (`14` l.61) puts the Owner's keyboard and screen-reader check of the six tabs at M8, while AT-26 itself is an M7 test. **[CHECK]** whether M7 can exit without it.
14. **Lighthouse page name.** AT-26 says "Lighthouse ≥ 80 on Home (ex-Dashboard)". NFR-010 (`10` l.38) and the ch.09 acceptance (`09` l.135) say "Dashboard". The page is now Home (UXN-270). **[CHECK]** rename NFR-010 and the ch.09 acceptance.
15. **Design-system timing.** `12` l.65 says "Design-system items UXN-001–018 are the first task of the first milestone that builds pages." Pages were built from M1 (`/config`, `/users`, `/health`, `/signin`), and the token blocks and contrast check already exist (`docs/test-map.md` l.60). Items UXN-003, 008, 010, 011 and 018 are P2/P3 and inactive. **[CHECK]** whether the token retrofit is M7 work.
16. **Third-party fonts versus no-tracker rule.** UXN-002 (`16` l.22) allows "Google Fonts"; UX-006 (`09` l.31) and PLT-036 (`02` l.49) forbid third-party trackers; SEC-012 (`10` l.75) limits the CSP. **[CHECK]** prefer self-hosted fonts (the default in this extract).
17. **CSP for the UI stack.** SEC-012 (`10` l.75) requires no `unsafe-inline` scripts and nonces, but says nothing about `style-src` or the chart libraries (shadcn/ui, Motion, TradingView Lightweight Charts, Recharts or Tremor). **[CHECK]** the CSP directives for styles and canvases.
18. **Owner acceptance and the screen-review gate.** UXN-284 (`16` l.324) requires a screenshot review on desktop and phone in Dark and Light for every page before its PR. No checklist or owner is named for the review. **[CHECK]**.
19. **ARN-049 and ARN-048 display milestone.** `docs/M3_design.md` l.155 and l.177 and `docs/M4_requirements.md` l.307 and l.312 say "display in M4/M6"; M6 did not build them. **[CHECK]** M7 or later (carried).
20. **Visual baselines.** TST-127 (`10` l.162) stores baselines in the private fixtures repo. The CLAUDE.md rule for this build permits copying only `spec/` and the brand files into the public repo. Baselines therefore cannot be checked into the public repo. **[CHECK]** confirm the location and the update flow.
21. **Masking of company pages.** UX-009 (`09` l.16–24) masks codes on Signals and Risk Monitor. UXN-270 and UXN-271 (`16` l.302–303, s13) hide only "Our activity" from masked Viewers; the company page itself shows the code and name. DAT-124 (`06` l.70) limits personal-use-only content for non-owners. **[CHECK]** whether the company page is a masked surface.
22. **Delayed prices: licence and display rule.** UXN-048 (`16` l.289) says "Delayed about 20 min" [VERIFY at build] and "Owner to confirm (Q-058)" (accepted by O-38). DAT-124 (`06` l.70) restricts Yahoo-sourced content for Editors and Viewers to "derived numbers". A live quote may not count as derived. **[CHECK]** Owner confirmation for the quote source and the display for non-owners.
23. **Control Room data by role.** UXN-283 (`16` l.322) shows PLT-061 facts, a fix action (OPS-037), free-tier usage bars and a "Security" segment. UX-090 and UX-092 (`09` l.99–101) limit error details to Owners; UX-100 (`09` l.104) and UX-117 (`09` l.116) make usage and secrets status Owner-only. **[CHECK]** which Control Room details non-owners see.
24. **Control Room refresh cost.** UXN-283 (`16` l.322) refreshes every 60 s "while the page is open" with "no extra jobs or quota". The Turso read budget is DAT-141 (`06` l.103). **[CHECK]** the reads per open page against DAT-141.
25. **Readability check tool.** UXN-030 (`16` l.191) requires a CI readability check at grade ≤ 8 with listed exceptions. No tool, $0 constraint or exception list is named. **[CHECK]**.
26. **Agent names versus plain language.** UX-091 (`09` l.100) requires a panel listing A1–A8. UXN-036 (`16` l.216) says agent names "MUST NOT be primary text". The panel is in System Health (Owner details). **[CHECK]** whether the panel is "Show details" content.
27. **Region menu statuses.** MKT-106 (`06` l.21) defines "not started / in build / testing / active / paused". UXN-282 (`16` l.321) lists "Active / In build with % / Not started" only. "Testing" and "paused" are not mapped. UXN-282 also says "Viewers see only markets the Owner has shared", and no sharing setting exists in the spec. **[CHECK]**.
28. **Settings → About.** UXN-019 (`16` l.185) requires the About page. The ch.09 §9.13 list (`09` l.106–117) does not include it. **[CHECK]** add it to Settings.
29. **Configuration keys missing from ch.15.** `attention_near_limit_pct` (5–30, default 15; `16` l.291) and `market_list_page_size` (50; `16` l.308) are named in ch.16 but not in §15.8 (`15` l.200–215). Also missing: the strategy-name config table (UXN-039), the quiet-hours window and snooze durations (UXN-160), and the sort defaults (UXN-046a). **[CHECK]** add the keys.
30. **Keys that the spec names but ch.15 lacks in the Market table.** `market_list_page_size` is above. The Market quote refresh uses `intraday_refresh_min` (`15` l.206). The sector heat grid and top movers are nightly (UXN-273). **[CHECK]** no further key is needed.
31. **Usage page for LLM spend.** The M6 extract (`docs/M6_requirements.md` §6) assigns the Owner LLM Usage page (LLM-051) to "M7 / M8". `spec/03` l.60 (LLM-051) is the source. **[CHECK]** M7 or M8.
32. **TST-121 coverage floors for UI.** TST-121 (`10` l.156) sets 90% on "money maths, validation statistics". UI code is neither. No UI coverage floor is set. **[CHECK]** whether `coverage_overall_min` (80%) applies to UI code.
33. **Corporate actions and dividends in pick tracking.** `docs/M6_exit_evidence.md` l.69 says pick tracking ignores them; ARN-095 (`16` l.246) says the pick outcome uses "the same costs model (ARN-031)". The UI must not show a pick result that ignores a dividend it should carry. **[CHECK]** the M6 pick back end.
34. **Aggregated news cards.** `16` l.149 ("Improves UXN-158") adds multi-source aggregation (≥ 5 sources). It has no status tag, so it is optional (`16` l.142). **[CHECK]** the architect to mark it P2 or accepted.
35. **Learn hub.** `16` l.153 ("Improves UX-070") adds a Learn section with articles authored by the Owner. It has no status tag and no data source (no article store in the spec). **[CHECK]** accepted or P2.
36. **Mockup file.** `16` l.317 says a copy of the Control Room mockup is at `docs/ui_mockup_s13_settings.html`. No such file is in `docs/`. The spec's SAMPLE DATA rule (UX-102) would apply. **[CHECK]** add the file or remove the reference.
37. **Sound.** UXN-285 (g) (`16` l.325) says "Sound off by default; optional soft status chimes." No licensed sound source is named. **[CHECK]** the audio source and licence (UXN-019).
38. **Viewer snooze and mark-as-read.** See item 9. Also UX-080 (`09` l.96) allows "Mark as read" from "the signed-in page" without naming the role. **[CHECK]**.
39. **Stale IDs in the M6 extract.** `docs/M6_requirements.md` §6 lists UXN-204 as "M7 (P2)" and UXN-203 and UXN-206 as M7 P1. This M7 extract follows the spec status tags. No further action needed beyond the M6 note.
40. **UX-130 Phase R.** UX-130 (`09` l.124) keeps real-money features out of v1. UXN-253 and UXN-254 are withdrawn (`16` l.146, l.151). Held as out of scope (§6). No gap; listed so that the Picks page is not read as Phase R.

## 6. Out of scope for M7 (later milestones)

| Item | Milestone | Source |
|---|---|---|
| P2 and P3 items: UXN-003, 008, 010, 011, 014, 018, 062, 105, 107, 108, 109, 112, 116, 117, 124, 125, 151, 153, 154, 155, 156, 162, 164, 165, 169, 202, 204, 205, 207, 209, 211, 215, 250, 252, 255 | After go-live (only if the Owner accepts them) | `12` l.65; `16` status note (l.3, l.7) |
| UXN-253 and UXN-254 (withdrawn); §16.14 rejected ideas | Not built | `16` l.146, l.151, l.115–138 |
| Phase R: real holdings upload, broker links, risk-tier allocations, real-money "Top Recommendations" | Not in v1 | UX-130 (`09` l.124); UX-053 (`09` l.82) |
| Real-time streaming of all ASX prices, intraday charts | Not in v1 | UXN-048 (`16` l.289); UXN-271 (`16` l.303) |
| 5Y chart range | Deferred until an archive-read path is specified | UXN-271 s13 (`16` l.303); DAT-140 (`06` l.102) |
| Full release gate, staging E2E day, restore test, Owner walkthrough, go-live | M8 | `12` l.55; `14` l.64–69 (AT-28…AT-31) |
| India and USA screens beyond the region switcher | M9, M10 | `12` l.56–57; UXN-282 (`16` l.321) |
| Dark-mode email CSS (UXN-169), Web Push (UXN-014) | P2 or P3, after go-live | `16` l.85, l.91 |
| Mistake-category "confusion matrix" and cost-decay attribution waterfall | Not in v1 (needs a new taxonomy or method) | `16` l.127–128 |
| Owner-facing LLM Usage page (LLM-051) | M7 or M8 (§5 item 31) | `03` l.60 |

## 7. Existing pages

Taken from `src/app/**/page.tsx` (15 page files) and `src/app/api/**/route.ts` (the route list that a page calls). Nothing in `src/app` is a navigation shell: there is no `(app)` navigation layout beyond `src/app/layout.tsx`. [CHECK] the `(app)` group has no `layout.tsx`, so auth and nav are per page (`requireUser` in each page; `src/app/(app)/page.tsx` l.6).

| Route | File | Heading shown | Evidence | Spec page it partly covers |
|---|---|---|---|---|
| `/` | `src/app/(app)/page.tsx` (72 lines) | "Praxis" (placeholder; the test-map says it carries "All trades are simulated.") | `docs/test-map.md` l.13 | Home (§2.4) |
| `/cards/[id]` | `src/app/(app)/cards/[id]/page.tsx` | Decision Card (read-only) | D-104 (`docs/07_decision_log.md` l.110) | Decision Card (§2.7; UX-041) |
| `/config` | `src/app/(app)/config/page.tsx` (195 lines) | "Configuration" | `docs/test-map.md` l.58 (UX-116) | UX-116 |
| `/health` | `src/app/(app)/health/page.tsx` (641 lines) | "System Health" | `docs/test-map.md` l.33, l.80 | System Health (§2.13; UX-090) |
| `/learning` | `src/app/(app)/learning/page.tsx` (44 lines) | "Learning" with challengers list | D-125 (`docs/07_decision_log.md` l.131) | Knowledge (§2.11; UX-070), minimal |
| `/learning/challengers/[id]` | `src/app/(app)/learning/challengers/[id]/page.tsx` | "Challenger {id}", History | D-125 | Knowledge challenger (§2.11), minimal |
| `/learning/lessons/[id]` | `src/app/(app)/learning/lessons/[id]/page.tsx` | "Lesson {id}", grade history | D-125 | Knowledge lesson (§2.11), minimal |
| `/review` | `src/app/(app)/review/page.tsx` (83 lines) | "Data review queue" | `docs/test-map.md` l.85 (DAT-221) | UX-114 |
| `/reviews/[date]` | `src/app/(app)/reviews/[date]/page.tsx` | "Evening Review {date}", POST mark-as-read | D-104 | Reviews (§2.12; UX-080) |
| `/settings` | `src/app/(app)/settings/page.tsx` (122 lines) | "Settings" | none in the decision log read | Settings (§2.15; UX-110) |
| `/usage` | `src/app/(app)/usage/page.tsx` (118 lines) | "Usage" | `docs/test-map.md` l.39 (PLT-050) | Usage (§2.14; UX-100) |
| `/users` | `src/app/(app)/users/page.tsx` (249 lines) | "Users & roles" | `docs/test-map.md` l.37 (UX-111) | UX-111 |
| `/signin` | `src/app/signin/page.tsx` | sign-in (public) | PLT-030/031 | UX-120 |
| `/privacy` | `src/app/privacy/page.tsx` | "Privacy" (public) | D-016 | footer link (§2.3) |
| `/terms` | `src/app/terms/page.tsx` | "Terms" (public) | D-016 | footer link (§2.3) |

Route handlers that the pages call (`src/app/api/**/route.ts`, selected): `/api/alerts`, `/api/alerts/[key]/ack`, `/api/alerts/[key]/snooze`, `/api/alerts/quiet-hours` (D-101); `/api/health`; `/api/email/test`; `/api/auth/[...nextauth]`; `/api/learning/annotations`, `/api/learning/lessons`, `/api/learning/challengers` and its approve, reject, retire, force-apply and shadow-viewed actions, `/api/learning/families/[family]/versions` and `rollback`, `/api/learning/lessons/[id]/retire` and `force-apply` (14 routes, D-125). There is no `GET /api/learning/plan` or `GET /api/learning/documents` (`docs/M6_design.md` l.213).

Pages required by ch.09 and ch.16 that **do not exist**: Home (as a real page; the current `/` is a placeholder), Picks, Picks track record, Market, company page and its "i" overview, Strategies (list, strategy page, execution detail, "Risk overview"), Signals or "Tonight's trade ideas" list, Risk Monitor / Stress tests, News (feed, "Alerts" chip), alert inbox (the header bell), Knowledge families, hypotheses, change ledger and Glossary, Reviews (evening list, "What the system learned", calendar), System Health as Control Room, Settings → Appearance, Region & markets, About, Ops checklist, sign-in error page (UX-122), email templates view (no page needed).

## 8. Coverage estimate

Spec lines read in full: `spec/09_ui_ux.md` (135 of 135), `spec/16_ui_next_level.md` (391 of 391), `spec/14_system_acceptance.md` (§14.7 and the §14.8 AT-30 row). Read by line range or by grep for UI terms: `spec/02` (§2.5, PLT-004, PLT-017, PLT-031…036, PLT-050, PLT-051, PLT-061, PLT-073 row), `spec/10` (ROL-101…107 and ROL-102a matrix, SEC-011, SEC-012, SEC-014, SEC-016, NFR-005, NFR-006, NFR-010, NFR-031, TST-113, TST-120…133, VAL-101, the acceptance block), `spec/13` (UX-101…104, MKT-104, ROL-101…106, REV-001, REV-003), `spec/15` (§15.1, §15.4, §15.5, §15.6, §15.7, §15.8 and the UI keys), `spec/05` (ARN-049, ARN-050, ARN-071, ARN-078, ARN-082, ARN-084, ARN-086, ARN-094), `spec/07` (AGT-014, AGT-101, AGT-110, AGT-111, AGT-115), `spec/08` (KB-010, KB-020, KB-030…032, KB-040, KB-050, KB-051, KB-070), `spec/04` (EML-005, EML-006, EML-011…016, EML-020, EML-023, EML-034, EML-036), `spec/03` (LLM-011, LLM-021, LLM-034…036, LLM-050), `spec/06` (DAT-120, DAT-123, DAT-124, DAT-140…142, MKT-102, MKT-104, MKT-106), `spec/00` (O-34, O-35, O-36, O-38), `spec/12` (rows M6 to M8, l.54–55, l.62, l.65).

Counts: 227 table rows in §2 across 18 subsections (some rows group several IDs, and a few rows are page or section references rather than spec IDs). 15 page files and 3 public or sign-in pages in §7. 40 numbered gaps in §5. The accepted ch.16 P1 items (67 UXN IDs, plus the back-end AGT-112, AGT-113 and ARN-095) are all cited in §2 with their line. The P2 and P3 items are listed in §6 without their text.

Items marked **[CHECK]**: 38 of the 40 numbered gaps in §5 carry a **[CHECK]** or an Owner decision. Items 39 and 40 are notes, not open questions.
