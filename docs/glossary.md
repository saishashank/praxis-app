# Praxis glossary

One-line meanings; the app and emails link here.
Every money figure is simulated: real market prices, modelled costs, no real orders or money.

## A

### A$ (Australian dollars)
The currency of the Australian practice rounds, so A$600 means 600 simulated Australian dollars.
_Spec: DAT-010, PRD-002_

### Abnormal return
The stock's move on an announcement day minus the market's move that day; large values often mark a price-moving item.
_Spec: AGT-020_

### Absolute gate
A check that a strategy makes money after costs, not just beats its controls: the lower end of its likely net return must be above zero.
_Spec: ARN-081, ARN-087_

### Acknowledge
Mark an alert as seen; the bell count clears only when you acknowledge, not when you open the list.
_Spec: UX-052, UXN-161_

### ADV (average daily value)
Average daily value: the mean of each day's close times volume over the previous 20 sessions; it sets liquidity tiers.
_Spec: AGT-030, ARN-010_

### AFSL
Australian Financial Services Licence: the licence that regulated financial advice requires; check it before sharing outputs with anyone else.
_Spec: PRD-025, ROL-107_

### Aim
The profit-taking price for a pick, set by its strategy's own rule, with the share of past similar trades that reached it.
_Spec: ARN-095, UXN-040, UXN-042_

### Alert inbox
The list of alerts grouped by tier, with P0 always at the top; acknowledged alerts move to Archived.
_Spec: UXN-157, UX-052_

### Alert tier P0
The most urgent alert: a held company at 10% or more of its strategy's value with a top-materiality announcement, or any halt of a held company.
_Spec: AGT-115, EML-020_

### Alert tier P1
An important alert: a held company below 10% weight with a materiality 2 or higher item, or a watchlist company with materiality 3.
_Spec: AGT-115_

### Alert tier P2
A routine alert, shown in the app and the digest only: anything that is neither urgent nor important.
_Spec: AGT-115_

### Allowlist
The list of Google addresses allowed to sign in, each with a role; anyone else is refused without any hint about the system.
_Spec: ROL-101, UX-120_

### Alpha-investing
A method that rations the chance of a false lesson across repeated tests, carrying unused chances forward.
_Spec: ARN-063_

### Annotation
A plain-text note of up to 1,000 characters on a lesson, card or hypothesis; it is never sent to any AI model.
_Spec: ROL-102b, KB-051_

### Announcement
A formal company notice to the exchange, such as results, a dividend, a contract win, a capital raising or a trading halt.
_Spec: AGT-020, DAT-103_

### Arena
The part of the app where the 12 practice strategies of each market run side by side, each starting with simulated A$600.
_Spec: ARN-000, ARN-001, UXN-031_

### ASIC
The Australian Securities and Investments Commission, the financial regulator; it publishes short-position data and caps leverage for retail clients.
_Spec: DAT-103, ARN-049_

### Assumed time
Flag on a historical announcement whose exact time is unknown; it is timed by its date and left out of the main test.
_Spec: DAT-001, ARN-020_

### ASX
The Australian Securities Exchange, the Australian share market; its real announcements and prices feed the simulation.
_Spec: PLT-010, DAT-103_

### Attention badge
A count on the Strategies tab of strategies that need a look, such as hitting their loss limit or a warning sign; no badge when zero.
_Spec: UXN-046_

### Attention reminder
A daily 08:00 Melbourne email, sent only when an item is amber or red, listing each open item and its one-line fix.
_Spec: EML-023_

### Audit log
A permanent record of sign-ins, role changes, allowlist changes and Owner actions; corrections are added as new entries.
_Spec: ROL-104, NFR-023_

## B

### Backup
An encrypted nightly copy of the database kept in a private repository, used to restore data after a failure.
_Spec: PLT-022, PLT-022b_

### Based on
The two or three plain-language reasons behind a trade idea or pick, each linked to its news item where one exists.
_Spec: UXN-037, UXN-038_

### Benchmark index
A broad market index, such as the S&P/ASX 200, that tracks the whole market and is used for market mood and comparisons.
_Spec: DAT-010, ARN-004_

### Block bootstrap
A test that reshuffles blocks of consecutive trades to see whether a result could be chance, keeping nearby trades together.
_Spec: ARN-081_

### Bonferroni
A strict correction for many tests: each test's threshold is divided by the number of tests, so one lucky result counts for less.
_Spec: ARN-081, ARN-085_

### Break-even move
The price move a sleeve trade needs to cover its costs, about +5% at the default size; shown beside the close-out move.
_Spec: ARN-045, PRD-026_

### Break-glass recovery address
A spare Google address for the Owner that stays switched off until a documented recovery step turns it on; every use is emailed and logged.
_Spec: ROL-101a, OPS-040a_

### Brokerage
The fee a broker charges per trade; the simulator charges it using the chosen cost profile and shows it as a trading fee.
_Spec: ARN-030, UXN-031_

### Bust
The simulated loss limit: a practice round ends and restarts when its value falls to A$300 or less, half the starting money.
_Spec: ARN-051, ARN-052, Ch. 05 section 5.1_

### Buy zone
The price range where a pick may be bought: tonight's close plus a small slippage allowance, valid for two sessions by default.
_Spec: AGT-113, UXN-040_

## C

### Calibrated probability
A probability is shown only with a stored calibration report; without one the app says "not yet calibrated" and does not present it as a forecast.
_Spec: VAL-101_

### Candle and pattern (A4)
The agent that calculates indicators and checks candlestick patterns from daily prices; patterns stay informational until they pass.
_Spec: AGT-030, AGT-031, Ch. 07 section 7.1_

