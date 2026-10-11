# M3 TST-101 known-answer draft: hand computation

Status: DRAFT by Haiku, blind pass from the spec text and `docs/M3_design.md` decisions (D-069). Not yet line-reviewed by Opus (AGENT_PLAN section 4). Expected values were also recomputed with exact rational arithmetic (BigInt fractions) in a throw-away script; all 43 agree. The machine-readable table is `tests/fixtures/arena/tst101_public.json`. Codes are synthetic (`ZZA` to `ZZZ`) only.

Spec references use `spec/05` (ARN), `spec/10` (TST-101) and `docs/M3_requirements.md` (REQ).

## 0. Conventions used in every case

- Money: integer micro-AUD (A$1 = 1,000,000). Prices: micro-AUD per share (A$10.00 = 10,000,000).
- Tick table (ARN-032, `tick(p)` on the reference price, band lower-inclusive): p < A$0.10 -> 1,000; A$0.10 <= p < A$2.00 -> 5,000; p >= A$2.00 -> 10,000.
- Slippage (R1, ARN-032 with tick_cross_factor = 1): `slip = max(bucket_bps x ref / 10,000 ; tick x 1)`. Buy fill = `ceil(ref + slip)` to the tick grid. Sell fill = `floor(ref - slip)` to the tick grid. The "tick" term is the tick-bps branch in price terms: `10,000 x tick / ref` bps times `ref` gives back `tick`.
- ADV buckets (ARN-032): >= A$5M 10 bps; A$1M to 5M 25 bps; A$250k to 1M 60 bps; A$100k to 250k 120 bps. Below A$100k: not in the spec (see open points).
- Brokerage (ARN-031, P5 default): <= A$1,000.00 A$5.00; > 1,000.00 and <= 3,000.00 A$10.00; > 3,000.00 and <= 10,000.00 A$19.95; > 10,000.00 and <= 25,000.00 A$29.95; > 25,000.00 0.12%.
- Rounding: half away from zero, applied once per quantity on the exact rational (R2, R5, R7). Shares are floor (ARN-023). Where a case needs no rounding, that is stated.
- Each case below lists inputs, the working in exact fractions, and the result in micro-AUD.

---

## 1. Brokerage profiles

### TST101-001: P5 at A$1,000.00 (upper bound of the A$5.00 tier)
- Inputs: profile P5, order value 1,000,000,000 micro.
- Working: 1,000,000,000 <= 1,000,000,000, so tier 1 applies. Fee = A$5.00.
- Rounding: none.
- Result: **5,000,000**

### TST101-002: P5 at A$1,000.01 (first value of the A$10.00 tier)
- Inputs: value 1,000,010,000.
- Working: > 1,000,000,000 and <= 3,000,000,000, tier 2. Fee = A$10.00.
- Result: **10,000,000**

### TST101-003: P5 at A$3,000.00 (upper bound of A$10.00)
- Inputs: value 3,000,000,000.
- Working: <= 3,000,000,000, tier 2. Fee = A$10.00.
- Result: **10,000,000**

### TST101-004: P5 at A$3,000.01 (first value of A$19.95)
- Inputs: value 3,000,010,000.
- Working: > 3,000,000,000 and <= 10,000,000,000, tier 3. Fee = A$19.95.
- Result: **19,950,000**

### TST101-005: P5 at A$10,000.00 (upper bound of A$19.95)
- Inputs: value 10,000,000,000.
- Working: tier 3. Fee = A$19.95.
- Result: **19,950,000**

### TST101-006: P5 at A$10,000.01 (first value of A$29.95)
- Inputs: value 10,000,010,000.
- Working: > 10,000,000,000 and <= 25,000,000,000, tier 4. Fee = A$29.95.
- Result: **29,950,000**

### TST101-007: P5 at A$25,000.00 (upper bound of A$29.95)
- Inputs: value 25,000,000,000.
- Working: tier 4. Fee = A$29.95.
- Result: **29,950,000**

### TST101-008: P5 at A$25,000.01 (first value of 0.12%)
- Inputs: value 25,000,010,000.
- Working: > 25,000,000,000, percentage tier. Fee = 25,000,010,000 x 12 / 10,000 = 300,000,120,000 / 10,000 = 30,000,012 exactly. This is A$30.000012. The brief's "A$30.00012" is a typo (design decision 17).
- Rounding: none needed (exact integer).
- Result: **30,000,012**

