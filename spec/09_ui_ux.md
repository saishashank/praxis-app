# Chapter 09 — Web UI / UX  (v2.0, session 10)

> **(s14) Read with ch. 16.** The ch. 16 **P1** items are accepted and binding (O-38) and win over this chapter where they differ. Page map after O-38 (UXN-033 + UXN-270): six tabs **Home, Picks, Market, Strategies, News, Reviews**. Dashboard (§9.3) → **Home**; Arena leaderboard, execution detail (§9.4–9.6) and Risk Monitor (§9.7) → **Strategies** (positions and risk on each strategy; concentration and kill switches under Strategies → "Risk overview"; alert inbox from the header bell, UXN-157); Signals / Decision Cards → "Tonight's trade ideas" on Home and on each strategy; News (§9.8) → **News**; Reviews and Knowledge → **Reviews** ("Evening reviews", "What the system learned"); Picks and Market are new (ch. 16 §16.21, UXN-270…273). Settings, System Health (as the Control Room, UXN-283), Usage, Ops checklist and Users & roles keep their full pages but are opened from the header **gear (account) menu**, not the tab bar. Every requirement in this chapter still applies to the page it moved to.

_Replaces the imported draft v0.7, which only specified the System Monitor and referred to a "previous version" of the Dashboard, Recommendations, Risk Monitor and News Hub pages that never existed. All pages are now specified here. Requirements only — no code, no visual mockups with numbers (any mockup MUST be labelled SAMPLE DATA, UX-102)._

## 9.1 Principles
- **UX-001 Platform.** Next.js web app on Vercel (PLT-003, PLT-072); fully usable on a phone (≥ 360 px wide) and desktop; dark and light themes (dark default); WCAG 2.2 AA contrast and keyboard navigation.
- **UX-002 Honesty labels.** Every monetary result is labelled **"Simulated"**. Forward-looking model probabilities appear only when calibrated (VAL-101); empirical frequencies are shown with n and a **90%** interval, and P(target) always appears with P(bust) and P(stalled) (ARN-071). Unmeasured values show "not yet measured" (REV-003). A short always-visible explainer states what "Simulated" means (real data, modelled costs/fills, no real orders) **(s11, UXP-R3-02)**. **(s13)** Every Simulated label has a hover/tap explainer: 'Simulated — real market prices, modelled costs and fills, no real orders or money.' The same line appears in the page footer.
- **UX-101 News content.** Store and show headline, source, timestamp, link to the original and a system-written summary (≤ 80 words, labelled). Full third-party text or images are not copied unless the source licence permits (DAT-120).
- **UX-102 Sample-data labelling.** Any mockup, seeded demo or empty-state example shows "SAMPLE DATA".
- **UX-103** Visual themes (e.g. a "Jarvis-style" System Health look) are optional and never display decorative or invented numbers.
- **UX-104 Reality panels.** Every page showing a target, signal or result shows the relevant reality panel (PRD-020/021/026) and the validation label (ARN-086).
- **UX-009 (s9) Masking for non-Owners (ROL-107).** Default when unmasked = off: **(s13)** Active set = every code appearing in any record visible to that user for that Melbourne date; letters are fixed for the whole date and never re-used within it.

