# M3 requirements extract: simulator and paper-trading arena

Source: `praxis-app-data/Requirement/v1/spec/` (chapters 05, 10, 12, 13 (FIX-042 only), 14, 15) and `docs/M2_design.md` §2. Extract only. Quotes are trimmed with "…". Spec IDs are cited as written. `(l.N)` is a line in the named spec file; ARN lines are in `05_paper_trading_arena.md`. Where the M3 row names no AT for an ID, the acceptance column says "gap". Spec text is the authority; this file does not change it.

## 1. M3 scope (ch.12 §12.3, verbatim)

> M3 | Simulator & Arena | Cost profiles P0–P5, fills/stops, settlement, sleeve and lockout, cohorts, controls C1–C3, ledger invariants, reproducibility | AT-10…AT-13

Related: BLD-024 (`12_build_plan.md` l.62) keeps the Arena and emails disabled in production from M2 (data-only mode); TST-115 (`10_nfr_testing.md` l.150) runs AT-10…AT-17 on staging with recorded data only. BLD-030 starts live paper trading after M8 sign-off. No BLD-02x item is specific to M3.

## 2. Requirements table

Columns: ID | exact MUST/SHOULD/MAY text (verbatim, trimmed) | acceptance | ch.15 keys (default, bounds, edit: O = Owner-only, B = Lane-B, — = fixed)

### 2.1 Universe and tiers

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-010 (l.33) | "Tiers are recomputed daily from point-in-time data and stored with every trade. **U1** = top 300 codes by 60-session median traded value … with raw price ≥ A$0.50" | gap (no M3 AT or TST-101 case) | U1 rule top 300 + ETFs, price ≥ 0.50 (200–400, O); ADV min U1/U2/U3 1M/250k/100k (±50%, O); price min 0.50/0.20/0.10 (O); U2 listed 12 months, mcap 30M (O) |
| ARN-011 (l.41) | "Manipulation/anomaly filters for U2/U3 entries (thresholds **Owner-only**, not Lane-B tunable) …" | gap | Filter thresholds as ARN-011 (±50%, O); promotional_keywords default ["guaranteed", "10-bagger", "next big", "moon", "explosive", "huge upside"] (O) |
| ARN-012 (l.42) | "The whole listed universe is screened daily from EOD data." | gap | — |
| ARN-013 (l.43) | "Trades > 0.5% of ADV or in U3 are labelled \"possibly un-tradeable\"." | gap | none (0.5% not in ch.15) |
| ARN-014 (l.44) | "If the universe cannot be refreshed, the last good list is used and flagged." | gap | none |

### 2.2 Orders and fills

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-003 (l.23) | "At most 2 open positions; a second only if both can each meet the marketable parcel after costs … If the stock entry and a sleeve opening can't both be funded, **the sleeve is skipped**, never the stock entry." | AT-11; Acceptance (l.138, A$560 NAV) | max_open_positions 2 (1–2, O) |
| ARN-020 (l.47) | "Decisions for session D use only inputs before D's decision cut-off (§5.1) and fill at D+1's open." | AT-10 (ARN-020…036) | decision_cutoff 18:10 Melbourne (—, O) |
| ARN-020a (l.48) | "At 09:55 exchange time a signed Vercel route … re-checks each pending buy against halts/suspensions, ARN-011 and thesis-breakers …" | gap in M3 (AT-18 is M5) | preopen_recheck 09:55 (O) |
| ARN-021 (l.49) | "IS fill: if the session **opens at or below** the level → fill at open − slippage; otherwise, if the low reaches the level → fill at level − slippage − 1 tick." | AT-10; TST-101 "stop hit inside range; gap through stop fills at open" | tick_cross_factor 1.0 (0.5–2, O) |
| ARN-021 (l.49) | "If a stop and a close signal both apply, the earlier fill wins; ambiguous intrabar ordering assumes the worse outcome." | AT-10; TST-101 worse-case ordering | — |
| ARN-022 (l.54) | "Long-only cash equities/ETFs; leverage only in the sleeve." | AT-10 (range) | — |
| ARN-023 (l.55) | "Whole shares only (rounded down)." | AT-10; TST-101 "whole-share rounding" | — |
| ARN-024 (l.56) | "A buy opening a new holding must be ≥ `min_marketable_parcel` (AU A$500 [VERIFY]); participation cap 1% of 20-session ADV; buys that fail are rejected and logged." | AT-10; TST-101 parcel rejection, minimum order and participation cap | min_marketable_parcel 500 A$ ([V], —); participation_cap 0.01 × ADV (0.005–0.02, O) |
| ARN-024a (l.57) | "Deployable cash = settled/matched cash − sleeve margin to be moved … − estimated brokerage − buffer (1% of NAV). Shares = floor(deployable ÷ expected fill price)…" | AT-10; TST-101 deployable-cash rule | cash_buffer 0.01 × NAV (0–0.03, O) |
| ARN-024a (s13) (l.57) | "…after the share count is set, actual brokerage is recomputed on the real order value. No iteration." | gap | — |
| ARN-025 (l.58) | "Settlement default `matched` (T+2 AU); variant `conservative`." | AT-10; TST-101 "T+2 settlement" | settlement_mode matched (matched/conservative, O) |
| ARN-026 (l.59) | "Halts/suspensions: no fills; frozen at last price; after 20 sessions marked at the suspension haircut (default 50%)." | AT-10; TST-101 suspension haircut and legacy ledger | suspension_haircut 0.5 (0.3–0.8, O); suspension_haircut_after 20 (10–60, O) |
| ARN-027 (l.60) | "Trading calendar per market." | gap in M3 (M2 calendar, DAT-160) | — |