### TST101-009: P0 with an empty zero-fee list falls back to P1
- Inputs: profile P0, zero-fee list empty, code not on the list (`ZZE`), value 1,000,000,000.
- Working: P0 is zero only for codes on the list. None listed, so P1 applies. P1 = flat A$3.00.
- Result: **3,000,000**

### TST101-010: P2 first buy below A$1,000.00 pays nothing
- Inputs: profile P2, buy number 1 for `ZZF` today, value 999,990,000.
- Working: first buy of the security today and 999,990,000 < 1,000,000,000 (strict). Fee = A$0.
- Result: **0**

### TST101-011: P3 stress profile is flat A$6.50
- Inputs: profile P3, value 5,000,000,000.
- Working: flat A$6.50 at any value.
- Result: **6,500,000**

### TST101-012: P4 minimum applies
- Inputs: profile P4, value 5,000,000,000.
- Working: 0.03% x 5,000,000,000 = 3/10,000 x 5,000,000,000 = 1,500,000 (A$1.50). Below the A$3.00 minimum, so the minimum applies (min applied after the percentage, design 4.4). Max A$9.99 not reached.
- Rounding: none (exact).
- Result: **3,000,000**

### TST101-013: P5b above A$1,000.00 is 0.20% with no minimum
- Inputs: profile P5b, value 1,000,010,000.
- Working: value > 1,000,000,000, so 0.20%: 1,000,010,000 x 20 / 10,000 = 20,000,200,000 / 10,000 = 2,000,020 exactly (A$2.00002).
- Result: **2,000,020**

---

## 2. Fill price and slippage

### TST101-014: buy at A$50.00 on ADV >= A$5M (bucket beats one tick)
- Inputs: side buy, ref 50,000,000, ADV >= A$5M (10 bps), tick 10,000 (ref >= A$2.00).
- Working: bucket = 50,000,000 x 10 / 10,000 = 50,000 (A$0.05). Tick-bps = 10,000 x 10,000 / 50,000,000 = 2 bps. Tick term = 10,000. slip = max(50,000 ; 10,000) = 50,000. Raw = 50,000,000 + 50,000 = 50,050,000. Ceil to 10,000 grid: 50,050,000 / 10,000 = 5,005 exactly. Fill = 50,050,000.
- Result: slippage **50,000**, fill **50,050,000**

### TST101-015: buy at A$12.34 on ADV A$1M to 5M (25 bps), rounds up
- Inputs: side buy, ref 12,340,000, ADV A$2M (25 bps), tick 10,000.
- Working: bucket = 12,340,000 x 25 / 10,000 = 30,850 exactly. Tick-bps = 8.10 bps (< 25). Tick term 10,000. slip = 30,850. Raw = 12,370,850. Raw / 10,000 = 1,237.085, ceil = 1,238. Fill = 12,380,000.
- Rounding: buy ceil (adverse to trader).
- Result: slippage **30,850**, raw **12,370,850**, fill **12,380,000**

### TST101-016: sell at A$12.34 on ADV A$1M to 5M, rounds down
- Inputs: side sell, same inputs as 015.
- Working: slip = 30,850. Raw = 12,340,000 - 30,850 = 12,309,150. Raw / 10,000 = 1,230.915, floor = 1,230. Fill = 12,300,000.
- Rounding: sell floor (adverse).
- Result: slippage **30,850**, raw **12,309,150**, fill **12,300,000**

### TST101-017: sell at A$15.00 on ADV A$250k to 1M (60 bps)
- Inputs: side sell, ref 15,000,000, ADV A$500k (60 bps), tick 10,000.
- Working: bucket = 15,000,000 x 60 / 10,000 = 90,000. Tick-bps = 6.67 (< 60). slip = 90,000. Raw = 15,000,000 - 90,000 = 14,910,000. Divided by 10,000 = 1,491 exact. Fill = 14,910,000.
- Result: slippage **90,000**, fill **14,910,000**

### TST101-018: buy at A$2.50 on ADV A$100k to 250k (120 bps bucket wins)
- Inputs: side buy, ref 2,500,000, ADV A$150k (120 bps), tick 10,000.
- Working: bucket = 2,500,000 x 120 / 10,000 = 30,000. Tick-bps = 10,000 x 10,000 / 2,500,000 = 40 bps (< 120). Tick term 10,000. slip = max(30,000 ; 10,000) = 30,000. Raw = 2,530,000. / 10,000 = 253 exact. Fill = 2,530,000.
- Result: slippage **30,000**, fill **2,530,000**

