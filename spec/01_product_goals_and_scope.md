# Chapter 01 — Product, Goals & Scope  (v2.0, session 10)

_Changes from v0.1 (session 5): aggressive-first Arena of 12 executions; evening (20:00) review email; universe widened to small/mid caps; leverage moved from non-goal to an evaluated, simulated experiment; broker/leverage research added (`docs/14`)._

## 1.1 Purpose
A private, zero-cost web application, controlled by the Owner with optional allowlisted family viewers (ROL-101), that continuously studies stocks — **Australia (ASX) first, then India, then USA (O-27)** — and runs **12 different aggressive paper-trading executions in parallel per market, each seeded with A$600 (O-25)**, to discover **which agent-driven approaches can double the seed (A$600 → A$1,200) fastest without being luck, why they did better or worse, and how to improve the criteria and agents**. It documents all analysis, learns from outcomes in a controlled way, and emails the owner a **daily 8 pm analysis** of what was traded, profit/loss, what was learned, what to improve tomorrow, and overall success rates.

## 1.2 Users
| Role | Description |
|---|---|
| Owner | The system's owner. Full control. Authenticates with their Google account. Receives all emails. |
| Editor / Viewer | Optional allowlisted family members with limited rights (ROL-101…107, Ch. 10). |
| System | Scheduled jobs and agents acting without a user session, authenticated by secrets. |
There are no sign-ups, public pages or self-service registration; only the Owner adds users.

## 1.3 Goals
- **PRD-001** The system MUST provide decision support and simulation only. It MUST NOT place real orders, connect to a broker account, or hold real money.
- **PRD-002 (s9)** Each execution MUST start with a seed of **A$600** [OWNER O-25; supersedes the original A$500 because a new ASX holding requires a A$500 minimum marketable parcel plus brokerage], configurable per market (DAT-010).
- **PRD-003** The first target for every execution MUST be **2× seed (A$1,200)** [OWNER]. The system MUST support a **target ladder** (further rungs, default 2× again) [PROPOSED].
- **PRD-004 (s9)** The primary outcome is **doubling the seed**, reported as the chance of reaching the target within 3/6/12 months together with the chances of bust and stall, compared with matched random controls, plus time-to-double curves (ARN-071); on net NAV after all simulated costs.
- **PRD-005** "Fastest double" MUST NOT be the sole success criterion: every leaderboard entry MUST also show bust rate, maximum drawdown, cost drag and a **validation status** (Chapter 05).
- **PRD-006** The system MUST run **12 different executions in parallel** [OWNER], **all with an aggressive risk profile to start** [OWNER], sharing one market-data feed (Chapter 05).
- **PRD-007** The whole system MUST run at **strictly $0** [OWNER]: no paid plan, paid API call, or payment card on file with any provider. If a free quota is exhausted the system MUST degrade gracefully, never overspend.
- **PRD-008** _(amended s9, O-22)_ Only allowlisted users may see any data, with the Owner/Editor/Viewer permissions of ROL-101…106 (Ch. 10); email goes to the Owner only.
- **PRD-009** All analysis, decisions, lessons and run summaries MUST be stored as markdown documents always accessible to the app and to future sessions (Chapter 08).
- **PRD-010** The system MUST email the owner a **daily analysis at 20:00 Australia/Melbourne** (Chapter 04). The recipient is the Owner's Gmail address (O-20) and MUST be configuration (`OWNER_EMAIL`).
- **PRD-011** The system MUST operate continuously with minimal LLM tokens (Chapters 02–03).
- **PRD-012** The system MUST analyse historic data and price drivers and include a candle-chart reading capability (Chapter 07; design constraints in `docs/13`).
- **PRD-013 (s9)** **Learning loop:** each day the system compares the executions, explains what did better or worse (only where the difference is statistically detectable, otherwise says so), updates the agents' **knowledge notes** (Lane A), and proposes rule changes that are tested and promoted only when they pass the validation test VAL-110 (Lane B, Ch. 05). Rule changes are therefore rare and evidence-based, not daily.
- **PRD-017** _(s9)_ **Markets (O-29):** Australia goes live first; India and then the USA are part of v1 and are activated later, one after the other, through MKT-102 (Ch. 06). Everything in this chapter stated for ASX applies per market with that market's currency, universe and costs.
- **PRD-014** **Universe:** the system MUST cover the **S&P/ASX 300 as the core** and MUST also scan **small- and mid-cap** and other ASX-listed companies for opportunities, subject to liquidity and manipulation filters ("leave no stone unturned") [OWNER] (Chapter 05, §5.3; data in Chapter 06).
- **PRD-015** **Leverage evaluation:** the system MUST simulate an owner-defined **leverage sleeve** (A$20 of the seed at up to 10×, with a "no leverage until the loss is recovered" rule) in half of the executions so its effect is measured against unlevered twins (Chapter 05, §5.6).
- **PRD-016** **Broker research:** the system documentation MUST include a current comparison of cheap ASX brokers for small trades (`docs/14`); real trading remains out of scope.

## 1.4 Reality constraints the owner must accept (shown in the app)
- **PRD-020** Doubling money quickly requires high volatility. Illustrative model results (simple random-walk simulation, no costs, assumes a positive edge exists; not a forecast): **(s13)** Zero-edge rows use `zero_edge_trials` (default 20,000; 5,000–100,000) Monte-Carlo paths with a fixed stored seed `zero_edge_seed`, daily volatility = median 20-session realised volatility of U1 over the development window, drift 0, costs per P5; the table states trials, seed and Monte-Carlo standard error.

