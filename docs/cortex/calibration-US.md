# Cortex calibration: United States (CXA-002 j)

Status: **not run: no price history** (M20 task US1; D-1114, D-1132, D-1115, CXA-012, CXA-015).

## Why it was not run

The per-market calibration (CXA-002 j) is the M15 programme (WP1 to WP6) run on the market's own price history, on the
development split only. The US has no price history to run it on:

- The fill run of 2026-11-12 found no robots-permitted free US price source: `query1`/`query2.finance.yahoo.com`,
  `stooq.com` and `api.nasdaq.com` disallow automated clients, and the polite client respects robots.txt and never
  bypasses it (D-1093, D-1132).
- The US history extract (`data/history/us`, never committed) therefore holds the symbol directories, FINRA short volume
  and short interest, and the halt archive, and **no daily bars**; the folder `yahoo/` is empty and `meta/universe_capped.json` lists 0 codes.
- The synthetic five-session data set of the fixture night (fictional codes, `source: synthetic_fixture`, D-1188) is a
  test input only. It is not a price history, carries no statistical content, and must never be fed to the calibration.

Nothing was estimated, extrapolated or borrowed from the Australian or Indian runs to fill the gap.

## What this means for the US

- **No parameter, family status or threshold is calibrated for the US.** Every family starts in shadow for the US
  (D-949) and stays there; the profile's money tables (tiers, slippage buckets, tick table) are the A4 figures that carry
  AU's bps and factors, with the US edges converted at a fixed rate (D-1151), each marked [VERIFY].
- **No holdout look is spent** (CXA-015, D-1114): the `holdout_look` registry has no US row, and the calibration tool
  refuses `--split validation` and `--split holdout`.
- **The survivorship caveat applies to every US report** (CXA-012, D-1115, `docs/cortex/data-limits-US.md`): a history that
  holds only today's listed codes overstates returns; the haircut (delisted share per year x an assumed 50 % loss, with
  and without) and the matched-control result ("unmatched" for the US) are stated there. When a price source exists the
  report carries the caveat until the market's own daily snapshots satisfy ARN-082.
- **The switch-on checklist cannot pass for the US** on `at_m_evidence` until a price source exists (D-1132).

## What unblocks it

A price source, decided by the Owner and listed in the V3 pull request (D-1132): a free keyed daily-bar API stored like
FRED's key (an Owner-store name only, $0 tier, terms read before use), or a licensed vendor. The seam is ready: the
batch-1 day reads a bars file (`src/lib/data/sources/us/bars.mjs`, D-1188) and `symbols.mjs` caps the universe by median
traded value (D-1187). With bars in the extract folder, `tools/m20/calibrate --market US` runs on the development split
and this file is replaced by its report.

Nothing in this file claims a result that has not happened.