### TST101-019: U3 at A$0.20 (tick-bps 250, spec quote)
- Inputs: side buy, ref 200,000, ADV A$150k (120 bps), tick 5,000 (band 0.10 to < 2.00).
- Working: bucket = 200,000 x 120 / 10,000 = 2,400. Tick-bps = 5,000 x 10,000 / 200,000 = 250 bps (matches ARN-032 acceptance "250 bps"). Tick term 5,000. slip = max(2,400 ; 5,000) = 5,000. Raw = 205,000. / 5,000 = 41 exact. Fill = 205,000 (A$0.205).
- Result: tick-bps **250**, slippage **5,000**, fill **205,000**

### TST101-020: buy at A$0.0999 (band edge below A$0.10). AMBIGUOUS
- Inputs: side buy, ref 99,900, ADV >= A$5M (10 bps), tick 1,000 (band < A$0.10).
- Working: bucket = 99,900 x 10 / 10,000 = 99.9 micro (exact 999/10). Tick term 1,000. slip = 1,000. Raw = 100,900 (A$0.1009). On the reference band grid (1,000): ceil(100.9) = 101 gives 101,000.
- Ambiguity: 101,000 is >= A$0.10 and so lies in the coarser band, whose grid is 5,000. Design 2.4 re-rounds on the new band: ceil(100,900 / 5,000 = 20.18) = 21 gives 105,000. Spec ARN-032 is silent on this. Expected 105,000 follows design 2.4; the alternative is 101,000. Opus to confirm.
- Result: slippage **1,000**, raw **100,900**, fill **105,000** (alt 101,000)

### TST101-021: buy at A$1.995 (band top edge, fill lands on A$2.00)
- Inputs: side buy, ref 1,995,000, ADV >= A$5M, tick 5,000 (band 0.10 to < 2.00).
- Working: bucket = 1,995,000 x 10 / 10,000 = 1,995. Tick-bps = 5,000 x 10,000 / 1,995,000 = 25.06 bps (> 10). Tick term 5,000. slip = 5,000. Raw = 2,000,000. Grid 5,000 (ref band): 400 exact. Fill 2,000,000 is >= A$2.00, so the coarser grid is 10,000: 200 exact, no re-round.
- Result: slippage **5,000**, fill **2,000,000**

---

## 3. Sizing, deployable cash and the parcel rule

Common to 022 to 025: buffer = 1% x NAV (ARN-024a). Pre-brokerage deployable = cash - buffer. Estimated brokerage = P5 on the pre-brokerage deployable (s13). Deployable = pre-brokerage - estimated brokerage. Shares = floor(deployable / fill). Actual brokerage = P5 on the real order value. No iteration.

### TST101-022: sizing at A$9.80 with A$600 cash (spec acceptance)
- Inputs: cash 600,000,000, NAV 600,000,000, ref 9,800,000 (ADV >= A$5M).
- Fill: bucket = 9,800,000 x 10 / 10,000 = 9,800. Tick-bps = 10,000 x 10,000 / 9,800,000 = 10.204 bps (> 10). Tick term 10,000. slip = 10,000. Raw = 9,810,000. Grid 10,000: 981 exact. Fill = 9,810,000 (A$9.81).
- Buffer: 1% x 600,000,000 = 6,000,000.
- Pre-brokerage: 600,000,000 - 6,000,000 = 594,000,000. Estimated brokerage: P5 on 594,000,000 (<= 1,000) = 5,000,000.
- Deployable: 594,000,000 - 5,000,000 = 589,000,000.
- Shares: 589,000,000 / 9,810,000 = 60.04. Floor = 60 (60 x 9,810,000 = 588,600,000; 61 x = 598,410,000 is above 589,000,000).
- Order value: 60 x 9,810,000 = 588,600,000 (A$588.60). Parcel 588.60 >= 500, passes.
- Actual brokerage: P5 on 588,600,000 = 5,000,000.
- Total cost: 588,600,000 + 5,000,000 = 593,600,000 (A$593.60) <= 594,000,000 (cash - buffer). Cash left: 600,000,000 - 593,600,000 = 6,400,000.
- Result: buffer **6,000,000**, est. brokerage **5,000,000**, deployable **589,000,000**, fill **9,810,000**, shares **60**, value **588,600,000**, total **593,600,000**, cash left **6,400,000**

