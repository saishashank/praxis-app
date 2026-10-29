# M14 requirements — Returns and validation

Delta specification extract from `Requirement/v2/spec/` chapters 10–14; continues from M8 on `build` branch.

## Scope

M14 is the second V2 milestone in the order of value (BLD-046: M8.1 → M14 → M15 …). It touches the simulator, validation and data layers; its LLM items are router hardening only, not new LLM features (BLD-045 allows it to run beside M11). Already shipped in M8.1 and not repeated here: DAT-231, GL-02/03/05/10 and LLM-070. §10.V2.2 also holds FAM-008, FAM-009, the F5 liquidity floor (O-49) and §10.V2.8 the ARN-084 amendment (O-45); these are outside the ch. 12 ID ranges but are included in M14 (design D-213).

**Parent chapters:**
- ch. 10 V2 §10.V2.2 (Returns: sizing, costs and exits) — FAM-004…007, ARN-106…109
- ch. 10 V2 §10.V2.3 (Validation and learning loop) — VAL-112…116, KB-081
- ch. 10 V2 §10.V2.4 (Data) — DAT-232…237
- ch. 10 V2 §10.V2.5 (Events and agents) — AGT-135…138
- ch. 10 V2 §10.V2.6 (LLM layer) — LLM-071…075
- ch. 14 V2 — AT-43…AT-46

## Requirements

### Returns: sizing, costs and exits (FAM-004…007, ARN-106…109)

#### FAM-004: Stop-distance cap
An entry is skipped when the initial stop distance exceeds `max_stop_distance_pct` (default 12%; bounds 6–20). Logged as `skipped_stop_distance`. This cap wins over any family-specific wider cap (e.g. F5 20%, CTX-013).

#### FAM-005: Per-signal cost gate
An entry requires the family's expected **gross** move — the development-split median price move of the setup **before** costs (ARN-071 outcomes with costs added back) — to be ≥ `cost_gate_k` (default 2.0; bounds 1.5–3.0) × the round-trip cost of its ADV bucket (fees + ARN-032 slippage). Costs are counted once, in the gate, never again in the compared figure. Reference figures at A$600 and A$5/side: 1.67% fees; 1.87–4.07% with slippage by bucket. Logged as `skipped_cost_gate`. The spec marks this family-median form as superseded by CTX-022a (matched-setup gross move per signal, ch. 17, M15); the family-median form stays as the fallback for a family with fewer than 30 matched setups. Before the Cortex exists it is the only form (design D-214).

#### FAM-006: Second-position limits
When an execution can hold two positions, the second must be in a different GICS sub-industry and have ≤ `second_position_max_corr` (default 0.6; bounds 0.3–0.9) 60-session return correlation with the first; else the next-ranked candidate is taken. Needs the sector map (the spec cites DAT-236 / O-23b). The ASX listed-companies file gives a GICS industry group, not a sub-industry (design D-218).

#### FAM-008: Signal validity and order expiry (in §10.V2.2)
A signal is valid for one session: its next-open order is filled, cancelled or expired at that open and never resubmitted; a fresh signal on a later night may signal the code again (FAM-002 cooling-off still applies).

#### FAM-009: SHOCK sizing below two parcels (in §10.V2.2)
Half size in SHOCK applies only when deployable cash is at least two marketable parcels; below that the execution makes no new entry, recorded as `abstain_shock`.

#### F5 liquidity floor (in §10.V2.2, O-49)
F5's default universe becomes U2 (ADV ≥ A$250k); U3 runs only as a labelled stress variant.

#### FAM-007: Ex-date stop comparison
On an ex-dividend session the stop is compared against close + cash dividend (needs DAT-231, vendor corporate actions).