### 2.3 Costs (P5 profiles)

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-030 (l.63) | "Every fill pays brokerage (cost profile) plus slippage." | AT-10 | cost_profile_default P5 (O) |
| ARN-031 (l.64) | "AU profiles each side [VERIFY]: P0 zero-fee list else P1; … **P5 default** ≤ A$1,000.00: A$5.00; > A$1,000.00 and ≤ A$3,000.00: A$10.00; … > A$25,000.00: 0.12%; P5b …" | AT-10; TST-101 P5 at each tier boundary (both sides) | cost tables P0–P5b per ARN-031 ([V], O) |
| ARN-032 (l.65) | "Slippage per fill = max(ADV bucket bps, (10,000 × tick(price) ÷ price) × tick_cross_factor); … buckets ≥ A$5M 10, A$1–5M 25, A$250k–1M 60, A$100–250k 120 bps …; raw prices." | AT-10; TST-101 tick-based slippage | slippage_buckets 10/25/60/120 bps (±50%, O); tick_table 0.001/0.005/0.01 A$ ([V], —); tick_cross_factor 1.0 (O) |
| ARN-033 (l.66) | "Leaderboards use P5 plus a stress column (P3 + 50% slippage)." | gap | stress_profile P3 + 50% (—) |
| ARN-034 (l.67) | "Cost-profile replay P0–P5b from stored fills." | gap | — |
| ARN-035 (l.68) | "Data, platform, currency and tax costs excluded and reported as such." | gap | — |
| ARN-083 (l.117) | "Cost robustness: must pass under P3 + 50% slippage." (validation gate, M4) | gap in M3 | — |