### TST101-023: parcel rejection (deployable buys 39 shares below A$500)
- Inputs: cash 400,000,000, NAV 400,000,000, ref 9,800,000 (fill 9,810,000 as in 022).
- Buffer: 4,000,000. Pre-brokerage: 396,000,000. Est. brokerage P5 = 5,000,000. Deployable: 391,000,000.
- Shares: 391,000,000 / 9,810,000 = 39.86. Floor = 39. Value: 39 x 9,810,000 = 382,590,000 (A$382.59).
- Parcel: 382,590,000 < 500,000,000 (A$500). Status rejected (min_marketable_parcel). No order, logged (ARN-024).
- Result: shares **39**, value **382,590,000**, status **rejected**

### TST101-024: minimum parcel boundary (exactly A$500.00 passes)
- Inputs: cash 516,000,000, NAV 516,000,000, ref 9,990,000 (ADV >= A$5M).
- Fill: bucket = 9,990,000 x 10 / 10,000 = 9,990. Tick-bps = 10,000 x 10,000 / 9,990,000 = 10.01 bps (> 10). Tick term 10,000. slip = 10,000. Raw = 10,000,000. Grid 10,000: 1,000 exact. Fill = 10,000,000 (A$10.00).
- Buffer: 5,160,000. Pre-brokerage: 510,840,000. Est. brokerage P5 = 5,000,000. Deployable: 505,840,000.
- Shares: 505,840,000 / 10,000,000 = 50.584. Floor = 50. Value 500,000,000 = A$500.00. Equal to the minimum, so it passes (>= A$500).
- Actual brokerage: 5,000,000. Total 505,000,000 <= 510,840,000. Cash left: 516,000,000 - 505,000,000 = 11,000,000.
- Result: shares **50**, value **500,000,000**, total **505,000,000**, cash left **11,000,000**

### TST101-025: participation cap (sized 10,079 shares > 1% of ADV 1,000,000 shares)
- Inputs: cash 100,000,000,000 (A$100,000), NAV the same, ref 9,800,000, ADV 1,000,000 shares and A$9.8M value (>= A$5M, 10 bps), participation cap 1%.
- Fill: bucket 9,800; tick-bps 10.204 (> 10); tick term 10,000; slip 10,000; raw 9,810,000 (A$9.81).
- Buffer: 1% x 100,000,000,000 = 1,000,000,000. Pre-brokerage: 99,000,000,000 (A$99,000).
- Estimated brokerage: value > 25,000,000,000, so 0.12% x 99,000,000,000 = 118,800,000 (A$118.80).
- Deployable: 99,000,000,000 - 118,800,000 = 98,881,200,000.
- Shares: 98,881,200,000 / 9,810,000 = 10,079.0... Check: 9,810,000 x 10,079 = 98,874,990,000 <= 98,881,200,000; x 10,080 = 98,884,800,000 > deployable. Floor = 10,079.
- Cap: 1% x 1,000,000 = 10,000 shares. 10,079 > 10,000, rejected (ARN-024).
- Cross-check on a value cap: 1% x A$9.8M ADV = A$98,000. Order A$98,874.99 > A$98,000. Also rejected, so the outcome does not depend on the units.
- Result: est. brokerage **118,800,000**, deployable **98,881,200,000**, shares sized **10,079**, value **98,874,990,000**, cap **10,000**, status **rejected**

---

## 4. Settlement, dividends, corporate actions and rights

### TST101-026: T+2 settlement, matched and conservative. AMBIGUOUS (availability day)
- Inputs: hold 10 shares, sell at open 10,000,000 (A$10.00), ADV >= A$5M (10 bps), tick 10,000, P5, settled cash before 100,000,000.
- Sale fill: bucket = 10,000,000 x 10 / 10,000 = 10,000. Tick-bps = 10.00 bps (equal). Tick term 10,000. slip = 10,000. Raw (sell) = 9,990,000. Grid 10,000: 999 exact. Fill = 9,990,000 (A$9.99).
- Sale value: 10 x 9,990,000 = 99,900,000 (A$99.90). Brokerage P5 = 5,000,000. Net proceeds 99,900,000 - 5,000,000 = 94,900,000 (A$94.90).
- Matched (ARN-025 default): proceeds fund buys the same session. Cash available = 100,000,000 + 94,900,000 = 194,900,000.
- Conservative: available on the same session = 100,000,000. From T+2 (settlement session) = 194,900,000.
- Ambiguity: ARN-025 does not say whether conservative proceeds fund a buy on the settlement session or only the next. Expected shows the settlement-session reading (design 15).
- Result: sale fill **9,990,000**, sale value **99,900,000**, brokerage **5,000,000**, net proceeds **94,900,000**, matched same-day cash **194,900,000**, conservative same-day cash **100,000,000**, conservative from settlement **194,900,000**