### Candlestick chart
A chart that draws each day's open, high, low and close as one bar, with volume shown below.
_Spec: UXN-271_

### Candlestick pattern
A short price shape, such as a bullish engulfing or hammer, detected by fixed rules; only a PASSED pattern may affect F4.
_Spec: AGT-031, ARN-074_

### Capital raising
A company selling new shares to raise cash; the system treats it as a negative event because it can dilute the share price.
_Spec: AGT-020, DAT-223_

### Challenger
A proposed new rule version that must pass replay, a shakedown and the promotion test before it can replace the current one.
_Spec: KB-040, ARN-065_

### Champion
The rule version a strategy currently runs, which its challengers are compared against.
_Spec: UXN-201_

### Change ledger
A record of every rule, parameter or knowledge change with its before and after values, so each change can be reversed.
_Spec: ARN-067, KB-043_

### CIF
Cumulative incidence: the estimated share of practice rounds that reach each outcome (target, bust, stalled or timeout) by a given session, counting rounds still running.
_Spec: ARN-071_

### Close-out
The forced closure of a sleeve trade once its loss reaches half its margin, plus costs.
_Spec: ARN-044_

### Close-out move
The price fall of about 5% that forces a sleeve trade to close; it is shown beside the break-even move.
_Spec: ARN-045_

### Close signal (CS)
An exit decided at the day's close and filled at the next session's open, less slippage.
_Spec: ARN-021_

### Cohort
One practice round from its start until it reaches target, bust, stalled or timeout; the app shows it as a round.
_Spec: ARN-053, UXN-031_

### Company and sector research (A2)
The agent that turns each announcement into a dated event record with its category, polarity and the price reaction.
_Spec: AGT-020, Ch. 07 section 7.1_

### Company overview ("i")
The panel opened by the "i" icon: what a company does, its SWOT, recent news and our view, with AI-written text clearly labelled.
_Spec: UXN-272_

### Company page
The page for one company with a candlestick chart, key numbers, our activity and its news and announcements.
_Spec: UXN-271_

### Completion marker
A stored record that a day's nightly steps finished, so later steps and the email only use complete data.
_Spec: DAT-020, EML-035_

### Completion window
Waiting period after a holdout that lets trades finish, so every outcome is complete before the holdout is judged.
_Spec: ARN-082_

### Confirmation look
A single second test of a promising weekly finding on new data; it can be run only once.
_Spec: ARN-062_

### Control Room
The System Health page drawn as a status ring with nine parts, each healthy, needing attention or down.
_Spec: UXN-283, PLT-061_

### Controls C1 to C3
Yardsticks run beside the strategies: C1 holds a broad index fund, C2 makes random matched trades, C3 is C2 with the leverage sleeve.
_Spec: ARN-004, ARN-084_

### Corporate action
A company event that changes a share's count or price, such as a dividend, split, consolidation, merger, rights offer or delisting.
_Spec: DAT-220_

### Cost drag
How much fees and price slip reduce a result, so you can see how much of a gain costs take away.
_Spec: UX-020, UXN-123_

### Cost-infeasible at this seed
A label shown when the average gross return per trade cannot cover round-trip costs on A$600; it blocks PASSED-BACKTEST.
_Spec: ARN-094_

### Cost profile P0
A zero-fee setting, used only where a broker charges no fee; otherwise the P1 setting applies.
_Spec: ARN-031_

### Cost profile P1
A flat A$3.00 fee on every trade.
_Spec: ARN-031_

### Cost profile P2
No fee on the first buy of a share each day when it is under A$1,000; otherwise the greater of A$11 or 0.10%.
_Spec: ARN-031_

### Cost profile P3
A stress setting with a A$6.50 fee per trade, used to check results still hold when costs are higher.
_Spec: ARN-031, ARN-083_

### Cost profile P4
A fee of 0.03% of trade value, with a A$3 minimum and a A$9.99 maximum.
_Spec: ARN-031_

### Cost profile P5
The default setting: A$5 on trades up to A$1,000, rising in steps to 0.12% of value above A$25,000.
_Spec: ARN-031, ARN-032_

### Cost profile P5b
A lower-fee variant: A$2 on trades up to A$1,000, then 0.20% of value.
_Spec: ARN-031_

### Critic (A7)
The agent that runs fixed checks on every lesson and proposed change, and lets an AI model word any concerns.
_Spec: AGT-041, AGT-042_

## D

### Daily review and learning (A6)
The agent that works out what each strategy did, compares them, and writes lessons and tomorrow's plan from stored results.
_Spec: AGT-040, ARN-060 to ARN-069_

### Data quality gate
A daily check of how complete and valid the price data is; if the largest tier falls below 95%, no new trades are made that night.
_Spec: DAT-201, DAT-210_

### Data review queue
The Owner's list of unclear company events, such as splits, to confirm, edit or reject; each card shows its evidence.
_Spec: DAT-221, UX-114_

### Day 0
The session in which an announcement was published; its price effect is measured from that day.
_Spec: ARN-020_

### Decision Card
A one-page record for each trade idea: the rules that fired, evidence, risks, exit plan, costs and a historical range.
_Spec: AGT-110, UX-041_

### Decision cut-off
The fixed 18:10 Melbourne time each day; news published after it feeds the next day's decisions.
_Spec: ARN-020, PLT-073_

### Degrade mode
A reduced-work state entered when a monthly free quota passes 95%: non-essential jobs pause and the system keeps running on rules.
_Spec: PLT-051, NFR-005_

### Delayed prices
Share prices shown during trading hours about 20 minutes late; for display only, so trading rules still use end-of-day prices.
_Spec: UXN-048_