### 2.4 Cohorts and the 12 executions

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-000 (l.20) | "Each market runs its own Arena in its own currency, costs, thresholds and controls (MKT-103)." | gap (AU only in M3) | — |
| ARN-001 (l.21) | "12 live executions per market, each seeded with the market seed (AU A$600 [OWNER O-25]), all aggressive [OWNER] …" | AT-11 | seed 600 A$ (O) |
| ARN-002 (l.22) | "Composition 6 families × {U, L} [OWNER O-18]: E01/E02 F1 Trend; E03/E04 F2 …; E11/E12 F6 Consensus." | AT-11 | families F1–F6 (B, §15.3) |
| ARN-004 (l.24–27) | "**C1** buy-and-hold of the broad index ETF … **C2** matched random-entry controls per family … **C3** the same C2 entries with a sleeve attached …" | AT-11 (C1–C3 start cohorts); TST-101 C2 exit mapping in ATR units | c2_controls_per_row 20 (≥ 10, —); c2_live_per_family 20 (10–50, O) |
| ARN-005 (l.29) | "≤ 8 unfunded challengers concurrently per market (KB-042)." | gap | max_challengers 8 (1–8, O) |
| ARN-006 (l.30) | "Lower-risk tiers may be added later by configuration." (MAY) | gap | — |
| ARN-040 (l.72) | "L executions carry a sleeve: margin = min(A$20, 4% of NAV) [OWNER]; leverage 10× [OWNER, hypothetical]; one sleeve trade at a time; no compounding." | AT-10 (ARN-040…050); Acceptance (l.145, A$20 margin) | sleeve_margin min(20, 4% NAV) (O); sleeve_leverage 10 (—) |
| ARN-041 (l.73) | "When a sleeve trade opens, the margin is **moved out of cash** into a separate sleeve-margin balance …" | AT-10; TST-101 "sleeve margin counted once in NAV" | — |
| ARN-042 (l.74) | "The sleeve opens only with its family's entry and closes at the same exit; underlying must be U1 or an index ETF (E10: U2 too); never U3." | AT-10 | sleeve_allow_u2 true (O) |
| ARN-053 (l.87) | "At a terminal close the outcome and TTD are fixed … **Twins restart together live:** when one twin resolves, the other's live cohort is liquidated the same way and both restart on the same session …" | AT-11; TST-101 twin restart and shadow continuation | — |
| ARN-054 (l.88) | "Further target rungs may be recorded; termination at rung 1 is the default." | gap | — |

### 2.5 Terminal states

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| §5.1 (l.12) Target | "Target liquidation NAV ≥ 2× seed (A$1,200)" | AT-11 "golden paths reach each terminal state" | target_multiple 2.0 (—/O, PRD-003); seed |
| §5.1 (l.12) Bust | "**Bust** ≤ 50% of seed (A$300)" | AT-11 | bust_fraction 0.5 (O) |
| §5.1 (l.12) Stalled | "**Stalled** no open position and either (a) NAV < `stall_floor` for 5 consecutive sessions … or (b) over 20 consecutive sessions … **every** signal was rejected only for parcel/whole-share reasons" | AT-11 (stalled); TST-101 stalled at floor for 5 sessions (U and L) and 20 sessions of parcel-only rejections | stall_floor ≈ 511 (computed, —); stall_sessions 5 (3–10, O); stall_parcel_rejections 20 (10–40, O) |
| §5.1 (l.12) Timeout | "**Timeout** 252 sessions." | AT-11 | timeout_sessions 252 (O) |
| ARN-052 (l.86) | "Bust, target and stall are judged on liquidation NAV at a close (§5.1)." | AT-11; TST-101 liquidation-NAV terminal checks | — |
| ARN-071 (l.104) | "Execution outcomes as competing-risk cumulative incidence functions (target / bust / stalled / timeout) with censoring …" | not M3 (scorecard; AT-17 is M4) | — |

### 2.6 Controls, guardrails and kill switches

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-090 (l.124) | "Deterministic, versioned rule sets; LLMs never trade." | gap | — |
| ARN-091 (l.125) | "No silent edits; changes via challengers or Owner force-apply (KB-050)." | gap | — |
| ARN-093 (l.127) | "Kill switch per family, checked at 20, 40, 60 … forward trades up to K = `killswitch_max_looks_per_year` …" | gap in M3 | killswitch_looks every 20 trades (—); killswitch_max_looks_per_year set yearly (—); α 0.05 ÷ 3 |
| ARN-094 (l.128) | "\"Cost-infeasible at this seed\" label when the development-split **gross mean per-trade return at fixed notional** … < 2× the round-trip cost of a A$600 trade …" | gap in M3 (blocks VAL-110 iv-b) | cost_feasibility_ratio 2 (—) |

