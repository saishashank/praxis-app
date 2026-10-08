# Chapter 15 — Configuration Reference  (v2.0, session 10)

_Every tunable value in the spec, with default, unit, bounds for Lane-B tuning, who may edit it, and whether it must be verified at build. Values are per market unless marked "global". Changing a value creates a versioned config record (PLT-041, UX-116). Lane B may tune only keys marked **B** within their bounds; keys marked **O** are Owner-only; **—** = fixed by the spec (change requires a spec change). [V] = verify at build._

## 15.1 Arena and costs (Ch. 05)
| Key | Default (AU) | Unit | Bounds | Edit | Ref |
|---|---|---|---|---|---|
| seed | 600 | A$ | — | O | O-25, ARN-001 |
| target_multiple | 2.0 | × seed | — | O | PRD-003 |
| bust_fraction | 0.5 | × seed | — | O | ARN-052 |
| timeout_sessions | 252 | sessions | — | O | §5.1 |
| stall_floor | computed: min_marketable_parcel + entry brokerage + entry slippage (10 bps) + buffer (1% NAV) ≈ 511, same for U and L **(s11)** | A$ | — | — | §5.1 |
| stall_sessions | 5 | sessions | 3–10 | O | §5.1 |
| stall_parcel_rejections | 20 | sessions | 10–40 | O | §5.1 |
| decision_cutoff | 18:10 Melbourne (AU) | local time | — | O | ARN-020 |
| preopen_recheck | 09:55 local | local time | — | O | ARN-020a |
| max_open_positions | 2 | count | 1–2 | O | ARN-003 |
| min_marketable_parcel | 500 | A$ | — [V] | — | ARN-024 |
| participation_cap | 0.01 | × ADV | 0.005–0.02 | O | ARN-024 |
| cash_buffer | 0.01 | × NAV | 0–0.03 | O | ARN-024a |
| settlement_mode | matched | enum | matched/conservative | O | ARN-025 |
| suspension_haircut | 0.5 | fraction | 0.3–0.8 | O | ARN-026 |
| suspension_haircut_after | 20 | sessions | 10–60 | O | ARN-026 |
| cost_profile_default | P5 | enum | P0–P5b | O | ARN-031 |
| cost tables P0–P5b | per ARN-031 | A$ | — [V] | O | ARN-031 |
| slippage_buckets | 10/25/60/120 bps by ADV | bps | ±50% | O | ARN-032 |
| tick_table | 0.001/0.005/0.01 | A$ | — [V] | — | ARN-032 |
| tick_cross_factor | 1.0 | ticks | 0.5–2 | O | ARN-032 |
| stress_profile | P3 + 50% slippage | — | — | — | ARN-033 |
| sleeve_margin | min(20, 4% NAV) | A$ | — | O | ARN-040 |
| sleeve_leverage | 10 | × | — | O | ARN-040 |
| sleeve_allow_u2 (E10) | true | bool | — | O | ARN-042 |
| sleeve_closeout_pct | 0.5 | × margin | 0.3–1.0 | O | ARN-044 |
| sleeve_cost_profile | = execution profile | enum | P5 / CFD-type [V] | O | ARN-045 |
| sleeve_financing_rate | 0.09 | p.a. | — [V] | O | ARN-045 |
| recovery_mode | REC-2 | enum | REC-1…REC-4 | O | ARN-047 |
| reality_cap | 5 | × | — [V] | — | ARN-049 |
| c2_live_per_family | 20 | count | 10–50 | O | ARN-004 |
| rolling_start_step | 5 | sessions | 5–21 | O | ARN-080 |
| split_holdout / split_validation | max(378, 15 × block) / max(504, 15 × block) entry sessions, frozen per lineage (rest = development; completion window inside history; lineage-level roll at promotion or on Owner request) | sessions | — | — | ARN-082 |
| active_lineages_L | max(6, active lineages); active = has a live or challenger version not retired; the L used is recorded with each test and labels are not re-tested when L changes | — | — | — | ARN-081 |
| purge_sessions | upper bound of the lineage's maximum-holding-period parameter + 20 (e.g. F2: 90 + 20 = 110; F1: 120 + 20 = 140) | sessions | — | — | ARN-082 |
| lesson_split | (development − purge): L1 on first 2/3, L2 on last 1/3, n ≥ 30; re-frozen at each roll | — | — | — | ARN-063 |
| trial_budget_per_lineage | 20 per frozen validation split (cumulative, market-level ledger) | tests | — | O | ARN-085 |
| survivorship_flag_share | 5% | missing share per year | — | O | ARN-082 |
| useful_edge_min | +0.5% | per-trade net excess | — | O | ARN-086 |
| dsr_default_sr_variance | variance of the **daily** Sharpe ratio across the 6 families on development data (computed at M4, frozen per split) | — | — | — | VAL-110 (vi) |
| holdout_confirm_alpha | 0.05 ÷ L one-sided | — | — | — | ARN-086 |
| l2_alpha_investing | W₀ = 0.10; α_j = W/(2+W); payout 0.05; wealth carried across rolls; pool per lineage (+ one market pool for cross-family lessons); mFDR ≤ 0.10 | — | — | — | ARN-063 |
| pbo_min_variants | 5 | count | — | — | VAL-110 (v) |
| comparison_findings | weekly, BH q = 0.10, one confirmation look (α = 0.05) once ≥ 30 new rows and ≥ max(75, 15 × block) sessions (block = larger frozen block of the lineages compared); 60-session lockout after a failed confirmation | — | — | — | ARN-062 |
| forward_alpha_spending | (0.10 ÷ L) / 2^k at look k (every 100 trades) | — | — | — | ARN-086 |
| killswitch_looks | every 20 forward trades; α = 0.05/3 per criterion spent as α/2^k | — | — | — | ARN-093 |
| killswitch_max_looks_per_year | set yearly from measured trade rate | count | — | — | ARN-093 |
| safety_check_min_neff | 8 | effective cohorts | — | — | VAL-110 (iii) |
| c2_controls_per_row | 20 | count | ≥ 10 | — | ARN-004 |
| bootstrap_replications | max(1,000, 20 ÷ level used) ≈ 48,000 at α_i ÷ L (L = 6) | count | — | — | ARN-081 |
| min_blocks | 15 | bootstrap blocks per tested window | — | — | ARN-081/082 |
| min_trades / min_entry_window | 100 trades / frozen window lengths max(378, 15 × block), max(504, 15 × block) and ≥ 15 blocks | — | — | — | ARN-082/086 |
| bootstrap_block | circular block bootstrap over entry dates, block = max(5, p75 realised hold), measured once before the default layout and frozen with the window lengths per lineage; studentised statistic | — | — | — | ARN-081 |
| replay_light / replay_full | weekly ≤ 30 min / monthly ≤ 90 min | Actions min | — | O | ARN-100 |
| alpha | 0.05 | — | — | — | VAL-110 |
| delta_bust_tolerance | 0.05 | abs | — | O | VAL-110 |
| pbo_max | 0.2 | — | — | — | VAL-110 |
| dsr_min | 0.95 | — | — | — | VAL-110 |
| max_challengers | 8 | count | 1–8 | O | ARN-005 |
| max_promotions_per_week | 3 | count | 0–3 | O | ARN-065 |
| shakedown_sessions | 10 | sessions | 5–20 | O | ARN-065 |
| lesson_L1_min_n | 30 | samples | ≥ 30 | — | ARN-063 |
| comparisons_fdr_q | 0.10 | — | — | — | ARN-062 |
| progress_min_neff | 3 | effective cohorts (ARN-053 definition, development split) | — | — | ARN-071 |
| barrier_k_up / k_down | 2 / 1.5 | × ATR | 1–3 | O | ARN-072 |
| min_cohorts_ranked | 5 | effective cohorts (ARN-053) | — | — | ARN-078 |
| cost_feasibility_ratio | 2 | × round-trip cost | — | — | ARN-094 |
| nightly_tokens_per_market | 30,000 | tokens | 0–40,000 | O | ARN-068 |
| progress_nav_buckets **(s11)** | [0.5–0.75, 0.75–1.0, 1.0–1.25, 1.25–1.5, 1.5–1.75, 1.75–2.0] (fractions of seed) | — | — | O | ARN-071 |
| progress_sessions_buckets **(s11)** | [0–20, 21–60, 61–120, 121–250, >250] (sessions elapsed) | — | — | O | ARN-071 |