### TST101-027: dividend receivable from ex-date, credited on pay date, franking separate
- Inputs: 60 shares held at close of the session before ex-date; DPS 250,000 (A$0.25); franking 100%, vendor credit 6,428,571 (input, not computed).
- Entitlement: 60 x 250,000 = 15,000,000 (A$15.00). Exact, no rounding (R3).
- NAV: receivable of 15,000,000 is included from the ex-date (ARN-036). On the pay date, cash rises by 15,000,000 and the receivable falls to zero.
- Franking: stored separately, added to NAV by 0. Excluded (ARN-036).
- Result: receivable **15,000,000**, cash on pay date **15,000,000**, franking in NAV **0**, franking recorded **6,428,571**

### TST101-028: 2-for-1 split is neutral (no artificial P/L)
- Inputs: 60 shares at raw close 10,000,000 (A$10.00); cash 100,000,000; split 2 new per 1 old, so factor f = 1/2.
- Re-base: quantity x (1/f) = 60 x 2 = 120. Price x f = 10,000,000 x 1/2 = 5,000,000. Exact.
- Value before: 60 x 10,000,000 = 600,000,000. Value after: 120 x 5,000,000 = 600,000,000.
- Cash delta: 0. P/L: 600,000,000 - 600,000,000 = 0.
- Result: shares **120**, raw close **5,000,000**, NAV before **600,000,000**, NAV after **600,000,000**, cash delta **0**, P/L **0**

### TST101-029: renounceable rights valued at last traded price, non-renounceable gives nothing
- Inputs: 60 shares; 1 right per 4 shares (ratio 0.25); rights last traded at 300,000 (A$0.30); cash before 0.
- Rights count: 60 x 0.25 = 15 (exact).
- Renounceable compensation: 15 x 300,000 = 4,500,000 (A$4.50), credited as `ca_comp`.
- Non-renounceable (same inputs): 0 (DAT-223).
- Result: rights **15**, renounceable comp **4,500,000**, non-renounceable comp **0**

### TST101-030: suspension haircut after 20 sessions. AMBIGUOUS (off-by-one)
- Inputs: 60 shares frozen at 10,000,000 (A$10.00); haircut 1/2; halt sessions elapsed 20.
- Working: 60 x 10,000,000 x 1/2 = 600,000,000 / 2 = 300,000,000 (A$300.00). Exact, so no rounding (R6).
- Ambiguity: ARN-026 "after 20 sessions" can mean the haircut applies at count 20 (expected here) or from count 21. At count 20 the value would be 600,000,000 under the second reading. Opus to confirm.
- Result: marked value **300,000,000**

---

## 5. Initial stop, intraday stop, close signal and sleeve close-out

### TST101-031: initial stop set from the actual entry fill
- Inputs: buy, open 10,000,000 (A$10.00), ADV >= A$5M, tick 10,000, stop distance 500,000 (A$0.50).
- Fill: bucket = 10,000 (10 bps of A$10.00). Tick-bps = 10.00 bps. Tick term 10,000. slip = 10,000. Raw = 10,010,000. Ceil to 10,000: 1,001 exact. Entry fill = 10,010,000 (A$10.01).
- Stop: fill - 500,000 = 9,510,000 (A$9.51). Set from the fill, not the open (ARN-021). From the open the stop would be 9,500,000, which is the wrong answer.
- Result: entry fill **10,010,000**, initial stop **9,510,000**

### TST101-032: IS gap-through at open (spec example A$0.95 against A$1.00 stop)
- Inputs: long stop level 1,000,000 (A$1.00); session open 950,000 (A$0.95) at or below the level; ADV >= A$5M; tick 5,000.
- Rule: open <= level, so fill = open - slippage (ARN-021).
- Slip: bucket = 950,000 x 10 / 10,000 = 950. Tick-bps = 5,000 x 10,000 / 950,000 = 52.6 bps. Tick term 5,000. slip = 5,000. Raw = 945,000. Floor to 5,000: 189 exact. Fill = 945,000 (A$0.945).
- Result: slippage **5,000**, fill **945,000**

