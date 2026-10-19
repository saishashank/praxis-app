# M6 requirements extract: Learning and knowledge

Verification (architect, 2026-10-20): every [CHECK] quote in §5 was re-read against `spec/`; corrected: ROL-102 line (l.52, not l.57), DAT-150 entity list and state machines, item 10 (the cache already has a `kb_version` column), items 13, 18, 19, 25, 32, 33 and 34.

Source: `spec/` in this repo (chapters 03, 05, 06, 07, 08, 09, 10, 12, 13, 14, 15 and 16; the M6 rows only, with cross-references to the M4 and M5 hand-over). `docs/M4_requirements.md`, `docs/M4_design.md`, `docs/M4_exit_evidence.md`, `docs/M5_design.md`, `docs/M5_exit_evidence.md`, `docs/test-map.md` and `docs/07_decision_log.md` are cited for the carried items. The private data and fixtures repositories were not read. Extract only. Quotes are trimmed with "…". Spec IDs are cited as written. `(l.N)` is a line in the named spec file. Where an M6 row names no AT for an ID, the acceptance column says "gap". Items marked **[CHECK]** are unclear, conflicting or not found in the spec and need an Owner or architect decision. Spec text is the authority; this file does not change it.

## 1. M6 scope (ch.12 §12.3, verbatim)

> M6 | Learning & knowledge | A6/A7, lessons, Lane A/B, challengers, Critic, KB documents and archive | AT-22…AT-24

Related items:

- **BLD-024** (`12_build_plan.md` l.62): "From M2 the production deployment runs … with the Arena, emails and decision agents (A2–A8) disabled." M6 agents (A6, A7) and the KB archive therefore need an explicit production switch rule. See §5 item 2.
- **Ch. 16 P1 back-end** (`12_build_plan.md` l.65): "Accepted P1 items join M7 (pages) and their back-end parts (AGT-112, AGT-113, ARN-095, Market data) join M5/M6." The accepted P1 knowledge items (UXN-200, UXN-201, UXN-208) are screens in M7; their back-end data is M6 by inference. See §5 item 37.
- **TST-115** (`10_nfr_testing.md` l.150): the single source for where each M6 test runs. Staging (recorded data): "AT-22…AT-29". TST-111 (bake-off) also runs on staging. See §2.9.
- **PLT-073** (`02_platform_hosting_auth.md` l.84–101): Batch 3 at 18:40 ("A6 attribution, comparisons, controls, lesson candidates"); "LLM wording + Critic" at "(≤ 19:10)" ("A6 wording, A7 checks and concerns, A8 assembly — runs back-to-back inside workflow 2 after batch 3").
- **13 errata timeline** (`13` l.68–69): "18:40 | Batch 3: close the books, attribution, comparisons, controls, lessons (deterministic)" and "19:10 | LLM narrative + critic (budgeted)".

## 2. Requirements table

Columns: ID (file l.N) | exact MUST/SHOULD/MAY text (verbatim, trimmed) | acceptance | ch.15 keys (default, bounds, edit: O = Owner-only, B = Lane-B, — = fixed, [V] = verify at build).