| Illustrative profile (annual return / volatility) | Doubles before halving, within 1 yr | Halves before doubling, within 1 yr | Doubles before halving, within 2 yrs | Halves before doubling, within 2 yrs |
|---|---|---|---|---|
| Index-like (8% / 15%) | 0% | 0% | 0.7% | 0% |
| Large-cap tilt (12% / 25%) | 1.2% | 0.2% | 11.3% | 1.7% |
| Small-cap/speculative (20% / 60%) | 24.0% | 22.6% | 39.8% | 37.5% |
| Extreme (30% / 100%) | 37.4% | 50.0% | 42.3% | 56.6% |
  _(s9)_ The table is an **illustrative model** (VAL-101 exempt), assuming the positive drift shown and **no costs**. The rows above use a halving barrier and therefore describe an account that is **never flat** (labelled so). In this Arena a flat account effectively fails at the stall floor (≈ 0.85 × seed, §5.1), so the app MUST add rows **computed at build by simulation with the lower barrier at the stall floor**: the same profiles, a **zero-edge** row and a row with the **P5 cost drag** at the families' typical turnover (for orientation only, an independent reviewer's simulation of the 20% / 60% profile with a 0.85 barrier gave ≈ 17% double vs ≈ 74% fail within 1 year, and ≈ 11% vs ≈ 82% at zero edge — the build replaces these with its own computed values), and state: "With no edge, doubling is unlikely and costs make it less likely; the app shows the zero-edge benchmark computed by simulation (ARN-071) beside every result." The app MUST display a reality panel: the faster the double, the closer the odds are to a coin-flip between doubling and halving.
- **PRD-021** Required annualised return to double: 3 years ≈ 26%; 2 years ≈ 41%; 1 year = 100%; 6 months = 300%; 3 months = 1,500%.
- **PRD-022** With A$600 (and a A$500 minimum parcel for a new holding), brokerage is a large drag (default P5: A$5 per side ≈ 1% each way on a A$500 parcel, ≈ 2% round trip plus slippage), and after a ~15% loss an execution may no longer afford a parcel ("stalled", ARN-053/§5.1) and the account can hold only 1–2 positions. The simulator MUST model this.
- **PRD-023** With 12 parallel executions some will double by luck. The system MUST include random-control portfolios and statistical validation.
- **PRD-024** Paper results overstate real-world results. All results MUST be labelled "simulated".
- **PRD-025** Personal use only. Sharing outputs with other people may require an Australian financial services licence (ASIC) [VERIFY with a licensed professional].
- **PRD-026** **Leverage reality panel** (from `docs/14`): A$20 margin at 10× = A$200 exposure; profit/loss = A$200 × the underlying's % move (a 10% move = ±A$20; a 10% fall wipes out the margin; the maximum loss is the A$20 margin, not A$200). The simulator closes the sleeve out at a −5% move (−A$10, half the margin, ARN-044); the full A$20 is lost only on a gap through the close-out level. At this size the sleeve moves total capital by only ~0.33× the underlying's move (A$200 ÷ A$600), and fixed minimum commissions can consume most of any gain. **10× on ASX shares is not available to Australian retail CFD clients (5× cap; ASIC order runs to 23 May 2027 [V])**; ~10× effective gearing exists via MINI/Turbo warrants (loss limited to premium, knock-out risk). The simulator treats 10× as a **hypothetical research setting** and shows the retail-compliant equivalent.
- **PRD-028 (s9) Evidence takes time.** The Owner guide and the Evening Review header state: "Forward rankings need ≥ 5 finished cohorts per execution; expect many months to years. Until then evidence comes from historical replays; daily comparisons are observations, not findings."
- **PRD-027** Small/micro-cap stocks are the targets of pump-and-dump schemes (ASIC warning [V]); simulated profits there may be un-tradeable in reality (spreads, halts, illiquidity).

## 1.5 Non-goals (v1)
Real-money trading; broker integration; short selling; options/futures; crypto; FX; custom domain; native mobile app; tax advice. _(s9: "non-ASX markets" and "multi-user access" removed from non-goals — India/USA are in v1 after Australia (O-21, MKT-101…104) and Owner/Editor/Viewer roles are in v1 (O-22, ROL-101…106).)_ (Leverage is **simulated only** — see PRD-015.)

## 1.6 Success metrics for the system itself
| Metric | Target [PROPOSED] |
|---|---|
| Scheduled job on-time rate | ≥ 95% of scheduled runs in any 30 days |
| Cost | A$0 / US$0, verified monthly |
| 8 pm Evening Review delivered | ≥ 28 of any 30 days (once the recipient address is configured) |
| Every trade, alert, lesson and parameter change traceable to a stored document | 100% |
| Leaderboard integrity | No entry without cost model, cohort count and validation label |

## Acceptance criteria — Chapter 01
- **Given** the app is deployed, **when** the owner opens the dashboard, **then** it shows the A$600 seed, the A$1,200 target, each execution's progress and TTD curve, and the reality panels (PRD-020..027).
- **Given** any code path attempts to contact a provider marked paid, **then** the call is blocked and an incident is logged (PRD-007).
- **Given** the app is used, **then** no screen offers to place a real order or link a broker (PRD-001).
- **Given** the recipient configuration value is missing, **then** the system runs normally, stores each Evening Review in-app, and shows a "set recipient address" banner (PRD-010).