### TST101-033: IS stop inside range (spec example, open A$1.02, low A$0.98)
- Inputs: stop level 1,000,000; open 1,020,000 (above level); low 980,000 (reaches level); ADV >= A$5M (assumed).
- Rule: low <= level and open > level, so fill = level - slippage - 1 tick (ARN-021).
- Slip on the level: bucket = 1,000 (10 bps). Tick-bps = 5,000 x 10,000 / 1,000,000 = 50 bps. Tick term 5,000. slip = 5,000. Level minus slip minus one tick: 1,000,000 - 5,000 - 5,000 = 990,000. Floor to 5,000: 198 exact. Fill = 990,000 (A$0.99).
- Note: the spec example gives no ADV. A$0.99 holds for ADV >= A$1M (10 and 25 bps buckets, since the one-tick term at A$1.00 is 50 bps). In the A$250k to 1M band (60 bps) the fill would be 988,000. The case assumes ADV >= A$5M.
- Result: slippage **5,000**, fill **990,000**

### TST101-034: stop and close signal both apply on D+1 (worse-case ordering). AMBIGUOUS
- Inputs: IS level 9,510,000 (from 031); CS signal at D close, filled at the D+1 open 9,800,000; D+1 low 9,500,000; ADV >= A$5M; tick 10,000.
- CS fill: slip at 9.80: bucket 9,800; tick-bps 10.204 (> 10); tick term 10,000; slip 10,000. Raw = 9,800,000 - 10,000 = 9,790,000. Floor to 10,000: 979 exact. CS fill = 9,790,000.
- IS fill: open 9,800,000 is above the level and the low 9,500,000 reaches it, so the in-range rule applies. Slip at 9.51: bucket 9,510; tick-bps 10.51 (> 10); tick term 10,000. Fill = 9,510,000 - 10,000 - 10,000 = 9,490,000. Floor: 949 exact.
- Ambiguity: ARN-021 says the earlier fill wins and an ambiguous order assumes the worse outcome. The CS fill happens at the open, which precedes any intraday move, so "earlier" would pick 9,790,000. The worse-case clause picks 9,490,000. Spec does not say which governs. Expected follows the worse-case clause.
- Result: CS fill **9,790,000**, IS fill **9,490,000**, selected **9,490,000**

### TST101-035: sleeve financing at 9% p.a., 365-day basis, charged cumulatively
- Inputs: exposure 200,000,000 (A$20 margin x 10); rate 0.09; basis 365; days 1 and 3.
- Cumulative charge: accrued(d) = round_half_away(E x 0.09 x d / 365) = round(18,000,000 x d / 365).
  - d = 1: 18,000,000 / 365 = 49,315.068... Round to 49,315.
  - d = 2: 36,000,000 / 365 = 98,630.137... Round to 98,630.
  - d = 3: 54,000,000 / 365 = 147,945.205... Round to 147,945.
- Daily charges: day 1 = 49,315. Day 2 = 98,630 - 49,315 = 49,315. Day 3 = 147,945 - 98,630 = 49,315. Sum of daily rows = 147,945 (design R5).
- Result: 1-day financing **49,315**, 3-day cumulative **147,945**, daily **49,315**

### TST101-036: sleeve close-out at -50% of margin (exact trigger, IS fill below level)
- Inputs: margin 20,000,000; leverage 10; notional 200,000,000; entry fill 10,000,000 (A$10.00); financing 0 (same-session exit); session open 9,800,000; low 9,500,000; tick 10,000; ADV >= A$5M; P5.
- Trigger: P/L = 200,000,000 x (P - 10,000,000) / 10,000,000 = -10,000,000 (-50% of margin). So P/L/notional = -0.05 and P = 10,000,000 x 0.95 = 9,500,000 (A$9.50). Trigger level is 9,500,000.
- IS fill: open 9,800,000 is above the level, low 9,500,000 reaches it. Fill = 9,500,000 - slip - tick. Slip at 9.50: bucket 9,500; tick-bps 10.53 (> 10); tick term 10,000; slip 10,000. Fill = 9,500,000 - 10,000 - 10,000 = 9,480,000. On grid (948 exact).
- Sleeve P/L: 200,000,000 x (9,480,000 - 10,000,000) / 10,000,000 = 200,000,000 x (-520,000) / 10,000,000 = -10,400,000 (-A$10.40).
- Exit brokerage: P5 on notional 200,000,000 = 5,000,000. Entry brokerage (already paid) also 5,000,000.
- Cash returned: margin 20,000,000 + P/L (-10,400,000) - exit brokerage 5,000,000 = 4,600,000.
- Ambiguity: ARN-044 charges brokerage and slippage "in addition". Design R4 computes P/L on fills, so the slippage inside 9,480,000 is not charged again. If slippage is charged separately, the loss is larger. Opus to confirm.
- Result: trigger price **9,500,000**, trigger P/L **-10,000,000**, IS fill **9,480,000**, sleeve P/L **-10,400,000**, exit brokerage **5,000,000**, cash returned **4,600,000**