### 2.7 Ledger, NAV and sleeve

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-051 (l.85) | "**NAV** at each close = cash (settled + unsettled receivables − unsettled payables) + Σ(quantity × raw close, or haircut value) + dividends receivable + sleeve-margin balance + sleeve unrealised price P/L − accrued unpaid financing. Franking excluded." | AT-11; AT-12 | — |
| ARN-101 (l.132) | "Nightly ledger invariants: cash ≥ 0; no shorts; sleeve-margin balance = margin of the open sleeve trade (else 0); sleeve price+financing loss ≤ margin; lock state consistent; NAV reconciles (ARN-051) …" | AT-12 (ARN-101, TST-104) | — |
| ARN-043 (l.75) | "Sleeve price P/L = margin × leverage × underlying return between the sleeve's entry and exit fills." | AT-10; TST-101 | sleeve_leverage 10 (—) |
| ARN-044 (l.76) | "Close-out when price P/L + accrued financing reaches −50% of the margin (IS exit); price P/L + financing loss capped at the margin; brokerage and slippage charged in addition." | AT-10; TST-101 "sleeve close-out at 50% margin; loss capped at margin" | sleeve_closeout_pct 0.5 (0.3–1.0, O) |
| ARN-045 (l.77) | "Sleeve costs: brokerage on notional per `sleeve_cost_profile` (default the execution's profile: P5 A$5 per side), slippage per ARN-032, financing 9% p.a. on exposure per calendar day [VERIFY]." | AT-10 | sleeve_cost_profile = execution profile (O); sleeve_financing_rate 0.09 p.a. ([V], —) |
| ARN-046 (l.78) | "A losing sleeve trade locks the sleeve and records `loss_to_recover`." | gap | not in ch.15 (see §5) |
| ARN-047 (l.79) | "**REC-2 (default)** unlocks when unlevered realised net P/L since the lock ≥ `loss_to_recover`; REC-1 …; REC-3 …; REC-4 after 10 sessions. A new cohort resets to unlocked." | TST-101 "REC-2 unlock" | recovery_mode REC-2 (REC-1…REC-4, O) |
| ARN-048 (l.80) | "A shadow sleeve logs hypothetical trades while locked." | gap | — |
| ARN-049 (l.81) | "Sleeve figures shown at 10× and at the reality-adjusted 5× … labelled \"hypothetical leverage\"; market-specific." | gap | reality_cap 5 ([V], —) |
| ARN-080 (l.114) | "Trade-level evidence uses the **signal ledger** … **at most one open row at a time** … simulated **unconstrained at fixed notional** (A$600 …)" | gap in M3 (M4 replay) | reentry_block 10 (5–20, B); rolling_start_step 5 (5–21, O) |
| ARN-060 (l.91) | "**Close the books** in batch 2 before signals: apply D's opening fills and IS exits from D's bars → corporate actions, dividends, financing → settle and mark to market → ledger invariants → terminal and sleeve-lock checks." | gap in M3 (AT-22 is M6); see §5 item 1 | — |
| ARN-102 (l.133) | "Cohorts store rule version, parameters, profiles, sleeve settings, data snapshot id, random seed; re-runs reproduce identical results." | AT-13 (ARN-102, NFR-022) | — |

### 2.8 Money and rounding rules (what the spec states)

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-023 (l.55) | "Whole shares only (rounded down)." | AT-10; TST-101 | — |
| ARN-024a (l.57) | "Shares = floor(deployable ÷ expected fill price), where the expected fill price already includes ARN-032 slippage (slippage is not reserved a second time)." | AT-10; Acceptance (l.137, A$9.80 → 60 shares) | — |
| ARN-024a (s13) (l.57) | "Estimated brokerage for sizing = the cost-profile charge for an order worth the whole deployable amount (conservative because P5 is non-decreasing in order value)" | gap | — |
| ARN-031 (l.64) | Tier boundaries as listed in 2.3 (≤ / > at A$1,000.00, A$3,000.00, A$10,000.00, A$25,000.00) | TST-101 both sides of each boundary | — |
| ARN-032 (l.65) | "… (10,000 × tick(price) ÷ price) …; raw prices." | AT-10; TST-101 | tick_table ([V]) |
| ARN-021 (l.49) | fill formulas as in 2.2 | AT-10; TST-101 | — |
| — | **No rounding-to-cents, fee-rounding or fill-tick rounding rule exists in the spec.** TST-101 requires "exact" outputs (see §5). | gap | — |