### Delisting
A company leaving the exchange; holdings close at the last price, or at zero after administration or liquidation.
_Spec: ARN-026, DAT-220_

### Development (split)
The oldest part of history, used to design and learn rules; every result shown on a screen comes from it.
_Spec: ARN-071, ARN-082_

### Digest history
The stored list of every past Evening Review, searchable by date and text.
_Spec: EML-015, UX-080_

### Distance to bust
The bar showing how far a position's value sits above the A$300 bust line; a simulated figure, not a margin call.
_Spec: UXN-150_

### Dividend
Cash a company pays shareholders out of its profits; the holder must own the share before the ex-date to receive it.
_Spec: DAT-220, ARN-036_

### Drawdown
How far a value has fallen from its highest point.
_Spec: UXN-031, UX-020_

### DSR
Deflated Sharpe ratio: a score of how likely a strong-looking result is real after allowing for how many variants were tried; it must reach 0.95 to pass.
_Spec: ARN-087 (vi), VAL-102_

## E

### Edge
A real, repeatable advantage over random picking after costs; the validation labels test whether one exists.
_Spec: ARN-086, ARN-087_

### Editor
A user who can add notes and run what-if checks, but cannot change rules, settings, users or any other configuration.
_Spec: ROL-102, ROL-102a_

### Effective N
The number of independent practice rounds behind a figure, with overlapping rounds counted once; it is the only count used.
_Spec: ARN-053_

### Evening Review
The daily report, sent at 20:00 Melbourne time and kept in the app, covering trades, profit, lessons, tomorrow's plan and success rates.
_Spec: EML-010, EML-012_

### Event record
A stored record of one categorised company announcement, with its polarity, day-0 price move and volume.
_Spec: AGT-020_

### Evidence timeline
A notice showing when each strategy could reach the next evidence level, based on how fast it produces finished trades.
_Spec: VAL-102, UX-017_

### Ex-date
The first day a share trades without its next dividend; you must hold the share at the close before it to receive the dividend.
_Spec: ARN-036_

### Execution
One of the 12 simulated accounts per market, set by strategy family, own-money or borrowed-money version, rule version and cost profile; shown as a strategy.
_Spec: ARN-001, ARN-002, UXN-031_

### Expectancy
The average net profit or loss per trade after costs, which is the typical result of one trade.
_Spec: ARN-070_

## F

### F1 Follow the trend
Buys shares at a one-year high on heavy trading and rides the rise with a trailing stop.
_Spec: UXN-039, Ch. 07 section 7.4_

### F2 Good company, good news
Buys solid, fairly priced companies just after better-than-expected results.
_Spec: UXN-039, Ch. 07 section 7.4_

### F3 News jump
Buys shares that jump on big good news with heavy trading, hoping the rise continues for a few weeks.
_Spec: UXN-039, Ch. 07 section 7.4_

### F4 Buy the dip
Buys strong companies after a short, sharp fall with no bad news behind it, and sells on the bounce.
_Spec: UXN-039, Ch. 07 section 7.4_

### F5 Small-company spotter
Looks for small companies with unusual buying and good news; the highest-risk family.
_Spec: UXN-039, Ch. 07 section 7.4_

### F6 Signals agree
Buys only when at least three different kinds of evidence point the same way.
_Spec: UXN-039, Ch. 07 section 7.4_

### Fallback chain
The ordered list of AI providers tried in turn when one fails or runs out, ending in rules-only text.
_Spec: LLM-011_

### Fill
The simulated price and quantity at which a trade is executed, after slippage and brokerage.
_Spec: ARN-021, ARN-030_

### Financing
Simulated daily interest on the borrowed part of a sleeve trade, at 9% a year.
_Spec: ARN-045_

### Force-apply
An Owner override that applies a rule change without passing the promotion test; its label resets to UNVALIDATED and the action is logged.
_Spec: AGT-042, KB-050_

### Forward evidence
Results from live practice after a rule was set; the only evidence that is fully out-of-sample.
_Spec: ARN-086_

### Fundamentals
Company financial figures, such as earnings and debt, used by F2 only from the date they became known.
_Spec: DAT-170_

## G

### Gain and loss colours
Teal shows gains and amber-orange shows losses, always with a sign and an arrow, so colour is never the only clue.
_Spec: UXN-001, UXN-281_

### Gap
A price that opens past a stop level; the stop fills at the opening price, which can be worse than the stop.
_Spec: ARN-021_

### GitHub Actions
GitHub's automated runner that performs the nightly batch jobs; it runs the data, learning and decision steps.
_Spec: PLT-013_

### Google sign-in
Sign-in with a Google account; only allowlisted, verified addresses get in, and there are no passwords or sign-ups.
_Spec: ROL-101, PLT-035_

## H

### Halt (trading halt)
A temporary suspension of trading in a share, usually around news; no simulated trade fills while it is halted.
_Spec: ARN-026, AGT-115_

### Heartbeat
Checks that run outside the main system at about 10:00 and 21:00 Melbourne time; they email if the worker or tonight's review is missing.
_Spec: PLT-074, NFR-006_

### Holdout
The final slice of history kept untouched until a challenger is checked once; it cannot be tuned against.
_Spec: ARN-082_

### Home
The Today tab: a day summary, value per currency, market mood, tonight's trade ideas, news on held or watched companies and a link to the latest review.
_Spec: UXN-034_

### Hypothesis
An untested idea for a rule change, graded L0; it must become a challenger and pass the tests before it can affect trades.
_Spec: FAM-101, KB-002_

## I