### TST101-037: sleeve loss capped at margin (gap through to A$8.49). AMBIGUOUS
- Inputs: margin 20,000,000; entry 10,000,000; notional 200,000,000; stop level 9,500,000; open 8,500,000 (at or below the level); financing 0; P5.
- Fill (open rule): slip at 8.50: bucket 8,500; tick-bps 11.76 (> 10); tick term 10,000. Fill = 8,500,000 - 10,000 = 8,490,000. Floor: 849 exact.
- Uncapped P/L: 200,000,000 x (8,490,000 - 10,000,000) / 10,000,000 = -30,200,000.
- Capped at margin: -20,000,000. Margin returned = 20,000,000 - 20,000,000 = 0.
- Exit brokerage P5 = 5,000,000, charged in addition (ARN-044). Cash delta at close = 0 - 5,000,000 = -5,000,000.
- Ambiguity: the spec does not say where brokerage beyond a fully consumed margin comes from. Expected charges settled cash, which would make cash negative in a fully deployed cohort (ARN-101 requires cash >= 0). Opus to confirm.
- Result: fill **8,490,000**, uncapped P/L **-30,200,000**, sleeve P/L **-20,000,000**, margin returned **0**, cash delta **-5,000,000**

---

## 6. NAV, terminal states, stall and controls

### TST101-038: NAV for one day
- Inputs: settled cash 100,000,000 (already net of the margin moved out); unsettled receivable 94,900,000; holding 60 shares at raw close 9,500,000; dividend receivable 15,000,000; sleeve margin 20,000,000; sleeve notional 200,000,000, entry 10,000,000, mark 9,600,000; accrued unpaid financing (1 day) 49,315; franking 6,428,571 (excluded).
- Holdings: 60 x 9,500,000 = 570,000,000.
- Sleeve unrealised P/L: 200,000,000 x (9,600,000 - 10,000,000) / 10,000,000 = -8,000,000.
- Sum (ARN-051): 100,000,000 + 94,900,000 + 570,000,000 + 15,000,000 + 20,000,000 - 8,000,000 - 49,315.
  - 100,000,000 + 94,900,000 = 194,900,000; + 570,000,000 = 764,900,000; + 15,000,000 = 779,900,000; + 20,000,000 = 799,900,000; - 8,000,000 = 791,900,000; - 49,315 = 791,850,685.
- Margin counted once: it appears only in the sleeve-margin line; cash excludes it.
- Franking excluded: 0 added.
- Result: holdings **570,000,000**, sleeve unrealised P/L **-8,000,000**, NAV **791,850,685**

### TST101-039: liquidation-NAV target check (NAV at target, liquidation NAV below it)
- Inputs: cash 0; 120 shares at raw close 10,000,000 (A$10.00); ADV >= A$5M; tick 10,000; P5; target 1,200,000,000.
- NAV: 120 x 10,000,000 = 1,200,000,000 (exactly target).
- Exit estimate: sell at 10,000,000; slip 10,000 (10 bps equals tick); fill 9,990,000. Exit value 120 x 9,990,000 = 1,198,800,000.
- Slippage cost: 120 x 10,000 = 1,200,000 (A$1.20).
- Exit brokerage: P5 on 1,198,800,000 (tier 2) = 10,000,000 (A$10.00).
- Liquidation NAV: 1,200,000,000 - 1,200,000 - 10,000,000 = 1,188,800,000 (A$1,188.80).
- 1,188,800,000 < 1,200,000,000, so target is not reached (ARN-052, section 5.1).
- Result: liquidation NAV **1,188,800,000**, target **false**