### 2.9 Corporate-action and dividend cash effects (ARN-036, ARN-026, ARN-043; DAT-220…223)

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| ARN-036 (l.69) | "A position held **at the close of the session before the ex-date** is entitled; from the ex-date NAV includes the dividend receivable; cash on the pay date; franking recorded separately, excluded from NAV. Other corporate actions per DAT-220…223." | AT-10 (ARN-020…036); TST-101 dividend receivable from ex-date, credited on pay date, franking separate | ca_auto_confirm (O, ch.15 l.139) |
| ARN-043 (l.75) | "Splits and consolidations do not change sleeve notional or margin; the underlying-return series … is adjusted via the recorded adjustment factor (DAT-220) …" | TST-101 "split and consolidation without artificial P/L" | — |
| DAT-223 (06 l.95) | "Entitlement offers are not taken up: **non-renounceable** — no compensation …; **renounceable** — rights valued at their last traded price if traded, else zero." | TST-101 "non-renounceable offer" | — |
| DAT-222 (06 l.94) | "Until resolved: affected codes blocked for entries, cohorts flagged; resolution recomputes factors and positions from the event date (reproducible)." | gap in M3 | — |

M2 read-side dependencies (`docs/M2_design.md` §2): `price_bar` (raw, first-seen immutable), `adjustment_factor` (ex_date ≤ D, DAT-126), `universe_snapshot` (tier, adv, halted), `corporate_action` / `corporate_action_event`, `quality_score` (gate_pass). See §5 item 11.

### 2.10 Testing (TST-101 rules and the M3 ATs)

TST-101 (`10_nfr_testing.md` l.137) is a bullet list, not a table. Rules: "Hand-computed cases MUST pass exactly" and "Every case MUST be stored in the private fixtures repo with inputs and exact expected outputs, including one case on each side of every P5 tier boundary and one parcel-rejection case." Case list (verbatim trimmed): "P5 brokerage at each tier boundary (A$1,000.00 / 1,000.01 / 3,000.00 / 3,000.01 / 10,000.00 / 10,000.01 / 25,000.00 / 25,000.01); marketable-parcel rejection; deployable-cash rule (ARN-024a); tick-based slippage; exit types IS/CS …; initial stop set from the actual fill; dividend receivable from ex-date; non-renounceable offer; suspension haircut and legacy ledger (ARN-026); twin restart and shadow continuation (ARN-053); **stalled** … ; liquidation-NAV terminal checks; C2 exit mapping in ATR units for F2/F3/F6 (ARN-004); sleeve margin counted once in NAV (ARN-041/051); P2 rule; T+2 settlement; stop hit inside range; gap through stop fills at open; worse-case ordering …; sleeve close-out at 50% margin; loss capped at margin; REC-2 unlock; split and consolidation without artificial P/L; dividend credited on pay date; franking recorded separately; minimum order and participation cap; whole-share rounding."

| ID | Text | Acceptance | ch.15 keys |
|---|---|---|---|
| TST-101 (l.137) | "Known-answer tests. Hand-computed cases MUST pass exactly …" (case list above) | AT-10 "All TST-101 cases pass exactly" | — |
| TST-102 (l.138) | "A frozen dataset (≈ 20 codes × 3 years per market incl. a split, a consolidation, a delisting, a halt, a rights issue) reproduces identical trades/NAV on every run and every platform." | AT-12 (3-year golden replay) | — |
| TST-104 (l.140) | "Property tests for ledger invariants (ARN-101) under random order sequences." | AT-12 | — |
| TST-109 (l.145) | "No-look-ahead test: perturb all data after date D; decisions for D and earlier MUST be unchanged." | gap in M3 (AT-09 is M2) | — |
| TST-121 (l.156) | "… 90% on money maths, validation statistics, rule interpreter, auth/roles, Worker scheduling" | gap | coverage_overall_min 80% lines; 90% on money maths |
| TST-130 (l.165) | "Mutation testing on money maths and validation statistics: weekly mutation run; surviving-mutant score ≥ 80%" | not gating per PR | mutation_score_min 80% |
| NFR-022 (l.45) | "Re-running a cohort with the same inputs, versions and seed reproduces identical …" | AT-13 | — |
| AT-10 (14 l.27) | "All TST-101 cases pass exactly" | — | — |
| AT-11 (14 l.28) | "12 executions (6 twin pairs) and controls C1–C3 each start a cohort with A$600; golden paths reach each terminal state … effective N (ARN-053) counts each non-overlapping cohort once and matches the fixture value." | — | — |
| AT-12 (14 l.29) | "Property tests and a 3-year golden replay show no invariant violation" | — | — |
| AT-13 (14 l.30) | "Two replays with identical inputs produce byte-identical trade lists and NAV series" | — | — |

