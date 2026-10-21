# M3 design note: practice engine and paper-trading arena (PROPOSAL)

Status: draft by Sonnet for Opus (architect; owner of money maths, AGENT_PLAN §4). Inputs: `docs/M3_requirements.md` (cited as "REQ"), spec ch.05/10/12-15, migrations 0001-0006, `docs/M2_design.md`, D-001..D-068. Everything below is a proposal; section 6 lists what Opus must decide. Spec IDs are cited as written; nothing here changes spec text.

## 1. Scope

| In M3 (ch.12 §12.3: cost profiles, fills/stops, settlement, sleeve and lockout, cohorts, controls C1-C3, ledger invariants, reproducibility; AT-10..AT-13) | Not in M3 |
|---|---|
| Money library (integer) and cost/slippage/tick modules (ARN-030..032) | Family signal rules F1-F6, indicators, Decision Cards (ch.07; M4/M5). M3 consumes **order intents** from fixtures/tests only |
| Order sizing, parcel/participation/whole-share rules, fills incl. IS/CS exits and gap-through-stop (ARN-020..024a) | Pre-open 09:55 re-check route (ARN-020a, M5, AT-18) |
| Settlement T+2, NAV, nightly ledger invariants (ARN-025, 051, 101) | Scorecards, CIFs, effective-N *reporting*, labels, replays, validation (ARN-070..087, M4); M3 stores enough to compute them |
| Dividend / DAT-223 / suspension-haircut cash effects, split neutrality (ARN-026, 036, 043) | Tier recompute and ARN-011 filters (ARN-010..014 use the M2 `universe_snapshot` tier as given) |
| Sleeve (margin, 10x, close-out, financing, lock, REC-1..4, shadow log) (ARN-040..048) | Kill-switch evaluation (ARN-093), cost-feasibility label (ARN-094), 5x "reality" display (ARN-049) - tables only |
| 12 executions + C1-C3 cohort start/terminal/restart/twins (ARN-001..004, 052, 053, §5.1) | C2 random-entry *selection* (needs family entries, M4); M3 builds the C2 **exit mapping** (TST-101) and the cohort shell |
| Reproducibility: stored params/versions/seed/snapshot, byte-identical replay (ARN-102, NFR-022, TST-102/104) | Other markets (ARN-000: AU only); live trading; arena stays `data_only` in production (BLD-024) |

Gaps with no M3 AT (REQ §5 item 12) get unit tests mapped in `docs/test-map.md`, as in D-057 #14.

## 2. Money representation (top priority)

### 2.1 Units and types
| Quantity | Stored as | Notes |
|---|---|---|
| Cash, fees, fills value, NAV, P/L, dividends, financing, sleeve margin | `INTEGER` **micro-AUD** (1e-6 A$), signed, column suffix `_micro` | SQLite INTEGER is 64-bit; 9.2e18 micro = A$9.2e12, no overflow risk. Engine uses JS `BigInt` for every intermediate; DB read with libsql `intMode: "bigint"` [VERIFY in T1] |
| Prices (open/close/stop/level/fill/slippage amount) | `INTEGER` micro-AUD per share | A tick (A$0.001 = 1000 micro) is a whole multiple of the unit; all ASX ticks are exact |
| Quantity | `INTEGER` shares | whole shares only (ARN-023) |
| Rates, factors, haircuts, fractions (0.12%, 1%, 0.9, 9% p.a., tick_cross_factor 1.5) | exact rational `{num, den}` of `BigInt`, parsed from the **decimal string** in config (never `Number`) | e.g. `0.12%` = 12/10000; `1.0`=1/1; fixes ch.15 floats from entering money paths |
| bps | integer num over 10000 | |
| Display | cents, derived at render only | `round_half_up(micro / 10000)`; never written back |

Rules: **no float touches stored money** (CI lint: ban `Number`/`parseFloat`/`toFixed` in `src/lib/arena/**` and the money module; AST test). M2 `price_bar` columns are `REAL` (0004): the single conversion `toMicro(x: number)` = `BigInt(Math.round(x*1e6))`, and it asserts `|x*1e6 - round| < 1e-3` (vendor price with more than 6 dp is flagged, bar rejected from sizing, never silently rounded). Adjusted prices (`adjusted.ts`) are **never** used for money (ARN-032 "raw prices"); only the split-neutral sleeve return uses the factor (section 4.5).