## 15.2 Universe and filters (Ch. 05 §5.3)
| Key | Default (AU) | Bounds | Edit | Ref |
|---|---|---|---|---|
| U1 rule | top 300 by 60-session median traded value + ETFs; price ≥ 0.50 | 200–400 | O | ARN-010 |
| U1/U2/U3 ADV minimum | 1M / 250k / 100k A$ | ±50% | O | ARN-010 |
| U1/U2/U3 price minimum | 0.50 / 0.20 / 0.10 A$ | — | O | ARN-010 |
| U2 min listed months / market cap | 12 / 30M A$ | — | O | ARN-010 |
| filter thresholds (5-session +100%, 1-session +30%, vol ratio 10, deep discount 15%, placements 2 in 120, consolidation 90, range 25% on 3 of 5) | as ARN-011 | ±50% | O | ARN-011 (Owner-only: universe filters are not Lane-B tunable) |
| promotional_keywords | **(s11)** list, default ["guaranteed", "10-bagger", "next big", "moon", "explosive", "huge upside"] | — | O | ARN-011 |

## 15.3 Families (Ch. 07 §7.4) — all **B** (Lane-B tunable within bounds)
| Key | Default | Bounds |
|---|---|---|
| F1 high_lookback | 250 | 120–250 sessions |
| F1 volume_ratio_min | 1.5 | 1.2–3 |
| F1 rs_top_fraction | 0.20 | 0.10–0.30 |
| F1 initial_stop_atr / trail_atr | 2 / 3 | 1.5–3 / 2–4 |
| F1 time_stop / min_gain | 40 / 5% | 20–60 / 0–10% |
| F1 max_hold | 120 sessions | 60–120 |
| F2 event_ar_min | +3% | 2–6% |
| F2 lookback_sessions | 5 | 3–10 |
| F2 stop_atr / time_stop | 2.5 / 60 | 1.5–3.5 / 30–90 |
| F3 event_ar_min / volume_ratio_min | +4% / 2 | 3–8% / 1.5–4 |
| F3 max_gap | +8% | 5–12% |
| F3 trail_after / trail_atr / time_exit | +10% / 2.5 / 20 | 5–20% / 1.5–4 / 10–40 |
| F4 rsi2_max / rsi14_max | 10 / 30 | 5–20 / 20–35 |
| F4 time_exit / stop_atr | 10 / 2 | 5–20 / 1.5–3 |
| F5 volume_ratio_min / ar_min / range_pos_min | 3 / +3% / 0.75 | 2–5 / 2–6% / 0.6–0.9 |
| F5 stop_atr / stop_cap / trail_atr / time_stop | 2.5 / −20% / 3 / 30 | 1.5–3.5 / −10…−25% / 2–4 / 15–45 |
| F6 min_classes / insider_min / short_drop_pp | 3 / +0.5 / 2 | 3–4 / 0.25–0.75 / 1–4 |
| F6 stop_atr / time_stop | 2 / 20 | 1.5–3 / 10–40 |
| reentry_block | 10 sessions | 5–20 |