### Incident
A recorded problem with severity S1, S2 or S3; one email is sent when it opens or escalates, not one per check.
_Spec: NFR-006, Ch. 11 section 11.4_

### Insider and flow score
A score from −1 to +1 built from directors' trades and substantial-holder changes; used only by F6 and Decision Cards.
_Spec: AGT-105_

### Insufficient evidence
Shown when there is not enough history to judge, such as fewer than 30 cases; the app shows "Not enough history yet (n = x)" instead.
_Spec: ARN-070, ARN-078, UX-020_

### Interval (90%)
A range the true figure is 90% likely to fall within; every interval in the app is 90%, and it is always shown with its n.
_Spec: ARN-070, ARN-086_

### Intraday stop (IS)
An exit that triggers during the day when the price reaches the stop level, filled at that level less slippage.
_Spec: ARN-021_

## K

### Key numbers
On a company page: market capitalisation, 52-week range, average daily volume, P/E, dividend yield and sector; "not available" where the source lacks one.
_Spec: UXN-271_

### Kill switch
An Owner switch that stops a data source or a strategy family; a family switch can also trip automatically when forward results break the test.
_Spec: DAT-123, ARN-093, UX-050_

### Knowledge base
The app's memory of rules, lessons, challengers, reviews and decisions, stored as data and as readable documents.
_Spec: KB-001, PRD-009_

## L

### L0 (observation)
The lowest lesson grade: something noticed but not yet tested.
_Spec: ARN-063_

### L1 (hypothesis)
A lesson grade for a pattern that looks real on the first two-thirds of development data, with at least 30 trades; still unconfirmed.
_Spec: ARN-063_

### L2 (tested)
A lesson grade for a pattern that also holds on the purged last third of development data, within the cumulative false-discovery limit.
_Spec: ARN-063_

### L3 (adopted)
The top lesson grade: an L2 lesson applied to a rule, or one that led to a challenger which then passed the promotion test.
_Spec: ARN-063_

### Lane A
Daily, automatic knowledge updates that can change only AI wording and Owner notes, never a trade.
_Spec: ARN-064, KB-030_

### Lane B
The guarded path for rule and parameter changes; a challenger must pass the promotion test before it can change any trade.
_Spec: ARN-065, KB-040_

### Learning journal
The running, dated record of every Evening Review, kept as a document so the system can learn from its own history.
_Spec: EML-015_

### Lesson
A statement learned from results, shown with its trade count and a grade from L0 to L3 that says how well it has been tested.
_Spec: ARN-063, KB-020_

### Leverage
Borrowed money that multiplies a trade's exposure; the sleeve uses a hypothetical 10 times, or 5 times in the reality-adjusted view.
_Spec: ARN-040, ARN-049_

### Leverage sleeve (L)
A hypothetical side account that adds borrowed exposure to a share trade; it is simulated only and shown as "with borrowed money".
_Spec: ARN-040, UXN-031_

### Lineage
A strategy family's chain of rule versions, from its first rules through every challenger; splits and limits are kept per lineage.
_Spec: ARN-082, Ch. 05 section 5.1_

### Liquidation NAV
A round's value if every holding were sold now, after exit costs; target, bust and stalled are judged on this figure.
_Spec: ARN-051, ARN-052_

### LLM (AI model)
A large language model: an AI text model used only to word, summarise and critique, never to calculate numbers or choose trades.
_Spec: LLM-001, AGT-001_

### LLM budget
The daily cap on AI requests and tokens for each role; once it is used up, rules-only text is shown instead.
_Spec: LLM-021, LLM-050_

### Lockout
A pause after a loss: a sleeve locks after a losing leveraged trade until a recovery rule unlocks it; a failed comparison check also waits 60 sessions.
_Spec: ARN-046, ARN-047, ARN-062_

### Luck check
A comparison against random picks, so a strategy's results can be judged against chance.
_Spec: UXN-031, UXN-041_

## M

### Macro and regime (A3)
The agent that works out the market's daily regime from the benchmark index and reports the economic calendar.
_Spec: AGT-101, Ch. 07 section 7.1_

### Mark as read
A button on the Evening Review that records you have read it; if none is marked read for three days, the Dashboard shows a banner.
_Spec: EML-036, UX-015_

### Market
A country's share market with its own currency, costs and rules: Australia (ASX) first, then India and the USA later.
_Spec: MKT-101, O-27_

### Market mood
The app's plain name for the regime: how the overall market is behaving, from its index trend and how much prices are swinging.
_Spec: UXN-031, AGT-101_

### Market status
The work state of each market: not started, in build, testing, active or paused, with the date of the last change.
_Spec: MKT-106_

### Market tab
The tab for searching and browsing every listed company, with top movers, a sector heat grid and company pages.
_Spec: UXN-270_

### Marketable parcel
The smallest buy allowed for a new holding, A$500 by default; smaller buys are rejected.
_Spec: ARN-024_

### Masking
Hides company codes, names, prices and exact dates from non-Owner users; companies appear as Stock A, Stock B and so on.
_Spec: UX-009, ROL-107_

### Material move
A move of 5% or more within one to three sessions after an announcement; the yardstick for scoring Sentinel alerts.
_Spec: ARN-073_

### Materiality
A score from 0 to 3 for how much an announcement could move a company's price; 3 is the most important.
_Spec: AGT-011_

### Melbourne time
Every time in the app and emails is Australia/Melbourne time: AEDT in daylight saving (October to April), AEST in winter.
_Spec: PLT-023, TST-103_

### Minimum detectable effect (MDE)
The smallest real edge the test would catch 80% of the time at its chosen level; shown with every result.
_Spec: ARN-081_

