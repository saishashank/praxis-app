# Cortex data limits: United States

What the US data cannot support, stated once so that no US report reads stronger than its data (M20 task A5; CXA-012,
CXA-013, CXA-015, D-1115, D-1132). The US market is built and **off** in production (PRD-040); these limits apply to
every report the US produces once it is switched on, and to the development-mode runs before that.

## 1. No price history from a free source (D-1132)

The fill run of 2026-11-12 found no robots-permitted free US price source: `query1`/`query2.finance.yahoo.com`,
`stooq.com` and `api.nasdaq.com` disallow automated clients, and the polite client respects that (D-1093; never
bypassed). The US extract therefore holds the symbol directories, FINRA short volume and short interest, and the halt
archive, but **no daily bars**.

- The US universe cap and the slippage buckets come out empty until a price source exists.
- The US calibration (CXA-002 j) is recorded as "not run: no price history" in `docs/cortex/calibration-US.md`.
- The switch-on checklist item `at_m_evidence` cannot pass for the US until a price source exists.
- Recommended default for the Owner (listed in the V3 pull request): a free keyed daily-bar API stored like FRED's
  key (an Owner-store name only, $0 tier, terms read before use), or a licensed vendor. The fetcher seam is
  `src/lib/data/sources/us/`; nothing in the build waits for it.

## 2. Survivorship (CXA-012, DAT-130/131)

A history that holds only the codes listed today leaves out the codes that fell and were delisted, so measured returns
are biased upward.

- **The caveat is on every US report** (`reportCaveats`, `src/lib/cortex/survivorship.ts`; the text lives in
  `src/lib/market/seed/dataLimits.mjs`). It lapses only when the market's own daily snapshots satisfy ARN-082
  (`coverage.ownSnapshotsSatisfyArn082`).
- **Haircut, with and without.** `haircut({ delistedSharePerYear, meanLossPct })` = delisted share per year x mean
  loss on a delisting (percent each), in percentage points per year; the loss is **assumed** at 50 %, and labelled so.
  Known answer: 3 % delisted per year x 50 % = **1.5 points per year**. A yearly return is shown beside its haircut
  value (`withAndWithout`): 12 % reads 10.5 % with the haircut.
- **Matched controls read "unmatched".** With no delisted codes in the history there is nothing to match a delisted
  code against; the report says so rather than showing a control comparison it cannot make.

## 3. Fundamentals (CXA-013)

- **F2 is calibratable from the first snapshot** through `fundamental_fact` (company facts as filed, DAT-226): the
  reader `factAsOf` returns the value known at the decision instant, never a restated one (AT-38). Until the first
  snapshot exists, F2 runs as the **"F2-no-fundamentals"** variant.
- A fact filed with a date only counts as known at the end of its UTC filing day (D-1160), so a calibration never reads
  a value earlier than the market could have known it.

## 4. Director trades (not blocked)

Form 4 carries the transaction type (purchase, sale, grant, exercise), so the director-trade split the AU feed cannot
make is available for the US. It is **not** blocked for the US.

## 5. Announcements

There is no exchange "price-sensitive" flag. The category map (`src/lib/market/seed/us/categoryMap.mjs`, 8-K item
numbers, forms 10-Q/10-K, Form 4, Schedule 13D/13G, `trading_halt` rows) assigns the AGT-020 category, the AGT-011
materiality and the CTX-043 verifiable flag, never an LLM (AGT-011a). Results and guidance are verifiable only when
their statements are parsed into `fundamental_fact`; a contract only with a disclosed value and counterparty.

## 6. What stays honest

Every family starts in shadow for the US (D-949); the per-market calibration runs on the development split only and
spends no holdout look (D-1114, CXA-015).