### 2.1 Batch 3 and A6 Daily Review & Learning

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| A6 roster (07 l.21) | A6 **Daily Review & Learning**, "Batch 3 (18:40) deterministic; 19:10 wording", main outputs "Attribution, comparisons, lessons, plan (ARN-060…069)", LLM role "R3 wording". | AT-22 | — |
| AGT-040 (07 l.71) | "A6 implements ARN-060…069." | AT-22 | — |
| AGT-050 (07 l.97) | "Steps follow PLT-073 with its deadlines; each step checks its predecessor's completion marker and otherwise runs on the latest complete inputs, marking outputs `partial`." | AT-22; gap for the A6 predecessor rule | — |
| AGT-051 (07 l.98) | "AU orders are final before the 19:45 marker; IN/US orders are created after their own closes and reported in the next 20:00 review." | AT-22 | — |
| AGT-004 (07 l.10) | "An agent failure never stops others; downstream steps run on the latest complete inputs and mark outputs `partial`." | gap (negative test for A6 failure) | — |
| AGT-002 (07 l.8) | "**(s13)** LLM-based outputs also store provider, model ID and fallback depth (0 = first choice; 'rules-only' when no model was used)." | AT-22; gap for A6/A7 records | — |
| AGT-001 (07 l.6) | "LLMs only in the Ch. 03 roles and never compute numbers, choose trades or change configuration (LLM-001, LLM-035, ARN-090)." | AT-22; AT-16 (no LLM number) | — |
| AGT-011a (07 l.7) | "LLM-adjusted values are stored in separate fields and used only for alert routing and text." | gap for A6 use of LLM fields | — |
| ARN-060 (05 l.91) | "**Close the books** in batch 2 before signals: …" (A6 reads the closed books; batch 2a is built in M4). | AT-22 | — |
| ARN-061 (05 l.92) | "Attribution tags for every trade and position (family, execution, rule version, tier, signals/agents, regime, events, holding period, costs, slippage, MFE/MAE, exit reason, filter decisions); blocked trades and their later outcomes." | AT-22; gap for MFE/MAE definition (§5 item 25) | — |
| ARN-062 (05 l.93) | "Nightly comparisons … are **descriptive** (point estimates with 90% intervals, labelled \"descriptive — not a finding\"). **Findings** … come only from the **weekly** test run with block-bootstrap intervals and Benjamini–Hochberg control across that week's comparisons; a detected difference gets **exactly one confirmation look** …" | AT-22; EML-037 | comparison_findings (weekly, BH q 0.10, one look at α 0.05 after ≥ 30 new rows and ≥ max(75, 15 × block) sessions; 60-session lockout) (—; l.51); comparisons_fdr_q 0.10 (—; l.70) |
| ARN-066 (05 l.97) | "Tomorrow's plan ≤ 5 items with reason, lesson id, lane and success measure; reviewed the next night." | AT-22 (≤ 5-item plan) | — |
| ARN-067 (05 l.98) | "Every change reversible from the change ledger." | AT-23 (rollback); gap for rollback rules (§5 item 19) | — |
| ARN-068 (05 l.99) | "≤ 30,000 LLM tokens per night per market; **(s11)** this is the sum across roles R1–R5 for that market's nightly batch. Deterministic tables and summary always produced." | AT-22; gap for role-budget sum (§5 item 27) | nightly_tokens_per_market 30,000 (0–40,000; O; l.75) |
| ARN-069 (05 l.100) | "Nightly outputs written to the KB." | AT-22; AT-24 | — |
| ARN-100 (05 l.131) | "Nightly deterministic compute ≤ 10 min per active market; **weekly light replay ≤ 30 min** (new trades + controls) and **monthly full replay ≤ 90 min** …" | gap for the learning-loop budget (§5 item 27) | replay_light / replay_full (O; l.61) |
| NFR-011 (10 l.39) | "Nightly deterministic compute for all executions, controls and challengers ≤ 10 minutes of Actions time per market; learning loop ≤ 5 further minutes (ARN-100) …" | gap: no measurement or key (§5 item 27) | — |
| ARN-076 (05 l.109) | "**(s9)** Weekly leave-one-input-class-out replay (re-run the family with one evidence class disabled) estimates marginal contribution." | gap: no milestone assigned (§5 item 24) | — |
| ARN-075 (05 l.108) | "LLM-role scorecard." | gap: no definition (§4 carried; §5 item 26) | — |
| AT-22 (14 l.53) | see §2.10 | AT-22 | — |
| DAT-022 (06 l.83) | "**Non-trading days:** a reduced pipeline (announcement sweep, macro, learning summaries, scheduled replays) writes a `non-trading` completion marker by 19:45 …" | gap whether A6 runs on non-trading days (§5 item 3) | — |
| EML-012 s4–s6 (04 l.23–25) | Section 4 "What was learned today (and fed to the agents)"; section 5 "What worked better and why"; section 6 "What needs improving for tomorrow". Each "needs A6 (M6)". | AT-20 full content checked at the M6 exit (M5_design #18); AT-20 | — |

### 2.2 Lesson grades and the learning statistics

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-063 (05 l.94) | "**Lesson grades (single definition):** **L0** Observation; **L1** Hypothesis — ≥ 30 relevant trades and a 90% interval excluding zero on the **first two-thirds of (development − one purge)** … **L2** Tested — holds on the **last third of (development − one purge)** … under **cumulative** false-discovery control over all L2 tests ever run on that window (Foster–Stine α-investing: initial wealth W₀ = 0.10; test j uses level α_j = W/(2 + W) … a rejection earns 0.05; wealth is **carried forward** across rolls, never reset …); **L3** Adopted — an L2 lesson applied via Lane A, or one that motivated a challenger which then passed VAL-110." | AT-22 (graded lessons); gap for L1 interval method (§5 item 13) | lesson_L1_min_n 30 (—; l.69); l2_alpha_investing W₀ 0.10, payout 0.05 (—; l.49); lesson_split (—; l.43) |
| ARN-063 (cont.) | "Lessons **never** access the validation or holdout splits and so do not consume the trial budget (ARN-085)." "Lane-A 'unproven notes' from L0/L1 keep their grade and never become L3." | AT-22; AT-23 | — |
| KB-020 (08 l.30) | "Evidence grades are defined **only** in ARN-063 … No lesson is described more strongly than its grade anywhere; any other grading text is void." | AT-22 | — |
| 06 lesson state (06 l.117) | "lesson: L0 → L1 → L2 (automatic by ARN-063 criteria, development data only) → L3 (on adoption); any → retired" | AT-22; gap for retired transition rule | — |
| NFR-023 (10 l.46) | "Append-only tables: fills, cash ledger, change ledger, audit events, decision cards, lessons. Corrections are new rows referencing the corrected row." | AT-22; gap for an append-only lesson test | — |
| REV-003 (13 l.10) | "Any performance figure … that appears in any document **without a stored measurement behind it is void**. The system MUST display such fields as \"not yet measured\" …" | AT-22; AT-27 (M7 display) | — |

### 2.3 Lane A (daily, low-risk knowledge changes)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-064 (05 l.95) | "**Lane A** (daily, automatic when no deterministic Critic check fails) may change only LLM prompt text and Owner-facing notes, plus alert-routing materiality adjustments never read by the Strategy Lab, filters or thesis-breakers. Anything that can change a trade is Lane B." | AT-22; AT-23 | — |
| KB-030 (08 l.33) | "Lane A MAY change only what ARN-064 allows … Watch-lists are computed deterministically (AGT-014). Anything that can change a trade is Lane B." | AT-22 (no rule changed by Lane A) | — |
| KB-031 (08 l.34) | "L0/L1 lessons may appear in agent playbooks only under a heading \"Unproven notes\"; L2+ may be stated as guidance. Lane-A application is automatic when no deterministic Critic check fails (AGT-042)." | AT-22; gap for minimum grade (§5 item 12) | — |
| KB-032 (08 l.35) | "**Playbook hygiene (stored-injection defence).** Agent-playbook text is assembled from structured lesson fields (statement template, metric, n, grade), not free LLM prose; any LLM-worded sentence must pass the **injection classifier** — deterministic checks … plus a model check whose detection rate on the LLM-040 adversarial set is ≥ 98% … Third-party text … is never copied into a playbook. Every Lane-A change writes a change-ledger row (before → after, lesson id, effective date = next session) and appears in Evening Review section 4. … it MUST be a $0 endpoint (LLM-003)." | AT-22; gap for thresholds and classifier default (§5 items 7–9) | llm_classifier_model (selected by LLM-040 bake-off; provider list [VERIFY]; O; l.170) |
| KB-002 playbook row (08 l.15) | `knowledge/{market}/agent-playbooks/{agent}.md`: "≤ 1,500-token distilled guidance injected into that agent's LLM prompt (ARN-064)"; written by A6 (Lane A) | AT-22; gap for token cap (§5 item 28) | — |
| KB-061 (08 l.49) | "KB text is data, not instructions: any instruction-like text inside a KB document or third-party content is ignored and logged (LLM-035)." | gap: injection event test | llm_injection_phrases (versioned list; O; l.182) |
| LLM-035 (03 l.41) | "**Prompt-injection defence:** … LLMs MUST have no side-effecting tools; nothing an LLM outputs may directly trigger a trade, secret access, email to arbitrary addresses, or config change …" | AT-22; gap for KB-path tests | llm_injection_phrases (O; l.182) |
| AT-22 Lane A clause (14 l.53) | "Lane A changes logged; no rule changed by Lane A" | AT-22 | — |

### 2.4 Lane B: challengers, validation and promotion

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-065 (05 l.96) | "**Lane B**: challengers are generated only from development data (counted as trials, ARN-085), replay-tested, run an **operational shakedown** of ≥ 10 sessions (not evidence), and are promoted only if **VAL-110** passes; promotion applies to the family's rule version for **both twins** at their next common cohort boundary; **(s11)** the ending cohort keeps its original version … ≤ 3 promotions per week per market; parameters within Ch. 15 bounds." | AT-23 | max_promotions_per_week 3 (0–3; O; l.67); shakedown_sessions 10 (5–20; O; l.68) |
| KB-040 (08 l.38) | "**Challenger lifecycle:** `proposed` (hypothesis document, generated only from the development split; counted as a trial when generated, ARN-085) → `replay` … → `shakedown` … → `review` (deterministic Critic checks, AGT-041/042) → `approved` → `promoted` at the next cohort boundary of the target execution → or `rejected` / `retired`. Validation/holdout results are never shown to the agents that propose challengers. **(s13)** Failing any VAL-110 component sets the challenger to `rejected` …" | AT-23 | — |
| KB-041 (08 l.39) | "**Promotion test** = **VAL-110** (Ch. 05 ARN-087) — the single definition. Any other rule … is void." | AT-23 | — |
| KB-042 (08 l.40) | "≤ 8 concurrent challengers per market (ARN-005); ≤ 3 promotions per week per market (ARN-065); parameters stay within bounds." | AT-23 | max_challengers 8 (1–8; O; l.66) |
| KB-043 (08 l.41) | "Any promotion can be reverted from the change ledger; the reverted version becomes a new version (history is never rewritten)." | AT-23; gap for rollback rules (§5 item 19) | — |
| ARN-005 (05 l.29) | "≤ 8 unfunded challengers concurrently per market (KB-042)." | AT-23 | max_challengers (O; l.66) |
| ARN-082 (05 l.116) | "**Rolling holdout (lineage-level event):** a roll happens when a challenger of the lineage is **promoted** … The holdout is used **once** per rule version." | AT-23; gap for roll-time challenger tests | split_holdout / split_validation (—; l.40); purge_sessions (—; l.42); active_lineages_L (—; l.41) |
| ARN-080 / ARN-081 (05 l.114–115) | Replays start every 5 sessions; trade-level evidence uses the signal ledger; "the **only** bootstrap procedure for trade-level tests (VAL-110 (i) and (ii), ARN-084, ARN-062, AT-17)". | AT-23 (replay stage) | bootstrap_block (—; l.60); bootstrap_replications (—; l.57); min_blocks 15 (—; l.58); min_trades 100 (—; l.59) |
| ARN-083 (05 l.117) | "Cost robustness: must pass under P3 + 50% slippage." | AT-23 | — |
| ARN-084 (05 l.118) | "**Leverage.** Primary test: H0 = sleeve per-trade net expectancy ≤ 0 …; each test recorded in the trial ledger (ARN-085)." | AT-23 | — |
| ARN-085 (05 l.119) | "**Trial ledger and budget:** one **market-level trial ledger** counts every generated challenger, every validation/holdout access, every candle-pattern test … and every new lineage … Lessons do not consume it (ARN-063)." | AT-23 | trial_budget_per_lineage 20 (—/O; l.44) |
| ARN-086 (05 l.120) | "**Labels** per (execution, rule version, variant): UNVALIDATED → **PASSED-BACKTEST** (VAL-110 on validation + one holdout confirmation of (i) at one-sided α = 0.05 ÷ L …) → **CONSISTENT-FORWARD** … Negative outcomes … **FAILED** if U < `useful_edge_min` … otherwise **NOT-DEMONSTRATED** …" | AT-23 (label path); gap for forward looks in M6 | useful_edge_min +0.5% (O; l.46); holdout_confirm_alpha 0.05 ÷ L (—; l.48); forward_alpha_spending (0.10 ÷ L)/2^k at look k (—; l.52) |
| ARN-087 = VAL-110 (05 l.121) | "On the validation split, a family (or a challenger vs its incumbent) passes iff: (i) per-trade net excess over matched C2 controls > 0 … **and** the absolute gate …; (ii) challengers only: the per-row excess … (iii) **safety check** … it **blocks** promotion only when effective N ≥ 8 and the point estimate > +5 percentage points …; (iv) absolute per-trade net expectancy (point estimate) > 0 under P3 + 50% slippage; (iv-b) not labelled cost-infeasible (ARN-094); (v) PBO … ≤ 0.2 when ≥ 5 variants …, else \"n/a\"; (vi) Deflated Sharpe Ratio … ≥ 0.95." | AT-23 (a failing VAL-110 component blocks promotion) | alpha 0.05 (—; l.62); delta_bust_tolerance 0.05 (O; l.63); safety_check_min_neff 8 (—; l.55); pbo_max 0.2 (—; l.64); pbo_min_variants 5 (—; l.50); dsr_min 0.95 (—; l.65); dsr_default_sr_variance (—; l.47) |
| ARN-094 (05 l.128) | "**Cost-infeasible at this seed** label when the development-split gross mean per-trade return … < 2× the round-trip cost of a A$600 trade; it blocks PASSED-BACKTEST (VAL-110 iv-b)." | AT-23 | cost_feasibility_ratio 2 (—; l.74) |
| VAL-102 (13 l.99) | "**Multiple-testing control and evidence timeline.** ARN-081 MUST additionally report the **Deflated Sharpe Ratio** and the **Probability of Backtest Overfitting** across all variants tried (trial count from ARN-085). The app MUST show, per execution, an evidence timeline …" | AT-23; gap for the timeline (UI M7) | pbo_min_variants (l.50); dsr_default_sr_variance (l.47) |
| VAL-103 / VAL-104 (13 l.100–101; 10 l.131–132) | "\"Accuracy\" is not a gate" and "No CAGR gates" — promotion follows ARN-065/081/092 only. | AT-23 (negative) | — |
| ARN-092 (05 l.126) | "Retire a version that is FAILED at one of the ARN-086 forward looks (same α spending), or is dominated." | AT-23; gap (§5 item 17) | — |
| FAM-002 / reentry (07 l.60; 15 l.110) | "A code exited by a stop cannot be re-entered by the same execution for 10 sessions." | regression for challengers | reentry_block 10 sessions (5–20; B; l.110) |
| §15.3 family keys (15 l.92–109) | "Families and executions … all **B** (Lane-B tunable within bounds)." F1–F6 parameters each have default and bounds. | AT-23; challenger bounds check | F1–F6 keys (B; l.92–109) |
| insider score weights / event polarity (15 l.116–117) | "insider score weights (0.5/0.25/0.25, 30-session window, 2 pp)" (B); "event polarity threshold 2%" (B). | AT-23 | B keys (l.116–117) |

### 2.5 Critic (A7) and the six deterministic checks

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| A7 roster (07 l.22) | A7 **Critic**, "19:10", "Deterministic checks + worded concerns (AGT-041)", LLM role "R3 from a different provider/model (LLM-010)". | AT-23 (review step) | — |
| AGT-041 (07 l.72) | "**Critic checks.** For every lesson ≥ L1 and every challenger, A7 runs six checks … (1) sample size …; (2) regime dependence …; the check **fails** if the point estimate is negative in at least half of those regimes …; (3) stress costs (VAL-110 (iv) for challengers; for lessons the same absolute-expectancy check on the development split); (4) data issues (quality flags, first-seen differences, survivorship coverage, TST-109 audit for the inputs); (5) luck (VAL-110 (i) for challengers; for lessons the ARN-063 L2 test on the later development third); (6) parameter bounds … **Checks 1–6 are deterministic**; the LLM only words concerns and alternative explanations." | AT-23 (review); gap for lesson-side thresholds (§5 items 15–16) | critic_llm_calls_per_night 10 (O; l.124) |
| AGT-042 (07 l.73) | "A failed deterministic check blocks Lane-A application of that lesson and Lane-B promotion of that challenger. The Owner may instead **force-apply** the change (KB-050, audit-logged): this is not a promotion — the rule version's label resets to UNVALIDATED and it is shown as \"forced by Owner\". LLM-worded concerns never block; they are shown to the Owner." | AT-23 (check 5 blocks promotion); gap for lesson force-apply (§5 item 22) | — |
| AGT-043 (07 l.74) | "A8 writes the review from stored data only (EML-014)." | AT-20 (M5); AT-22 | — |
| AGT-120 roster (13 l.80) | "The agent roster is: Sentinel, Company & Sector Research, Macro & Signal Research (incl. regime), Candle & Pattern, Strategy Lab, Daily Review & Learning, Critic, Scribe — each deterministic except where chapter 03 assigns an LLM role." | AT-22; AT-23 | — |
| LLM-010 (03 l.19) | "The **author and critic of a decision MUST come from different providers/model families** where possible (reduces correlated errors)." | gap for R3 provider rule (§5 item 4) | — |
| LLM-021 (03 l.32) | "A7 Critic wording calls are capped at 10 per night per market, highest-grade items first; the rest are marked \"critic wording deferred\" (deterministic checks still run, AGT-041). If only one provider is available, LLM-010 degrades to \"different model\", logged." | AT-23; AT-22 | critic_llm_calls_per_night 10 (O; l.124) |
| 13 timeline (13 l.69) | "19:10: LLM narrative + critic (budgeted)"; ARN-063, LLM-032 | AT-22 (19:45 marker) | — |

### 2.6 LLM roles, bake-off and budgets used by M6

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| R3 role (03 l.15) | "**R3 Strategist/Critic**: write theses, review strategies/trades, red-team, produce lessons (weekly/monthly + per-trade review); low volume, high quality; Gemini 2.5 Pro (free tier, very small daily quota) if available; otherwise the best reasoning-capable free model from the bake-off …" | AT-22; AT-23; gap (§5 item 7) | llm_budget_r3_daily 25,000 (12,500–37,500; O; l.185) |
| LLM-011 (03 l.20) | "Every role MUST have an ordered **fallback chain** of ≥ 2 providers plus rules-only." | AT-22; AT-23 | — |
| LLM-012 (03 l.21) | "Model IDs MUST come from configuration and provider discovery … and MUST alert when a model is retired/renamed." | gap (test) | — |
| R3 budget (03 l.56) | "R3 strategist/critic: ≤ 25,000 tokens/day (weekly deep review may borrow a bigger slice)" | AT-22; gap for weekly borrowing rule | llm_budget_r3_daily (O; l.185) |
| R5 budget (03 l.57) | "R5 writer: ≤ 10,000 tokens/day" (A8 narrative, M5) | AT-20 (M5) | llm_budget_r5_daily 10,000 (5,000–15,000; O; l.186) |
| Total budget (03 l.53) | "Total LLM tokens per day (all providers, all active markets): ≤ 150,000" | AT-22 | llm_daily_budget_total 150,000 (75,000–225,000; O; l.187); llm_market_share (AU 1.0; O; l.188) |
| LLM-020 (03 l.33) | "Provider limits MUST be stored in configuration with a \"last verified\" date; the router MUST enforce per-provider request/token counters …" | AT-22 (budget exhaustion path) | — |
| LLM-031 (03 l.37) | "**Caching:** identical (role, prompt-hash) requests MUST be served from cache … Cache is stored in a Turso table with key = (role, model, prompt-hash, knowledge-base version), TTL `llm_cache_ttl_hours` … and is invalidated whenever the knowledge-base version changes." | AT-22; gap: M4 cache key has no KB version (§5 item 10) | llm_cache_ttl_hours 24 (1–168; O; l.169) |
| LLM-034 (03 l.40) | "**Numeric grounding:** any number, date or ticker in an LLM answer MUST be traceable to the provided context; otherwise the answer is rejected/flagged." | AT-16; AT-22 | — |
| LLM-036 (03 l.42) | "**Privacy:** … Never send secrets, any user's email address, user annotations or other user-entered text … providers that may train on prompts … receive **only our extracted facts** …" | AT-22; KB-051 | trains_on_prompts (per provider [V]; O; l.168) |
| LLM-037 (03 l.43) | "**Compact context:** prompts MUST use compact, pre-summarised structured context packs (not raw PDFs, not entire histories) …" | AT-22; KB-060 | — |
| KB-060 (08 l.48) | "LLM prompts receive compact context packs built from the KB (LLM-037): the agent playbook, relevant lessons with grades, and the Decision Card — never whole histories." | AT-22 | — |
| LLM-040 (03 l.46) | "**Model bake-off.** Before assigning a model to a role, and again monthly and whenever a provider/model changes, the system … MUST run a **bake-off** on a stored **golden test set** (≥ 50 items) covering: announcement triage …, summary faithfulness, JSON validity, refusal to answer from memory, and adversarial prompt-injection documents …" **(s13)** "The build agent MUST create the first version (≥ 50 items, ≥ 10 per category) from recorded public ASX announcements before M1 exit; the Owner MAY spot-check ≥ 10 items." | gap for M6 role assignment (§5 items 6–7) | — |
| LLM-041 (03 l.47) | "Initial pass thresholds [PROPOSED]: JSON validity ≥ 98%; invented numbers = 0; injection resistance = 100% on the test set; triage agreement with reference ≥ 85%. Models below threshold MUST NOT be assigned to that role." | gap for R3 and classifier (§5 item 8) | — |
| LLM-042 (03 l.48) | "Bake-off results MUST be stored as a markdown report and shown on the LLM page; role assignments are updated by configuration." | gap (report not found in repo) | — |
| TST-111 (10 l.147) | "**LLM bake-off** per LLM-040…042 before role assignment and monthly." | staging (TST-115) | — |
| LLM-050 (03 l.59) | "When a role's daily budget is exhausted, the router MUST fall to the next provider, then to rules-only; it MUST record \"LLM budget exhausted\" and mention it in the daily email. **(s13)** When the daily LLM budget runs short, features are dropped in this order: company overviews first, then news summaries, then Decision Card explanations; Evening Review text is dropped last." | AT-22 | llm_budget_r2 / r1 keys (l.183–184) |
| LLM-051 (03 l.60) | "The LLM Usage page MUST show tokens/requests per provider, role and day, cache hit rate, fallback rate and failures." | M7/M8 page; no milestone assigned for the back-end | — |

### 2.7 KB documents, storage, archive and retention

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| KB-001 (08 l.9) | "**Two synchronised forms.** (a) Structured records in the database (playbook_version, lesson, challenger, change_ledger, decision_card, document); (b) markdown documents generated from them and archived nightly to the **separate private data repository** under `knowledge/` (PLT-022a) — never to the code repository, so archives never trigger deployments. The database is authoritative; markdown is regenerated, never hand-edited by agents." | AT-24 | — |
| KB-002 (08 l.12–20) | Layout: `families/F1…F6.md` (A5/A6 on change); `agent-playbooks/{agent}.md` (A6, Lane A); `lessons/L-{id}.md` (A6/A7); `challengers/C-{id}.md` (A6/A7); `reviews/YYYY-MM-DD.md` (A8, "The Evening Review content for that date (EML-015)"); `hypotheses/` (A6, Owner); `knowledge/common/` (pipeline / ops). | AT-24; AT-20 (KB clause) | — |
| KB-003 (08 l.22) | "Every document carries front matter: id, market, type, created, updated, version, evidence grade (if any), related ids." | AT-24 | — |
| PLT-022a (02 l.35) | "Backups and `knowledge/` archives MUST go to a **separate private data repository** (`<repo>-data`), never to the code repository, so they never trigger deployments …" | AT-24; AT-05a | — |
| EML-015 (04 l.32) | "Every review MUST be stored in the app (Digest history) as markdown/HTML and also as a dated markdown document in the knowledge base (Chapter 08), forming the running learning journal." | AT-20 ("stored in-app and in KB"); AT-24 | — |
| KB-010 (08 l.25) | "**Declarative rules.** A family rule version is a declarative specification … **unknown fields or operators are rejected at load**." | AT-23 (challenger generation); gap for the enumeration (§5 item 32) | — |
| KB-011 (08 l.26) | "**Immutability.** A version is never edited after creation; changes create a new version with a parent pointer." | AT-23; AT-24 | — |
| KB-012 (08 l.27) | "**v1 seed.** On first deployment, version 1 of F1–F6 per market is created from Ch. 07 §7.4 with grade L0 and label UNVALIDATED; its metric fields are empty until measured." | gap: not evidenced (§5 item 32) | — |
| DAT-142 (06 l.104) | "**Retention:** market data in Turso 500 sessions; logs 30 days; run records 180 days; news 400 days; **forever**: decision cards, trades/fills/ledgers, lessons, change ledger, documents, universe_snapshot, corporate_action, adjustment_factor, trading_calendar, source_register, audit events …" | AT-24; gap for KB markdown retention | retention (logs 30 d, runs 180 d, news 400 d; O; l.145) |
| DAT-143 (06 l.105) | "Nightly backup (PLT-022b) includes every forever table of the main DB, plus the auth DB …; price history files plus the backup reproduce every cohort (ARN-102, verified by TST-108)." | AT-04 (M1); TST-108 | backup retention 14/8/12 (O; l.146) |
| DAT-150 (06 l.108) | Entities include "rule_version", "signal", "decision_card", "blocked_trade", "watch_list", "lesson", "critique", "challenger", "trial_counter", "change_ledger", "calibration_report", "bakeoff_result", "llm_call", "llm_cache", "document", "annotation" (indicative list). State machines: "lesson | L0 → L1 → L2 … → L3 (on adoption) ; any → retired" (l.117); "challenger | proposed → replay → shakedown → review → approved → promoted \| rejected \| retired (KB-040)" (l.118). | AT-24; gap for playbook_version (§5 item 33) | — |
| PLT-022b (02 l.36) | "Backups MUST be encrypted … Encrypted backups are stored as release assets of the data repo (not commits), retained 14 daily / 8 weekly / 12 monthly." | AT-04; gap for KB markdown storage mode (§5 item 30) | backup retention (O; l.146) |
| PLT-022 (02 l.37) | "The system MUST run a **nightly export/backup** of critical tables and all documents to the private data repository (PLT-022a) so the database can be rebuilt …" | AT-24; AT-04 | — |
| KB-070 (08 l.52) | "The Knowledge page (Ch. 09 §9.9) lists and full-text searches all KB documents by market, type, date, family, grade and code …" | M7 (AT-25) | — |
| ARN-102 (05 l.133) | "Cohorts store rule version, parameters, profiles, sleeve settings, data snapshot id, random seed; re-runs reproduce identical results." | AT-24; AT-13 (M3) | — |

### 2.8 Human edits, annotations and roles

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| KB-050 (08 l.44) | "Only the **Owner** may create or edit a family rule or parameter from the UI (ROL-102). An Owner edit creates a new version flagged `owner-authored`; by default it enters Lane B as a challenger. The Owner MAY force-apply it at the next cohort boundary …" | AT-23; gap for API vs UI milestone (§5 item 35) | — |
| KB-051 (08 l.45) | "Editors may add annotations to lessons, cards and hypotheses (never altering the record). Viewers are read-only (ROL-102). Annotations and any user-entered free text are **never** included in LLM context (LLM-036)." | AT-02; AT-22 (context builder test) | — |
| ROL-102 (10 l.52) | "Owner only: allowlist and roles, secrets status, configuration, market activation, source switches, corporate-action review, rule edits, challenger approval/force-apply/rollback, kill switches. Editor: annotate, acknowledge alerts, run what-if replays within a daily budget … Editors MUST NOT change rules or configuration." | AT-02; AT-23 | — |
| ROL-102b (10 l.64) | "**Annotations.** Editors and the Owner may annotate lessons, decision cards and hypotheses with plain-text notes (≤ 1,000 characters) … Author or Owner may edit or delete an annotation. Every annotation create/edit/delete is audit-logged." | AT-02; gap for storage milestone (§5 item 34) | — (no key; 1,000 characters) |
| UX-071a (09 l.92) | "**Annotations.** Editors and Owner can add plain-text annotations (≤ 1,000 chars) to lessons, Decision Cards and hypotheses …" | M7 page; back-end per §5 item 34 | — |
| UX-071 (09 l.91) | "Owner-only actions: create/edit a family version (→ challenger by default, KB-050), approve/reject a challenger, force-apply with confirmation, rollback. Editors can annotate. Every action is audit-logged." | M7 page; back-end M6 (§5 item 35) | — |

### 2.9 Tests and environments (M6 rows)

| ID (file l.N) | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| TST-115 (10 l.150) | "**Where tests run** — … **Staging (recorded data):** TST-100…107, 109, 110, 112; AT-02, AT-03 …, AT-22…AT-29, TST-108 build-phase drills, TST-111 bake-off, AT-M2, AT-M3, AT-M5." | AT-22…AT-24 on staging | — |
| TST-109 (10 l.145) | "**No-look-ahead test:** perturb all data after date D; decisions for D and earlier MUST be unchanged." | AT-22; applicability to A6 lessons is [CHECK] (§5 item 38) | — |
| TST-123 (10 l.158) | "**Jobs.** Every scheduled or dispatched job (nightly batches, backfill, backups, reminder email, quota meter, watchdogs) MUST have tests for: normal run on the golden dataset; **idempotent re-run** after a crash at each stage; missing predecessor marker …; provider off / quota exhausted …; DST/holiday dates." | gap: M6 jobs (batch 3 A6 step, Critic step, KB archive, bake-off job) need the matrix | — |
| TST-121 (10 l.156) | "… Overall coverage floors (`coverage_overall_min` 80% lines; **90% on money maths, validation statistics**, rule interpreter, auth/roles, Worker scheduling) …" | M6 statistics code (ARN-063, ARN-087, Critic checks) | coverage_overall_min 80% / 90% critical (O; l.194) |
| TST-120 (10 l.155) | "CI MUST fail when **changed lines** have < 90% line coverage and < 80% branch coverage (`diff_coverage_min`, `diff_branch_min`) …" | every M6 PR | diff_coverage_min 90% (O; l.192); diff_branch_min 80% (O; l.193) |
| TST-130 (10 l.165) | "**Mutation testing** on money maths and validation statistics: weekly mutation run; surviving-mutant score ≥ 80% (`mutation_score_min`) …" | M6 α-investing, DSR/PBO, Critic checks | mutation_score_min 80% (60–95; O; l.195) |
| TST-122 (10 l.157) | "**Services / API.** Every API route and server action MUST have tests for: success, validation errors, auth required, **each role (Owner/Editor/Viewer/none) allowed vs refused** …" | AT-02 / AT-23 (Owner-only challenger actions) | — |
| TST-125 (10 l.160) | "**Contracts.** Each boundary has a schema-checked contract test on both sides: … app → Turso schema (migration tests up and down on a copy) …" | M6 migrations (lesson, challenger, change_ledger) | — |
| TST-133 (10 l.168) | "**Test map.** The repo keeps a generated **test map** … every MUST in ch. 01–12 and every accepted ch. 16 P1 item has at least one test or is listed as Owner-executed in ch. 14." | AT-31 completeness | — |
| TST-108 (10 l.144) | "**Restore test:** … during the build (M1–M7) … the drill job generates a fresh throwaway key pair …" | AT-04 (M1); M6 tables must be inside the drill | — |
| TST-112 (10 l.151) | "**Gates.** … **Infrastructure release gate (M1–M7):** PR gate + the CI smoke test + ZAP baseline + the exit tests of completed milestones …" | AT-22…AT-24 in the gate | — |
| TST-112a (10 l.148) | "**Workflow re-enable test.** … batch workflows (PLT-015)" | gap: Worker dispatch of A6 batch | — |

### 2.10 Acceptance tests AT-22…AT-24 (verbatim, `14_system_acceptance.md` l.53–55)

| AT | Verbatim test (trimmed where marked) | Proves | Mapped rows |
|---|---|---|---|
| AT-22 (l.53) | "**Nightly loop** — Attribution, comparisons, graded lessons and ≤ 5-item plan written before 19:45; Lane A changes logged; no rule changed by Lane A" | ARN-060…069, KB-030/031 | §2.1–§2.3 |
| AT-23 (l.54) | "**Challenger lifecycle** — A seeded challenger goes proposed → replay → shakedown → review; a failing VAL-110 component or deterministic Critic check blocks promotion; a passing one promotes only at a cohort boundary" | KB-040…043, AGT-041/042 | §2.4, §2.5 |
| AT-24 (l.55) | "**KB archive** — Every record of the day has a regenerated markdown document in the **private data repo** (never the code repo; no deployment triggered)" | KB-001…003, PLT-022a | §2.7 |

Chapter 14 acceptance criteria for these tests: "**Given** a go-live request, **when** any AT-01…AT-31 is failing, **then** production go-live does not proceed." (14 l.83). AT-22 to AT-24 sit in the staging set of TST-115, so they are not pinned to production by the spec.

### 2.11 Configuration keys referenced by M6

| Key (ch.15 l.N) | Default | Bounds | Edit | Ref |
|---|---|---|---|---|
| lesson_split (l.43) | (development − purge); L1 first 2/3, L2 last 1/3, n ≥ 30; re-frozen at each roll | — | — | ARN-063 |
| lesson_L1_min_n (l.69) | 30 | ≥ 30 | — | ARN-063 |
| l2_alpha_investing (l.49) | W₀ = 0.10; payout 0.05; pool per lineage (+ one market pool); mFDR ≤ 0.10 | — | — | ARN-063 |
| comparison_findings / comparisons_fdr_q (l.51, l.70) | weekly; BH q 0.10; one look at α 0.05 after ≥ 30 rows and ≥ max(75, 15 × block) sessions; 60-session lockout | — | — | ARN-062 |
| max_challengers (l.66) | 8 | 1–8 | O | ARN-005, KB-042 |
| max_promotions_per_week (l.67) | 3 | 0–3 | O | ARN-065, KB-042 |
| shakedown_sessions (l.68) | 10 | 5–20 | O | ARN-065 |
| trial_budget_per_lineage (l.44) | 20 per frozen validation split (cumulative) | — | O | ARN-085 |
| active_lineages_L (l.41) | max(6, active lineages) | — | — | ARN-081 |
| split_holdout / split_validation (l.40) | max(378, 15 × block) / max(504, 15 × block) entry sessions | — | — | ARN-082 |
| purge_sessions (l.42) | upper bound of the max-hold key + 20 | — | — | ARN-082 |
| survivorship_flag_share (l.45) | 5% | — | O | ARN-082 |
| useful_edge_min (l.46) | +0.5% per-trade net excess | — | O | ARN-086 |
| dsr_default_sr_variance (l.47) | computed at M4, frozen per split | — | — | VAL-110 (vi); **not present in build** (M5 exit l.77) |
| holdout_confirm_alpha (l.48) | 0.05 ÷ L one-sided | — | — | ARN-086 |
| pbo_min_variants (l.50) | 5 | — | — | VAL-110 (v) |
| forward_alpha_spending (l.52) | (0.10 ÷ L) / 2^k at look k (every 100 trades) | — | — | ARN-086 |
| safety_check_min_neff (l.55) | 8 | — | — | VAL-110 (iii) |
| c2_controls_per_row (l.56) | 20 | ≥ 10 | — | ARN-004, ARN-081 |
| bootstrap_replications (l.57) | max(1,000, 20 ÷ level used) ≈ 48,000 at α_i ÷ L (L = 6) | — | — | ARN-081 |
| min_blocks (l.58) / min_trades (l.59) | 15 blocks / 100 trades | — | — | ARN-081/082/086 |
| bootstrap_block (l.60) | max(5, p75 realised hold), measured once, frozen per lineage | — | — | ARN-081 |
| alpha (l.62) / delta_bust_tolerance (l.63) | 0.05 / 0.05 abs | — / — | — / O | VAL-110 |
| pbo_max (l.64) / dsr_min (l.65) | 0.2 / 0.95 | — | — | VAL-110 |
| reentry_block (l.110) | 10 sessions | 5–20 | B | FAM-002, ARN-080 |
| F1–F6 family keys (l.92–109) | per family | per family | B | Ch. 07 §7.4 |
| insider score weights (l.116) / event polarity threshold (l.117) | 0.5/0.25/0.25, 30 sessions, 2 pp / 2% | as AGT-105 / — | B | AGT-105, AGT-020 |
| regime thresholds (l.115) | as AGT-101 | — | O | AGT-101 (shared by all families) |
| critic_llm_calls_per_night (l.124) | 10 | — | O | LLM-021 |
| nightly_tokens_per_market (l.75) | 30,000 | 0–40,000 | O | ARN-068 |
| llm_budget_r3_daily (l.185) | 25,000 tokens | 12,500–37,500 | O | LLM-050 |
| llm_budget_r5_daily (l.186) | 10,000 tokens | 5,000–15,000 | O | LLM-050 |
| llm_daily_budget_total (l.187) | 150,000 tokens | 75,000–225,000 | O | LLM-050 |
| llm_cache_ttl_hours (l.169) | 24 hours | 1–168 | O | LLM-031 |
| llm_classifier_model (l.170) | selected by the LLM-040 bake-off (injection role) | provider list [VERIFY] | O | KB-032 |
| llm_injection_phrases (l.182) | versioned phrase list | list | O | LLM-035; **not present in build** (M5 exit l.77) |
| trains_on_prompts (l.168) | per provider terms [V] | — | O | LLM-036 |
| retention (l.145) | logs 30 d, runs 180 d, news 400 d; forever for lessons and change ledger (DAT-142) | as DAT-142 | O | DAT-142 |
| backup retention (l.146) | 14 daily / 8 weekly / 12 monthly | as PLT-022b | O | PLT-022b |
| diff_coverage_min (l.192) / diff_branch_min (l.193) | 90% lines / 80% branches | 80–100% / 70–100% | O | TST-120 |
| coverage_overall_min (l.194) | 80% overall; 90% critical modules | 70–95% | O | TST-121 |
| mutation_score_min (l.195) | 80% | 60–95% | O | TST-130 |
| picks keys (l.208–215; conditional) | picks_per_profile 5; picks_max_per_family 2; pick_valid_sessions 2; pick_success_min_n 30; factor_min_bucket_n 30; factor_buckets terciles | as ch.15 §15.8 | O | AGT-112/113, ARN-095 (only if in M6; §5 item 37) |

Not keyed in ch.15 (M6 needs one or the other): the playbook token cap of 1,500 tokens (KB-002); the learning-loop budget of 5 minutes (NFR-011); the injection-classifier pass threshold (KB-032 98% against LLM-041 100%); the regime-count rule of Critic check 2; the absolute-expectancy threshold of Critic check 3 for lessons; the L1 interval method; the weekly cadence of the comparison test (ARN-062) and of the leave-one-class replay (ARN-076); the annotation length of 1,000 characters (ROL-102b). See §5.

## 3. Values to remember (numbers with sources)

- **Batch and deadlines.** Batch 3 at 18:40 (deterministic); LLM wording and Critic "(≤ 19:10)" back-to-back in workflow 2; A8 assembly 19:10–19:45; completion marker 19:45; email 20:00–20:45 (`02` PLT-073 l.84–101; `13` l.68–72; AGT-051 `07` l.98).
- **Lesson grades** L0–L3 only, one definition (ARN-063 `05` l.94; KB-020 `08` l.30). L1 needs ≥ 30 relevant trades (lesson_L1_min_n 30). L2 n ≥ 30 rows, else "L2 not reachable" with its date.
- **α-investing** (ARN-063): W₀ = 0.10; test j level α_j = W/(2+W), so the first test uses α_1 = 0.10 ÷ 2.10 ≈ 0.0476; cost of a test = W/2; payout 0.05 on rejection (derived from the formula; check at build).
- **Trial budget** m = 20 per lineage and validation split (ARN-085), Bonferroni α_i = 0.05 ÷ 20 = 0.0025, and ÷ L = 6 gives ≈ 0.00042 (ARN-081); bootstrap replications ≈ 48,000 at that level.
- **VAL-110** thresholds: safety check effective N ≥ 8 and +5 pp (ARN-087 iii); PBO ≤ 0.2 when ≥ 5 variants (v); DSR ≥ 0.95 (vi); useful edge +0.5% (ARN-086); holdout confirmation at 0.05 ÷ L (ARN-086).
- **Challengers and promotions**: ≤ 8 concurrent per market; ≤ 3 promotions per week per market; shakedown ≥ 10 sessions (not evidence); holdout used once per rule version (ARN-082).
- **Critic**: six deterministic checks; ≤ 10 Critic wording calls per night per market, highest-grade items first (LLM-021; critic_llm_calls_per_night).
- **Tokens**: R3 ≤ 25,000/day (12,500–37,500); R5 ≤ 10,000/day; total ≤ 150,000/day; ≤ 30,000 per night per market (ARN-068), which is stricter than the role sum (§5 item 27).
- **Bake-off**: golden set ≥ 50 items, ≥ 10 per category (LLM-040 s13); thresholds JSON validity ≥ 98%, invented numbers 0, injection resistance 100%, triage agreement ≥ 85% (LLM-041); classifier detection ≥ 98% (KB-032).
- **Cache**: TTL 24 hours; key includes the KB version (LLM-031).
- **Playbooks**: ≤ 1,500 tokens per agent (KB-002); L0/L1 text under "Unproven notes" (KB-031).
- **Retention**: lessons, change ledger, documents, decision cards, audit events kept forever (DAT-142); run records 180 days, logs 30 days.
- **Owner-only**: family rule edits, challenger approval, force-apply, rollback, kill switches (ROL-102 `10` l.57; KB-050).
- **Email**: Evening Review (M5) is the only email; M6 adds no email. KB archive writes to the private data repository, never the code repository (PLT-022a; AT-24).

## 4. Carried over from earlier milestones

Each row is an item an earlier milestone left for M6 (`docs/M4_requirements.md` §4–5, `docs/M4_design.md`, `docs/M4_exit_evidence.md`, `docs/M5_design.md`, `docs/M5_exit_evidence.md`, `docs/07_decision_log.md`, `docs/test-map.md`).

| Carried item | Source | What M6 must do |
|---|---|---|
| **Batch 3 lessons and attribution deferred** | `docs/M4_design.md` l.16 ("A6 lessons/plan, A8 Scribe and email (M5/M6)"), l.237 (option A: deterministic batch 3 in M4, "A6 attribution/lessons M6 (recommended)"); D-093 (`docs/07_decision_log.md` l.99): batch 3 built with the forward ledger, scorecards and kill switch; `docs/test-map.md` l.172 ("ARN-060..ARN-069 (A6), AGT-040..AGT-043 (A6, A7, A8) … deferred (M6)") | Build A6 attribution (ARN-061), comparisons (ARN-062), lessons (ARN-063), plan (ARN-066) and the Critic (AGT-041…043) on top of the M4 batch 3. Re-check the M4 "live outcome basis" limit (`docs/M4_exit_evidence.md` l.78–80: batch 3 live outcome uses terminal liquidation NAV, "to be reviewed (D-093 follow-up)"). |
| **KB archive of reviews** | `docs/M5_exit_evidence.md` l.73 ("A6 lessons and the KB archive of reviews are M6"); `docs/M5_design.md` l.213 (#19: "the M6 KB importer back-fills it; AT-20's KB clause is checked with AT-24 in M6"); `docs/test-map.md` l.195 | Back-fill `evening_review` rows into `knowledge/{market}/reviews/YYYY-MM-DD.md` (§5 item 31) and run AT-24. |
| **Evening Review sections 4–6 full content** | `docs/M5_design.md` l.212 (#18: "AT-20 passes in M5 with [the EML-014 fallback] and the full content is checked at the M6 exit"); `docs/M5_exit_evidence.md` l.42 ("Not evidenced" list) | At the M6 exit, check the full content of sections 4–6 (lessons, Lane A changes, challenger status, plan) against stored A6 output. |
| **LLM bake-off before live roles (D-084)** | `docs/07_decision_log.md` l.90 (D-084: M4 router core in modes off / rules-only / mock / live; no role assigned); `docs/M4_design.md` l.14 ("live provider adapters, bake-off (LLM-040…042, TST-111) and any role assignment → M5 (R1) / M8"); `docs/test-map.md` l.159 ("deferred (M5/M6)"); `docs/M5_exit_evidence.md` (no bake-off record) | Run the bake-off before R3 (A6 wording, A7 checks) and the injection classifier go live (§5 items 6–9). Store the report (LLM-042). |
| **No KB version source for the cache key** | `docs/07_decision_log.md` l.90 (D-084: "Cache keyed by sha-256 of role, model, template version and inputs" — this is the prompt hash); the code already stores `kb_version` in the `llm_cache` primary key (`db/migrations/main/0008_agents.sql`) and takes it from `RouterConfig.kbVersion` (`src/lib/llm/router.ts`), but no caller supplies a real value yet; LLM-031 (`03` l.37) | Define the KB version (M6 owns the KB) and pass it to every router; a KB change then misses the old cache rows (§5 item 10). |
| **Injection filter uses the built-in list** | `docs/07_decision_log.md` l.90 ("built-in v1 phrase list until a `llm_injection_phrases` key exists"); `docs/M5_exit_evidence.md` l.77 ("proposed config keys still missing (… `llm_injection_phrases`, `dsr_default_sr_variance`)") | Add both keys to the configuration registry before the KB injection test (KB-061). |
| **ARN-075 LLM-role scorecard** | `docs/M5_exit_evidence.md` l.72 ("ARN-075 has no definition in the spec"); `docs/M4_requirements.md` §5 item 33 | Define it or leave "n/a" (§5 item 26). |
| **ARN-049 5× reality display and ARN-048 shadow display** | `docs/M3_design.md` l.155 and l.177 ("display in M4/M6"); `docs/M4_requirements.md` l.307 and l.312 ("[CHECK] milestone not set in `12_build_plan.md`") | Decide whether these displays are M6 (§5 item 39). |
| **Picks back-end AGT-112, AGT-113, ARN-095** | `12_build_plan.md` l.65 ("M5/M6"); `docs/M5_design.md` l.201 (#7: "not in the M5 review; … M6/M7") | Decide whether the picks back-end (factor attribution, picks, pick tracking) is M6 (§5 item 37). |
| **Critic and A6 are not yet in the repo** | `docs/test-map.md` l.172–173 ("deferred (M6)"; "AGT-112, AGT-113, AGT-115, ARN-073, ARN-075, ARN-077 … deferred (M5/M6)") | Test-map rows for M6 to be added as the build passes each exit test. |
| **Staging run for the M4 and M5 acceptance set** | `docs/M5_exit_evidence.md` l.75–76 (AT-14 to AT-17 staging run, pending a release); l.66 (migrations 0007–0009 and auth 0004 not applied anywhere; "the staging run for AT-14 to AT-21 waits for it") | The staging run for AT-22…AT-24 uses the same environment as TST-115 and must wait for the same release (D-022). |
| **Owner prerequisites carried from M5** | `docs/M5_exit_evidence.md` l.53–65 (Resend, Gmail filter, `asx_enabled`, forced watchdog, Worker slots disabled) | Not M6 items, but M6 staging needs the same Worker slots (for batch 3) and the data-repo token for the archive. |

## 5. Gaps, contradictions and open questions (numbered)

1. **Batch 3 milestone.** D-093 (`docs/07_decision_log.md` l.99) built batch 3 in M4 with deterministic review numbers. `spec/12_build_plan.md` l.53 and `spec/07_agents.md` l.21 put A6 in M6. `docs/M4_requirements.md` §4 and §5 item 27 record the same conflict. **[CHECK]** which parts of batch 3 (attribution, comparisons, controls, lesson candidates) remain for M6.
2. **Production switch for A6, A7 and the KB archive.** BLD-024 (`12` l.62) disables A2–A8 in production until go-live. TST-115 (`10` l.150) places AT-22…AT-29 on staging. PLT-022a (`02` l.35) requires the nightly `knowledge/` archive to the private repo, and AT-05a requires that archives trigger no deployment. The spec does not say whether the archive runs in production during data-only mode. **[CHECK]**.
3. **Learning on non-trading days.** DAT-022 (`06` l.83) makes "learning summaries" part of the reduced non-trading pipeline. AGT-051 and AT-22 do not say whether A6 runs on non-trading days, or whether section 4 of a non-trading review comes from A6. **[CHECK]** (see also M5 §5 item 5).
4. **Critic provider rule.** LLM-010 (`03` l.19) requires the critic from a different provider "where possible". No R3 provider is assigned (`03` l.15, "if available"), and LLM-021 degrades to "different model, logged" when one provider exists. The spec does not say which provider is the critic while only one is available. **[CHECK]**.
5. **Critic with the LLM off.** AGT-001 and LLM-002 require full output with no LLM. AGT-042 says "LLM-worded concerns never block; they are shown to the Owner", without saying where (in-app or email). EML-021 (`04` l.37) forbids emails for single-provider fallbacks. **[CHECK]** where concerns are shown.
6. **Golden test set.** LLM-040 (`03` l.46, s13) requires the build agent to create the first set of ≥ 50 items (≥ 10 per category) from recorded public ASX announcements before M1 exit, with an Owner spot-check of ≥ 10 items (O-38 Q-059, `00` l.71). No record of the set appears in `docs/`, and the fixtures repository was not read. **[CHECK]**.
7. **Bake-off gate for R3 and the classifier.** TST-111 (`10` l.147) and LLM-040 (`03` l.46) say "before role assignment". M6 assigns R3 (A6 wording and A7 concerns). The spec does not name the M6 gate. Same question as M5 §5 item 21. **Owner decision** on the gate for M6.
8. **Two injection thresholds.** KB-032 (`08` l.35) requires a model check with "detection rate … ≥ 98%" on the LLM-040 adversarial set. LLM-041 (`03` l.47) requires "injection resistance = 100% on the test set". Both apply to the same classifier. **[CHECK]** which one gates the role.
9. **Classifier default.** `llm_classifier_model` (`15` l.170) is "selected by LLM-040 bake-off", with bounds "provider list [VERIFY at build]". KB-032 requires a $0 endpoint (LLM-003). No default is given, and no candidate is named. **[CHECK]**.
10. **KB version for the cache key.** LLM-031 (`03` l.37) requires the key "(role, model, prompt-hash, knowledge-base version)" and invalidation "whenever the knowledge-base version changes". D-084 (`docs/07_decision_log.md` l.90) describes the prompt hash (role, model, template version and inputs); the build already keys `llm_cache` on `kb_version` (0008) through `RouterConfig.kbVersion`, but nothing defines or supplies a real KB version yet. This is a build change for M6, not a spec conflict. **[CHECK]** the KB-version definition and that it is recorded in the decision log.
11. **Lane-A scope conflict.** FIX-030 (`13` l.31) lists "knowledge text, watch/block lists, Sentinel materiality weights and data-quality flags". KB-030 (`08` l.33) and ARN-064 (`05` l.95) list "agent-playbook text, Owner-facing notes, alert-routing materiality adjustments". Watch-lists are deterministic under AGT-014 (`07` l.31). By REV-001 and BLD-001a the home chapters win, so the `08`/`05` list applies. **[CHECK]** the Owner's confirmation.
12. **Lane-A minimum grade.** KB-031 (`08` l.34) lets L2+ be "stated as guidance" and restricts L0/L1 to "Unproven notes". ARN-064 and AGT-042 make Lane A "automatic when no deterministic Critic check fails". The spec does not say whether an L1 lesson may be applied automatically, or what force-apply does for a lesson. **[CHECK]**.
13. **L1 interval method.** ARN-063 (`05` l.94) requires "a 90% interval excluding zero" for L1. The spec does not name the estimator. ARN-081 (`05` l.115) calls its block bootstrap "the **only** bootstrap procedure for trade-level tests (VAL-110 (i) and (ii), ARN-084, ARN-062, AT-17)"; ARN-063 is not in that list. **[CHECK]**.
14. **α-investing pool with re-frozen thirds.** ARN-063 says wealth is "carried forward across rolls, never reset", and that "lesson thirds re-frozen at each roll" (`15` l.43). When the thirds move, the set of L2 tests on "that window" changes, and the pool per lineage and the market-level pool for cross-family lessons need a rule. **[CHECK]**.
15. **Critic check 2 edge case.** AGT-041 (`07` l.72) fails a lesson when the point estimate is negative "in at least half of those regimes" with ≥ 30 rows. The spec does not say what happens when fewer than two regimes qualify. **[CHECK]**.
16. **Critic checks 3 and 4 for lessons.** For lessons, check 3 is "the same absolute-expectancy check on the development split". The threshold and the cost profile (VAL-110 (iv) uses P3 + 50% slippage for challengers) are not given. Check 4 refers to a "TST-109 audit for the inputs", which is not defined for lessons. **[CHECK]**.
17. **"Any component" versus conditional components.** KB-040 (`08` l.38, s13): "Failing any VAL-110 component sets the challenger to `rejected`." ARN-087 (`05` l.121) (iii) blocks only when effective N ≥ 8 and the point estimate is more than +5 pp, and is otherwise "shown descriptively". (v) PBO is "n/a" below 5 variants. The spec does not say whether "n/a" or a descriptive-only check counts as a failure. **[CHECK]**.
18. **Promotion boundary.** KB-040 (`08` l.38) promotes "at the next cohort boundary of the target execution". ARN-065 (`05` l.96) applies the promotion to "both twins at their next common cohort boundary". Build note: twins and their controls share one restart group (`twin_group`, D-076) that restarts together (ARN-053), so in this build the two boundaries are the same session. **[CHECK]** which applies.
19. **Rollback rules.** KB-043 (`08` l.41) and ARN-067 (`05` l.98) allow reversion from the change ledger, and the reverted version becomes a new version; KB-043 adds "Kill switch ARN-093 freezes a family's changes". The spec does not say whether a rollback counts against the 3-per-week promotion cap, or whether it needs VAL-110. **[CHECK]**.
20. **Who generates challengers.** ARN-065 and KB-040 say challengers are "generated" from development data. AGT-001 and LLM-035 (`03` l.41) forbid an LLM from changing configuration. The spec does not say whether the generator is deterministic or an LLM role (R3 proposes text only). **[CHECK]**.
21. **Seeded challenger for AT-23.** AT-23 (`14` l.54) needs "a seeded challenger". The seed fixture is not named, and TST-115 places AT-23 on recorded data. **[CHECK]** the fixture location and content (fixtures repo, not read).
22. **Force-apply for lessons.** AGT-042 (`07` l.73) and KB-050 (`08` l.44) describe force-apply for "the change" in terms of rule versions and challengers. Lane-A lesson force-apply (after a failed check) is not described. **[CHECK]**.
23. **Weekly comparison test.** ARN-062 (`05` l.93) requires a weekly test run, a BH correction across the week's comparisons, and one confirmation look. The spec does not give the weekday, the storage of the look date, or the lockout record. EML-037 (`04` l.49) depends on the ARN-062 result before sections 4–5 can state differences. **[CHECK]**.
24. **Leave-one-class replay (ARN-076).** ARN-076 (`05` l.109) is weekly and not assigned to a milestone. ARN-100 (`05` l.131) caps the weekly light replay at 30 minutes. **[CHECK]** whether ARN-076 is in M6.
25. **Attribution fields.** ARN-061 (`05` l.92) lists "MFE/MAE" and "filter decisions". MFE and MAE are not defined anywhere in `spec/` (ARN-061 is their only occurrence). **[CHECK]**.
26. **ARN-075 LLM-role scorecard.** Still has no definition (`05` l.108; M4 and M5 carried items). EML-012 s7 (`04` l.26) allows "n/a" for agents without a signal test. **[CHECK]**: keep "n/a" until defined.
27. **Token and compute budgets.** ARN-068 (`05` l.99) allows 30,000 tokens per night per market. The role budgets (`03` l.53–57; `15` l.183–187) add up to more than that per day (R1 60,000 + R2 50,000 + R3 25,000 + R5 10,000). `docs/M4_design.md` used "the stricter token cap applies" (D-078), which implies the 30,000 nightly cap governs. NFR-011 (`10` l.39) sets the learning loop at "≤ 5 further minutes" without a key or a measurement. **[CHECK]**.
28. **Playbook size.** KB-002 (`08` l.15) caps each agent playbook at ≤ 1,500 tokens. No key exists in `15`. **[CHECK]** whether it is a fixed constant (`—`) or a key.
29. **KB archive runner and token.** PLT-022a (`02` l.35) and KB-001 (`08` l.9) say the archive goes to the private data repo nightly. BLD-010 row 4 (`12` l.22) puts the data-repo token in the `production` environment. The spec does not say whether the archive runs as a signed Vercel route or as an Actions job, or which token it uses. The archive must not trigger a deployment (AT-05a). **[CHECK]**.
30. **KB markdown storage mode.** PLT-022b (`02` l.36) says encrypted backups are "release assets … (not commits)". KB-001 (`08` l.9) and AT-24 (`14` l.55) describe markdown documents under `knowledge/`. The spec does not say whether the markdown is committed to the data repository or stored as release assets. **[CHECK]**.
31. **Evening Review KB backfill.** M5 stored each review as an `evening_review` row (`docs/M5_design.md` l.213, #19). EML-015 (`04` l.32) requires a dated markdown document in the KB, and KB-002 names `knowledge/{market}/reviews/YYYY-MM-DD.md`. The spec does not say which dates the backfill covers. **[CHECK]**.
32. **Rule schema and v1 seed.** The (s13) sentence of KB-010 (`08` l.25) requires the field enumeration to be published in the rule-schema reference "at M3", and KB-012 (`08` l.27) requires version 1 of F1–F6 per market at first deployment. Neither is evidenced in the M3–M5 documents read for this extract. **[CHECK]**.
33. **Table list.** KB-001 (`08` l.9) names a `playbook_version` table. DAT-150 (`06` l.108, "indicative") names "rule_version", "lesson", "critique", "challenger", "trial_counter", "change_ledger", "bakeoff_result", "document" and "annotation" but not `playbook_version`. **[CHECK]** the table names.
34. **Annotations storage.** ROL-102b (`10` l.64), KB-051 (`08` l.45) and UX-071a (`09` l.92) require annotations on lessons, cards and hypotheses (≤ 1,000 characters, audit-logged); DAT-150 (`06` l.108) lists an `annotation` entity. The spec does not assign the storage or API to M6 or M7. **[CHECK]**.
35. **Owner-authored edits and rollback API.** KB-050 (`08` l.44) and UX-071 (`09` l.91) place the edit, approve, force-apply and rollback actions in the UI. The UI is M7 (`12` l.54). The back-end API that the UI needs is not assigned. **[CHECK]** whether it is M6 (the back-end parts of ch. 16 P1 items join M5/M6, `12` l.65).
36. **Plan storage.** ARN-066 (`05` l.97) requires the plan (≤ 5 items with reason, lesson id, lane and success measure) to be "reviewed the next night". The spec does not say where the plan is stored or how the review is recorded. EML-012 s6 (`04` l.25) uses it. **[CHECK]**.
37. **Picks back-end.** `12` l.65 puts AGT-112, AGT-113 and ARN-095 in "M5/M6". M5 excluded them (`docs/M5_design.md` l.201, #7). The accepted P1 items UXN-121 (`16` l.160), UXN-041 (`16` l.251) and UXN-043 depend on them. **[CHECK]** whether M6 or M7 builds them.
38. **No-look-ahead for lessons.** TST-109 (`10` l.145) covers "decisions for D and earlier". Lessons and attribution are not decisions. The spec does not say whether A6 must also pass TST-109. **[CHECK]**.
39. **5× display and shadow sleeve display.** ARN-049 (`05` l.81) (5× reality display) and ARN-048 (`05` l.80) (shadow sleeve display) are "M4/M6" in `docs/M3_design.md` l.155–177 and `docs/M4_requirements.md` l.307, l.312, and no milestone is set in `12`. **[CHECK]**.
40. **Owner prerequisites for M6.** (a) Spot-check at least 10 golden items (LLM-040, O-38 Q-059). (b) Choose the R3 provider and the classifier model after the bake-off (LLM-040; `llm_classifier_model`). (c) Confirm the Lane-A list (item 11) and the promotion-boundary rule (item 18). (d) Add the keys `llm_injection_phrases` and `dsr_default_sr_variance` to the registry (`docs/M5_exit_evidence.md` l.77). (e) Confirm that the data-repository token (SEC-017 f, BLD-010 row 4) may be used by the KB archive, and that the archive path is outside the code repository (PLT-022a). (f) Confirm the free LLM keys and their `trains_on_prompts` values, dated (LLM-040; BLD-010 row 12). **Owner prerequisites.**

## 6. Out of scope for M6 (later milestones)

| Item | Milestone | Source |
|---|---|---|
| Knowledge page, family and lesson browsing, search and grade filter (UX-070, UX-071b, KB-070, UXN-200, UXN-215) | M7 | `12` l.54; `09` l.90–93; `16` l.95, l.100 |
| Champion-vs-challenger comparison table, multi-challenger selector, version-diff panel (UXN-201, UXN-208, UXN-204) | M7 (UXN-204 is P2) | `16` l.96, l.98–99 |
| Performance-by-regime heatmap (UXN-202, P2), grade filter (UXN-215, P2), long-press glossary (UXN-105, P2) | After go-live | `16` l.97, l.100–101 |
| Reviews calendar heatmap (UXN-206), guided reflection form (UXN-203) | M7 (P1 screens) | `16` l.105, l.107 |
| Mistake-category "confusion matrix" | Not in v1 (needs a new taxonomy) | `16` l.127 |
| Calibrated probabilities and AT-27 | M7 (UI) | `14` l.62; `10` l.129 |
| Owner-facing LLM Usage page (LLM-051) | M7 / M8 | `03` l.60 |
| Live LLM bake-off as an ongoing monthly job (LLM-040) | M8 (first run open, §5 item 7) | `03` l.46; `12` l.55 |
| Full release gate, staging E2E day, restore test, go-live (AT-28…AT-31) | M8 | `12` l.55; `14` l.66–80 |
| India and USA lessons, cross-market pools and per-market review blocks | M9, M10 | `12` l.56–57; `04` l.13 |
| Morning Brief content beyond EML-016 (no spec) | Not assigned | `04` l.33 |
| Dark-mode email CSS (UXN-169), P2 items | Not in v1 | `16` l.91 (P2, inactive) |

## 7. Coverage estimate

Spec lines read or cited in this extract: about 430 of the 2,251 spec lines in `spec/` (about 19 %). Fully read: `05_paper_trading_arena.md` (149), `07_agents.md` (110), `08_knowledge_base.md` (62), `03_llm_and_token_policy.md` (71), `14_system_acceptance.md` (84), `13_review_errata_and_addenda.md` (166), `15_configuration_reference.md` (220). Partly read: `10_nfr_testing.md` (TST-108…133, VAL-101…105, NFR-006, NFR-011, NFR-023, ROL-102, ROL-102b), `06_data_layer.md` (DAT-022, DAT-142…150, the state machines at l.116–118), `02_platform_hosting_auth.md` (PLT-022…022b, PLT-073 table), `09_ui_ux.md` (UX-032, UX-070…071b, UX-080 cross-references), `16_ui_next_level.md` (§16.11–16.12, UXN-041/043/121/037/AGT-112/113/ARN-095 lines), `04_email_and_notifications.md` (EML-012, EML-015, EML-037). Not read: `01`, `11`, the rest of `16` and `09`. The private data repository and the fixtures repository were not read (outside this extract's scope).

Requirement rows in §2: 115 table rows in §2.1–§2.9 (some rows group several IDs, for example "ARN-080 / ARN-081"), 3 acceptance rows in §2.10 and 43 configuration rows in §2.11. Gaps: 40 numbered items in §5. Items flagged **[CHECK]**: 38 of 40 (item 7 is an Owner decision and item 40 is the Owner prerequisites list).