| Page / item | Viewer & Editor see |
|---|---|
| Dashboard tiles, Arena, leaderboard | executions, families, NAV, metrics — **no codes** |
| Signals, Decision Cards, Risk Monitor positions | code shown as "Stock A/B…" (letters assigned alphabetically by code among that day's active set, reset at local date-start) **(s11, BLD-R1-08, BLD-R3-07)**, sector and tier only; **no** trade prices, trade-level dates (week only: ISO week number and year, e.g. 2026-W38) **(s11, BLD-R3-07)**, evidence source links or company names — masked users see the **rules-only template text** instead of LLM free text |
| Reviews (in-app) | same masking as above |
| News | headlines of macro/regulator items; company items only for unmasked codes |
| Alert inbox, Risk Monitor "latest events", execution-detail trade lists | same masking: no code, name, trade price, exact date or source link |
| Challenger and Critic text (Knowledge) | rules-only template text; no LLM free text |
| Knowledge | lessons and rules (no code-level examples; rules-only template text for lessons) |

The Owner can unmask **per user**, for all codes, with an expiry (default 30 days); each change is audit-logged.
- **UX-008 (s9) Safe rendering.** LLM text is rendered as plain text (no markdown links/images); links are clickable only if `https:` and their host is in the source register (SEC-016).
- **UX-003 Market context.** A market switcher (AU / IN / US) sits in the header; each market shows its **work status** (MKT-106: not started / in build / testing / active / paused) and, until active, its checklist (MKT-102). Currency and local exchange time are shown per market; owner-facing timestamps use Australia/Melbourne.
- **UX-004 Role-aware.** Controls a role cannot use are hidden for Viewers **and** visible-but-disabled-with-reason for Editors **(s11, UXP-R2-03)**; all controls are refused server-side per the role × action matrix (ROL-102a). A small role badge shows the signed-in role. For non-Owners, code-level signals and Decision Cards are **masked by default** (ROL-107).
- **UX-005 Performance.** First contentful paint < 2 s on a mid-range phone over 4G for Dashboard; API p95 < 500 ms for page data (NFR-010). Pages load from pre-computed nightly tables, not live recomputation.
- **UX-006 No third-party trackers**, no remote images in-app except our own assets (PLT-036).
- **UX-007 Empty and error states.** Every page defines what it shows before the first cohort/data exists and when its data is stale (older than **2×** its expected interval, as PLT-017) — a banner with the last good timestamp.

## 9.2 Navigation
_(s14) The menu below is the original page list; the **six tabs + gear menu** of ch. 16 UXN-270/UXN-033 (see the page map at the top of this chapter) replace it as the navigation. The pages and their roles still apply._

| Menu item | Page | Roles |
|---|---|---|
| Dashboard | §9.3 | all |
| Arena | §9.4 leaderboard + §9.5 execution detail | all |
| Signals | §9.6 tonight's signals and Decision Cards (replaces "Top Recommendations" for v1) | all |
| Risk Monitor | §9.7 open simulated positions, alerts, thesis-breakers | all |
| News | §9.8 | all |
| Knowledge | §9.9 families, lessons, challengers, hypotheses | all (edit: Owner) |
| Reviews | §9.10 Evening Review history | all |
| System Health | §9.11 (the "System Monitor") | all (details: Owner) |
| Usage | §9.12 | Owner |
| Ops checklist | §9.13 UX-118 | Owner |
| Settings / Admin | §9.13 | Owner (personal preferences: all) |

## 9.3 Dashboard
- **UX-010** Top strip per active market: date of last completed run, data-quality verdict (DAT-210), regime (AGT-101) with a tap-to-show one-line meaning and its effect on entries **(s11, UXP-R1-05)**, Sentinel status, "Simulated" label.
- **UX-011** Arena summary: 12 execution tiles (E01–E12) each with family, U/L variant, NAV vs the A$600 seed, A$1,200 target, A$300 bust line and the **stall floor** (≈ A$511, U and L) (progress bar), **progress** = empirical P(target | NAV, time) with n or "not yet measured" (ARN-071), "live rule ≠ validated variant" when applicable (ARN-082), open positions count, sleeve lock state for L variants, validation label (F5 reachable date shown directly on its tile) **(s11, UXP-R3-04)**. Executions showing a terminal state (target/bust/stalled/timeout) link to the execution detail page **(s11, UXP-R3-05)**. Stalled executions are terminal and restart automatically, same as bust **(s11, UXP-R1-04)**. Tapping opens §9.5.
- **UX-012** Today's changes: new entries/exits scheduled for next open, cohorts completed today (target/bust/stalled/timeout), P0/P1 alerts since last review.
- **UX-012a (s11)** Dashboard first visit shows a dismissible welcome banner summarising the 12 executions, the A$1,200 target and A$300 bust line, and what "Simulated" means **(s11, UXP-R2-05, UXP-R3-02)**.
- **UX-013** Headline scorecard (ARN-077) showing per-currency totals only, no FX-converted grand total **(s11, O-34)** and a link to tonight's Evening Review.
- **UX-014** Reality panel (PRD-020 odds table, collapsible) and control comparison: best of the 12 executions vs the distribution of the **best of 12 matched control portfolios** (so the selection effect is shown fairly, ARN-078).
- **UX-016 (s9)** Market status strip: one chip per market with its work status (MKT-106) and milestone.
- **UX-017 (s9)** Evidence-timeline notice (VAL-102, PRD-028): "Forward rankings need ≥ 5 finished cohorts (effective) per execution and forward labels need ≥ 100 forward signal trades; for some families that takes years — the dates shown are computed from the measured signal rate. Until then evidence comes from historical replays; daily comparisons are descriptive, weekly findings must repeat to count."
- **UX-015** Banners: missing recipient email (EML-006), degrade mode (PLT-051), partial review (EML-011), sources switched off (DAT-123), token expiry within 14 days (PLT-074), no Evening Review marked read for 3 days (EML-036).

## 9.4 Arena leaderboard
- **UX-020** Table of (execution, rule version) with: family, variant, resolved cohorts and effective N, CIF of target, bust **and** stalled at 3/6/12 months with CIs, E[NAV end] − seed, each also minus the matched control (ARN-071), zero-edge benchmark, TTD curve link, stalled share, cost-feasibility label (ARN-094), max drawdown (median, 95th pct), cost drag, validation label (with minimum detectable effect); entries not meeting ARN-078 appear in an "insufficient evidence" section. Default sort by validation label, then tied groups (ARN-078); order within a group is alphabetical, never by point estimate. Below 600 px wide, show a card view **(s11, UXP-R1-20)**. Hover/tap definitions provided for CIF, effective N, thesis-breaker, cost drag, validation labels, effective cohorts **(s11, UXP-R1-07, UXP-R2-08, UXP-R1-17)** — see Glossary (§9.9a). **(s13)** Label sort order: CONSISTENT-FORWARD, PASSED-BACKTEST, UNVALIDATED, NOT-DEMONSTRATED, UNVALIDATABLE, FAILED. [OWNER, O-38]
- **UX-021** Controls C1–C3 rows appear alongside; a "possible luck" flag shows where ARN-086 requires it.
- **UX-022** Toggle: cost profile replay (P0–P5, P5b and stress, ARN-034) served from pre-computed nightly per-fill tables (no heavy compute in the request).
- **UX-023** U-vs-L twin comparison per family (ARN-050/084) with the reality-adjusted 5× view (ARN-049) and the hypothetical-leverage label.

## 9.5 Execution detail
- **UX-030** Page header shows "Cohort N · started [date] · [x] sessions held" **(s11, UXP-R1-02, UXP-R1-16)** above the NAV chart for the current cohort with seed, target and bust lines; list of past cohorts with outcome, TTD, drawdown.
- **UX-031** Positions and trade list; each trade links to its Decision Card (§9.6) and costs breakdown.
- **UX-032** Rule version in use (link to Knowledge), pending challengers for this execution, sleeve state/history (L only), change ledger entries affecting it. A version-history panel shows date, action, VAL-110 result, and an Owner-only revert button **(s11, BLD-R3-14)**.

## 9.6 Signals and Decision Cards
- **UX-040** Per market, tonight's signals grouped by family: taken (became orders), not taken (lower rank, filters, data gaps) with reason.
- **UX-041** Decision Card view (AGT-110): rules fired with values, rank score, evidence lines with source links, thesis-breakers with live status, exit plan, cost estimate, scenario table (percentile-based, labelled "historical range, not a forecast" with one plain-English sentence explaining what the 10th/50th/90th percentile columns represent) **(s11, UXP-R1-03)**, regime, data-quality status, family validation label, and a reality panel. **(s13)** The explanatory sentence is a fixed template filled from stored numbers; it is never LLM-written.
- **UX-042** No button places a real order; the page states "Simulation only — not financial advice" (PRD-001, ROL-106).

## 9.7 Risk Monitor (simulated positions)
- **UX-050** All open positions across executions: code, execution, weight in NAV, unrealised P/L, distance to stop, days held vs time stop, thesis-breaker status (green/amber/red), latest events and alerts for the code. Owner can pause/resume an execution (blocks new entries, existing positions still managed) or per-family kill-switch on/off **(s11, UXP-R1-09, UXP-R3-06)**, with audit logging and status display.
- **UX-051** Concentration view: exposure by code, sector and tier across the 12 executions (information only; executions are independent).
- **UX-052** Alert inbox (AGT-115): P0/P1/P2 with acknowledge (per user; allowed for all roles per ROL-102a).
- **UX-053** Phase R note: real holdings upload/screenshots are **not** in v1 (§9.15).

## 9.8 News
- **UX-060** Feed per market of stored items (DAT-110): headline, source, time (Melbourne and exchange time), codes tagged, materiality, our summary (≤ 80 words, labelled "AI-generated" when written by role R2 or "rule-based" when deterministic fallback was used) **(s11, UXP-R1-11)**, and a link to the original. Full third-party text/images are not reproduced (UX-101).
- **UX-061** Filters: market, code, category, materiality, date range; full-text search over headlines and our summaries; retention 400 days (DAT-142).
- **UX-062** Items linked to held positions show which executions hold the code.

## 9.9 Knowledge
- **UX-070** Browse and search KB documents (KB-070): families (current version, parameters with bounds, version history and diffs), lessons (grade badge), challengers (lifecycle stage, replay and forward results, Critic answers), hypotheses, change ledger.
- **UX-071** Owner-only actions: create/edit a family version (→ challenger by default, KB-050), approve/reject a challenger, force-apply with confirmation, rollback. Editors can annotate. Every action is audit-logged.
- **UX-071a (s11) Annotations.** Editors and Owner can add plain-text annotations (≤ 1,000 chars) to lessons, Decision Cards and hypotheses; visible to all users; author or Owner may edit/delete; all changes are audit-logged **(s11, BLD-R3-08)**. **(s13)** On masked content, annotations are visible only to Owner/Editor; a masked Viewer sees 'Note added by <role> on <date>' without text.
- **UX-071b (s11) Glossary.** A searchable Glossary page provides tap-to-define tooltips for CIF, effective N, thesis-breaker, cost drag, validation labels (PASSED-BACKTEST, UNVALIDATED, etc.) and effective cohorts **(s11, UXP-R1-07, UXP-R2-08, UXP-R1-17)**. Definitions also appear as hover/tap on the leaderboard and decision cards.

## 9.10 Reviews
- **UX-080** Evening Review history per date (EML-015), rendered in-app identical to the email, with "partial" markers and delivery status; searchable by date and text. During the 19:30–20:45 pending window, the list shows a "pending" state **(s11, UXP-R1-06)**. A **"Mark as read"** button (POST from the signed-in page) records that the Owner has read the review (EML-036).

## 9.11 System Health (the "System Monitor")
- **UX-090** Shows PLT-061 content: per job (Sentinel, batches 1–3, email, backup, bake-off) last success, duration, next scheduled time, status (success/running/failed shown with status colours) **(s11, UXP-R1-10)** with staleness defined as 2× the job's expected interval **(s11, UXP-R1-10)**; per source (DAT-120 register) enabled/disabled, last fetch, error rate; per market data-quality score history (DAT-201); LLM provider status and fallbacks; last backup and last restore test.
- **UX-091** An agent panel lists A1–A8 with last run, outputs count, status and link to their latest outputs. A visual "Jarvis-style" theme is optional (UX-103) and MUST NOT display invented or decorative numbers.
- **UX-092** Viewers/Editors see status only; Owners also see error details and logs (secrets redacted, PLT-040).

## 9.12 Usage (Owner)
- **UX-100** Free-tier meters (PLT-050): Vercel, Actions minutes, Turso storage/reads/writes, Cloudflare requests and CPU, each LLM provider, Resend emails, history-file store — current, limit, %, trend, per market (MKT-104); degrade-mode state.

## 9.13 Settings and Admin
- **UX-110 Personal (all roles):** theme, default market, alert display preferences (per-tier immediate vs digest toggle; P0 cannot be turned off) **(s11, UXP-R1-12)**, time format (stored as user_preference; the only other Viewer write besides alert acknowledgement — ROL-102a).
- **UX-111 Users & roles (Owner):** allowlist of Google emails with role (default Viewer), add/revoke/change role, audit log (ROL-101…104). The **Add user** button stays disabled until the Owner records the sharing acknowledgement (ROL-107). **(s13)** Add-user stays disabled with the hint 'Acknowledge sharing first' until the ROL-107 acknowledgement row exists.
- **UX-118 (s9) Ops checklist (Owner):** the OPS-020 tasks with due dates, done ticks and token-expiry dates.
- **UX-119 (s9) What-if (Owner, Editor):** parameter what-ifs run only against pre-computed nightly tables (≤ 2 s); anything heavier is queued for the next nightly batch within the ROL-102 daily budget.
- **UX-112 Markets (Owner):** activation checklist per market (MKT-102) and the activate/deactivate switch.
- **UX-113 Sources (Owner):** licence register (DAT-120) with per-source kill switches (DAT-123) and ASX risk-acceptance record (DAT-122).
- **UX-114 Data review queue (Owner):** unconfirmed corporate actions (DAT-221) with evidence and confirm/edit/reject.
- **UX-115 Email (Owner):** recipient (read-only, from `OWNER_EMAIL`, EML-005), send time, pause, Morning Brief toggle, test email (EML-016, EML-034).
- **UX-116 Configuration (Owner):** view (and edit where allowed) thresholds, budgets, schedules, cost profiles, sleeve settings; every edit is versioned and audit-logged (PLT-041).
- **UX-117 Secrets status (Owner):** shows only whether each required secret is present and when it was last verified by the CI smoke test — never values (SEC-101).

## 9.14 Sign-in, sessions, errors
- **UX-120** Sign-in page with "Sign in with Google" only; non-allowlisted accounts see a neutral "not authorised" message that reveals nothing about the system (PLT-030/031).
- **UX-121** Session expiry returns the user to sign-in and then to the page they were on.
- **UX-122** Generic error page with a correlation id; details only in Owner logs.

## 9.15 Phase R (parked, not in v1)
- **UX-130** Real-money features — risk-tier allocations (Turbo/Balanced/Steady), a "Top Recommendations" page for real trading, holdings screenshot upload/OCR, broker links — are out of v1 and require revisiting PRD-001/PRD-025 with the Owner first. The imported v0.7 content for them is kept only as ideas in `knowledge/common/`.

## Acceptance criteria — Chapter 09
- **Given** a Viewer, **when** they open Knowledge or Settings, **then** only personal preferences are editable, Usage/Admin/Ops are not in their menu, and any other write call returns 403 (UX-004, ROL-102a).
- **Given** a Viewer opens Signals, **then** codes are masked unless the Owner has unmasked them (ROL-107).
- **Given** a phone 360 px wide, **then** every page reachable from the six tabs (Home, Picks, Market, Strategies, News, Reviews) and the gear menu is fully usable without horizontal scrolling (UX-001; UXN-270) **(s14)**.
- **Given** no cohort has completed, **then** the leaderboard shows all executions under "insufficient evidence" and every metric shows "not yet measured" (UX-002, UX-020).
- **Given** a Decision Card, **then** it shows rules with values, evidence links, thesis-breakers with status, exit plan, percentile scenario table labelled "not a forecast", and the validation label (UX-041).
- **Given** a news item, **then** only headline, source, time, link and our labelled summary are shown (UX-060).
- **Given** stale data (last run older than expected), **then** the affected pages show a stale banner with the last good time (UX-007).
- **Given** an Owner force-applies a rule edit, **then** a confirmation is required, the execution's label resets to UNVALIDATED and an audit event exists (UX-071, KB-050).
- **Given** Lighthouse on Dashboard (mobile), **then** performance ≥ 80 and FCP < 2 s (UX-005).
