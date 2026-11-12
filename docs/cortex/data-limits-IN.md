# Cortex data limits: India

What the India data cannot support, stated once so that no India report reads stronger than its data (M20 task A5;
CXA-012, CXA-013, CXA-015, D-1115, D-1132). India is built and **off** in production (PRD-040); these limits apply to
every report India produces once it is switched on, and to the development-mode runs before that.

## 1. No index or volatility series from a free source (D-1132)

The India extract takes its prices from the NSE bhavcopy archive (primary), so prices are unaffected. The **Nifty 50
index and India VIX series are Yahoo-only** and Yahoo disallows automated clients (D-1093: robots.txt is respected,
never bypassed). They are recorded as **not pulled**.

- No angle reads the index or the VIX series for India (AT-69: gate-only, read by `benchmark_index` and
  `volatility_index` in the fixture night's gates).
- Anything that needs the benchmark (the abnormal-return proxy, the regime classifier) runs on the data it has and says
  "no benchmark" rather than substituting another series.

## 2. Survivorship (CXA-012)

India is **measured on the bhavcopy archive** (`reportCaveats`, `src/lib/cortex/survivorship.ts`): the archive lists the
codes that traded on each day, so delisted codes are present, but its price history is not adjusted for later corporate
actions. The caveat is on every India report and does not lapse with the market's own snapshots.

- **Haircut, with and without.** The same `haircut` function applies when a delisted share is measured from the
  archive: delisted share per year x mean loss on a delisting (assumed 50 %). Known answer: 3 % x 50 % = **1.5 points per
  year**. The report shows the figure with and without it.
- Matched controls are possible for India (delisted codes exist in the archive) and read "matched".

## 3. Fundamentals (CXA-013)

India's results are parsed from NSE/BSE XBRL **when A3's terms check passes**; otherwise the fundamentals-dependent
family is **BLOCKED-DATA** for India and says so on the report. Nothing is guessed from headlines.

## 4. Director trades (not blocked)

SEBI (PIT) disclosures carry the transaction type, so the director-trade split is available for India and is **not**
blocked.

## 5. Announcements

There is no exchange "price-sensitive" flag. The category map (`src/lib/market/seed/in/categoryMap.mjs`, NSE/BSE
subject strings) assigns the AGT-020 category, the AGT-011 materiality and the CTX-043 verifiable flag, never an LLM
(AGT-011a). Announcements are **headline and link only, never a body** (D-1125). Results and guidance are verifiable
only when their statements were parsed (XBRL, when its terms pass); a contract only with a disclosed value and
counterparty.

## 6. Price bands and surveillance

A close at a daily price-band limit is **band-locked**: the fill model refuses every fill that session and cancels the
order with reason `band_locked` (D-1109). A code on the ASM or GSM surveillance list takes no new entry (promotion
trigger 3; exits are unaffected). Both depend on the exchange's daily band and surveillance files; when a file is
missing for a day the session is not treated as locked (a data-quality matter, DAT-210), and the report says the file
was missing.

## 7. What stays honest

Every family starts in shadow for India (D-949); the per-market calibration runs on the development split only and
spends no holdout look (D-1114, CXA-015).
