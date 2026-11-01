# M15 movers gap study — what the Cortex could and could not have seen

Status: qualitative gap analysis, November 2026. Public-safe: no codes, prices or day-level dates. The private study (codes, per-mover table, numbers) lives in the private data folder (SEC-110). This note changes no code; every addition below goes through design-freeze change control (D-380, D-461 hold).

## Question
The Owner asked whether the Cortex (ch. 17, angles D1–D10, families F1–F6) could have predicted the past year's largest single-day movers — overnight gaps and intraday moves — and, if not, what is missing.

## Method (and its limits)
- Window: the twelve months to late October 2026, every ASX code in the history extract, the app's interim movers filter (price and traded-value floors, D-200) applied to the prior session so nothing is known ahead.
- Per stock-day: daily move, overnight gap and intraday move; volume vs the prior 20 sessions; index and same-industry moves; ASIC short interest as published. Split and adjustment days excluded.
- Three top-10 gainer lists (daily, gap, intraday) and the matching loser lists: 30 gainer slots (24 unique stock-days), 30 loser slots (20 unique).
- For each mover, what the Cortex could have known at the prior close (or at the open for intraday): the price/volume angles that are `active` today (momentum, 52-week-high proximity, volume ratio, RSI, ATR regime, range contraction), approximated family entry conditions from the rule schema with default parameters, and a proxy rank over the liquid universe.
- Selecting the top movers after the fact is look-ahead and survivorship bias, and the window overlaps the end of the frozen validation period and the forward period. The counts below describe overlap, not predictive power; nothing here tunes a parameter.
- There is no announcement archive in the history (CTX-051), so the cause of each move is inferred from its shape (gap vs intraday, volume, halt, peers, season) and is unverified. That absence is itself the first finding.

## Findings
1. Ranking overlap only. A quarter of the gainer stock-days sat in the top decile of the price/volume proxy at the prior close; two met an F1-style breakout entry; one met an F4-style dip entry; ten followed a qualifying event within five sessions (F3/F5 continuation territory, which needs the live announcement feed). A similar share of the *loser* stock-days also ranked in the top decile: momentum names carry symmetric event risk. The price angles see the conditions, not the trigger.
2. Overnight gaps are announcements. Every gap gainer is a pre-open announcement; none is predictable from prices. Two had visible momentum and volume the day before.
3. Most intraday movers are invisible at the open. Seven of the ten intraday gainers opened within two percent of the prior close. The M17 intraday watch only quotes codes with a same-day Sentinel catalyst, so a move without a recorded catalyst is never a candidate, and there is no universe sweep.
4. The one dated precursor was outside the lists. Returns from a trading halt or suspension (about ninety liquid cases in the year) moved ten percent or more about one time in five, against a base rate near one percent, mostly down (discounted raisings) with takeover halts up. The Cortex has a halt veto but no halt-resolution watch.
5. Weak, direction-less conditions. Prior-day volume at twice normal appears about 1.6 times more often before a ten-percent day than on an ordinary day; short interest above five percent appears on both the gainer and loser side at a small lift. Both are risk markers, not direction.
6. Warm-up blind spot. The largest momentum ignition of the year was a recent listing with too few sessions for the 250-session breakout lookback and the 126-session momentum horizon.
7. Seasonality. Ten-percent days cluster in the two results seasons and one commodity rally month; a quarter of the movers fall in results months.
8. Sector shocks explain one gainer. Commodity/sector linkage matters little for extreme movers; it matters for the intraday watch's sector-adjusted move, which is null today (D-445).

## Honest statement on predictability
Extreme single-day moves are event-driven. "Predict before" is not available from prices; the realistic aims are (a) do not be on the wrong side of a known event (halt resume, results date, heavily shorted name), (b) detect early and decide, with delayed quotes and a 30-minute scan, whether the move is an attention item or nothing, and (c) accumulate the announcement evidence that would let the event families be calibrated at all.

## Additions, ranked by value for effort (one retail investor, delayed quotes)
| # | addition | data | status |
|---|---|---|---|
| A1 | Halt-resolution watch: a state row per halted/suspended code with a reason class from the halt notice (raise, takeover, material, regulatory) and an expected sign; feeds the gate list (no dip-buy on a negative resume), the intraday watch (armed at the open) and the attention mail | live announcements + zero-volume bars, already ingested | build now |
| A2 | Results-season and known-date calendar gate (A-D8-04-lite): results windows now, per-company dates once a year of live announcements exists | calendar + live announcements | build now |
| A3 | Pre-announcement volume creep (A-D2-07) measured live through the forward passport instead of waiting for an archive; also pre-arms the intraday watch | live feed | build now (measured, then shadow) |
| A4 | Short interest as an event-risk flag for sizing and gates, not a score input | ASIC, already ingested | build now |
| A5 | Young-listing variant of the breakout and momentum angles (lookback capped at sessions since listing, minimum 60) as a pre-registered grid point | prices | build now, shadow |
| A6 | Intraday universe sweep: one batch quote per scan slot over the liquid universe with a stricter no-catalyst path that only raises attention, never an order | a batch delayed-quote endpoint on the accepted host; new register row (DAT-120/124) | Owner decision |
| A7 | Announcement archive history: forward accumulation now ($0, clean point-in-time) or a licensed archive to unlock the development split for the event angles and F2/F3/F5 calibration | vendor licence into the register | Owner decision |
| A8 | EOD sector composite from the current industry map for the intraday watch's sector adjustment and card text | prices + current map | build now, low priority |

Not recommended: a pre-open auction feed (no free source; acting on it is chasing, which the gap cap already forbids) and an explorer drill-result calendar (the movers filter removes those names).

## Change control
1. One change request per addition in the private design-freeze record: definition, inputs, point-in-time rule, cluster or gate, grid points, pre-registered test and sample size, before any builder task.
2. The 100-angle grid is fixed (CTX-011): A3 and A5 version existing angles; A1, A2, A4 and A8 are gates, states or facts outside the score; no new score angle without an archive.
3. Calibration on the development split only; the validation window stays unread; this study's window is forward evidence and never sets a threshold.
4. Shadow first for everything; promotion follows the CTX-053 evaluator. The M15 verdict (every family in shadow) stands.