### TST101-040: stall via NAV floor (5 sessions, U and L)
- Inputs: no open position; U NAV 505,000,000; L NAV 520,000,000; stall_sessions 5.
- Floor: spec text is "about A$511". Design formula (500 + 5 + 0.5) / (1 - 0.01) = 505.5 / 0.99 = 510.606... Rounded to micro = 510,606,061. The range that matters is 505,000,000 < floor < 520,000,000, and both candidate floors fall in it, so the verdict does not depend on the rounding.
- U: 505,000,000 < 510,606,061 for 5 consecutive sessions, so stalled.
- L: 520,000,000 > 510,606,061, so not stalled. It may enter, with the sleeve skipped (ARN-003).
- Result: U stalled **true**, L stalled **false**

### TST101-041: stall via 20 sessions of parcel-only rejections
- Inputs: cash 400,000,000, NAV 400,000,000, ref 9,800,000 (fill 9,810,000); a family signal each session; no open position; 20 consecutive sessions.
- Each session: deployable 391,000,000 buys 39 shares of A$382.59 (as 023), rejected for parcel only.
- After 20 consecutive sessions, condition (b) of section 5.1 holds, so stalled.
- Result: stalled at session 20 **true**, rejection value **382,590,000**

### TST101-042: C2 exit mapping in ATR units (F3 event)
- Inputs: ATR(20) = 400,000 (A$0.40); event day-low 1.3 ATR below the entry-day open; control entry-day open 10,000,000.
- Offset: 1.3 x 400,000 = 520,000 (exact).
- Control stop: 10,000,000 - 520,000 = 9,480,000 (A$9.48), which is on the 0.01 grid (ARN-004 C2 mapping).
- Result: offset **520,000**, control stop **9,480,000**

### TST101-043: REC-2 unlock at loss_to_recover. AMBIGUOUS (definition)
- Inputs: sleeve trade P/L -10,400,000 (from 036); entry brokerage 5,000,000; exit brokerage 5,000,000.
- loss_to_recover (design decision 5): total net loss of the locking trade = |-10,400,000| + 5,000,000 + 5,000,000 = 20,400,000 (A$20.40).
- Test A: unlevered realised net P/L since lock = 20,400,000 >= 20,400,000, so unlocked.
- Test B: 20,390,000 < 20,400,000, so still locked.
- Ambiguity: ARN-046 records loss_to_recover but does not define it. The definition here is design decision 5 (D-069), not spec text. Opus to confirm.
- Result: loss_to_recover **20,400,000**, unlocked at A **true**, unlocked at B **false**

---

## 7. Open points and gaps (not in the table)

1. **ADV below A$100k.** ARN-032 has no bucket below A$100k. Design decision 9 uses 120 bps. No case here depends on it.
2. **P2 boundary.** ARN-031 writes "first buy < A$1,000"; P5 uses <=. Design 10 implements < as written. Case 010 is A$999.99 and does not touch the edge.
3. **Stall floor value.** Design 510.61 (1% buffer on the floor itself) vs spec "about A$511". Case 040 is insensitive. Stall floor's slippage branch "max(10 bps, one tick)" is per share and is ill-defined for a dollar parcel. Not tested.
4. **P0 zero-fee list.** Empty until sourced (design 10). Case 009 covers the fallback to P1.
5. **Not in this draft:** consolidation, legacy ledger (ARN-026), twin restart and shadow continuation (ARN-053), C2 for F2 and F6, P2 maximum branch (max(A$11.00, 0.10%)), frozen-price suspension below 20 sessions, sleeve-skip rule (ARN-003), settlement-mode NAV interaction. These need more cases before TST-101 is complete.
6. **Half-away ties.** No case hits an exact half-micro tie, so half-away and half-even agree on this table.


## Architect rulings on the ambiguous cases (Opus, 2026-10-11 — D-071)
| Case | Ruling |
|---|---|
| TST101-020 | A slipped fill that crosses into a coarser band is re-rounded on the new band's grid, adverse to the trader (design §2.4) → 105,000 micro. |
| TST101-026 | Conservative settlement: sale proceeds are available from the start of the settlement session (T+2). |
| TST101-030 | "After 20 sessions": the suspension haircut applies from session 21. |
| TST101-034 | ARN-022 (spec/05:53): the earlier fill wins, so the CS exit at the open (9,790,000) is selected over the later intraday stop (9,490,000); the worse outcome applies only when intrabar ordering is ambiguous (both at the open). The table value was corrected from 9,490,000 to 9,790,000. |
| TST101-036 | Sleeve slippage is inside the fill price, not an extra charge. |
| TST101-037 | Brokerage beyond a fully consumed sleeve margin is charged to main cash (conservative) — [VERIFY]. |
| TST101-043 | loss_to_recover per D-069 decision 5. |
