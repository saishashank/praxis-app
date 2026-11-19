# Cortex data limits: Australia

What the Australian data cannot support, stated once so that no AU research report reads stronger than its data (M23
task R4; CXA-012, CXA-013, D-1740 to D-1743). The AU market is live; its live figures do not read this record. It is
read by the research reports of M23 (`reportCaveats`, `src/lib/cortex/survivorship.ts`; the text lives in
`src/lib/market/seed/dataLimits.mjs`).

## 1. Survivorship (CXA-012)

The offline ASX history on the build machine holds only the codes listed today, so codes delisted earlier are missing and
measured returns are biased upward.

- **The delisting loss is assumed, not measured.** The key `survivorship_loss_assumed_pct` is 50 and is fixed at
  pre-registration (bounds 30 to 80). Haircut = delisted share per year x assumed loss / 100, in points per year. Known
  answer: 3 % delisted per year x 50 % = **1.5 points per year**; with 30 % it is 0.9 and with 80 % it is 2.4.
- **Published with and without.** A yearly return is shown beside its haircut value (`withAndWithout`).
- **The delisted share is not measured for AU.** The history has no delisted codes; the report passes a share only when
  one is known, otherwise it shows the caveat without a haircut figure.
- **Matched controls only from the first own universe snapshot.** Before the market's own `universe_snapshot` starts there
  are no delisted codes to match against, so controls read "unmatched". For a report whose first session is on or after
  the first own snapshot they read "matched".
- **The caveat lapses** only when the market's own snapshots satisfy ARN-082 (`coverage.ownSnapshotsSatisfyArn082`).

## 2. Industry history (CXA-012)

Industry groups come from the listed-company file as it stands today. Every session before the market's first own
`instrument_class` snapshot is labelled **static industry** (`industryLabel(d, firstSnapshotAsOf)`); from the snapshot's
date the map is point in time and the label is dropped. The CXA-009 report uses the same wording.

## 3. Fundamentals (CXA-013): BLOCKED-DATA

AU fundamentals stay **BLOCKED-DATA** (FAM-102): the fundamentals conditions of F2 are skipped and F2 runs as the
**"F2-no-fundamentals"** variant. Nothing is estimated from headlines.

- **Source check, 2026-11-17 (DAT-101): FAIL.** A desk check of the source register and the data on hand; no new fetch.
  A free source passes only when it gives each value as first filed, with its filing date, under terms that allow
  storage. The candidates give today's figures (a vendor's page, no history of restatements), scanned or unstructured
  annual-report and Appendix 4E/4D filings on the exchange site, or the regulator's company datasets (no financial
  statements). None passes.
- Repeated if the Owner names a candidate source; a PASS needs the filing date of every value.

## 4. Director trades (BLOCKED-DATA for AU only)

The ASX Appendix 3Y notice carries no trade type (purchase, sale, grant, exercise), so a purchase-only director signal
cannot be built. The split is blocked for AU. It is **not** blocked for the US (Form 4) or India (NSE disclosures).

## 5. What stays honest

The AU live product is unchanged; no figure on a page or in an e-mail reads this record. A research report carries the
caveats above in its Data section, and any figure with a haircut is shown beside the unadjusted one.