### Model success
The share of closed picks that made money after costs, shown with its count; hidden until enough picks have closed.
_Spec: UXN-041, AGT-113_

### Morning Brief
An optional 08:00 email with overnight news, today's calendar and tonight's plan; off by default and sent on trading days only.
_Spec: EML-016_

### Motion setting
Turns off non-essential animation; the app also follows your device's reduced-motion setting.
_Spec: UXN-281, UXN-005_

### Moving average (SMA)
Simple average of the last n closing prices, including today; shown as the 50-day and 200-day lines on company pages.
_Spec: AGT-030, UXN-271_

## N

### n (sample size)
The number of cases behind a figure; figures with too few cases are shown as insufficient evidence.
_Spec: ARN-070_

### NAV
What a practice round's cash, holdings and sleeve are worth at the latest close; the app shows it as "Value".
_Spec: ARN-051, UXN-031_

### Net and gross
Net means after brokerage and price slip; gross means before them.
_Spec: ARN-094, ARN-070_

### News tab
The tab that combines the news feed with the alert inbox, with filters for My companies, All news and Alerts.
_Spec: UXN-035, UX-060_

### Nightly pipeline
The sequence of data, learning and decision steps that runs each trading evening; it should finish by about 19:45 Melbourne time.
_Spec: DAT-020, EML-011_

### NOT-DEMONSTRATED
A label meaning the test did not pass but a useful edge is still possible; it is different from FAILED.
_Spec: ARN-086_

### Not financial advice
The footer on every page and email: results are simulated, for personal use only, and are not financial advice.
_Spec: NFR-031, ROL-106_

### Not yet measured
Shown instead of a figure until enough data exists; the app never fills the gap with an invented number.
_Spec: UX-002, REV-003_

## O

### Open position
Shares a practice round currently holds; each has a stop-loss and a time stop.
_Spec: ARN-003_

### Operational shakedown
Ten sessions of live running for a challenger to check it works; this is an operational check, not evidence of profit.
_Spec: ARN-065, KB-040_

### Order
A simulated instruction to buy or sell, filled at the next session's open; no real order is ever sent.
_Spec: ARN-020, UX-042_

### Owner
The one account that controls everything: users, rules, settings, sources and approvals; the only role that can change anything.
_Spec: ROL-101, ROL-102_

### Owner-accepted risk
A known risk the Owner has accepted in writing, such as using an unofficial price feed; each is recorded with its reference number.
_Spec: DAT-120, DAT-122_

## P

### P/L (profit and loss)
Money gained or lost on a simulated trade or round after costs; always shown per currency and labelled simulated.
_Spec: UX-002, UX-013_

### Paper trading
Practising with simulated money at real prices and modelled costs; no real orders are placed and no real money is held.
_Spec: PRD-001, PRD-024_

### Partial review
An Evening Review sent before every step finished, with a box at the top listing the missing sections; also called partial mode.
_Spec: EML-011, PLT-073_

### Participation cap
The largest slice of a company's typical daily trading value a simulated order may take: 1%.
_Spec: ARN-024_

### PASSED-BACKTEST
A label: the rule passed its tests on validation data and a holdout check, but has not yet been proven in live practice.
_Spec: ARN-086_

### Pause
An Owner action that stops a strategy opening new trades while still managing its existing positions.
_Spec: UX-050_

### PBO
Probability of backtest overfitting: estimates how likely the best past result comes from fitting the past too closely; must be 0.2 or lower to pass.
_Spec: ARN-087 (v), VAL-102_

### Per-currency totals
Totals are shown separately for each currency and never converted into one grand total.
_Spec: O-34, UX-013_

### Pick
A published trade idea for one of the three risk profiles, followed on paper, with its numbers fixed at the time it was shown.
_Spec: UXN-040, ARN-095_

### Pick states
Waiting to buy, Bought at a price, Missed (never reached its buy zone, so not counted) or Closed with its result.
_Spec: UXN-040, UXN-043, ARN-095_

### Picks
The tab showing up to five pick ideas per risk profile, each with buy zone, stop-loss, aim and time frame.
_Spec: AGT-113, UXN-040_

### Playbook
A short guide fed into one agent's AI prompt, built from stored lesson fields rather than free text.
_Spec: KB-002, KB-032_

### Point-in-time data
Data stored with the time it was published, so each decision uses only what was known then.
_Spec: DAT-001_

### Polarity
Whether an announcement is likely good (+), bad (−) or neutral (0) for the share price, set by rules.
_Spec: AGT-020_

### Pre-open re-check
A check at 09:55 that cancels any pending buy if the company has since halted or a thesis-breaker has fired.
_Spec: ARN-020a_

### Price-sensitive announcement
An announcement the company marks as likely to move its share price; it feeds the materiality and event rules.
_Spec: AGT-011_

### Promotion
The step where a challenger replaces its strategy's rule version, only after passing the promotion test at a cohort boundary.
_Spec: KB-040, ARN-065_

### Promotion test (VAL-110)
The single test a challenger must pass: an edge over controls, cost checks, a safety check and risk statistics.
_Spec: ARN-087_

### Purge
A gap of days between two test periods, so no trade can run from one period into the next.
_Spec: ARN-082_

## Q

### Quiet hours
A time window when P1 and P2 alerts are held back; P0 alerts are never held back.
_Spec: UXN-160_

### Quota
The free allowance limit on requests, storage, minutes or emails per month or per day; the system tracks usage against each one.
_Spec: PLT-050, PLT-051_

## R

### R1 to R5 (AI roles)
The internal AI jobs: R1 triage, R2 analyst, R3 strategist and critic, R4 chart reader (optional), R5 writer; never shown as primary text.
_Spec: LLM-010, Ch. 03 section 3.2_