### 2.2 Rounding: one mode, few places
**Mode (proposal): round half away from zero ("half-up on magnitude") on exact rationals, applied once per quantity.** Rationale: hand-computable for TST-101 (Haiku/Opus checking by pencil), sign-symmetric for P/L, and ties at 0.5 micro are practically unreachable (so half-even's bias benefit is nil). Alternative half-even: same results except exact .5-micro ties; costs explanation. Decision 7.

| # | Where rounding happens | Rule | Why |
|---|---|---|---|
| R1 | **Fill price** = reference price +/- slippage | slippage amount computed as exact rational, **buy: ceil, sell: floor, to the tick grid** (adverse to the trader); fill is a whole number of ticks | ARN-032/021 examples are tick multiples (A$9.80 -> A$9.81); no spec rule, REQ §5 item 6 |
| R2 | **Brokerage** (percentage tiers: P2, P4, P5 above A$25,000, P5b above A$1,000) | `fee = round_half_away(value_micro * rate)` to 1 micro, **per fill, once** | exact in micro for all fixed-A$ tiers; percent tiers differ from A$ cents by < A$0.000001 |
| R3 | **Dividend entitlement** = shares x per-share amount | per-share amount stored as micro (vendor gives <= 4 dp); product exact, no rounding. If vendor gives > 6 dp: round_half_away to micro on the per-share amount once, recorded | |
| R4 | **Sleeve price P/L** at close: `notional x (exit - entry)/entry` | exact rational, rounded **once** at the close fill; mark-to-market P/L recomputed from scratch each day from the same formula (not accumulated) | no drift |
| R5 | **Sleeve financing**: `exposure x 9% x days/365` | rounded **once per day from the cumulative formula** (`accrued(d) = round(E*r*days_d/365)`; day's charge = accrued(d) - accrued(d-1)) | sum of daily rows equals the one-shot figure exactly |
| R6 | **Suspension haircut / liquidation NAV estimates** | `round_half_away(qty*price*haircut)` once per position per day | |
| R7 | **Shares** | `floor` (ARN-023/024a) | spec |
| R8 | **Cents** | **never in storage.** Option B (decision 6): round each fee to cents like a real broker | |

NAV, cash, ledger balances and every aggregate are **sums of integers** - no rounding at day or NAV level, so the ledger invariants (ARN-101) hold with exact equality, not tolerances.

### 2.3 TST-101 reproduced exactly
Order value and fee in micro (A$1.00 = 1,000,000):

| Case | Value (micro) | P5 rule | Fee (micro) = A$ |
|---|---|---|---|
| A$1,000.00 | 1,000,000,000 | <= 1,000.00 | 5,000,000 = 5.00 |
| A$1,000.01 | 1,000,010,000 | > 1,000.00, <= 3,000.00 | 10,000,000 = 10.00 |
| A$3,000.00 / 3,000.01 | 3,000,000,000 / 3,000,010,000 | 10.00 / 19.95 | 10.00 / 19.95 |
| A$10,000.00 / 10,000.01 | | 19.95 / 29.95 | |
| A$25,000.00 | 25,000,000,000 | <= 25,000.00 | 29,950,000 = 29.95 |
| **A$25,000.01** | 25,000,010,000 | 0.12% = 12/10000 | 25,000,010,000 x 12 / 10,000 = **30,000,012 micro = A$30.000012** (exact; no rounding needed) |

Note: the brief for this note quotes "A$30.00012" for A$25,000.01; the arithmetic gives **A$30.000012** (25,000.01 x 0.0012). Flagged for Opus (decision 17); fixtures must carry the exact value. If cent-rounding (R8/B) is chosen the case yields A$30.00.

Worked sizing (spec Acceptance l.137): A$600, buffer 1% of NAV = 6,000,000; price A$9.80 = 9,800,000; ADV bucket 10 bps -> 9,800,000 x 10/10,000 = 9,800 micro; tick(9.80)=10,000 micro (>= A$2.00); tick-bps = 10,000 x 10,000/9,800,000 = 10.2 bps > 10 -> slippage = max(ceil_to_tick(9,800), 1.0 x 10,000) = 10,000 -> **fill 9,810,000**. Est. brokerage for sizing = P5 on the whole deployable (594,000,000 -> 5.00 = 5,000,000); deployable = 600,000,000 - 6,000,000 - 5,000,000 = 589,000,000; shares = floor(589,000,000 / 9,810,000) = **60** (61 x 9.81 = 598.41 > 589); cost 588,600,000 + actual brokerage P5 (588.60 -> 5.00) = 593.60 <= 594. U3 at A$0.20: tick(0.20)=0.005; tick-bps = 5,000x10,000/200,000 = 250 bps (matches the spec's "250 bps"); fill 205,000.

### 2.4 Tick-size table ([VERIFY])
`tick(p)`: p < 0.10 -> 1,000 micro; 0.10 <= p < 2.00 -> 5,000; p >= 2.00 -> 10,000 (ARN-032 as written; band edges: lower-inclusive). Stored as a versioned config table (`tick_table`, ch.15, fixed) with `verified=0` until the Owner approves a source (REQ §4); tests use the table as written. `tick(p)` is evaluated on the **reference price**; if the slipped fill crosses into a coarser band, it is re-rounded (buy ceil / sell floor) on the new band's grid; a pure function with a table test at 0.0999/0.10/1.995/2.00.

Other [VERIFY] numbers (A$500 parcel, P0-P5b tables, 9% financing, ETF code) are loaded as config with a `verified` flag; the Arena stays `data_only` in production until the Owner has approved them (BLD-024, BLD-030).

## 3. Tables (migration `db/migrations/main/0007_arena.sql`)

Conventions as 0004 (ISO-8601 UTC ms text for instants, `d` = Sydney trading date, `*_micro INTEGER`, 0/1 CHECKs, `INSERT ... ON CONFLICT DO NOTHING`, never `REPLACE`). **Everything is retained forever** (DAT-142: money-trail tables are not pruned). Volume: ~25 execution rows; ~265 live cohorts (12 E + C1 + 6x20 C2 + 6x20 C3, REQ 2.4) -> `nav_daily` ~265 rows/session = ~5.6k/month plus shadow cohorts; ledger ~3-4x that; total well under 1% of the 6M writes/month ceiling (DAT-141); storage ~100-150 MB/year [estimate, check in T3].

| Table | Key / main columns | Mutability |
|---|---|---|
| `execution` | `id` PK ('E01'..'E12','C1','C2-F1'..,'C3-F1'..), `market`, `kind` (E/C1/C2/C3), `family`, `variant` U/L, `twin_group`, `rule_version`, `cost_profile`, `status` | insert; `status`, `rule_version` updatable (guard trigger); no delete |
| `cohort` | `id` PK, `execution_id`, `control_idx` NULL (1..20 for C2/C3), `start_d`, `seed_micro`, `rule_version`, `params_json` (resolved config copy + hash), `cost_profile_version`, `sleeve_json`, `data_snapshot_id`, `rng_seed`, `twin_group`, `restart_of`, `live` 0/1 (0 = shadow), `terminal_kind` (target/bust/stalled/timeout), `terminal_d`, `ttd_sessions`, `ttd_days`, `outcome_micro` | one-way: `terminal_*` NULL -> value once (trigger like `trading_calendar_guard_update`); else immutable |
| `cohort_event` | `(cohort_id, seq)`; `kind` (start, terminal, restart, shadow_continue, lock, unlock), `d`, `detail_json` | append-only |
| `order` | `id` PK, `cohort_id`, `decided_d`, `fill_d`, `code`, `side`, `kind` (entry, exit_cs, exit_is, sleeve_open, sleeve_close), `qty`, `ref_stop_micro`, `status` (pending/filled/rejected/cancelled), `reject_reason` (parcel, whole_share, participation, cash, gate, halted, ...), `tier`, `untradeable_flag`; UNIQUE (cohort_id, decided_d, code, kind) | status moves pending -> one terminal value (trigger); every family signal produces one row, so stall (b) "every signal rejected only for parcel/whole-share" is a query |
| `fill` | `id` PK, `order_id` UNIQUE, `cohort_id`, `d`, `code`, `side`, `qty`, `rule` (open / level / gap_open / close_signal), `ref_price_micro`, `slip_micro`, `fill_price_micro`, `value_micro`, `brokerage_micro`, `cost_profile`, `bar_o/h/l/c_micro` (evidence copy) | **append-only** (no UPDATE/DELETE) |
| `trade` | `id` PK, `cohort_id`, `code`, `entry_fill_id`, `exit_fill_id` NULL, `exit_type` (IS/CS/terminal/legacy), `stop_micro`, `legacy` 0/1 | open row; one NULL -> value close (trigger). **Positions are derived** (open trades x qty), plus a daily snapshot inside `nav_daily_pos` (below) |
| `cash_ledger` | `id` PK, `cohort_id`, `d`, `txn_id`, `account` (cash_settled, cash_recv, cash_pay, div_recv, sleeve_margin, fin_accrued, fees_paid), `delta_micro` signed, `kind` (seed, buy, sell, brokerage, settle, div_accrue, div_pay, sleeve_open/close/pnl, financing, ca_comp, reversal), `ref_type`, `ref_id`, UNIQUE (cohort_id, d, txn_id, account) | **append-only**; double entry: rows of one `txn_id` must net to zero across (cash + non-cash counter accounts) - the writer checks, the nightly invariant re-checks. Corrections are compensating `reversal` rows, never updates |
| `nav_daily` | PK (cohort_id, d); `cash_settled_micro`, `recv_micro`, `pay_micro`, `positions_micro`, `div_recv_micro`, `sleeve_margin_micro`, `sleeve_unreal_micro`, `fin_accrued_micro`, `nav_micro`, `liq_nav_micro`, `open_positions`, `invariants_ok` | append-only |
| `nav_daily_pos` | PK (cohort_id, d, code): `qty`, `close_micro`, `value_micro`, `haircut` 0/1 | append-only (reproducibility evidence, positions-as-of-close) |
| `sleeve_trade` | `id` PK, `cohort_id`, `code`, `margin_micro`, `leverage`, `notional_micro`, `entry_fill_id`, `exit_fill_id` NULL, `price_pl_micro`, `financing_micro`, `closed_by` (exit/closeout), `shadow` 0/1 | one close update (trigger) |
| `sleeve_state` | `(cohort_id, seq)`: `state` (unlocked/locked), `d`, `loss_to_recover_micro`, `mode` | append-only |
| `cost_profile` | PK (`code`, `version`): `tiers_json`, `slippage_json` (buckets), `source`, `verified` 0/1, `effective_from` | append-only, versioned; cohorts pin the version (ARN-102, ARN-034 replay) |
| `arena_control` | `id`, `scope` (market/family/execution), `scope_key`, `state` (enabled/paused/killed), `set_at`, `set_by`, `reason` | append-only event log; current = latest row. Holds Owner pause and the ARN-093 kill-switch *state* (evaluation is M4). Distinct from "controls C1-C3", which are executions |
| terminal states | columns on `cohort` + `cohort_event` (no separate table) | see above |

Append-only = pattern of 0004 (`BEFORE UPDATE/DELETE ... RAISE(ABORT,'append-only')`); tests: attempted UPDATE/DELETE on every table fails; `INSERT OR REPLACE` is documented as banned (it bypasses delete triggers). Hot indexes: `fill(cohort_id,d)`, `order(cohort_id,status)`, `cash_ledger(cohort_id,d)`.

## 4. Engine flow

### 4.1 Batch timing (ARN-060 vs ch.13)
ARN-060 needs D's open fills/IS exits/corporate actions/settlement **before** signals (cash and positions drive sizing and `max_open_positions`); ch.13 puts the whole of "close the books" at 18:40, after the 18:10 orders. **Proposal:** split it. **Batch 2a "close the books"** (new, ARN-060 verbatim order) runs as soon as Batch 1 for D has its `completion_marker` and the quality gate has run, and before 18:10; **Batch 2b** (18:10 cut-off, signals/orders for D+1) reads the closed ledger; **Batch 3** (18:40) keeps attribution/comparisons/controls/lessons and re-runs the invariants as a check. Amend the ch.13 row. If Batch 1 is late, 2a waits and 2b is skipped (existing data-incomplete rule), never run on a stale ledger. 2a/2b/3 each write a `run_record` with key `arena-<phase>:<market>:<d>` (cf. `batch1:${market}:${d}`, D-062) so the Worker/watchdog treat them like Batch 1.

### 4.2 Close the books for day D (per cohort, deterministic order: cohort id asc, order id asc)
1. Preconditions: market mode `full` or `data_only` replay; D is a `trading_calendar` session (ARN-027); `completion_marker` for D; else skip with a run record.
2. Fill orders with `fill_d = D` against D's raw bar; then evaluate IS stops of positions (including those opened this session) on D's bar.
3. Corporate actions with `ex_date = D` (cash effects 4.5), dividends payable on D, sleeve financing (calendar days since last accrual), suspension/halt handling.
4. Settle (T+2 sessions from `trading_calendar`), mark to market, write `nav_daily`/`nav_daily_pos`.
5. Invariants (ARN-101): cash >= 0; no shorts; sleeve-margin balance = open sleeve margin or 0; sleeve price+financing loss <= margin; lock state consistent; `nav` re-derived from the ledger equals stored NAV (exact); each `txn_id` nets to zero. A violation marks `invariants_ok=0`, writes an app_log error and the run record `failed`; no later phase runs for that cohort.
6. Terminal checks on **liquidation NAV** (Target/Bust/Stalled/Timeout, §5.1; sleeve-lock/unlock REC-1..4). A terminal close queues liquidation orders at D+1 open under normal fill rules (ARN-053), the next cohort starts at the open after that; the twin (and U/L pair, C-controls) restarts together; the unfinished other cohorts continue in shadow (`live=0`).

### 4.3 Fill model (ARN-020/021/024/030/032), all in `src/lib/arena/fills.ts` pure functions
- Decision on D uses data before the cut-off; **fill at D+1 open** for entries and CS exits. Entry fill = open + slippage (R1 ceil); exit = open - slippage (floor).
- **IS stop** (long): if open <= level -> fill at open - slippage; else if low <= level -> fill at level - slippage - 1 tick (rounded per R1). Initial stop is set **from the actual fill** (TST-101). If stop and a close signal both apply, the earlier fill wins; ambiguous intrabar order (e.g. stop and entry same session) assumes the worse outcome (stop hit after entry fill).
- Slippage = max(ADV bucket bps, tick-bps x `tick_cross_factor`) expressed as a price amount then rounded per R1 (decision 9 for bucket edges and ADV < A$100k).
- Parcel: new holding >= A$500 (`min_marketable_parcel`, order value after rounding down); participation <= 1% of 20-session ADV (shares); failures -> `order.status='rejected'` with reason. Trades > 0.5% ADV or U3 labelled `untradeable_flag` (ARN-013; threshold is not in ch.15 - add `untradeable_adv_pct` 0.005, decision 12).
- Sizing (ARN-024a): deployable = settled/matched cash - sleeve margin (only if both fit, ARN-003) - est. brokerage (P5 on the whole deployable) - 1% of NAV buffer; shares = floor(deployable / expected fill incl. slippage); actual brokerage recomputed after share count; no iteration.
- Halts (`universe_snapshot.halted` / suspension): no fill, frozen at last price; after 20 sessions marked at haircut (rational 1/2) (ARN-026), position moves to the legacy ledger when a cohort ends.

### 4.4 Costs (ARN-030..035)
`cost_profile` rows define P0..P5b; `brokerage(profile, side, value_micro, ctx)` pure. P5 tiers use `<=` upper bounds exactly as ARN-031; P2 uses "first buy < A$1,000 per security per day" (needs same-day buy memory per cohort and code: derived from `fill`); P4 min/max applied after the 0.03% rounding. P0 "zero-fee list else P1": list empty until supplied (decision 10). ARN-033 stress column (P3 + 50% slippage) and ARN-034 replay are pure re-pricing over stored `fill` rows: stored `ref_price_micro`/bar evidence make this possible without re-running (M4 consumes).

### 4.5 Corporate-action cash effects
`rules.mjs` already says cash dividends/special/rights/mergers do not adjust prices (f=1) and leaves cash to the simulator (DAT-223 rights valuation function exists at ~l.226). M3 adds `src/lib/arena/corpActions.ts`, called in step 3 of 4.2, reading `corporate_action` (confirmed only, `corporate_action_event`) and `adjustment_factor` (ex_date <= D):
- **Dividend:** entitlement = shares held at the **prior session's close** (from `nav_daily_pos` of D-1); on ex-date write ledger `div_accrue` (div_recv +, counter `div_income`); on pay date `div_pay` (div_recv -, cash_settled +). Franking stored on the dividend record (`ref_id` payload), excluded from NAV (ARN-036). Special dividends identical.
- **Entitlement offers (DAT-223):** non-renounceable -> nothing; renounceable -> rights at last traded price if traded else 0, credited as `ca_comp` cash, shares x rights ratio.
- **Splits/consolidations:** no cash, no P/L (ARN-043); quantity and recorded price basis are re-expressed via the factor (positions stored in pre-split terms with factor-adjusted marks, or re-based - decision 14); sleeve return series uses the adjustment factor so notional/margin are unchanged.
- **Cash mergers / delisting:** delisting at last price, administration -> 0 (ARN-026); cash merger pays on the DAT-223 terms.
- DAT-222 "unresolved => entries blocked, resolution recomputes from the event date": recompute **by appending reversal + replacement ledger rows**, never edits (decision 13).

### 4.6 Idempotency, re-runs, gate
- Every writer is `INSERT ... ON CONFLICT DO NOTHING` on natural/unique keys (above); re-running D for the same data snapshot is a no-op. `run_record.concurrency_key` + `hasSuccess` (runRecord.ts) blocks duplicate runs; stage-level resume as in Batch 1.
- Replay / AT-13: the same inputs produce byte-identical `fill` and `nav_daily` rows; no clock reads, no `Math.random` (C2 uses a seeded integer PRNG stored as `rng_seed`; ordering fixed); `data_snapshot_id` = id of the last successful Batch 1 run record + max `ingested_at` for D. A test replays 3 years twice and compares serialized rows (TST-102).
- **Quality gate (DAT-210, `gate.ts`):** `entriesAllowed()` is called when **creating entry orders (2b)** and again at **fill time (2a)**: a failed/blocked code turns a pending entry into `cancelled('gate')`. `exitsAllowed()` always true - stops, CS exits, terminal liquidations and sleeve close-outs always execute (reduce risk). A bar flagged bad is still the only data available; exits use it and the flag is recorded on the `fill` row `bar_*` evidence.

## 5. TST-101 test-table plan
- **Format:** one JSON file per case family in the private fixtures repo, `arena/tst101/<id>.json`, loaded through `PRAXIS_FIXTURES_DIR` (the `fixtures` CI job; skips locally, as M2 T5). Each row: `id`, `req` (spec IDs), `inputs` (config values as decimal strings, prices/amounts as **decimal strings or micro integers**, never floats), `expected` (micro integers) and `work` (a short hand computation as text, so Opus can check by pencil). A schema test rejects a float. Cases are invented numbers (no market data); a *small* mirror of the spec-quoted examples (the 8 boundary values, A$9.80 -> 60 shares, ARN-021 examples, stall at A$505/A$520) is also committed in `tests/` so a local run catches regressions without the private repo.
- **Coverage:** every item of the TST-101 list (REQ 2.10) plus one on each side of every P5 boundary and one parcel rejection. Parametrised tests set `stall_sessions=5`, `stall_parcel_rejections=20` explicitly (decision 2).
- **Who:** Haiku drafts the rows from the spec text (inputs + expected + `work`, mechanical arithmetic) *before* the engine code exists (blind), and a second Haiku pass recomputes `expected` independently with a throw-away script using Python `fractions.Fraction`; any difference is listed. **Opus line-reviews every `work` line and expected value** (AGENT_PLAN §4: money maths), signs off in the file header (`reviewed_by`, date). Sonnet implements against the table and may not edit `expected`; an engine/table mismatch goes back to Opus. The table also seeds the 3-year golden dataset (TST-102, M2 fixtures) and the property tests (TST-104: random order sequences keep ARN-101 invariants).
- Targets: 90% coverage on `src/lib/money/**` and `src/lib/arena/**` money paths (TST-121), mutation score >= 80% weekly (TST-130) on the money module.

## 6. Open decisions for Opus
1. **ARN-060 vs ch.13 timing** - A: split into 2a (before signals) / 2b / 3 (recommended); B: keep ch.13 and sign orders on a provisional ledger (rejected: sizing would use stale cash).
2. **TST-101 hard-coded 5/20 vs ch.15 tunable** - recommend: tests inject the values; fixtures record them; amend TST-101 wording to "at default settings".
3. **ARN-080 replay start (every 5 vs 5-21)** - recommend default 5 = lower bound, M4 reads `rolling_start_step`; no M3 code.
4. **Stall floor 10 bps vs one tick** - A: fixed A$511.00 constant (recommended; matches AT-11 A$505/A$520); B: formula per candidate. Exact sum is A$510.61; spec text should say "round up to A$511".
5. **`loss_to_recover`** - recommend: positive micro amount = the locking sleeve trade's total net loss (price P/L + financing + brokerage + slippage); unlock when unlevered realised net P/L since lock (stock trades, net of costs) >= it; fixed definition, no key.
6. **Fee rounding** - A: micro precision, A$30.000012 (recommended; exact, no cents invented); B: cents per fee (broker-realistic, requires a rule and shifts TST-101 values).
7. **Rounding mode** - half-away-from-zero (recommended) vs half-even.
8. **Financing day count** - 365, every calendar day the sleeve is open (FIX-042), exposure = notional, charged cumulatively (R5); amend ch.05.
9. **Slippage details** - ceil/floor to tick (R1, recommended), band edges lower-inclusive, ADV < A$100k -> 120 bps bucket with tick floor (U3 case 250 bps comes from tick), `tick_cross_factor` non-integer rounded on the grid.
10. **P0 zero-fee list** (empty until sourced) and P2 operator `<` vs `<=`: implement as written, `verified=0`.
11. **Positions stored or derived** - derived from `trade`/`fill` + `nav_daily_pos` snapshot (recommended) vs mutable `position` table (rejected: mutability).
12. **Untradeable threshold** - add `untradeable_adv_pct` 0.5% to ch.15 (O).
13. **DAT-222 recompute** - reversal + replacement rows (recommended) vs rebuild cohort from event date (breaks append-only).
14. **Split representation** - re-base quantity in the ledger via factor on the ex-date (recommended: quantity x 1/f as a recorded `ca_adjust` event, price from raw bars) vs adjust history.
15. **Settlement semantics** - `matched`: sale proceeds fund new buys immediately (matched with the buy's own T+2), appear as `cash_recv`; `conservative`: proceeds deployable only after T+2. Recommend this reading; ARN-025 is silent.
16. **Where the engine runs** - GitHub Actions job dispatched like Batch 1 (D-062), Node, no Vercel limits (recommended) vs Vercel route (time limit risk for 265 cohorts x 3 years replay).
17. **Brief typo** - A$30.00012 vs exact A$30.000012 (section 2.3); confirm exact is intended.
18. **`libsql` bigint mode** and a CI lint banning floats in money paths - confirm acceptable.
19. **Shadow sleeve (ARN-048) and 5x display (ARN-049)** - M3 logs shadow trades only; display in M4/M6.
20. **[VERIFY] approvals** (parcel A$500, P0-P5b, tick table, 9%, ETF code) - Owner action; blocks `full` mode, not coding.

### Architect decisions (Opus, 2026-10-11 — D-069)
1. **Timing:** split "close the books" into batch 2a (before signals), 2b at 18:10, batch 3 at 18:40 — as recommended.
2. **TST-101 5/20 sessions:** tests inject the configured values; the table states "at default settings".
3. **Replay start:** default 5 sessions (ch.15 lower bound); no M3 code.
4. **Stall floor:** slippage = **max(10 bps, one price tick)**, rounded adverse to the trader — not a fixed dollar figure.
5. **loss_to_recover:** the total net loss of the sleeve trade that caused the lock; REC-2 unlocks on unlevered realised net P/L since the lock.
6. **Fee precision:** micro-AUD (P5 at A$25,000.01 = **A$30.000012** exactly; the earlier brief's A$30.00012 was a typo).
7. **Rounding mode:** half-away-from-zero, once per quantity, on the exact rational.
8. **Financing:** divide by 365, every calendar day the sleeve is open, charged cumulatively; ch.05 to be amended accordingly.
9. **Slippage buckets:** round to tick; bucket edges lower-inclusive; ADV below A$100k uses the 120 bps bucket.
10. **P0 list / P2 boundary:** implement as written, flagged [VERIFY].
11. **Positions:** derived from fills and trades, never a mutable table.
12. **New key** `untradeable_adv_pct` = 0.5 % (ARN-013 had none).
13. **DAT-222 recompute:** append reversal + replacement rows.
14. **Splits/consolidations:** re-base quantity by the factor on the ex-date (cash unchanged).
15. **Settlement:** `matched` = sale proceeds fund buys immediately; `conservative` = wait for T+2.
16. **Where it runs:** a GitHub Actions job like Batch 1 (approved commit, production env, no Vercel route).
17. **Exact values** as in 6.
18. **libsql** reads money columns in bigint mode; a CI test bans floating-point arithmetic in money modules.
19. **Shadow sleeve** (ARN-048) logged in M3; the 5x display (ARN-049) waits for M4/M6.
20. **Owner [VERIFY] items** (A$500 parcel, P0–P5b tables, tick table, 9 % financing, C1 ETF code) must be approved by the Owner before `full` mode; they do not block coding.

## 7. Task breakdown (ordered; HR = high-risk, finished properly regardless of pacing, AGENT_PLAN §4)

| # | Task | Files (new unless stated) | Tests | HR | Owner action |
|---|---|---|---|---|---|
| T1 | Money library: micro BigInt, rationals, rounding R1-R7, tick table, config decimal parsing, `toMicro`, float-ban lint | `src/lib/money/{micro,rational,round,tick}.ts`, `scripts/ci/no-float-money.mjs` | unit + property (fast-check style) incl. section 2.3 worked values; Fraction cross-check | HR | none |
| T2 | Cost and slippage modules, profiles P0-P5b, config registry entries (`stall_floor`, `untradeable_adv_pct`, ...) | `src/lib/arena/{costs,slippage}.ts`, `src/lib/config/keys.ts` (edit) | TST-101 P5 boundaries, tick slippage, P2/P4 | HR | none |
| T3 | TST-101 known-answer table (Haiku draft, second recompute, Opus line-review) + loader | fixtures repo `arena/tst101/*`, `tests/arena/tst101.test.ts`, `tests/fixtures/synthetic/` mirror | schema test (no floats); skip-if-absent | HR (review) | Opus sign-off |
| T4 | Migration 0007 + `schema.ts` types + guard triggers | `db/migrations/main/0007_arena.sql`, `src/lib/arena/schema.ts` | append-only/one-way trigger tests per table, migration up/down, repo-hygiene | HR | none |
| T5 | Sizing and fill engine (ARN-020..024a, IS/CS, gap, stop from fill, parcel/participation) | `src/lib/arena/{sizing,fills}.ts` | TST-101 order/fill cases | HR | none |
| T6 | Ledger, settlement T+2, NAV, liquidation NAV, invariants | `src/lib/arena/{ledger,nav,invariants}.ts` | TST-101 settlement/NAV; TST-104 property tests | HR | none |
| T7 | Corporate-action cash effects (dividend, DAT-223, split/consol neutrality, haircut/legacy) | `src/lib/arena/corpActions.ts` (reads `rules.mjs` helpers) | TST-101 CA cases; TST-102 events | HR | none |
| T8 | Sleeve engine, lock/recovery REC-1..4, shadow log | `src/lib/arena/sleeve.ts` | TST-101 sleeve (50% close-out, cap, REC-2, margin once in NAV) | HR | none |
| T9 | Executions, cohorts, terminal states, twin restart, C1/C3 shells, C2 exit mapping | `src/lib/arena/{cohort,terminal}.ts` | AT-11 golden paths; stalled U/L; twin restart; effective-N fixture | HR | confirm ETF code for C1 |
| T10 | Daily orchestrator 2a, run records, idempotency, gate use, data-only guard, workflow, replay harness | `src/lib/arena/closeBooks.ts`, `.github/workflows/arena-close.yml`, `scripts/arena/replay.mjs` | AT-12 3-year golden replay, AT-13 byte-identical, no-look-ahead (TST-109) | HR | approve new workflow/environment as in D-062/D-053 |
| T11 | Acceptance AT-10..AT-13 on staging, `docs/test-map.md` + decision-log entries, M3 exit evidence | `docs/test-map.md`, `docs/07_decision_log.md`, `docs/M3_exit_evidence.md` (allow-list entry) | staging run with recorded data (TST-115) | no | approve [VERIFY] items (decision 20) |

Order rationale: T1-T3 first (everything else depends on exact arithmetic and the reviewed table); T4 may run in parallel with T2/T3; T5-T8 are pure code against the table; T9-T10 compose them; T11 closes the milestone. Per CLAUDE.md the only review points remain the three PRs (M1, M2, M8); M3 produces no PR/email.