## 15.4 Agents, regime, alerts (Ch. 07)
| Key | Default | Edit | Ref |
|---|---|---|---|
| regime thresholds (SMA 200, vol pct 70/95/50, 5-session fall 7%, exit hysteresis 3) | as AGT-101 | O | AGT-101 (Owner-only: shared by all families) |
| insider score weights (0.5/0.25/0.25, 30-session window, 2 pp) | as AGT-105 | B | AGT-105 |
| event polarity threshold | 2% | B | AGT-020 |
| r2_materiality_min | 2 | O | LLM-032 |
| alert_p0_weight | 10% NAV | O | AGT-115 |
| p0_email_daily_cap / batch window | 10 / 5 min | O | EML-020 |
| watch_list_window / owner_add_expiry | 20 sessions / 90 days | O | AGT-014 |
| sentinel_max_items_per_run | 40 | O | PLT-075 |
| scenario_min_n | 30 | — | AGT-110 |
| critic_llm_calls_per_night | 10 | O | LLM-021 |
| vision_gate | 90% on ≥ 200 charts | — | AGT-033 |

## 15.5 Data (Ch. 06)
| Key | Default | Edit | Ref |
|---|---|---|---|
| source pass bars (98% U1, 90% U2/U3, 4 of 5 days, ≤ 2% blocked) | as DAT-101 | — | DAT-101 |
| cross_check_tolerance | 0.5% | O | DAT-102 |
| refetch_diff_flag | 0.1% | O | DAT-002 |
| suspect_move | 40% | O | DAT-200 |
| u1_quality_gate | 95% | O | DAT-210 |
| asx_min_spacing | 65 s | — | DAT-122 |
| asx_poll_interval | 4 min (announcement hours; every second ASX slot) | O | DAT-122 |
| asx_slot_priorities | poll > pre-open > batch > PDF queue > backfill | — | DAT-122 |
| source_off_mode | per DAT-127 (ASX-off / Yahoo-off behaviour) | O | DAT-127 |
| ca_auto_confirm | single-source action consistent with price series → auto-confirmed | O | DAT-221 |
| asx_block_trip | > 5% 403/challenge over 1 h | O | DAT-122 |
| turso_recent_sessions | 500 | O | DAT-140 |
| turso ceilings (storage 3 GB, writes 6M/month, reads 300M/month, staging ≤ 15%) | as DAT-141 | O | DAT-141 |
| storage_warn_gb **(s11)** | 2.5 | GB | — | O | DAT-141 |
| storage_ceiling_gb **(s11)** | 3 | GB | — | O | DAT-141 |
| retention (logs 30 d, runs 180 d, news 400 d) | as DAT-142 | O | DAT-142 |
| backup retention 14 daily / 8 weekly / 12 monthly | as PLT-022b | O | PLT-022b |
| event_backfill_years | 6 | O | DAT-125 |
| event_coverage_min | 90% | — | DAT-125 |