### Realised and unrealised
Realised profit or loss comes from closed trades; unrealised is the gain or loss on positions still open.
_Spec: EML-012 (section 3)_

### Reality panel
A box beside results showing illustrative odds and random-chance comparisons, so expectations stay realistic.
_Spec: PRD-020, UX-104_

### Regime
The market's state each day: SHOCK, RISK-OFF, NEUTRAL or RISK-ON, from the index trend and how much prices are swinging.
_Spec: AGT-101, UXN-031_

### Region switcher
The header menu for choosing AU, IN or US; only active markets can be selected.
_Spec: UXN-282_

### Replay
Running a strategy's rules over past data to see how it would have done.
_Spec: ARN-080_

### Resend
The email service that sends the Evening Review and alerts; it is free and sends only to the Owner's address.
_Spec: EML-001, EML-003_

### Reviews tab
The tab for past Evening Reviews and "What the system learned", covering lessons and changes.
_Spec: UXN-033_

### Risk Monitor
The view of every open simulated position with its stop, time limit, weight, warning status and latest alerts; now part of Strategies.
_Spec: UX-050, UXN-033_

### Risk profiles (Aggressive, Balanced, Conservative)
The three Picks profiles: Aggressive allows any company and larger sizes, Balanced uses larger companies, Conservative uses only the largest, least volatile ones.
_Spec: AGT-113_

### Rolling holdout
The test period that moves forward when a challenger is promoted or the Owner asks, so newer data becomes the holdout.
_Spec: ARN-082_

### Rolling-start replay
A replay that starts a new practice round every five sessions over past data, giving most of the early evidence.
_Spec: ARN-080, BLD-031_

### Round
The app's name for a cohort; see Cohort.
_Spec: UXN-031_

### Rule version
A numbered set of strategy rules that is never edited; any change creates a new version.
_Spec: KB-011_

### Rules-only
Running without an AI model: alerts, trades and emails still work from fixed rules and template text, labelled as such.
_Spec: LLM-002, EML-014_

### Run record
A stored log of each scheduled job: when it ran, its status, items processed and any error.
_Spec: PLT-017_

## S

### 250-session high
A signal test: today's close is at least the highest close of the previous 249 sessions.
_Spec: AGT-030_

### S1
The most serious incident, such as a broken ledger, a leaked secret or unauthorised access; the affected market is paused the same day.
_Spec: Ch. 11 section 11.4, NFR-006_

### S2
A serious incident, such as a nightly run failing twice or the Sentinel blind for hours; the target response is within 24 hours.
_Spec: Ch. 11 section 11.4_

### S3
A minor incident, such as one source degraded with a working fallback; it is reviewed at the next weekly review.
_Spec: Ch. 11 section 11.4_

### Sample data
Example data in a mock-up or empty state, always labelled SAMPLE DATA so it is never read as a result.
_Spec: UX-102_

### Scenario table
Bad, typical and good cases from the strategy's own past similar trades, shown as 10th, 50th and 90th percentiles: a historical range, not a forecast.
_Spec: AGT-110, UX-041_

### Scribe (A8)
The agent that assembles the Evening Review and dashboard summaries from stored data; AI wording is optional.
_Spec: AGT-043, Ch. 07 section 7.1_

### Secret
A private key or token that lets one service talk to another; kept only in service settings, never shown, emailed or pasted.
_Spec: PLT-040, SEC-101_

### Sector heat grid
A grid of sectors coloured by their day change; tap one to list its companies.
_Spec: UXN-270_

### Seed
The starting simulated money for each practice round: A$600, shown as "starting money".
_Spec: ARN-001, PRD-002_

### Sentinel (A1)
The agent that watches announcements and news through the day and raises alerts for held and watched companies.
_Spec: AGT-010, AGT-014_

### Sessions
A trading day on the exchange; holding limits and round lengths are counted in sessions, not calendar days.
_Spec: ARN-027, Ch. 05 section 5.1_

### Settlement (T+2)
The two-session delay before a sale's proceeds count as cash; simulated trades follow the same rule.
_Spec: ARN-025_

### Shadow cohort
An unfinished twin or control round that keeps running in the background for statistics only, with no live effect.
_Spec: ARN-053_

### Shadow sleeve
A hypothetical log of sleeve trades kept while the real sleeve is locked; it helps judge the recovery rule.
_Spec: ARN-048, ARN-047_

### Sharing acknowledgement
A one-time Owner confirmation, recorded before adding any other user, that the financial-advice sharing risk has been considered.
_Spec: ROL-107_

### Short interest
The share of a company's shares that have been sold short, from ASIC reports published with a lag; used by F6 only.
_Spec: DAT-103, AGT-105_

### Signal
A rule-based buy idea for a company from a strategy family, before filters and position sizing.
_Spec: ARN-080, AGT-014_

### Signal ledger
The single list of every family signal that passed the filters, with at most one open row per company and strategy; used for trade-level tests.
_Spec: ARN-080_

### Signal success
The share of an agent's alerts or signals that a later real price move confirmed; "n/a" where the agent has no test.
_Spec: ARN-073, ARN-074_

### Simulated
Label on every money figure: real market prices with modelled costs and fills; no real orders or money are involved.
_Spec: UX-002, PRD-024_

### Slippage
Price slip: the modelled extra cost of paying a little more, or getting a little less, than the quoted price.
_Spec: ARN-032, UXN-031_

### Snooze
Hides an amber attention item for 1, 3 or 7 days; red items cannot be snoozed.
_Spec: EML-023, UXN-283_