Test placement: TST-115 (`10_nfr_testing.md` l.150) puts AT-10…AT-17 on staging with recorded data. Gate: TST-112 (l.151) PR gate includes TST-100–105 and TST-109.

## 3. Numeric constants for money maths (ID:line)

Money: all AU figures; currency A$.

- Seed A$600 per execution: ARN-001 (l.21); §5.1 (l.12); TST-101/AT-11 (14 l.28).
- Target 2× seed = A$1,200: §5.1 (l.12); PRD-003.
- Bust 50% of seed = A$300: §5.1 (l.12).
- Stall floor ≈ A$511 "= parcel + entry brokerage + entry slippage at 10 bps + buffer (1% of NAV)": §5.1 (l.12). The spec writes "A$500 + 5 + 0.5 + 5.1 â A$511" (the sum is A$510.6).
- Stall: 5 consecutive sessions (l.12); 20 consecutive sessions of parcel-only rejection (l.12).
- Timeout 252 sessions: §5.1 (l.12).
- Minimum marketable parcel A$500 [VERIFY]: ARN-024 (l.56).
- Participation cap 1% of 20-session ADV: ARN-024 (l.56).
- Cash buffer 1% of NAV: ARN-024a (l.57); acceptance (l.138: "A$600 − A$6 buffer").
- P0 zero-fee list else P1 A$3.00; P2 A$0 first buy < A$1,000 per security per day, else greater of A$11.00 or 0.10%; P3 A$6.50; P4 0.03% min A$3 max A$9.99; P5 A$5.00 (≤ A$1,000.00), A$10.00 (≤ A$3,000.00), A$19.95 (≤ A$10,000.00), A$29.95 (≤ A$25,000.00), 0.12% above; P5b A$2.00 (≤ A$1,000.00), 0.20% above: ARN-031 (l.64).
- Tier boundaries tested by TST-101: A$1,000.00 / 1,000.01 / 3,000.00 / 3,000.01 / 10,000.00 / 10,000.01 / 25,000.00 / 25,000.01: TST-101 (10 l.137).
- Slippage buckets 10 / 25 / 60 / 120 bps for ADV ≥ A$5M / A$1–5M / A$250k–1M / A$100–250k: ARN-032 (l.65); ch.15 slippage_buckets.
- Tick table A$0.001 (< A$0.10), A$0.005 (A$0.10–< A$2.00), A$0.01 (≥ A$2.00) [VERIFY]: ARN-032 (l.65).
- Tick cross factor 1.0 (ch.15 l.28); fill rule "− 1 tick" for a gap-through-level IS fill: ARN-021 (l.49).
- Stress: P3 + 50% slippage: ARN-033 (l.66); ARN-083 (l.117); ARN-087(iv) (l.121).
- Sleeve margin min(A$20, 4% of NAV); leverage 10×; reality cap 5×: ARN-040 (l.72); ARN-049 (l.81).
- Sleeve close-out at −50% of margin: ARN-044 (l.76).
- Sleeve brokerage P5 A$5 per side: ARN-045 (l.77).
- Sleeve financing 9% p.a. "per calendar day" [VERIFY]: ARN-045 (l.77); divisor 365 per 13_review FIX-042 (l.34) — see §5 item 10.
- Break-even move ≈ +5% and close-out move ≈ −5% at A$200 exposure under P5: ARN-045 (l.77).
- Fixed notional A$600 for the signal ledger: ARN-080 (l.114); ARN-087(v) (l.121).
- Cost-feasibility: gross per-trade return < 2× round-trip cost of a A$600 trade: ARN-094 (l.128).
- Useful edge +0.5% net (VAL-110 label, not M3 money maths): ARN-086 (l.120).
- Max 2 open positions: ARN-003 (l.23).
- Decision cut-off 18:10 Melbourne: §5.1 table; ch.15 l.15.
- Sizing: floor() to whole shares: ARN-023 (l.55), ARN-024a (l.57). No cent rounding stated.

## 4. Needs the Owner (M3)