## 15.6 Platform, email, security, ops (Ch. 02–04, 10–11)
| Key | Default | Edit | Ref |
|---|---|---|---|
| schedule times (PLT-073 table) | Melbourne local | O | PLT-073 |
| actions_minutes_soft_ceiling | 3,000/month (public code repo — standard runners free, O-29) | O | PLT-014 |
| quota thresholds | 70/90/95% per period | O | PLT-051 |
| sentinel_blind_alert | 15 min | O | PLT-018 |
| heartbeat_crons | Vercel Cron in the 00:xx and 11:xx UTC hours (fires anywhere in the hour; production only; wording PLT-011) | O | PLT-074 |
| watchdog_times | 20:40 and 21:50 Melbourne | O | PLT-014a, NFR-006 |
| offsite_backup_reminder | 40 days | O | OPS-020 |
| session_lifetime | 14 days | O | PLT-033 |
| rate limits (sign-in 10/min/IP, writes 60/min/user, exports 5/h/user) | as SEC-014 | O | SEC-014 |
| hmac_max_age | 300 s | — | SEC-017 |
| evening_review_time / partial_at / send_by | 20:00 / 20:30 / 20:45 | O | EML-010/011 |
| email_max_size | 90 KB | — | EML-013 |
| unopened_review_banner | 3 days | O | EML-036 |
| what_if_daily_limit_per_user **(s11)** | 5 | count per user | 0–20 | O | ROL-102a |
| llm token budgets per role | Ch. 03 §3.6 | O | LLM-050 |
| trains_on_prompts (per LLM provider) | per provider terms [V] | O | Ch. 03 |
| llm_cache_ttl_hours **(s11)** | 24 | hours | 1–168 | O | LLM-031 |
| llm_classifier_model **(s11)** | selected by LLM-040 bake-off (injection role) | model id | provider list [VERIFY at build] | O | KB-032 |
| unmask_expiry | 30 days | O | UX-009 |
| ci_minutes_budget | soft 1,000/month (s13, TST-132) | O | TST-114 |
| actions_reserve | last 10% of the monthly budget reserved for batches, backups, watchdog | — | NFR-005 |
| email_reserved_slots | 3 per day (Evening Review, new S1/S2 incident, EML-023 attention reminder) (s14) | — | EML-004, EML-023 |
| token_warning_days | 14 / 7 / 2 | O | SEC-021 |