### Source licence register
The record of each data source's terms, permitted use, rate limits and status: enabled, disabled or owner-accepted risk.
_Spec: DAT-120_

### Source-off mode
A data source switched off; trades that need it are blocked or reduced, exits still run, and the review lists the feed as off.
_Spec: DAT-127, DAT-123_

### Staging
The test copy of the app: recorded data only, email to the Owner only, and subjects prefixed [STAGING].
_Spec: NFR-040, EML-004_

### Stale data
Data older than twice its expected interval; the page shows a banner with the time of the last good data.
_Spec: UX-007, PLT-017_

### Stall floor
The value below which a round counts toward stalled: about A$511, the same for own-money and borrowed-money versions.
_Spec: Ch. 05 section 5.1, UX-011_

### Stalled
A round ends when it holds no trade and cannot afford a parcel for five sessions, or is turned away for that reason for 20 sessions.
_Spec: Ch. 05 section 5.1, UX-011_

### Stop-loss
A price below the buy price at which a holding is sold to limit the loss; prices can gap through it, so losses can exceed it.
_Spec: ARN-021, UXN-045_

### Strategies tab
The tab with the 12 practice strategies per market, their risk, kill switches and the risk overview.
_Spec: UXN-033_

### Strategy family
One of six strategy types, F1 to F6, each with its own entry, exit and sizing rules, run as an own-money and a borrowed-money twin.
_Spec: ARN-002, Ch. 07 section 7.4_

### Strategy Lab (A5)
The agent that applies the six strategy rules after the books close, producing signals, Decision Cards, next-open orders and controls.
_Spec: Ch. 07 section 7.1, ARN-060_

### Stress test
A table of simulated results under pre-computed market falls and rises, such as the ASX down 10% to 30%; computed overnight.
_Spec: UXN-152_

### Suggested size
The position size a pick profile allows, from its caps and your notional portfolio amount; an example, not an order.
_Spec: AGT-113, UXN-040_

### Survivorship bias
Results look better than they were because companies that later failed or left the exchange are missing from the history.
_Spec: ARN-082_

### SWOT
Strengths, weaknesses, opportunities and threats: a short list of factors about a company.
_Spec: UXN-272_

## T

### Target
The simulated goal of each round: a liquidation value of A$1,200, double the starting money.
_Spec: ARN-051, ARN-052, UXN-031_

### Terminal state
The final outcome of a round: target, bust, stalled or timeout.
_Spec: ARN-071, Ch. 05 section 5.1_

### Theme
The colour style of the app (dark, light, midnight, dim, high contrast or match device); it changes only how the app looks.
_Spec: UXN-280_

### Thesis-breaker
A condition that would mean a trade's reason no longer holds, such as a price breaking a level; shown green, amber or red as "warning signs".
_Spec: AGT-111, UXN-031_

### Tick size
The smallest allowed price step for a share; the simulator rounds slippage to whole ticks.
_Spec: ARN-032_

### Tied
Two or more strategies whose ranges overlap are grouped as tied and listed alphabetically; they are never ranked.
_Spec: ARN-078, UX-020_

### Time frame
The expected holding period for a pick, shown in weeks, from the median holding time of past similar trades.
_Spec: AGT-113, UXN-042_

### Time stop
A limit on how many sessions a holding can stay open; the holding is closed when the limit is reached.
_Spec: ARN-003_

### Time to target (TTD)
The number of sessions from a round's start until its liquidation value first reaches the target.
_Spec: ARN-051_

### Timeout
A round that reaches 252 sessions without any other outcome; it then ends and restarts.
_Spec: Ch. 05 section 5.1_

### Token expiry
The date a secret expires; reminders go out 30, 14, 7 and 2 days before it.
_Spec: SEC-021, NFR-006_

### Top movers
The Market tab list of the biggest rises, the biggest falls and the most-traded companies of the day.
_Spec: UXN-270_

### Track record
The page listing every closed pick, the figures shown at publication, what happened and success over time.
_Spec: UXN-043_

### Trade idea
A signal the system plans to act on, shown with its Decision Card and marked as taken or not taken.
_Spec: UX-040, UXN-040_

### Trailing stop
A stop that rises with the highest close since entry and never falls.
_Spec: Ch. 07 section 7.4 (F1)_

### Trial budget
A limit on how many tests and challengers a lineage may use on one validation period; each use is counted so chance wins are not treated as proof.
_Spec: ARN-085_

### Triple barrier
A signal test where a trade closes at a profit target, a loss limit or 20 sessions, whichever comes first.
_Spec: ARN-072_

### Turso
The free database that holds the app's data; on the free plan it can restore to a point one day back.
_Spec: PLT-020, DAT-141_

### Twin pair
The own-money and borrowed-money versions of one strategy family; they get identical signals and restart together.
_Spec: ARN-002, ARN-053_

## U

### Universe snapshot
The stored daily record of which companies were listed, with their tier, size and trading value, so history stays point-in-time.
_Spec: DAT-130_

### Universe tiers U1 to U3
Groups of companies by size and trading value: U1 Core (most traded), U2 Extended, and U3 Discovery (smallest, with extra checks).
_Spec: ARN-010, ARN-011_

### Unlevered (U)
The version of each strategy that uses only its own simulated money; the app shows it as "own money".
_Spec: ARN-022, UXN-031_

### Unmask
An Owner action that shows one user all company codes for 30 days; every change is audit-logged.
_Spec: ROL-107, UX-009_

### UNVALIDATABLE
A label for a rule whose event history covers under 90% of its test dates, so it cannot be tested yet.
_Spec: DAT-127, ARN-086_