- **Already decided (no action unless changed):** seed A$600 (O-25); six families × U/L twins (O-18); aggressive profile (O-11); P5 default costs (O-17); AU first (O-27); sleeve margin/leverage marked [OWNER] (ARN-040, l.72); ARN-001 composition [OWNER] (l.21–22).
- **Owner-only keys (ch.15 "O"):** stall_sessions, stall_parcel_rejections, timeout_sessions, max_open_positions, participation_cap, cash_buffer, suspension haircut, cost_profile_default, slippage buckets, sleeve keys, recovery_mode, c2_live_per_family, max_challengers, rolling_start_step. The defaults are recorded; any change is an Owner decision.
- **Owner-only thresholds:** ARN-011 filter thresholds and promotional keyword list (ch.15 l.86–87) are "not Lane-B tunable"; Owner must confirm them before U2/U3 entries use them.
- **[VERIFY] items needing an Owner-approved source at build:** minimum parcel A$500 (ARN-024); P0–P5b cost tables (ARN-031); tick table (ARN-032); sleeve financing 9% p.a. (ARN-045); AU index ETF code for C1 "[VERIFY code]" (ARN-004).
- **Dated action:** the ASIC CFD order "runs to 23 May 2027" — the label must be re-verified after that date (ARN-049; 13_review FIX-061; OPS-020).
- **Unspecified owner:** ARN-093 "set each year from the measured trade rate" — the spec does not say who sets `killswitch_max_looks_per_year`.
- **Runtime Owner requests (not build work):** rolling-holdout roll request after one holdout-length of data (ARN-082); Owner force-apply of a rule (ARN-091, KB-050).
- BUILD_SETUP §10.2 was not checked for M3 items (not one of the listed sources).

## 5. Cross-references not found / contradictions

1. ARN-060 (l.91) says "Close the books in batch 2 before signals"; `13_review_errata_and_addenda.md` timetable puts "Batch 2: indicators, screens, family signals … orders" at 18:10 and "Batch 3: close the books" at 18:40. Contradiction; the ordering needs an Owner or spec decision.
2. TST-101 (10 l.137) hard-codes "stalled … for 5 sessions" and "20 sessions"; ch.15 l.13–14 makes both tunable (stall_sessions 3–10, stall_parcel_rejections 10–40, O). Test and config disagree.
3. ARN-080 (l.114) fixes "Cohort replays start every 5 sessions"; ch.15 l.39 gives rolling_start_step bounds 5–21 (O). Contradiction.
4. §5.1 stall floor uses "entry slippage at 10 bps" (A$0.50); ARN-032 slippage is max(bucket, one tick). At A$9.80 one tick is 10.2 bps (ARN-032 Given), so the ≈ A$511 floor under-counts whenever the tick exceeds 10 bps.
5. No rounding rule for money. P5 0.12% above A$25,000 gives fractions of a cent (A$25,000.01 → A$30.00012), yet TST-101 requires "exact" outputs. The spec does not state a cent or fill-tick rounding rule.
6. ARN-032 bps slippage: the spec does not say whether the slippage amount or the fill is rounded to a tick (the ARN-021 and Given examples imply tick multiples).
7. ARN-031 boundary operators differ: P2 "< A$1,000" vs P5 "≤ A$1,000.00". P0 "zero-fee list else P1" is ambiguous.
8. ARN-032 bucket edges at exactly A$1M, A$5M, A$250k and A$100k are not assigned to a bucket.
9. ARN-046/047 use `loss_to_recover` but it has no definition and no ch.15 key.
10. ARN-045 says financing "per calendar day" with no divisor; only 13_review FIX-042 (÷ 365) states it. ch.05 should carry the divisor.
11. Named in the task but not found: "adjusted reader" is not in `docs/M2_design.md` §2 (only the table list); the quality gate is not in §2 either (only `quality_score`; the gate rule is DAT-210 at 06 l.88). DAT-125 and DAT-170 are defined in 06 (l.71, l.125); no gap there.
12. No M3 AT names ARN-020a, ARN-027, ARN-033, ARN-034, ARN-035, ARN-046, ARN-048, ARN-049, ARN-050, ARN-054, ARN-093, ARN-094 or TST-109 (AT-09 is M2). These are gaps in the M3 acceptance set.