#### ARN-106: Exit ablation
For every family, the replay also reports a **time-stop-only comparator** (same entries, exit at the family's time limit only). A trailing-stop variant is kept only if it beats the comparator on the development split, then counts as a challenger (ARN-085).

#### ARN-107: Slip sensitivity
Replays add a seeded one-tick adverse-slip variant beside ARN-083 (descriptive, reported for stability).

#### ARN-108: Parameter neighbourhood
Each rule version's development replay reports results for ±1 step of every parameter (descriptive "stability" table on the Strategies page). A version whose neighbours fail the absolute gate (ARN-081) is labelled "fragile".

#### ARN-109: Settlement for statistics
Cohort and time-to-double statistics use the `conservative` settlement variant; `matched` is reported as sensitivity (Owner decision O-48).

### Validation and learning loop (VAL-112…116, KB-081)

#### VAL-112: Error budget
**Alpha-spending per lineage** (Foster–Stine, as already implemented for L2 lessons) with family-wise error 0.05 per lineage and the trial ledger unchanged. The absolute gate (ARN-081) and holdout confirmation (ARN-086) stay. Every generated hypothesis, Committee rating, sizing/stop variant and pattern test is counted (at most three sizing/stop variants per family per quarter). Owner decision O-43: alpha-spending per lineage.

#### VAL-113: Power arithmetic
All sample-size planning uses the actual per-test level (0.000417 under v1, or the VAL-112 level once chosen); the ch. 05 minimum of 100 trades is a floor, not a power target. Pattern tests (AGT-031) are planned at 80% power with α from the ledger and **effective N**. They start in the order: bullish engulfing, piercing, bullish harami, morning star, hammer. The earlier sample-size figures are withdrawn; M15 computes and publishes the new numbers.

#### VAL-114: Daily rank quality
For each family's rank score, the nightly batch computes the cross-sectional rank correlation (IC) with the **D+1-close-to-D+2-close** excess return over the U1 median (no same-day leakage), with a monthly block bootstrap. About 250 cross-sections a year make ranking changes testable long before trade-level promotion. Descriptive; it feeds Lane B only as a screening statistic for rank challengers.

#### VAL-115: Minimum backtest length
Each lineage shows the MinBTL for its number of trials and is labelled "too short" until met. The spec marks the formula [VERIFY] against the primary paper.

#### VAL-116: Lesson alpha pool
Fixed-fraction spend per test and an explicit "effectively exhausted" status below α = 0.005 instead of the halving rule (Owner decision O-44, default).

#### KB-081: Pre-registered challenger set
Lane B's first challengers per family are pre-registered from the research (iter_10 register):
- F1 lookback 252 and U2-only skip-month
- F4 5-session U2 reversal
- F3 drift windows 20/40/60
- Equal-weight three-factor composite (126-session momentum, low volatility, volume trend) as one rank challenger
- Vol-scaled rank **with** an unscaled control arm

Each is a counted trial. O-46: 2–3 pre-registered challengers per family, and at most three sizing/stop variants per family per quarter, all counted.

#### ARN-084 amended (§10.V2.8, O-45)
Sleeve comparisons are descriptive and not charged to the lineage's trial budget.

### Data (DAT-232…237)

#### DAT-232: Split-adjusted volume
Volume ratios, ADV and F1/F5 thresholds use split-adjusted volume (historical volume **multiplied** by the split ratio so dollar volume is unchanged, CTX-050), after a measurement of split-day frequency in the M2 data.

#### DAT-233: Adjustment factors
Price factors (dividends) and split factors are stored separately with a reference-close check, following the zipline/Lean convention.

#### DAT-234: Index-change events
S&P/ASX index additions and deletions are tagged and **excluded** from F3 triggers (they partly reverse within 20 sessions). The free index-change date list is [VERIFY].

#### DAT-235: Benchmark
Comparisons use a total-return series (price index + dividends from the same data) once GL-10 is decided (Owner decision O-51: dividends credited, total-return benchmark).

#### DAT-236: Licence register corrections
RBA tables are copyrighted: use derived numbers with the source named; the `asx_listed_companies` row must state its actual terms (O-23 covered announcements only). The automated list fetch is kept under a new Owner risk acceptance **O-23b**; the build must find and record at least two alternative free universe sources (e.g. S&P/ASX index-constituent files, exchange-published CSVs, licensed open datasets) with their terms, so the ASX fetch can be switched off without losing the universe. A manual CSV upload on the Configuration page remains the fallback (Owner decision O-53 revised).

#### DAT-237: Announcement dedup
Exact-hash dedup in the Worker; MinHash near-duplicate detection in the nightly batch (MIT library) so re-released or mirrored announcements are not double-counted as events.

### Events and agents (AGT-135…138)

#### AGT-135: Exchange-query polarity
Keep −1 but add a `query_response` category and a flag when the price reaction reverses by the next close (Drienko & Sault 2013 is intraday evidence). Owner decision O-50.

#### AGT-136: Director trades
Keep the −0.5 sale weight; a challenger tests −0.25 and splitting by trade type (on-market vs option exercise). Owner decision O-50.

#### AGT-137: Price-based surprise
F3 gains a challenger using day-0 abnormal return as the surprise measure (no earnings data needed); drift window tested at 20/40/60 sessions (US classic PEAD is near zero recently; ASX uncalibrated).

#### AGT-138: Guidance maintained
New event category `guidance_maintained` (polarity from the day-0 abnormal return), so "reaffirmed/unchanged" announcements are not lumped into `other`.

### LLM layer (LLM-071…075)

#### LLM-071: Constrained decoding
Where the route supports strict JSON schemas (Groq strict mode; Gemini response schema), the router uses them; the app-side validation stays. Evidence-ID citations (LLM-064) are passed as a per-request **enum** in the schema so invalid citations are impossible by construction.

#### LLM-072: Fail-closed labels
Every classification role returns an enumerated label; substring or fuzzy matching is forbidden.

#### LLM-073: Datamarking
Untrusted announcement/news text in any prompt is datamarked (Spotlighting-style) and the bake-off (LLM-063) includes hostile datamarked packs.

#### LLM-074: One repair call
A failed schema gets at most one repair call naming the failing field, with its tokens reserved before the first call.

#### LLM-075: Cut-off record
Each model's knowledge cut-off is stored; no Committee or steelman test window may predate it; every LLM-proposed hypothesis is a counted trial (VAL-112).

## Acceptance tests

| ID | Test | Pass condition |
|---|---|---|
| **AT-43** | Sizing and cost gates | Fixture signals across ADV buckets and stop distances. FAM-004/005/006 skip reasons logged; no order violates the cap, gate or second-position limits; time-stop comparator and ±1 parameter table present for every family (ARN-106/108). |
| **AT-44** | Rank quality and error budget | Synthetic cross-sections with a planted rank edge; a lineage with 25 trials. VAL-114 IC detects the planted edge with the bootstrap interval excluding 0; VAL-112 level applied as the Owner chose; every hypothesis/variant appears in the trial ledger. |
| **AT-45** | Data additions | Yahoo fixture with dividends and splits; a split day; an index-change event. DAT-231 vendor rows present without an extra request; split-adjusted volume ratio correct; index-change event excluded from F3 and tagged. |
| **AT-46** | LLM hardening | Roster config; a schema with a citation enum; a datamarked hostile pack; a classifier returning "bullish-ish". Retired models absent from every route; out-of-enum citation impossible; hostile pack causes no instruction following; fuzzy label rejected (LLM-070…073). |

AT-46 also checks the LLM-070 roster half (retired models absent), which M8.1 built; M14 reuses that test.

## Configuration keys (ch. 15 V2, M14 rows)

`max_stop_distance_pct` 12 (6–20), `cost_gate_k` 2.0 (1.5–3.0; the same key serves CTX-022a), `second_position_max_corr` 0.6 (0.3–0.9), `val_error_budget_mode` alpha_spending (fixed | alpha_spending | bh_fdr), `val_fwer_per_lineage` 0.05 (0.01–0.10), `l2_alpha_spend_fraction` 0.1 (0.05–0.25), `rank_ic_bootstrap_blocks` monthly (monthly | weekly, fixed), `f5_default_universe` U2 (U1 | U2 | U3), `settlement_stats_mode` conservative (conservative | matched), `dedup_minhash_threshold` 0.85 (0.7–0.95). Keys the design adds are listed in `docs/M14_design.md` §2.7.

## Decisions

D-213…D-252, in `docs/M14_design.md` §4 and the decision log.

## Parent requirements

- v1 ch. 05 (arena simulator): FAM-001, ARN-071, ARN-081…091, VAL-001…050, ARN-032, ARN-095
- v1 ch. 06 (data): DAT-001, DAT-200…230
- v1 ch. 07 (agents): AGT-001…134
- v1 ch. 03 (LLM): LLM-020…070