### UNVALIDATED
A label for a rule with no passed evidence yet: it is not proven better than luck.
_Spec: ARN-086, UXN-123_

## V

### Validation label
The evidence badge on a strategy: UNVALIDATED, PASSED-BACKTEST, CONSISTENT-FORWARD, FAILED, NOT-DEMONSTRATED or UNVALIDATABLE, each defined in this glossary.
_Spec: ARN-086, UXN-060_

### Validation split
The middle slice of history where a challenger is tested for pass or fail before the holdout is used.
_Spec: ARN-082_

### Vercel
The free hosting service that runs the web app; it serves the pages and the app's routes.
_Spec: PLT-001_

### Viewer
A user who can read pages but change nothing except their own preferences and alert acknowledgements; codes are masked for them.
_Spec: ROL-102, ROL-102a_

### Volatility
How much a price swings day to day, measured as the spread of daily returns over 20 sessions.
_Spec: AGT-101_

### Volume ratio
Today's trading volume divided by the average of the previous 20 sessions.
_Spec: AGT-030_

## W

### Watchdog
A scheduled check at 20:40 and 21:50 Melbourne time that sends the review itself if it is missing, and fails on purpose so GitHub emails the Owner.
_Spec: PLT-074, NFR-006_

### Watchlist
Companies you star to follow; their news and alerts are tracked, and the list appears on Home.
_Spec: UXN-047, AGT-014_

### Why this trade
The plain-language reasons behind a trade idea, written from stored facts: by AI when available, otherwise labelled rules-only.
_Spec: UXN-102, UXN-042_

### Win rate
Share of trades that made money after costs.
_Spec: ARN-070_

### Worker (Cloudflare)
The small always-on Cloudflare program that polls announcement sources each minute and starts the nightly jobs.
_Spec: PLT-012_

### Written without AI today
A label on an Evening Review whose narrative sections were written from stored facts only, because no AI model was available.
_Spec: EML-014, UXN-113_

## Z

### Zero-edge benchmark
A simulated strategy with no real edge but the same volatility, costs and trading style; results should beat it to count.
_Spec: ARN-071, UXN-068_

## Market terms

_Standard market terms the app shows; the spec uses them without defining them (decision D-011)._

### ATR (average true range)
How much a share price typically moves in a day, averaged over recent days; stops are set a few ATRs away.
_Spec: AGT-030, ARN-021, UXN-122_

### Bid-ask spread
The gap between the best price buyers offer and the best price sellers ask; a wide spread makes trading dearer.
_Spec: UXN-123_

### Dividend yield
Dividends paid over the last year as a percentage of today's share price.
_Spec: UXN-271_

### EBITDA
A company's earnings before interest, tax, depreciation and amortisation — a rough measure of cash earnings from operations.
_Spec: Ch. 07 §7.4_

### Franking
Australian tax credits attached to some dividends for tax the company already paid; recorded but not counted in simulated NAV.
_Spec: ARN-036, DAT-220_

### GICS sector
The standard industry group (such as Financials or Materials) a company belongs to.
_Spec: Ch. 07 §7.4_

### Liquidity
How easily a share can be bought or sold without moving its price; low liquidity is shown as a headwind.
_Spec: UXN-123, ARN-010_

### Market capitalisation
A company's total share-market value: share price times the number of shares on issue (market cap).
_Spec: UXN-271, ARN-010_

### Net debt to EBITDA
Debt minus cash, divided by EBITDA; it shows how many years of cash earnings would repay the debt.
_Spec: Ch. 07 §7.4_

### P/E (price to earnings ratio)
Share price divided by earnings per share; how many years of current profit the price pays for.
_Spec: UXN-271, Ch. 07 §7.4_

### Profit factor
Total simulated gains from winning trades divided by total simulated losses from losing trades; above 1 means gains exceeded losses.
_Spec: EML-012_

### Average win / average loss
The average simulated gain on winning trades compared with the average simulated loss on losing trades.
_Spec: EML-012_

### RSI (relative strength index)
A 0–100 score of how strongly a price has risen or fallen recently; very low values suggest a short-term oversold share.
_Spec: AGT-030, Ch. 07 §7.4, UXN-122_
## Set-up terms

_Terms used in the Owner guide (BLD-012)._

### 2-step verification
A second sign-in check (a code or phone prompt) on top of your password; required on every account the build uses.
_Spec: SEC-020_

### age key pair
Two linked keys made with the free `age` tool: the public key locks backups, and only the offline private key can unlock them.
_Spec: PLT-022b, SEC-017 k_

### Cloudflare
The free service that runs Praxis's small always-on timer program (the Worker); production and staging use separate accounts.
_Spec: BLD-010 r7, O-32_

### Cloudflare Worker
A small program on Cloudflare that wakes on a schedule to keep time and start jobs; it has no public web page.
_Spec: PLT-071, BLD-012_

### GitHub
The website that holds the app's code, runs its automatic tests and deployments, and stores most of its secrets.
_Spec: BLD-010 r1_

### GitHub environment
A named, locked box of secrets in GitHub (such as `production`) that only approved jobs on set branches can open.
_Spec: SEC-017, SEC-108_

### Google Cloud
Google's console where the sign-in clients ("Sign in with Google") for production and staging are created.
_Spec: PLT-035, BLD-010 r10_

### M0
The first milestone: you set up the free accounts and stores; the build agent then builds everything else.
_Spec: BLD-010, BLD-011_

### OAuth client
The registration that lets Praxis offer "Sign in with Google"; it has a public ID and a secret kept in Vercel.
_Spec: PLT-035, SEC-017 j_