## 15.7 Keys added in session 13 **(s13)** (active)
| Key | Default | Bounds | Edit | Ref |
|---|---|---|---|---|
| zero_edge_trials | 20,000 | 5,000–100,000 | O | PRD-020 |
| zero_edge_seed | fixed, stored at build | — | — | PRD-020 |
| llm_injection_phrases | versioned phrase list | list | O | LLM-035 |
| llm_budget_r1_daily | 60,000 tokens | 30,000–90,000 | O | LLM-050 |
| llm_budget_r2_daily | 50,000 tokens | 25,000–75,000 | O | LLM-050 |
| llm_budget_r3_daily | 25,000 tokens | 12,500–37,500 | O | LLM-050 |
| llm_budget_r5_daily | 10,000 tokens | 5,000–15,000 | O | LLM-050 |
| llm_daily_budget_total | 150,000 tokens | 75,000–225,000 | O | LLM-050 |
| llm_market_share | AU 1.0 until another market is active | shares sum to 1 | O | LLM-050 |
| email_daily_cap | 20 | 5–50 | O | EML-004 |
| email_monthly_cap | 300 | 50–1,000 | O | EML-004 |
| unopened_review_incident_days | 7 | 3–14 | O | NFR-006, EML-036 |
| diff_coverage_min | 90% lines on changed code | 80–100% | O | TST-120 |
| diff_branch_min | 80% branches on changed code | 70–100% | O | TST-120 |
| coverage_overall_min | 80% overall; 90% critical modules | 70–95% | O | TST-121 |
| mutation_score_min | 80% (money, statistics) | 60–95% | O | TST-130 |
| attention_reminder_enabled | on | on/off | O | EML-023 |
| attention_reminder_time | 08:00 Melbourne | 06:00–22:00 | O | EML-023 |
| attention_snooze_max_days | 7 | 1–14 | O | EML-023 |

## 15.8 Keys from ch. 16 **(s13)** — **active** for the accepted P1 items (O-38, s14); a key whose item is P2/P3 stays inactive
| Key | Default | Bounds | Edit | Ref |
|---|---|---|---|---|
| overview_max_per_night | 20 | 0–60 | O | UXN-272 |
| overview_refresh_days | 7 | 1–30 | O | UXN-272 |
| intraday_codes_max | 150 | 0–300 | O | UXN-048 |
| intraday_refresh_min | 5 | 2–15 | O | UXN-048 |
| watchlist_max | 50 | 10–200 | O | UXN-047 |
| picks_per_profile | 5 | 0–10 | O | AGT-113 |
| pick_profiles | Aggressive / Balanced / Conservative caps as AGT-113 (tiers, max % per pick 20/10/5, risk per pick 2/1/0.5 %) | each cap 0–100 % | O | AGT-113 (s14) |
| profile_portfolio_amount | A$10,000 per profile | A$1,000–1,000,000 | O | AGT-113, UXN-040 (sizing examples only) (s14) |
| picks_max_per_family | 2 | 1–5 | O | AGT-113 |
| pick_valid_sessions | 2 | 1–5 | O | UXN-040, AGT-113 |
| pick_success_min_n | 30 | as ch. 16 | O | UXN-041 |
| factor_min_bucket_n | 30 | 20–100 | O | AGT-112 |
| factor_buckets | terciles of the development distribution | terciles / quintiles | O | AGT-112 (s14) |

## Acceptance criteria — Chapter 15
- **Given** any threshold used in code, **then** it is a key in this chapter (or added here with a decision-log entry) — checked by a CI grep of config keys vs code references.
- **Given** a Lane-B challenger, **then** it changes only **B** keys and stays within their bounds.
- **Given** an Owner edit, **then** a new config version with before/after and audit event exists.
