# M20 requirements: India and US, built and off in production (O-83)

Delta extract from `Requirement/v3/spec/` (V3 draft, session V3-1, 2026-11-11). Source chapters: ch. 12 V3 (M20 row, BLD-048…BLD-055), ch. 20 (MKT-110…MKT-114, DAT-241…DAT-247, ARN-116…ARN-120, UXN-312, UXN-313, §20.6 switch-on, §20.7 AT-M tests in development mode, AT-67…AT-71), ch. 22 (CXA-001, CXA-002 (j), CXA-008, CXA-012, CXA-013, CXA-015), ch. 14 V3 (AT-68, AT-69, AT-70, AT-71, AT-38, AT-75, AT-85), ch. 15 V3 (§15.11.1 keys), ch. 26 V3 (TST-139, AT-85), ch. 00 V3 (O-82, O-83, A-18…A-22, D-923…D-950), ch. 01 V3 (PRD-039…PRD-049). Also read for the ids the M20 row names but the V3 files do not define: ch. 23 (no DAT-224…226 text, see Gap 3), ch. 24 (UXN-318), ch. 25 (OPS-103, OPS-104), V2 `spec/06_data_delta.md` and `spec/14_acceptance_delta.md` (DAT-224…226, AT-38), V1 `spec/14_system_acceptance.md` (AT-M0…AT-M5) and V1 `spec/06_data_layer.md` (MKT-102). Build decisions in this milestone start at **D-1091** (see Gap 4). Continues from M19 on `build`.

Source of truth: the V3 spec in `D:\Projects\Praxis\wt-v3-req\Requirement\v3\spec\` (read-only). Quotes are copied from that text. Code paths are files in `D:\Projects\Praxis\wt-v3`; they are marked **(guess)** where only a probable home was found, and "new" where no file exists. Paths marked "M19 stub" were found by grep and carry an `M20` marker in the code. Items marked **F** are money maths and cost formulas (the M20 row: "money maths and cost formulas **F**").

## Scope

M20 is "India and US, built and off in production (O-83)". It is **15 build-agent days** in the estimate (ch. 12 V3 row: "shared 4 + IN 5 + US 6 in parallel ≈ 10 calendar"). Its exit is AT-69, AT-70, AT-71, AT-38 and AT-68 (every CI run), plus AT-M1…AT-M5 for IN and US in development mode (ch. 14 V3, §20.7). AT-75's IN and US clauses are part of M20 (ch. 14 V3: "M19 (AU), M20 (IN/US), M23 (series)").

It has six kinds of work, in the order the spec gives:

1. **Shared tasks first** (ch. 12 M20 row): history extract tooling and the extract scripts (MKT-112), source reports and licence rows (DAT-101), DAT-245 category maps, DAT-246 halt and band models, DAT-247 label sets, calendars (OPS-103 seeds), MKT-113 quota projections and universe caps, MKT-111 switch-on checklist and rollback, AT-M1…AT-M5 in development mode per market, per-market Cortex calibration on the extract (CXA-002 j), and CXA-012 / CXA-013 per-market data-limit records.
2. **Track IN** (ch. 12 M20 row): "ARN-116, ARN-118 (₹ ticks, buckets), ARN-119/120, bands/ASM, NSE sources."
3. **Track US** (ch. 12 M20 row): "ARN-117, ARN-118 (US$), DAT-224…226 EDGAR as filed (V2 M10 delta, AT-38), LULD/suspensions, FINRA, Form 4/13D."
4. **Both tracks run in parallel** Sonnet streams after the shared tasks (BLD-049: "≤ 5 Sonnet + ≤ 5 Haiku; never two sub-agents on the same files").
5. **Off-in-production stays true.** Every IN/US code path added in M20 is built and tested in development, CI and the local recorded-day harness. Nothing reaches production (see the facts below).
6. **Switch-on is code only.** The two-step switch and rollback are built and tested (AT-71). The Owner performs the switch after the merge (BLD-050, §20.6).

Facts that bind every M20 task:

- **Production `markets_enabled` stays `["AU"]` for all of V3.** BLD-050: "`markets_enabled` in production stays `["AU"]` for the whole of V3 (AT-68 on every CI run), and the switch-on is an Owner step after the merge (MKT-111, §20.6)." PRD-040 says the same.
- **Nothing IN or US is written to production Turso.** PRD-040: "no IN/US row is written to Turso". MKT-110 (b): "the data layer refuses any write whose `market` is not enabled (`MarketNotEnabled`, logged as an incident)". The write guard is in M19 (D-995, `db/migrations/main/0035_m19_market_guard.sql`).
- **History extracts go to `D:\Projects\Praxis\data\history\in\` and `D:\Projects\Praxis\data\history\us\`, and are never committed.** D-927: "IN/US development, validation and holdout history lives at `D:\Projects\Praxis\data\history\in\` and `\us\` (never committed, like the M15 extract); CI fixtures live in `praxis-app-fixtures` only." Neither folder exists yet (the folder holds asic, fred, index, m15, meta, rba, yahoo).
- **`tools/m20/PLAN.md` is named by the spec and does not exist.** MKT-112 names "plan `tools/m20/PLAN.md`, same shape as `v2/tools/m15/PLAN.md`". RESUME §3 says "`tools/m20/PLAN.md` written first". The expected home is `D:\Projects\Praxis\wt-v3-req\Requirement\v3\tools\m20\PLAN.md`; the `Requirement\v3\` folder has only `BACKLOG.md`, `README.md`, `RESUME.md` and `spec\`. The reference `Requirement\v2\tools\m15\PLAN.md` exists. See Gap 1.
- **Build decisions start at D-1091.** BLD-054 and the M19 extract say D-951, but the M19 design (D-1005) corrected the start to D-991 and M19 used D-991…D-1090. See Gap 4.
- **AU stays byte-identical.** A-20: "Every CXA-002 parameterisation leaves AU behaviour byte-identical (AT-32/AT-50 hash); any difference is a defect, not a tuning." The AT-32 and AT-50 baseline is `tests/acceptance/v3/replay-hash.baseline.json` (written at M19 step 0, never rewritten).
- **The M19 gate must hold.** BLD-050: "M20 starts only after M19 exits (AT-67, AT-68 green)." See Gap 5.

---

## Hard constraints that apply to every M20 item

- **PRD-039 Everything in the backlog is built.** A stub carries a recorded reason (D-nnn) and a test. Any M20 stub (for example a reader the track does not finish) follows this.
- **PRD-040 India and US are built now, off in production (O-83).** "In production no IN/US job runs, no IN/US row is written to Turso and no IN/US data UI is shown (MKT-110) until the Owner switches a market on after the AU confidence gate (MKT-109, MKT-111)."
- **PRD-041 / PRD-033.** "No LLM output may create, size, change or cancel an order, a thesis-breaker or a rule." M20 has no LLM item (LLM work is M22).
- **PRD-045 Cost ceilings.** "the system uses at most **20 % of the free plan's monthly reads and writes** (O-81, 2026-11-09); every list query uses **keyset paging, never OFFSET**." MKT-113: "The projection must keep the whole system within **20 % of the Turso free plan** (O-81, PRD-045)". Any IN/US query must be keyset; the OFFSET static test is OPS-104 (d).
- **PRD-046 No staging.** Verification is CI plus prod-safe flags. The recorded-day CI job is the staging replacement (TST-138).
- **PRD-047 ASX Worker live fetch stays off.** "`ASX_LIVE` stays off in the Worker." M20 touches `worker/src/clock.ts` and `worker/src/localtime.ts` for IN/US slots and zones, and must not re-enable the ASX poll.
- **PRD-048 One pull request.** M20 opens no PR and asks the Owner nothing (BLD-048). Decisions are recorded in `docs/M20_design.md` and listed in the V3 PR.
- **MKT-107 / AT-67.** "A literal market code, timezone, cut-off time, currency, parcel floor, tick table, settlement cycle or index code outside the profile loader and the profile seed is a defect (AT-67 static test)." AT-67 allows the loader, the seed and the migrations. The M19 allow-list (`src/lib/market/**`, `src/lib/market/seed/allow.mjs`, and `EXTRA_ALLOW` in `scripts/ci/market-literals.mjs`) and the D-1000 scan rule apply. An unused allow-list entry fails the scan (M19 exit §1).
- **BLD-051 / CXA-015 research honesty.** "Every lineage has at most **one** holdout look, recorded in a `holdout_look` registry" (CXA-015). MKT-112: "the holdout rule (CXA-015) applies per market." No M20 task may look at a holdout twice.
- **MKT-110 three proofs hold while M20 adds code.** The M19 proofs (dispatch refusal, write guard and nightly invariant, UI filter and 404) must stay green on every CI run (AT-68). M19 design (line 225) says a test that plants an off-market row must use `plantOffMarketRow` (defined in `tests/db/helpers.ts`).
- **Owner-facing times are in Melbourne time.** UXN-313: "every market time is shown as local **and** Melbourne". Project memory: report all times to the Owner in Melbourne time.
- **No Owner questions in the build (O-82).** Every open point is decided by the recommended default, recorded as D-nnn and listed in the V3 PR.

---

## A. Build rules (ch. 12 V3, BLD-048…BLD-055)

- **BLD-048 One PR.** "Exactly one PR `build`→`main` titled "V3 build complete:" is opened when every milestone M18–M23 is done and green". M20 opens none.
- **BLD-049 Order of value (D-942).** "M18 → M19 → M20 → M21 → M22 → M23, completed in this order on `build`. A milestone's tasks may run in parallel streams (≤ 5 Sonnet + ≤ 5 Haiku); never two sub-agents on the same files."
- **BLD-050 India and US together (O-83).** "M20 starts only after M19 exits (AT-67, AT-68 green)." "Neither track may write to production."
- **BLD-051 Research honesty.** Every research task pre-registers its hypothesis, grid point, split and n before any computation. M20 research surfaces are CXA-002 (j) per-market calibration and CXA-012 measurements (Section E).
- **BLD-053 Progress recording.** BUILD_SETUP §9 "V3" heading with rows "V3 current milestone" and "V3 last step done / next step". "V3 PR opened" is written only when the PR exists (M20 does not write it).
- **BLD-054 Decision numbering (D-924).** "Build decisions continue from D-951 in `docs/M19_design.md`" (the wording was for M18). The live rule is D-1005: M20 decisions start at **D-1091** in `docs/M20_design.md`. `docs/07_decision_log.md` is not edited for V3.
- **BLD-055 Milestone package.** "Haiku requirements extract (`docs/M<nn>_requirements.md`) → design + decisions (`docs/M<nn>_design.md`) → tasks with tests first → Haiku review → Opus/Fable acceptance of the **F** items → `docs/M<nn>_exit_evidence.md` with every AT of the milestone and its evidence → §9 row update."

---

## B. Shared tasks (ch. 12 M20 row, first; both tracks wait for them)

The ch. 12 M20 row, verbatim: "Shared: `tools/m20/PLAN.md` + extract scripts → `D:\Projects\Praxis\data\history\in\`, `\us\` (MKT-112) · DAT-101 source reports and licence rows for every DAT-243/DAT-244 row [VERIFY] · DAT-245 category maps · DAT-246 halt/band models · DAT-247 label sets (page from CXA-008) · calendars (OPS-103 seeds) · MKT-113 quota projections and universe caps · MKT-111 switch-on checklist and rollback · AT-M1…AT-M5 in development mode (§20.7) per market · per-market Cortex calibration on the extract (CTX-050 via CXA-002 j; families in shadow, D-949) · CXA-012/CXA-013 per-market data-limit records."

### B.1 MKT-112 Development, validation and holdout history per market (never committed)
- **Full text:** "Each built market has its own history extract on the build machine at `D:\Projects\Praxis\data\history\<in|us>\` (siblings of the M15 AU extract), produced by `Requirement/v3/tools/m20/` scripts written in M20 (plan `tools/m20/PLAN.md`, same shape as `v2/tools/m15/PLAN.md`), with a coverage report per source in `praxis-app/docs/`. Fixtures for CI live in `praxis-app-fixtures` only. The history is **development data** under ARN-082 with the market's own splits; the holdout rule (CXA-015) applies per market. India's delisted codes come from the NSE bhavcopy archive [VERIFY depth and terms]; the US has no free point-in-time delisted list, so US replays carry the **survivorship caveat** (DAT-130/131, CXA-012) in every report until own snapshots satisfy ARN-082."
- **Tags:** **[VERIFY]** NSE bhavcopy depth and terms (internet, Section M). ARN-082 and DAT-130/131 are v1/V2 IDs (Gap 6).
- **Decisions:** D-927.
- **Acceptance:** no AT of its own. Feeds AT-69/AT-70 fixtures, AT-75 (IN and US nights) and CXA-012.
- **Files:** `tools/m20/` (new, per the spec's `Requirement/v3/tools/m20/`). Reuse candidates from the M15 extract: `D:\Projects\Praxis\wt-v3-req\Requirement\v2\tools\m15\` (`PLAN.md`, `coverage.mjs`, `coverage_asic.mjs`, `pull_asic.mjs`, `pull_history.mjs`, `refresh.mjs`) (**guess**: reuse decision for the build). AU extract sibling exists: `D:\Projects\Praxis\data\history\m15`. Coverage report goes in `praxis-app/docs/` (new).

### B.2 DAT-101 source reports and licence rows
- **Text (ch. 20 §20.2 heading):** "every row [VERIFY] at M20 start under DAT-101, DAT-120, DAT-121". The per-row tables are in Section C and D.
- **Text (ch. 20 §20.5 / §20.7):** AT-M1 "uses the DAT-101 report run from the Actions runner on a workflow with `markets_enabled` limited to the test run and **no production database** (the report writes to the run's artefact only)".
- **Tags:** **[VERIFY]** every IN and US source row. DAT-101, DAT-120, DAT-121 are v1 IDs (Gap 6).
- **Decisions:** A-18 (Yahoo basis for IN and US tickers, assumed, to verify at M20). If a source fails DAT-101, "the market stays `off` until one passes" (A-18).
- **Acceptance:** AT-M1 (sources), and the licence register rows that MKT-111 requires.
- **Files:** `docs/source-licence-register.md` (exists in `wt-v3`, 18 KB). New IN and US rows are added there (guess: the build's first task).

### B.3 DAT-241 / DAT-242 profile values and completeness (IN and US)
- **DAT-242 text:** "A profile is `complete` only when every field has a value and every [VERIFY] field has a `verified_at` date and the evidence reference (the DAT-101 report or the licence register row). The switch-on checklist (MKT-111) requires `complete`."
- **M19 state (D-999):** "IN and US are incomplete in M19 by design". Every IN and US value is seeded with `verify = 1` and no `verified_at` (D-998 / D-999 / D-1001 in M19 design). Seeds: `src/lib/market/seed/IN.mjs`, `src/lib/market/seed/US.mjs`. `src/lib/market/profileWrite.ts` line 258: "Records the date and evidence of an unchanged [VERIFY] value (DAT-242; used from M20)."
- **Four fields are still `null` ("set at M20")** for IN and US (D-1010; tests `tests/market/completeness.test.ts` line 39 "four fields are set at M20"): `tiers`, `slippage_buckets`, `sleeve_reality_cap`, `bar_latency_p95_min`. Recorded as `null` in the seeds (`value_json = null`).
- **Completeness test (M19):** `tests/market/completeness.test.ts` line 68 already asserts the target: "verifying every IN field with a date and a reference, and filling the four M20 fields, makes it complete".
- **Tags:** **[VERIFY]** all IN and US values in the DAT-241 table (Section L).
- **Decisions:** D-947 (design parcel floors, `[PROPOSED]`, Owner-editable within bounds, a change is a counted trial).
- **Acceptance:** AT-67 (no literal outside the loader and seed), AT-68, and AT-71's "`complete` is required" predicate.

### B.4 DAT-245 Per-market announcement categories and materiality (IN and US)
- **Full text:** "Neither IN nor US has an exchange "price-sensitive" flag. Each profile carries a **category map** from the source's own type (NSE/BSE announcement subject; 8-K item numbers 1.01…9.01, 10-Q/10-K, Form 4) to the AGT-020 categories (results, guidance, contract, capital raising, director trade, substantial holder, takeover, halt, exchange query, dividend, other) and a **materiality rule** per category (AGT-011 scale 0–3). The map is a fixture-tested table in the profile seed, never an LLM output (AGT-011a). CTX-043's "verifiable categories" rule applies per market with the same tests (parsed financial statements for results/guidance; a disclosed value and counterparty for contracts)."
- **Conflict:** the category list above has **11** categories, but AT-69 says "the 8-category map" (Gap 9).
- **Tags:** AGT-011, AGT-011a, AGT-020, CTX-043 are v1/V2 IDs (Gap 6).
- **Decisions:** none in the spec. The map is seed data.
- **Acceptance:** AT-69 ("the 8-category map classifies 50 fixture announcements as labelled"); CXA-002 (g).
- **Files:** `src/lib/market/seed/IN.mjs`, `src/lib/market/seed/US.mjs` (category map field; the seed holds `category_map` as a field, D-1010). AU has no map (ASX flag path unchanged, D-1031). Stub reader: `src/lib/cortex/profileReaders.ts` (`categoryMapReader`, throws `not built (M20): category map`, `NotBuiltM20`).

### B.5 DAT-246 Halt and band model per market
- **Full text:** "AU keeps CTX-016. India: a code whose close sits at its daily band limit is **band-locked**: no fill is simulated at that price on that session (an order against a band-locked code is cancelled, reason `band_locked`), and a code on the ASM/GSM surveillance lists is a **promotion-flag input** (CTX-044 trigger 3 for IN: on the list = no new entries). US: a LULD halt is a trading halt for its duration (CTX-016 halt rules, no exit fill during the halt); an SEC trading suspension is a suspension. Known-answer fixtures per market (AT-69, AT-70)."
- **Tags:** CTX-016, CTX-044 are v1/V2 IDs (Gap 6).
- **Decisions:** none in the spec.
- **Acceptance:** AT-69 (band-locked close cancels an order with reason `band_locked`; an ASM-listed code takes no new entry), AT-70 (a LULD halt gives no exit fill and re-scores at reopen).
- **Files:** `src/lib/cortex/profileReaders.ts` `haltReader` (M20 stub, `not built (M20): halt model`); `src/lib/money/tick.ts` (band table as argument, D-1033); `src/lib/arena/costs.ts` (cost profile).

### B.6 DAT-247 Labelled announcements per market
- **Full text:** "CTX-040's golden set is per market: ≥ 500 Owner-labelled items per market before a text label may enter that market's score; until then labels are shadow for that market. The labelling page (UXN-318, CXA-008) takes a market filter."
- **Ownership conflict:** the M20 row lists "DAT-247 label sets (page from CXA-008)"; UXN-318 (the labelling page) is listed in the **M21** row (ch. 12). See Gap 8.
- **Tags:** CTX-040 is v1/V2 (Gap 6). The Owner labels ≥ 500 items per market; the spec states the Owner's pace sets the date (CXA-008: "The Owner's labelling pace sets the date; nothing is forced.").
- **Decisions:** D-934 (research honesty).
- **Acceptance:** AT-75 (IN/US): "the text-label page stores Owner labels append-only per market and the evaluation refuses to run below 500 items."

### B.7 Calendars (OPS-103 seeds)
- **§20.2 text:** "Per-market calendars are seeded for the current and next year at M20 and drafted yearly by OPS-103."
- **OPS-103 text (ch. 25):** "The job that drafts next year's calendar from each enabled market's published holiday list runs on 1 November for every **built** market (AU, IN, US); the first live alarm is 2027-11-02, so M18 proves it with a clock fixture."
- **Holiday sources:** IN "NSE holiday list" (public, yearly draft OPS-103); US "NYSE holiday list" (public, yearly draft). Calendar source row in DAT-241: IN "NSE holiday list", US "NYSE holiday list" (ch. 20 §20.1, "calendar source").
- **Open decision (M19 design line 220):** "`trading_calendar` is in that list: M20 must decide whether IN/US calendar rows (DAT-248: "seeded at M20") are configuration — if they are seeded in production the invariant and the guard need an exemption then, not now." Decision needed in M20 (Gap 10).
- **Files:** `src/lib/data/calendar.ts` (`CALENDAR_MARKETS`; line 53: "A built market without rules (IN, US until M20) is not listed."), `src/lib/data/calendarAdmin.ts` (OPS-103 draft job, exists), `tests/config/m19Keys.test.ts` line 142 (`expect([...CALENDAR_MARKETS]).toEqual(["AU"]); // IN and US have no calendar rules until M20`; this assertion changes in M20), `db/migrations/main/` (guess: IN and US calendar seed rows).

### B.8 MKT-113 Quota budget per market; universe caps
- **Full text:** "Before any production write, the Usage page shows a projection per market (MKT-104) for Turso reads/writes, Actions minutes, Worker requests and the market-data host's request count. The projection must keep the whole system within **20 % of the Turso free plan** (O-81, PRD-045) and ≤ 90 % of every other budget (MKT-105). The US universe is capped at **`us_universe_max` = 2,500 codes by 60-session median traded value** (about 6,000 listed; the full list is ≈ 3× AU's calls and writes, backlog §0) [PROPOSED, D-928]; India at `in_universe_max` = 2,000 (NSE main board ≈ 2,000 [VERIFY]). Caps are profile keys the Owner may raise only within the projection."
- **Name conflict:** MKT-113 uses `us_universe_max` / `in_universe_max`; ch. 15 §15.11.1 and D-1010 use `mkt.<CODE>.universe_max` (AU none, IN 2,000, US 2,500; bounds 500–6,000). See Gap 13.
- **Tags:** **[VERIFY]** NSE main board ≈ 2,000. **[PROPOSED, D-928]** caps. MKT-104 is v1.
- **Decisions:** D-928.
- **Acceptance:** none named. The projection is needed before any `full` switch (MKT-111: "the quota projection with the market added fits MKT-113").
- **Files:** `src/lib/config/keys.ts` (`universe_max` registered in M19, "read by nothing until M20" per M19 D-1001 / gap 8); Usage page (existing; guess: `src/app/(app)/usage/`). Projection code: new (guess).

### B.9 MKT-111 Switch-on checklist and rollback (AT-71)
- **Full text (MKT-111):** "The Owner switches a built market on in two steps from Settings → Region (Owner only): `off` → `data_only` (ingest, snapshots, Sentinel, shadow Cortex; no books, no e-mails) for ≥ 5 trading days with green quality verdicts, then `data_only` → `full` (books open the next trading day, BLD-030 pattern). The switch is enabled only when the market's checklist is complete: AT-M1…AT-M5 evidence for that market (§20.7), the licence register rows for every source of that market are `enabled` or `owner-accepted-risk` (DAT-120), the quota projection with the market added fits MKT-113, and AU meets MKT-105. **Rollback** is `full` → `off` in one click: existing rows are kept (forever tables stay), no new row is written, books are closed at the next session's open as a kill (CTX-028), and the audit event records the reason."
- **D-929 (ch. 00):** "Switch-on = MKT-105 for AU + per-market checklist (AT-M evidence, licence rows, quota projection) + two-step `off → data_only (≥ 5 days) → full`; rollback `full → off` keeps rows, writes nothing new, closes books at the next open; default order India then US."
- **M19 writer state:** `src/lib/config/keys.ts` line 2229: "The only writer of `enabled` is the M20 two-step (none in M19)." `src/lib/data/controls.ts` line 552: "the Owner's switch-on is the M20 two-step."
- **UXN-312 M20 part (D-1001):** "M20 the checklist with links, the quota projection, the two-step and rollback."
- **Tags:** MKT-105, BLD-030, DAT-120, CTX-028 are v1 IDs (Gap 6). The 5-day rule and the checklist are in-spec.
- **Decisions:** D-929; D-994 (two switches: `markets_enabled` is the DB column `market.enabled`; `PRAXIS_MARKETS_ENABLED` is the production assertion; the Owner sets the variable with the M20 switch-on, M19 design §9).
- **Acceptance:** AT-71 (Section H).
- **Files:** `src/lib/config/keys.ts` (`markets_enabled`, `market_mode`), `src/lib/data/controls.ts` (the writer), `src/app/(app)/settings/region/` (page, `region.ts` lines 30 and 125 carry the M20 checklist comments). `src/components/shell/RegionMenu.tsx` (switcher, M19 filter). Rollback writes an audit event (guess: existing audit helper, to find).

### B.10 AT-M1…AT-M5 in development mode, per market
- **§20.7 text:** "AT-M0…AT-M5 (v1 ch. 14) are run **per built market in CI and on the build machine** with recorded fixtures and the local history, never in production (BLD-024 no longer applies to IN/US before switch-on). AT-M0 (the gate) is replaced for V3 by the switch-on checklist; AT-M1 (sources) uses the DAT-101 report run from the Actions runner on a workflow with `markets_enabled` limited to the test run and **no production database** (the report writes to the run's artefact only); AT-M4 (five consecutive quality verdicts) uses five recorded days."
- **v1 text (ch. 14 V1, lines 74–79, the source of AT-M1…M5):** AT-M1 "Sources | DAT-101 report and licence register for the market; exchange-site access decided (DAT-121); market profile DAT-010 complete". AT-M2 "Calendar & time | Market calendar loaded; DST/holiday tests for its jobs pass; results appear in the next 20:00 Melbourne review". AT-M3 "Costs | Market cost profile known-answer tests pass (DAT-010)". AT-M4 "Quality & replay | Five consecutive days of quality verdicts; rolling-start replay runs for all families on the market; **(s11)** pass criterion = replay completes without error for every family and every label is computed or shows its "not reachable" reason". AT-M5 "Isolation | The market's arena, ledgers and labels never mix with other markets; `testing` → `active` switch starts cohorts next trading day".
- **Decisions:** D-948 ("AT-M1…AT-M5 run per built market in development mode (CI, build machine, recorded days); BLD-024 production data-only mode no longer applies to IN/US before switch-on").
- **Gap:** AT-M5 names the v1 status `active`; the V3 status set (MKT-114) is `not started → in build → testing → built → active ⇄ paused` (Gap 7).
- **Files:** the recorded-day job (`scripts/e2e-day/recorded-day.mjs`, exists); `e2e/seed/states/markets-dev.mjs` (M19 state `market-built-off`, "The mode stays `off` (a freshly enabled market collects nothing until the Owner switches it on, M20)").

### B.11 CXA-012 and CXA-013 per-market data-limit records
- **CXA-012 text:** "Survivorship haircut: the pre-registered value is **the delisted-code share of the development universe per year × the mean post-delisting loss assumed at −50 %** [PROPOSED], published with and without (CTX-050); per market (IN has a delisted archive, so the haircut is measured, not assumed; US and AU early years assumed). D-346 (no matched controls): matched controls are added where a market's point-in-time universe exists (own snapshots; IN bhavcopy); otherwise the report states "unmatched". … D-297, D-296, D-242 (director trade-type split, BLOCKED-DATA): remain BLOCKED-DATA for AU; re-checked per market at M20 (SEBI PIT and Form 4 both carry the transaction type → the split is **not** blocked for IN/US)."
- **CXA-013 text:** "US: EDGAR company facts as filed (DAT-224…226) make F2 **calibratable** for the US from the first snapshot (ARN-082 coverage formula; "F2-no-fundamentals" variant until then). IN: NSE/BSE XBRL results if the terms pass DAT-101 [VERIFY], else BLOCKED-DATA. AU: stays BLOCKED-DATA unless a free point-in-time source passes DAT-101 (none known; the check and its result are recorded at M23)."
- **Tags:** **[VERIFY]** IN XBRL terms (DAT-101). D-346, D-285, D-297, D-296, D-242, ARN-082 are v1/V2 IDs (Gap 6).
- **Decisions:** D-346 and D-285 are cited, text not in the V3 extract.
- **Acceptance:** CXA-012 / CXA-013 have no AT of their own (Section N, Gap 12).
- **Files:** `src/lib/cortex/` (F2 readers, guess), `src/lib/cortex/profileReaders.ts` (M20 readers replace the stubs).

---

## C. Track IN (Sonnet stream, in parallel with US)

### C.1 DAT-243 India sources (candidates; none is primary until it passes DAT-101)
Verbatim rows of ch. 20 §20.2 (Need | Candidate source | Terms / risk to verify | Runtime):

| Need | Candidate source | Terms / risk to verify | Runtime |
|---|---|---|---|
| EOD prices, volumes | Yahoo Finance `.NS`/`.BO` (same personal-use basis as O-26); NSE bhavcopy archive for history and delisted codes | Yahoo O-26 covers IN tickers [VERIFY]; NSE archive terms, bot blocking (DAT-121: off until checked) | Actions runner |
| Announcements | NSE corporate announcements, BSE announcements (no price-sensitive flag → DAT-245 category map) | both sites block bots and have terms; may need the same Owner acceptance as O-23; until then headline + link only or `disabled` | Actions runner (never the Worker, PRD-047 pattern) |
| Classification | NSE industry classification file | redistribution terms | once per month |
| Short data proxy | NSE F&O open interest per stock; SLB volumes | daily files; terms | Actions |
| Insider notices | SEBI PIT / SAST disclosures via NSE/BSE | terms | Actions |
| Bands, surveillance | NSE price-band file; ASM/GSM lists | daily files | Actions |
| Index changes | NSE Indices announcements | manual CSV fallback (D-238 pattern) | manual |
| Forward results dates | board-meeting intimations (NSE) | terms | Actions |
| Fundamentals | NSE/BSE XBRL results; Yahoo `.NS` fundamentals | terms; XBRL parser cost | Actions, monthly |
| Macro | RBI, MOSPI, Nifty 50 / India VIX series | public statistics | Actions |
| Calendar | NSE holiday list | public | yearly draft (OPS-103) |

### C.2 ARN-116 India cost profile IN-P1 **F**
- **Full text:** "Per order: brokerage min(₹20, 0.03 % of value) [VERIFY against the cheapest reliable discount broker, O-79 instruction pattern]; STT 0.1 % of value on delivery buys and sells [VERIFY]; exchange transaction charge ≈ 0.00297 % (NSE) [VERIFY]; SEBI turnover fee ₹10 per crore [VERIFY]; stamp duty 0.015 % on buys [VERIFY]; GST 18 % on brokerage + exchange + SEBI charges; DP charge ≈ ₹15 + GST per sell order [VERIFY]. The formula with these constants is a profile fixture; the Cortex cost gate (CTX-022a) uses it per order. The design note stands: these fixed per-sell charges are heavy for a ₹30,000 book, so the economic gate will reject most small parcels — that is the honest answer at this account size (CTX-022a wording)."
- **Tags:** **[VERIFY]** each constant (seven items). **F**.
- **Decisions:** none in the spec beyond the constants.
- **Acceptance:** AT-69 "Cost formula fixtures (buy and sell at ₹10,000 and ₹100,000 reproduce hand-computed totals to ₹0.01)".
- **Files:** `src/lib/arena/costs.ts` (line 112–117: `costProfileOfMarket` throws `not built (M20)` for IN; the M20 table replaces it), `src/lib/market/staticProfile.mjs` (lines 70–75: `cost profiles for market ${code} not built (M20)`), `src/lib/market/seed/IN.mjs` (`cost_formula` = `IN-P1` enum), `tests/arena/profileParams.test.ts` (lines 124–131 assert the M20 throw; change in M20), `tests/cortex/profileParams.test.ts` (lines 77–88 likewise).

### C.3 ARN-118 Tick tables and slippage buckets (IN) **F**
- **Full text:** "NSE tick ₹0.05 (₹0.01 for prices below ₹250 since 2024 [VERIFY]); US $0.01 (sub-penny quoting below $1). ADV buckets are set from each market's extract at M20 so that the bucket boundaries fall at the same ADV percentiles as AU's."
- **Profile field:** `tick table` IN "NSE ₹0.05 for all [VERIFY, ₹0.01 below ₹250 since 2024]" (DAT-241 table) and `slippage_buckets` (null, set at M20).
- **Tags:** **[VERIFY]** tick rule. **F**.
- **Acceptance:** AT-69 (fixtures), AT-75 (IN fixture night applies the ₹ parcel floor).
- **Files:** `src/lib/money/tick.ts` (`tickFor`, `slippageAmount`, `slippageTicks`, `stallSlippageMicro`, `slippedFill` take the band table, D-1033), `src/lib/arena/slippage.ts` (line 27 throws `slippage buckets for market ... not built (M20)`), `src/lib/arena/sizing.ts` (`STALL_FLOOR_SLIPPAGE_BPS` duplicates the AU tick table, D-1090).

### C.4 ARN-119 Seeds and conversion (IN) **F**
- **Full text:** "Each market's 12 books and controls open with the DAT-010 seed rule (A$600 converted at the activation-day RBA close, rounded) on the first `full` trading day; the seed, FX rate and date are recorded in the ledger (ARN-001 per market, MKT-103 never pooled)."
- **Profile:** `currency, seed` IN "INR, A$600 at activation-day FX close rounded to ₹1,000". `FX source` IN "RBA daily rates" (ch. 20 §20.1 table). Note: the IN seed is in ₹ and the FX source is the RBA, which the spec names for all markets (Gap 16 for the rounding basis).
- **Tags:** **[VERIFY]**; DAT-010 is v1.
- **Acceptance:** AT-M3 (costs known-answer); AT-M5 (isolation).
- **Files:** `src/lib/market/seed/IN.mjs` (currency and seed row), `src/lib/market/profile.ts` (loader), the book seeding code (guess: `src/lib/arena/`).

### C.5 ARN-120 Settlement and deployable cash (IN, T+1) **F**
- **Full text:** "`settlement_days` from the profile replaces the T+2 constant in CTX-027 and ARN-025 (IN and US T+1); the replay enforces the same (AT-M4). The stall predicate (ARN-071) uses the market's `parcel_floor`."
- **AT-69 IN clause:** "T+1 proceeds fund a buy the next session but not the same session".
- **M19 sites to change (M19 design, D-1003 / gap list):** `closeBooks.ts`, `settledCash.ts`, `replay/ledger.ts` (the T+2 arithmetic). Paths found: `src/lib/arena/closeBooks.ts`, `src/lib/cortex/gates/settledCash.ts`; `replay/ledger.ts` not found under that name (**guess**: `src/lib/replay/`).
- **Tags:** ARN-071, ARN-025 are v1 (Gap 6). **F**.
- **Acceptance:** AT-69 (T+1 funding), AT-M4 (replay).

### C.6 DAT-241 IN field values (ch. 20 §20.1 table, IN column, verbatim)
| Field | IN [VERIFY] (verbatim) | M20 action |
|---|---|---|
| exchange, timezone | NSE (+ BSE codes), Asia/Kolkata | verify; Worker zone table (D-1004) |
| session (local) | 09:15–15:30 (pre-open auction 09:00–09:08) | verify; `session` class (D-1090 notes the session-time class) |
| opening_auction_window | single open 09:15 after the 09:00–09:08 call auction | CXA-002 (c) |
| announcement hours (local) | NSE/BSE filings 24 h, bulk after close [VERIFY] | verify |
| decision_cutoff | 2 h after close ≈ 17:30 IST → 22:00/23:00 Melbourne (DST) | CXA-002 (a) |
| known_time rules | filings = NSE/BSE publication time; bhavcopy = D close + measured latency | CXA-002 (a) |
| batch schedule (Melbourne) | close + 60 / + 100 / + 130 min | PLT-073 (v1) |
| review-date rule | latest session with a completion marker by the AU review time (previous day) | DAT-010 (v1) |
| currency, seed | INR, A$600 at activation-day FX close rounded to ₹1,000 | ARN-119 |
| parcel_floor | none (1 share) → design floor ₹25,000 [PROPOSED, D-947] | CXA-002 (b) |
| settlement_days | 1 (T+1) | ARN-120 |
| tick table, slippage buckets | NSE ₹0.05 for all [VERIFY, ₹0.01 below ₹250 since 2024] | ARN-118 |
| size/liquidity tiers | thresholds in ₹ set at M20 from the extract | `tiers` (null) |
| cost_formula | IN-P1 (ARN-116) | ARN-116 |
| benchmark, regime index, volatility index | Nifty 50, India VIX (+ S&P 500 global) | CXA-002 (h) |
| control C1 instrument | Nifty 50 ETF | DAT-010 (v1) |
| classification scheme | NSE industry classification (4 levels; use level 2 as "industry group") | CXA-002 (e) |
| short_data kind | proxy: F&O open interest per stock + SLB volumes | DAT-243 |
| insider_notice kind | SEBI PIT and SAST disclosures (NSE/BSE) | DAT-243 |
| halt model | daily price bands 2/5/10/20 % (band-locked = no fill) + ASM/GSM lists | DAT-246 |
| index_change source | NSE Indices rebalance notices (semi-annual) | manual CSV fallback |
| forward results dates | board-meeting intimations ≥ 2 working days ahead | DAT-243 |
| fundamentals source | NSE/BSE XBRL results or Yahoo `.NS` [VERIFY terms] | CXA-013 |
| dividend imputation | none (angle dropped) | CXA-002 (i) |
| sleeve reality cap | set at M20 (SEBI margin rules) | **not set in M19**; M20 |
| calendar source | NSE holiday list | OPS-103 |
| FX source | RBA daily rates | ARN-119 |

### C.7 CXA-002 IN application (AT-75 IN clause)
- **(a)** "the market's `decision_cutoff` (local time stored, Melbourne shown); … bars = close + the market's measured 95th-percentile latency, measured on 10 nights per market [VERIFY]". IN latency is unmeasured (Gap 11).
- **(b)** "'T+2' → `settlement_days`; 'A$500' → `parcel_floor` in the market currency (IN/US design floors per D-947)".
- **(c)** "IN single open after the 09:00–09:08 call auction"; "the 09:55 re-check becomes 'preopen_recheck_min minutes before the market's open' (AU 5 min → 09:55, unchanged)."
- **(e)** "the per-industry NAV cap (35 %) applies to that scheme's group level".
- **(f)** "the notice source and the halt model come from the profile (DAT-246: IN bands and ASM/GSM; …)".
- **(g)** "IN adds the surveillance-list trigger (DAT-246)."
- **(i)** "the angle count for IN/US is 99, the cluster K rule (CTX-012) is unchanged."
- **AT-75 IN clause (ch. 22 line 43):** "an IN fixture night applies T+1, the ₹ parcel floor, the single open and band-locking".
- **Files (M19 stubs to replace):** `src/lib/cortex/profileReaders.ts` (`classificationReader` line 28, `haltReader` line 33, `categoryMapReader` line 43; each throws `NotBuiltM20`), `src/lib/cortex/stage.ts` line 327 (`profileReaders(profile); // CXA-002 e, f, g: an M20 rule set throws ...`), `tests/cortex/profileStubs.test.ts` (asserts the IN and US throws; replaced in M20).

### C.8 Worker zone and slots for IN (D-1004, D-1046, D-1089)
- **D-1004 text (M19):** "M20 adds the Kolkata (no DST) and New York tables with the DST tests of TST-103."
- **D-1089 text (M19 design line 167):** "When M20 adds Kolkata and New York the minute test must use the slot market's own zone (`Slot` gains `tz`), or an IN slot fires at the Sydney time."
- **D-1046 text (M19):** a market "whose zone is not in `ZONE_RULES` (IN, US until M20) is left out of the table with the log line `clock: skipped market <CODE> unusable`, never guessed (D-1004 `unsupported zone`)."
- **Files:** `worker/src/localtime.ts` (line 62: "M20 adds the Kolkata and New York rules"; `ZONE_RULES`), `worker/src/clock.ts` (Sydney-only slot minutes, D-1089), `worker/src/schedule.ts` (`slotsFor(row)`, `slotTable(rows)`, D-1045), `src/lib/market/clockTables.mjs` (`ZONE_RULES`, `FEED_SLOT_TIMES`; comment "tests at M20" / "another market's feed slots are added with its data work at M20").

### C.9 IN sleeve cap, tiers, latency (the four M20 fields)
- `sleeve_reality_cap` IN: "set at M20 (SEBI margin rules)" (ch. 20 §20.1 table). Not set in M19.
- `tiers` IN: "thresholds in ₹ set at M20 from the extract" (table).
- `bar_latency_p95_min` IN: measured on 10 nights per market [VERIFY] (CXA-002 a). Not measurable until the IN extract exists.
- `slippage_buckets` IN: ARN-118 ADV buckets "set from each market's extract at M20 so that the bucket boundaries fall at the same ADV percentiles as AU's."

### C.10 IN categories, halts and surveillance (AT-69 known answers)
- **AT-69:** "a band-locked close cancels an order with reason `band_locked`; an ASM-listed code takes no new entry; T+1 proceeds fund a buy the next session but not the same session; the 8-category map classifies 50 fixture announcements as labelled; the Nifty 50 regime table and India VIX feed the gates only."
- **Files:** `src/lib/arena/` (order cancel reason, guess), `src/lib/cortex/` (ASM trigger, CTX-044 trigger 3, guess).

---

## D. Track US (Sonnet stream, in parallel with IN)

### D.1 DAT-244 US sources (candidates)
Verbatim rows of ch. 20 §20.2 (Need | Candidate source | Terms / risk to verify | Runtime):

| Need | Candidate source | Terms / risk to verify | Runtime |
|---|---|---|---|
| EOD prices, volumes | Yahoo Finance (O-26 basis); Stooq daily files as the alternative universe source (DAT-252) | O-26 covers US tickers [VERIFY]; Stooq terms | Actions |
| Filings as announcements | SEC EDGAR full-text/feeds with a declared User-Agent; 8-K item numbers as categories (DAT-245) | free; fair-access rate limit 10 requests/s; User-Agent required | Actions |
| Classification | EDGAR company facts / submissions (SIC) | free | monthly |
| Short data | FINRA short interest (twice monthly); FINRA daily short-sale volume files | terms (FINRA data licence [VERIFY]) | Actions |
| Insider notices | SEC Form 4 (XML), Schedules 13D/13G | free | Actions |
| Halts, suspensions | Nasdaq trade-halt feed; SEC trading suspensions page | terms [VERIFY] | Actions |
| Index changes | S&P DJI press releases; FTSE Russell reconstitution schedule | manual CSV fallback | manual |
| Forward results dates | EDGAR filing history cadence (10-Q/10-K); no free forward calendar with clear terms [VERIFY] | — | Actions |
| Fundamentals | EDGAR company facts, as filed (DAT-224…226, AT-38) | free | Actions |
| Macro | FRED, Fed, S&P 500, VIX | FRED API key (free) [SETUP: Owner key] | Actions |
| Calendar | NYSE holiday list | public | yearly draft |

### D.2 ARN-117 US cost profile US-P1 **F**
- **Full text:** "$0 commission; SEC Section 31 fee on sells (rate set yearly by the SEC, stored as a dated profile constant [VERIFY current rate]); FINRA TAF per share on sells with its yearly cap [VERIFY]; no stamp duty. Slippage per ARN-032 with US tick and ADV buckets in US$."
- **AT-70:** "SEC fee and TAF on a sell reproduce the dated constants".
- **Files:** `src/lib/arena/costs.ts`, `src/lib/market/seed/US.mjs` (`cost_formula` = `US-P1`), `tests/cortex/profileParams.test.ts` (asserts `costProfilesOf("IN")` throws; add US).

### D.3 ARN-118 US tick and ADV buckets **F**
- **Text:** "US $0.01 (sub-penny quoting below $1)." ADV buckets in US$ set "from each market's extract at M20 so that the bucket boundaries fall at the same ADV percentiles as AU's."
- **Files:** as C.3.

### D.4 DAT-224…226 EDGAR as filed (V2 text; V3 cites it)
The V3 files do not define these; they are V2 ch. 06 (`Requirement/v2/spec/06_data_delta.md`).
- **DAT-224:** "US fundamentals as filed (PRD-031). For the US market profile, the fundamentals source is SEC EDGAR's machine-readable company facts [VERIFY: endpoint, rate limit and terms at M10 start]. EDGAR needs no key; it requires a declared contact User-Agent, which is held as configuration in the secret store, never in the spec or repo (SEC-110)."
- **DAT-225:** "EDGAR enters the source-licence register (M8 T14) before first use, with its fair-access terms [VERIFY]."
- **DAT-226:** "A stored fixture with an as-filed value and a later restatement shows that a decision dated between the two filings reads the first-filed value. A decision dated after the restatement reads the restated value. A replay that reads a value filed after its decision date fails TST-109."
- **Milestone row (V2 ch. 12):** "When M10 starts: DAT-224…226 EDGAR as-filed | AT-38 (part of M10's AT-M3)". The V3 ch. 12 M20 row carries the same work into M20.
- **Tags:** **[VERIFY]** EDGAR endpoint, rate limit, terms. The User-Agent contact value is an input the Owner's secret store holds; it must not be invented (Gap 22).
- **Files:** `src/lib/market/seed/US.mjs` (`fundamentals_source`), `src/lib/data/` (as-filed reader, new), `db/migrations/main/` (new table if needed, guess). `src/lib/cortex/gates/` (F2 calibration, CXA-013).

### D.5 CXA-013 US F2 fundamentals
- "US: EDGAR company facts as filed (DAT-224…226) make F2 **calibratable** for the US from the first snapshot (ARN-082 coverage formula; "F2-no-fundamentals" variant until then)."
- **Decisions:** none in the spec beyond CXA-013.

### D.6 AT-70 US known answers
- "SEC fee and TAF on a sell reproduce the dated constants; a LULD halt gives no exit fill and re-scores at reopen; an 8-K item map classifies 50 fixture filings; EDGAR as-filed values follow AT-38 (first-filed before restatement, restated after); no EDGAR or FINRA request while US is off in production (AT-68 a)."
- **ch. 14 V3 AT-70 pass condition:** "0 EDGAR/FINRA requests in production shape".

### D.7 US profile values (ch. 20 §20.1, US column, verbatim where it matters)
- exchange, timezone: "NYSE + Nasdaq, America/New_York"; session "09:30–16:00"; opening_auction_window "09:30 opening cross (Nasdaq/NYSE)"; announcement hours "EDGAR acceptance 06:00–22:00 ET"; decision_cutoff "2 h after close ≈ 18:00 ET → 09:00/10:00 next day Melbourne"; known_time: "EDGAR = acceptance time; bars = D close + measured latency"; currency USD, "same rule rounded to US$10"; parcel_floor "none → design floor US$300 [PROPOSED, D-947]"; settlement_days 1; tick "US$0.01 (sub-penny for < $1)"; size tiers "thresholds in US$ from the extract"; cost_formula US-P1; benchmark "S&P 500, VIX"; control C1 "S&P 500 ETF"; classification "SIC code (EDGAR) mapped to 2-digit groups"; short_data "FINRA short interest (twice monthly, lagged) + daily short-sale volume"; insider_notice "SEC Form 4 (XML), 13D/13G"; halt model "LULD halts (Nasdaq feed) + SEC suspensions"; index_change "S&P DJI announcements; Russell reconstitution"; forward results dates "EDGAR filing history (10-Q/10-K cadence)"; fundamentals "EDGAR company facts, as filed (DAT-224…226)"; macro "FRED, Fed, S&P 500, VIX"; dividend imputation "none (angle dropped)"; sleeve reality cap "set at M20 (Reg T 2×)"; calendar "NYSE holiday list"; FX "RBA daily rates".
- **US known_time bars:** "US index bars for a non-US market = D+1 09:00 Melbourne as today" (CXA-002 a). M19 design says the US bar rule is M20 ("US = its own bar rule at M20", M19 design line 73).
- **US `sleeve_reality_cap`:** "set at M20 (Reg T 2×)" (not set in M19).

### D.8 US Worker zone (America/New_York)
- D-1004 M20 adds the New York table with "the DST tests of TST-103" (Section C.8). US slot minutes also need `Slot.tz` (D-1089).

### D.9 CXA-012 US survivorship
- "US: the survivorship caveat (DAT-130/131, CXA-012) in every report until own snapshots satisfy ARN-082" (MKT-112). "US and AU early years assumed" (CXA-012 haircut assumed, not measured). "US replays carry the survivorship caveat" is the report requirement.

### D.10 US UI and e-mail (M20 part)
- Per-market Evening Review and Morning Brief sections: UXN-313 "the Evening Review and Morning Brief gain one section per enabled market, never pooled (MKT-103), sent on that market's trading days (EML-016)" (Section G).

---

## E. Cortex per market (CXA-002 (j), D-949, CXA-008, CXA-015)

- **CXA-002 (j) text (ch. 22 line 19):** "CTX-050/051/052 calibration, announcement history and warm-up run **per market** on that market's extract (MKT-112); "staging" in CTX-052 is read as "the local recorded-day harness and, after switch-on, production `data_only` mode" (PRD-046)."
- **D-949 text:** "Each market has its own Cortex calibration on its own history; AU calibration never transfers; every family starts in shadow per market and leaves only through CTX-053 on that market's data."
- **§20.4 text:** "Each market has its **own** calibration (M15 programme per market, CTX-050) on its own history (MKT-112); families start in **shadow** per market (CTX-054) and may trade only through CTX-053 on that market's data; the AU calibration never transfers (MKT-103). The ≈ 60 % price/volume-only angles (D1, D2 except A-D2-07/08, D7, D9, D10 and the price-derived parts of D4/D5/D8) compute per market unchanged; the 24 announcement angles are forward-only per market (CTX-051) from the market's first timed announcement."
- **Scope note (M19 requirements gap 6 and CXA-004):** the 24 announcement angles are forward-only; CXA-004's one calibration fires only at ≥ 252 timed sessions (M23 trigger). M20 does not run that calibration; it records the per-market start.
- **Holdout (CXA-015 / MKT-112):** "the holdout rule (CXA-015) applies per market." Per-market calibration that produces a holdout look must be pre-registered; the spec does not say whether the M20 calibration uses a look (Gap 9).
- **CXA-008 / DAT-247 label page:** see B.6. Exit "when a market's golden set reaches ≥ 500 items and the lower 90 % bound of agreement clears the threshold, one evaluation decides…" (M23 research).
- **Files:** `scripts/` calibration, announcement-history and warm-up scripts that "take `--market` and read the profile" (M19 design, D-1051 / CXA-002 (j) row; the script path is **(guess)**: `scripts/cortex/`). `src/lib/cortex/` (guess). `src/lib/cortex/stage.ts` `loadStageRows` (M19 D-1016 follow-up).
- **D-1090 items the M20 Cortex work must fix:** "`stage.ts` and `cortexReplay.ts` pass `angles` without `anglesForProfile` (AU-only replay, D-1031)."

---

## F. Switch-on and rollback (MKT-111, AT-71, D-929; Owner step after the merge)

- **§20.6 Switch-on procedure (OPS-061 amended), verbatim:**
  1. "AU meets MKT-105 (≥ 60 trading days live, healthy); the Owner reads the per-market AT-M evidence in `docs/M20_exit_evidence.md`."
  2. "Owner accepts or disables each source whose licence row needs an acceptance (DAT-120; IN exchange sites under DAT-121)."
  3. "Owner sets the market to `data_only`; after ≥ 5 green trading days and a quota projection within MKT-113, sets `full`."
  4. "Books open the next trading day with the ARN-119 seed; the Cortex runs in shadow for every family until CTX-053 passes per market; the market's first Evening Review section says so."
- **AT-71 text (ch. 14 V3 / ch. 20 line 117):** "Switch disabled while any checklist item is open; `off → data_only → full` enforces the 5-day rule and the two-step; `full → off` writes no new row, keeps forever tables, closes books at the next open with reason `market_off`, and audits the reason; AT-M1…AT-M5 evidence for both markets is present in the exit evidence."
- **Build (code only, M20):** the checklist (AT-M evidence, licence rows, quota projection, AU meets MKT-105), the two-step writer (`controls.ts`), rollback (`full → off`), the audit event, the Owner page (UXN-312).
- **Not done by the build:** the Owner's switch-on (A-22, §20.6). The build must not set `markets_enabled` or `PRAXIS_MARKETS_ENABLED` in production.
- **Rollback text (MKT-111):** "existing rows are kept (forever tables stay), no new row is written, books are closed at the next session's open as a kill (CTX-028), and the audit event records the reason."

---

## G. UI and e-mail per market (UXN-312 and UXN-313, M20 part)

- **UXN-312 full text (ch. 20 §20.5):** "The header switcher (UX-003) lists only **enabled** markets in production (MKT-110 c); development lists all built markets. Settings → Region → Markets (Owner only) shows every market with its MKT-114 status, the switch-on checklist (MKT-111) with each item's evidence link, the quota projection (MKT-113), and the `off` / `data_only` / `full` control with the two-step rule and the rollback button. Editors and Viewers never see IN/US rows while a market is off."
- **M20 part of UXN-312 (D-1001):** "M20 the checklist with links, the quota projection, the two-step and rollback."
- **UXN-313 full text (ch. 20 §20.5):** "Every figure carries its market's currency symbol and formatting (₹ with Indian digit grouping; US$); every market time is shown as local **and** Melbourne ("09:15 IST · 14:45 Melbourne"), the freshness line stays in trading words ("End of day, Fri 6 Nov"; the plain-words rule of D-884/D-919/D-922); the family badge colours (UXN-311) are the same across markets; the Evening Review and Morning Brief gain one section per enabled market, never pooled (MKT-103), sent on that market's trading days (EML-016)."
- **M19 state (for M20 to finish):**
  - D-1002: `CurrencyFormat` per profile (`A$` en-AU, `₹` en-IN with lakh/crore grouping, `US$` en-US).
  - D-1063: `formatMarketTime(iso, marketTz, prefs?)` (`health/format.ts`): "the M20 per-market pages call it."
  - D-1061: "`runReviewSend` builds the one review of the date for the first enabled market until the per-market sections of M20 (`paused`/`no_market` when none is enabled)."
  - `src/lib/email/brief.ts` line 64: "Per-market sections in the template are M20."
  - `src/lib/email/templates/reviewWords.ts` line 9: "per-market sections arrive with M20."
  - `src/lib/review/send.ts` line 238: "One review per date, built for the first enabled market until the per-market sections of M20 (D-1061)."
- **Reader for M20 UI:** `src/components/shell/RegionMenu.tsx` (switcher, M19 filter), `src/app/(app)/settings/region/` (page), `src/app/(app)/settings/region.ts` (line 30 and 125: "the checklist with evidence links is M20, D-1001"), `src/lib/ui/loaders/*.ts` (loaders; M19 filter, D-997 `resolveMarket`).
- **Dual time rule:** D-1063 gives "YYYY-MM-DD HH:MM <zone> · HH:MM Melbourne" for a non-AU zone.

---

## H. Acceptance tests

### H.1 AT-69 India known answers (ch. 20 line 115; ch. 14 V3 index)
- **Pass condition (ch. 14):** "Hand-computed totals to ₹0.01; `band_locked` cancel; ASM = no entry; T+1 funding; 50 fixture announcements classified; Nifty 50 / India VIX gate-only."
- **Full text:** "Cost formula fixtures (buy and sell at ₹10,000 and ₹100,000 reproduce hand-computed totals to ₹0.01); a band-locked close cancels an order with reason `band_locked`; an ASM-listed code takes no new entry; T+1 proceeds fund a buy the next session but not the same session; the 8-category map classifies 50 fixture announcements as labelled; the Nifty 50 regime table and India VIX feed the gates only."
- **IDs fed:** ARN-116, ARN-118, ARN-120, DAT-245, DAT-246, CXA-002 (b), (d), (f), (g), (h).
- **Gap:** "8-category map" vs 11 categories (Gap 9).

### H.2 AT-70 US known answers (ch. 20 line 116)
- See D.6. IDs fed: ARN-117, ARN-118, DAT-244, DAT-245 (8-K map), DAT-246 (LULD), DAT-224…226 (AT-38).

### H.3 AT-71 Switch-on and rollback (ch. 20 line 117; ch. 14 V3)
- See F. Pass condition as above.

### H.4 AT-38 EDGAR as filed (V2 ch. 14 line 13, verbatim)
- "**AT-38 EDGAR as filed (M10)** | DAT-226 fixture | First-filed value read before the restatement date and the restated value after; no EDGAR call while US is inactive"
- ch. 14 V3 index: "AT-38 (US as filed)" is part of the V3 PR gate. ch. 20 AT-70 applies AT-38 "behaviour".

### H.5 AT-68 IN/US off in production (every CI run)
- **Pass condition (ch. 14):** "Production configuration (`markets_enabled = ["AU"]`): dispatch, write, UI — (a) master clock and every market-taking workflow refuse IN/US; (b) `MarketNotEnabled` on a planted IN write + incident; nightly row-by-market invariant 0 and alarms on a planted row; (c) no IN/US item on any page, loader, e-mail or switcher; IN/US routes 404; Editor/Viewer walks `leaks()` empty; Owner Markets row reads "Built — off in production"."
- **M20 must keep it green.** New IN/US pages and loaders must sit behind `resolveMarket` (D-997). The M20 switch-on code path must not run while `markets_enabled` is `["AU"]`.
- **M19 evidence:** `docs/test-reports/AT-68.md` (the AT table of `docs/M19_exit_evidence.md` lists it as "CI and CI recorded-day").

### H.6 AT-75 IN and US clauses (ch. 22 line 43; ch. 14 V3)
- "The AU recorded night hashes identically with every CXA-002 field read from the profile; an IN fixture night applies T+1, the ₹ parcel floor, the single open and band-locking; a US fixture night applies the SEC/TAF costs and the SIC grouping; the sector index series for a fixture market reproduces hand-computed values; the text-label page stores Owner labels append-only per market and the evaluation refuses to run below 500 items."
- **M20 part:** the IN and US fixture-night clauses, and the label page's per-market append-only rule (DAT-247). **M23 part:** the sector-series clause (CXA-009). M19 wrote the AU part (`docs/test-reports/AT-75.md`).

### H.7 AT-M1…AT-M5 per built market in development mode (ch. 20 §20.7; v1 texts in B.10)
- Run per built market "in CI and on the build machine with recorded fixtures and the local history, never in production". AT-M4 "uses five recorded days."
- AT-M1 needs the DAT-101 report: an Actions workflow with `markets_enabled` limited to the test run and "no production database" (Section M).

### H.8 AT-85 Test completeness (kept green)
- "AU/IN/US profile fixtures run" (ch. 14 V3 AT-85 summary; ch. 26 AT-85: "the market matrix runs AU/IN/US profile fixtures").
- **TST-139 (ch. 26):** "the recorded-day job runs AU in `full` and IN/US in `off` (the production shape) **and** one IN and one US recorded day in `data_only` (the development shape)". The IN and US `data_only` recorded days need fixtures in `praxis-app-fixtures`, which M20 creates (D-1085: "The `data_only` recorded days for IN and US stay M20 (fixtures in `praxis-app-fixtures`), a recorded partial, not a stub.").
- **Files:** `tests/market/profiles/IN.json` and `US.json` (exist, equal their seeds, D-1085); `scripts/market/gen-fixtures.mjs` (`--check`); `e2e/` and `tests/` matrix config (location: M19 TST-139).

### H.9 AT-32 / AT-50 replay hash
- Unchanged by M20 (A-20). M20's first IN or US-reading change to the night must record "the manifest change as a decided, visible change" (D-1016 follow-up).

### AT coverage table (M20)

| Acceptance test | Covers |
|---|---|
| **AT-69** India known answers | ARN-116, ARN-118 (IN), ARN-119/120 (IN), DAT-245 (IN), DAT-246 (IN), CXA-002 (b, d, f, g, h) (IN) |
| **AT-70** US known answers | ARN-117, ARN-118 (US), DAT-244, DAT-245 (US, 8-K), DAT-246 (US), DAT-224…226 (AT-38), CXA-013 (US) |
| **AT-71** Switch-on and rollback | MKT-111, D-929, UXN-312 (M20 part), DAT-242 (completeness predicate), MKT-113 |
| **AT-38** EDGAR as filed | DAT-224, DAT-225, DAT-226 |
| **AT-68** (every CI run) | MKT-110 (a, b, c), UXN-312, MKT-114, D-926 |
| **AT-75** (IN, US clauses) | CXA-002 (a–j, IN and US), DAT-247 (per-market labels), CXA-008 |
| **AT-M1…AT-M5** (IN, US, dev mode) | DAT-101, DAT-120/121, DAT-010, ARN-116/117, MKT-112, ARN-119/120 |
| **AT-85** (kept green) | TST-139 (IN/US fixtures) |
| **AT-32 / AT-50** replay hash | CXA-001, CXA-002, A-20 |

---

## I. Configuration keys M20 reads, sets or changes (ch. 15 V3 §15.11.1)

| Key | Default (production) | Bounds | Edit | Ref | M20 work |
|---|---|---|---|---|---|
| markets_enabled | `["AU"]` | subset of built markets | E (production) / O via the Markets two-step (MKT-111) | MKT-110, MKT-111 | two-step writer; env `PRAXIS_MARKETS_ENABLED` set only at switch-on (D-994) |
| market_mode (per market) | AU `full`; IN `off`; US `off` | off / data_only / full | O (two-step, checklist) | MKT-109, MKT-111 | two-step writer |
| mkt.<CODE>.decision_cutoff | AU 18:10 Melbourne; IN/US per DAT-241 | HH:MM local | — (profile seed; change = counted trial) | CXA-002 a | verify IN and US |
| mkt.<CODE>.settlement_days | AU 2; IN 1; US 1 | 0–3 | — | CXA-002 b | ARN-120 |
| mkt.<CODE>.parcel_floor | AU 500 AUD; IN 25,000 INR; US 300 USD [D-947] | ≥ 0 in market currency | O (within bounds; counted trial) | CXA-002 b, O-60 | design floors; Owner-editable |
| mkt.<CODE>.opening_auction_window | AU 10:00–10:09 staggered; IN 09:15 single; US 09:30 single | profile enum + minutes | — | CXA-002 c | single-open readers |
| mkt.<CODE>.preopen_recheck_min | 5 | fixed | — | CXA-002 c | IN and US value 5 (ch. 15) |
| mkt.<CODE>.classification_scheme | AU gics_group; IN nse_level2; US sic_2digit | enum | — | CXA-002 e | `classificationReader` (M20) |
| mkt.<CODE>.cost_formula | AU P5; IN IN-P1; US US-P1 | enum | O | ARN-116, ARN-117 | cost tables |
| mkt.<CODE>.universe_max | AU none; IN 2,000; US 2,500 | 500–6,000 | O (only within the MKT-113 projection) | MKT-113, D-928 | read in M20 (M19 registered it, gap 8) |
| mkt.<CODE>.dividend_imputation | AU true; IN false; US false | bool | — | CXA-002 i | verify |

- Not in M20 (ch. 15 §15.11.3 and §15.11.4): `llm_live_roles`, `llm_budget_workers_ai_daily`, `minilm_enabled`, `news_assess_per_run` (M22/M18), `regime_altinputs_enabled` (M22), `sector_index_weighting` (M23), `survivorship_loss_assumed_pct` (M23, but CXA-012 is M20; see Gap 12), `label_golden_min` (fixed 500, DAT-247), `residual_monitor_alarm_pp` (M23), `holdout_looks_max` (fixed 1, CXA-015).
- **Rule (ch. 15):** "an edit to a `mkt.<CODE>.*` key that affects costs, parcels or settlement, **then** a counted trial is charged for that market's lineages and the change ledger records it (DAT-242, VAL-112)."
- **Environment (ch. 15 table, `source_hosts`):** "source_hosts (existing list) | + asic.gov.au, ssrn.com | list | — | DAT-253." IN and US hosts are not listed in the V3 spec (Gap 21).

---

## J. Decisions linked to M20 (ch. 00 V3)

| D-nnn | Decision (ch. 00, short) | M20 part |
|---|---|---|
| D-923 | V3 is a delta on v1 + V2; ch. 17 stays frozen v7; CXA amendments only | CXA-002 (j) |
| D-925 | One market-profile model | Every IN/US value read through the loader (AT-67) |
| D-926 | "Off in production" = three proofs | Keep green (AT-68) |
| D-927 | History lives at `D:\Projects\Praxis\data\history\in\` and `\us\`, never committed; CI fixtures in `praxis-app-fixtures` only | MKT-112 |
| D-928 | Universe caps: US 2,500 codes by 60-session median traded value, IN 2,000; Owner may raise only within the quota projection | MKT-113 |
| D-929 | Switch-on = MKT-105 for AU + per-market checklist + two-step; rollback `full → off`; default order India then US | MKT-111, AT-71 |
| D-934 | Research items time-boxed, one holdout look, PASS / NULL / INCONCLUSIVE | CXA-015 per market (Section E) |
| D-944 | Holdings OCR stub (not M20) | none |
| D-947 | Design parcel floors: IN ₹25,000, US US$300 [PROPOSED]; a change is a counted trial | DAT-241, CXA-002 b |
| D-948 | AT-M1…AT-M5 per built market in development mode | §20.7 (Section B.10) |
| D-949 | Each market has its own Cortex calibration; AU calibration never transfers; shadow per market | CXA-002 (j), §20.4 (Section E) |
| D-950 | MKT-106 work status gains `built` | done in M19 (D-998); M20 keeps it |

Other ch. 00 decisions that are M20 and not M19 (ch. 00 progress text): "D-927 (history path), D-928 (universe caps), D-929 (switch-on and rollback), D-932 (non-goal safe forms), D-938 (Committee)." D-932 and D-938 are outside M20's build (M21 and M22/M23).

**Build decisions M20 must record (derived from the spec's open points; recorded in `docs/M20_design.md` from D-1091):** the [VERIFY] results (Section L), the first IN/US calibration look rule (Gap 9), the calendar-row decision (Gap 10), the universe-cap name (Gap 13), the IN and US `SOURCE_HOSTS` list (Gap 21), the EDGAR contact handling (Gap 22), and the decision whether `trading_calendar` IN/US rows are configuration (B.7).

---

## K. M19 follow-ups that land in M20

### K.1 Named in the brief (quoted in full from `docs/M19_design.md`)

- **D-1016** (line 121): "- **D-1016** Cortex schema hash (A1, found by the step-0 baseline): the night's input manifest carries `schemaSha`, the sha256 of the table names (`src/lib/cortex/stage.ts`), so any migration that adds a table changes every manifest id and with it `cortex_night`, `cortex_decision`, `cortex_feature_daily` and `input_manifest` in the AT-32 world. The three market-profile tables (`market_profile*`, 0034) are configuration a night never reads and are left out of that hash (`name NOT LIKE 'market_profile%'`), so the AU manifests, and the AT-32 baseline, stay byte-identical; the baseline file is not rewritten. A later M19/M20 migration that adds a data table must either do the same or record the manifest change as a decision (Fable review, F task B1). Review (Fable, 2026-11-12): accepted for M19 (`schema_sha` is write-only metadata; nothing reads, compares or dedupes on it; production AU manifests keep their pre-0034 value). Follow-up for M20, when the night starts reading the profile tables: replace the `sqlite_master` scan in `loadStageRows` with a fixed list of the tables the night reads (name + column names), and re-record the AT-32 baseline as a decided, visible change."
- **D-1086** (line 164): "- **D-1086** M19 exit review follow-up, wrapper (Fable, 2026-11-12): wrap the script client factories and the Worker's `pipeline()` with `wrapClient`/`marketRefusalReporter` (a shared `scriptDb()`) at M20, before any IN/US write path exists (see D-1020)."
- **D-1087** (line 165): "- **D-1087** One `--market` resolver (Fable F1, M20): `src/lib/arena/marketFlag.ts` (D-1032) delegates to `resolveScriptMarket` (`scriptMarket.mjs`, D-1050) and `guard.mjs` re-exports its `assertMarketEnabled`, so there is one refusal vocabulary (`refused: market required` vs `market required` today). Harmless while one market is enabled."
- **D-1088** (line 166): "- **D-1088** One home-seed helper (Fable F3, M20): `homeMarket.mjs` stays the constants facade but derives every value from `homeProfile()` (`staticProfile.mjs`); its own `slotsProjection` call goes. No byte change (verified: the six `HOME_*` values equal the profile's)."
- **D-1089** (line 167): "- **D-1089** Worker slot zone (Fable F4, M20, under D-1045): `clock.ts` compares slot minutes on the Sydney clock only; safe in M19 because IN/US zones are not in `ZONE_RULES` (D-1046). When M20 adds Kolkata and New York the minute test must use the slot market's own zone (`Slot` gains `tz`), or an IN slot fires at the Sydney time."
- **D-1090** (line 168): "- **D-1090** Facts the AT-67 scan does not see (Fable F5, M20): `sizing.ts` `STALL_FLOOR_SLIPPAGE_BPS` duplicates the AU tick table's `stall_floor_bps`; the session-time class omits 09:58, 10:32, 15:32 and 18:00; the allow-list entries `WorkerSlotsForm.tsx`, `TimeSeriesChart.tsx` (`A$` default), `view/costPlans.ts` and the `yahoo_fetch.py` defaults are per-market facts to parameterise (the batch-1 and index workflows still pass no suffix or currency, D-1034); `stage.ts` and `cortexReplay.ts` pass `angles` without `anglesForProfile` (AU-only replay, D-1031). Each is an M20 task line."

**Where each lands:** D-1016 → B.10 / Section E (`loadStageRows`, AT-32 manifest re-record); D-1086 → Section B.x / Gap 17 (script factories and Worker `pipeline()`); D-1087 → `src/lib/arena/marketFlag.ts`, `scriptMarket.mjs`, `guard.mjs`; D-1088 → `src/lib/market/homeMarket.mjs`, `staticProfile.mjs`; D-1089 → `worker/src/clock.ts`, `Slot` gets `tz`; D-1090 → `src/lib/arena/sizing.ts`, `WorkerSlotsForm.tsx`, `TimeSeriesChart.tsx`, `view/costPlans.ts`, `scripts/ingest/yahoo_fetch.py`, `scripts/backfill/fetch_prices.py`, `src/lib/cortex/stage.ts`, `cortexReplay.ts`.

### K.2 Other M19 decisions whose text says M20 (grep of `docs/M19_design.md`, one line each)

| D-nnn (M19 line) | The M20 part, quoted from the M19 text |
|---|---|
| D-994 (line 100) | "The only writer of `enabled` is the M20 two-step (none in M19)." |
| D-998 (line 104) | "IN and US `built` (M19 built the model and the proofs; their data work is M20)" |
| D-999 (line 105) | "IN and US are incomplete in M19 by design (gaps 4, 7, 17)" |
| D-1001 (line 107) | "M20 the checklist with links, the quota projection, the two-step and rollback. CXA-002 (a) — AU `bar_latency_p95_min` is today's measured value; IN/US `null` [VERIFY] until M20's 10-night measurement." |
| D-1003 (line 109) | "IN/US amounts are ARN-119 at M20" (currency-denominated keys lose their `A$` labels) |
| D-1004 (line 110) | "M20 adds the Kolkata (no DST) and New York tables with the DST tests of TST-103." |
| D-1010 (line 116) | "`null` means "set at M20" (IN and US `tiers`, `slippage_buckets`, `sleeve_reality_cap`, `bar_latency_p95_min`)" |
| D-1016 (line 121) | see K.1 |
| D-1020 (line 125) | "wrapping the factories (a shared `scriptDb()`) is M20 (D-1086)." |
| D-1031 (line 152) | "any other value throws `not built (M20): <what> <value>`, `NotBuiltM20`" |
| D-1033 (line 149) | "A market whose table is not built (IN and US) throws `not built (M20)`." |
| D-1046 (line 134) | "a market whose zone is not in `ZONE_RULES` (IN, US until M20) is left out of the table with the log line `clock: skipped market <CODE> unusable`" |
| D-1051 (line 139) | "These modules are home-market modules until M20 hands each a `MarketProfile`" |
| D-1061 (line 143) | "until the per-market sections of M20" |
| D-1063 (line 145) | "No AU page uses another form; the M20 per-market pages call it." |
| D-1085 (line 163) | "The `data_only` recorded days for IN and US stay M20 (fixtures in `praxis-app-fixtures`), a recorded partial, not a stub." |
| D-1086 to D-1090 | K.1 |

Also in the M19 text (not a numbered decision): the `trading_calendar` note (M19 design line 220, Gap 10), the `markets_enabled` / `PRAXIS_MARKETS_ENABLED` note (line 222, B.9), the `plantOffMarketRow` note (line 225, Section "Hard constraints"), the Worker local-time stub (line 226, C.8), and the "No Owner prompt" note (line 230: "every M20 reader is a tested `not built (M20)` stub (PRD-039)").

### K.3 Items in M19's exit that M20 inherits
- The M19 "Gaps" and "Not in M19" list in `docs/M19_requirements.md` (the brief's source) assign to M20: MKT-111, MKT-112, MKT-113, MKT-109 (switch-on gate), DAT-243 to DAT-247, ARN-116 to ARN-120, CXA-002 (j), AT-69 to AT-71, AT-M1…AT-M5 (dev), UXN-318 (M21 per its row), and "D-929, D-927, D-928 build decisions for switch-on, history path, caps. M20." Note: M19 requirements file states "D-951" numbering (stale, Gap 4).

---

## L. [VERIFY] items for M20 (every one that the spec marks)

| # | Item | What must be verified | Spec source named |
|---|---|---|---|
| L1 | MKT-107 count | (M19 closed it; re-count if any new literal enters) | ch. 20 MKT-107; D-991 |
| L2 | DAT-241 IN and US fields (every row) | each value, with `verified_at` and evidence | ch. 20 §20.1 (DAT-241) |
| L3 | DAT-242 completeness | `complete` only when every `verify = 1` field has date and reference | ch. 20 §20.1 (DAT-242) |
| L4 | DAT-243 IN sources (Yahoo `.NS`/`.BO`, O-26) | IN tickers covered by O-26 personal-use basis | ch. 20 §20.2; A-18 |
| L5 | DAT-243 NSE archive terms and bot blocking | DAT-121 "off until checked" | ch. 20 §20.2 |
| L6 | DAT-243 announcements (NSE, BSE) | terms; Owner acceptance as O-23; or headline + link only or `disabled` | ch. 20 §20.2 |
| L7 | DAT-243 classification file | redistribution terms | ch. 20 §20.2 |
| L8 | DAT-243 short-data proxy (F&O OI, SLB) | daily files; terms | ch. 20 §20.2 |
| L9 | DAT-243 insider notices (SEBI PIT / SAST) | terms | ch. 20 §20.2 |
| L10 | DAT-243 bands and ASM/GSM | daily files | ch. 20 §20.2 |
| L11 | DAT-243 index changes (NSE Indices) | manual CSV fallback (D-238) | ch. 20 §20.2 |
| L12 | DAT-243 forward results dates | board-meeting intimations; terms | ch. 20 §20.2 |
| L13 | DAT-243 fundamentals (NSE/BSE XBRL, Yahoo `.NS`) | terms; XBRL parser cost | ch. 20 §20.2; CXA-013 |
| L14 | DAT-243 macro (RBI, MOSPI, Nifty 50, India VIX) | public statistics | ch. 20 §20.2 |
| L15 | DAT-243 calendar (NSE holiday list) | public | ch. 20 §20.2 |
| L16 | DAT-244 US Yahoo (O-26 covers US tickers) | [VERIFY] | ch. 20 §20.2 |
| L17 | DAT-244 Stooq | terms | ch. 20 §20.2 |
| L18 | DAT-244 EDGAR | free; fair-access 10 requests/s; User-Agent | ch. 20 §20.2 (no [VERIFY] mark; V2 DAT-224 marks endpoint, rate limit and terms) |
| L19 | DAT-224 EDGAR endpoint, rate limit, terms | "[VERIFY: endpoint, rate limit and terms at M10 start]" | V2 ch. 06 DAT-224 |
| L20 | DAT-225 EDGAR licence-register entry | "with its fair-access terms [VERIFY]" | V2 ch. 06 DAT-225 |
| L21 | DAT-244 FINRA | FINRA data licence | ch. 20 §20.2 |
| L22 | DAT-244 Nasdaq trade-halt feed; SEC trading suspensions page | terms | ch. 20 §20.2 |
| L23 | DAT-244 forward results (EDGAR cadence) | no free forward calendar with clear terms | ch. 20 §20.2 |
| L24 | DAT-244 FRED key | [SETUP: Owner key] | ch. 20 §20.2 |
| L25 | DAT-245 map (IN and US) | fixture-tested table | ch. 20 §20.2 |
| L26 | DAT-246 IN bands and ASM/GSM; US LULD and SEC | known answers | ch. 20 §20.2 |
| L27 | ARN-116 IN-P1: brokerage min(₹20, 0.03 %) | [VERIFY against the cheapest reliable discount broker, O-79 pattern] | ch. 20 §20.3 |
| L28 | ARN-116 STT 0.1 % | [VERIFY] | ch. 20 §20.3 |
| L29 | ARN-116 exchange transaction charge ≈ 0.00297 % (NSE) | [VERIFY] | ch. 20 §20.3 |
| L30 | ARN-116 SEBI turnover fee ₹10 per crore | [VERIFY] | ch. 20 §20.3 |
| L31 | ARN-116 stamp duty 0.015 % on buys | [VERIFY] | ch. 20 §20.3 |
| L32 | ARN-116 DP charge ≈ ₹15 + GST per sell | [VERIFY] | ch. 20 §20.3 |
| L33 | ARN-117 SEC Section 31 fee rate | "stored as a dated profile constant [VERIFY current rate]" | ch. 20 §20.3 |
| L34 | ARN-117 FINRA TAF per share and yearly cap | [VERIFY] | ch. 20 §20.3 |
| L35 | ARN-118 NSE tick ₹0.01 below ₹250 | "since 2024 [VERIFY]" | ch. 20 §20.3 |
| L36 | ARN-118 US sub-penny below $1 | (stated, no verify mark) | ch. 20 §20.3 |
| L37 | ARN-119 FX (RBA daily rates) and rounding | activation-day rule | ch. 20 §20.1 / §20.3 |
| L38 | CXA-002 (a) 95th-percentile latency | "measured on 10 nights per market [VERIFY]" | ch. 22 CXA-002 (a) |
| L39 | CXA-012 IN delisted archive (NSE bhavcopy) | "depth and terms" | ch. 20 MKT-112 |
| L40 | CXA-013 IN XBRL terms | "if the terms pass DAT-101 [VERIFY], else BLOCKED-DATA" | ch. 22 CXA-013 |
| L41 | D-928 NSE main board ≈ 2,000 | [VERIFY] | ch. 20 MKT-113 |
| L42 | D-947 parcel floors | [PROPOSED] | ch. 00 D-947 |
| L43 | D-928 caps | [PROPOSED, D-928] | ch. 20 MKT-113 |
| L44 | A-18 Yahoo basis for IN and US tickers | "[VERIFY at M20]" | ch. 00 A-18 |
| L45 | A-19 literal count | "[VERIFY count at build start]" (closed in M19) | ch. 00 A-19 |
| L46 | DAT-244 Yahoo US | O-26 covers US tickers [VERIFY] | ch. 20 §20.2 |
| L47 | AT-M1 DAT-101 report | run on Actions, no production DB | ch. 20 §20.7 |
| L48 | Macro: FRED API key | [SETUP: Owner key] | ch. 20 §20.2 |
| L49 | Owner-side: EDGAR User-Agent contact | held in the secret store (DAT-224) | V2 ch. 06 DAT-224 |

---

## M. Items whose data needs an internet source (for the orchestrator to decide what runs offline)

The spec names each source below. "Offline option" lists what the repo already holds or what the spec allows without a fetch. Nothing has been fetched in this extract.

| # | Source named by the spec | Items it feeds | Needs internet | Offline option the spec or repo gives |
|---|---|---|---|---|
| M1 | NSE bhavcopy archive (EOD history, delisted codes) | MKT-112, CXA-012 (IN), ARN-118 buckets, AT-M4 replay | yes | none in repo for IN (`data\history\in\` absent); fixtures in `praxis-app-fixtures` (not checked) |
| M2 | Yahoo Finance `.NS` / `.BO` / US tickers (O-26 basis) | DAT-243, DAT-244, AT-M4, MKT-112 | yes | `data\history\yahoo\` exists (AU, check coverage); A-18 keeps market `off` if it fails |
| M3 | NSE announcements, BSE announcements | DAT-243, DAT-245, AGT-011 | yes (bot blocking) | "headline + link only or `disabled`" (DAT-243 row) |
| M4 | NSE industry classification file | CXA-002 (e), DAT-241 | yes | "once per month" (Actions) |
| M5 | NSE F&O open interest; SLB volumes | short_data proxy (DAT-243) | yes | none |
| M6 | SEBI PIT / SAST via NSE/BSE | insider_notice (IN) | yes | none |
| M7 | NSE price-band file; ASM/GSM lists | DAT-246 (IN), CXA-002 (f), (g) | yes | none; known-answer fixtures (AT-69) |
| M8 | NSE Indices announcements (index changes) | DAT-241 index_change | yes (manual CSV fallback) | "manual CSV fallback (D-238 pattern)" |
| M9 | NSE/BSE board-meeting intimations | forward results dates | yes | none |
| M10 | NSE/BSE XBRL results; Yahoo `.NS` fundamentals | fundamentals (IN), CXA-013 | yes | "BLOCKED-DATA" if terms fail (CXA-013) |
| M11 | RBI, MOSPI, Nifty 50 / India VIX series | macro (IN), regime (CXA-002 h) | yes | none |
| M12 | NSE holiday list | calendar (IN, OPS-103) | yes (yearly) | none |
| M13 | SEC EDGAR company facts (as filed) | fundamentals (US), CXA-013, AT-38 | yes (User-Agent, 10 req/s) | fixtures for AT-38 (DAT-226 fixture) |
| M14 | SEC EDGAR full-text / feeds (8-K items, Form 4, 13D/13G) | announcements (US), insider_notice (US), DAT-245 map | yes | fixtures for AT-70 ("50 fixture filings") |
| M15 | SEC EDGAR submissions (SIC) | classification (US) | yes (monthly) | none |
| M16 | FINRA short interest; daily short-sale volume | short_data (US) | yes (FINRA licence [VERIFY]) | none |
| M17 | Nasdaq trade-halt feed; SEC trading suspensions page | halt model (US, DAT-246) | yes | "LULD halt" fixtures (AT-70) |
| M18 | S&P DJI press releases; FTSE Russell schedule | index_change (US) | manual CSV fallback | manual |
| M19 | NYSE holiday list | calendar (US, OPS-103) | yes (yearly) | none |
| M20 | FRED (macro; API key [SETUP: Owner key]) | macro (US), regime | yes | none |
| M21 | SEC fee rate (yearly) and FINRA TAF | ARN-117 constants | yes (dated constants) | the dated profile constant (ARN-117 "stored as a dated profile constant") |
| M22 | RBA daily rates | FX for the IN and US seeds (ARN-119) | yes | activation-day FX rule (ARN-119) |
| M23 | Stooq daily files (alternative universe, DAT-252) | universe (US) | yes | none; spec says "[VERIFY] Stooq terms" |
| M24 | Nasdaq/NYSE symbol directories; NSE equity list (DAT-252 alternatives) | universe fallback | yes | "enabled as fallbacks only when" the list fetch fails (DAT-252 terms) |
| M25 | Actions runner for DAT-101 report (AT-M1) | AT-M1 | yes | none; "the report writes to the run's artefact only" |

Not M20 (listed here so the orchestrator does not start them): Polymarket and Kalshi read endpoints (DAT-248, M22), CXA-009 sector index series (M23), Cortex LLM provider calls (LLM-077, M22), ASX Worker poll (PRD-047, off).

---

## N. Gaps

1. **`tools/m20/PLAN.md` does not exist.** The spec names it (MKT-112; RESUME §3 "written first"; README folder map). The `Requirement\v3\` folder has no `tools\` folder. The M15 reference `Requirement\v2\tools\m15\PLAN.md` exists. The first M20 task is to write the plan.
2. **History folders do not exist.** `D:\Projects\Praxis\data\history\in\` and `\us\` are absent. Present: `asic`, `fred`, `index`, `m15`, `meta`, `rba`, `yahoo`.
3. **DAT-224…226 and AT-38 are not in the V3 files.** The brief expected them in `23_llm_and_data_delta.md`; ch. 23 has no EDGAR text. They are V2 text (`Requirement/v2/spec/06_data_delta.md` and `14_acceptance_delta.md` line 13), quoted in D.4 and H.4.
4. **Decision numbering conflict.** `docs/M19_requirements.md` (the brief's template) says "Build decisions in this milestone start at D-951" and quotes BLD-054 for M19. `docs/M19_design.md` D-1005 corrects it: M18 used D-951…D-990, so M19 started at D-991, and M19 used D-991…D-1090. This extract uses **D-1091** for M20, consistent with D-1005.
5. **The M19 gate is not recorded as green on the remote.** `docs/M19_exit_evidence.md` records the exit tree `d476057d` and says the next step is "push `build`, check CI, then M20 requirements extract." BLD-050 requires "M20 starts only after M19 exits (AT-67, AT-68 green)." The orchestrator must confirm CI on `build` before M20 tasks start.
6. **Many IDs cited in the M20 rows have no text in the V3 extract.** From v1 or V2 (their text must be read at build): DAT-010, DAT-101, DAT-120, DAT-121, DAT-130/131, DAT-160, DAT-232, DAT-234, DAT-236, ARN-001, ARN-025, ARN-031, ARN-032, ARN-049, ARN-071, ARN-082, AGT-011, AGT-011a (the rule is quoted in DAT-245), AGT-020 (categories listed in DAT-245), CTX-010…028, CTX-040, CTX-043, CTX-044, CTX-050…054, CTX-016, CTX-022a, MKT-103, MKT-104, MKT-105, MKT-106, BLD-024, BLD-030, EML-016, OPS-061 (v1 text read at line 58, partial), PLT-071, PLT-073, SEC-112, D-238, D-239, D-242, D-285, D-296, D-297, D-346, FAM-102, O-23, O-26, O-29, O-60, O-79, O-81, A-D2-07/08, A-D3-09, A-D3-10, A-D4-05, A-D8-04/06, PRD-031, NFR-023, VAL-112, TST-103, TST-109.
7. **AT-M1…AT-M5 text is v1 and partly superseded.** V1 ch. 14 is the source. AT-M0 is replaced by the switch-on checklist (§20.7). AT-M5 names the v1 status `active`; MKT-114 changed the status set (`not started → in build → testing → built → active ⇄ paused`).
8. **Label ownership.** The M20 row lists "DAT-247 label sets (page from CXA-008)". The labelling page UXN-318 is in the M21 row (ch. 12) and in ch. 24 §24.6. CXA-008 says the page is "Built" but the M23 row lists CXA-008 as a research item. Owner of the page is unclear.
9. **Two spec conflicts and one research question.**
   - AT-69 says "the 8-category map", but DAT-245 lists 11 categories (results, guidance, contract, capital raising, director trade, substantial holder, takeover, halt, exchange query, dividend, other).
   - The spec does not say whether the M20 per-market calibration (CXA-002 (j), CTX-050) spends a holdout look. CXA-015 says "at most **one** holdout look" per lineage, and MKT-112 says "the holdout rule (CXA-015) applies per market". The M19 requirements extract called (j) "a parameterisation, not research"; ch. 22 CXA-002 (j) describes it as "run per market". The orchestrator should decide and record (BLD-051).
   - The "per-market calibration" output is CTX-050 on the extract, but CTX-050 text is in v1/V2 (Gap 6).
10. **`trading_calendar` IN/US rows.** M19 design line 220: "M20 must decide whether IN/US calendar rows (DAT-248: 'seeded at M20') are configuration — if they are seeded in production the invariant and the guard need an exemption then, not now." DAT-248 in the V3 files does not say "seeded at M20"; §20.2 says "Per-market calendars are seeded for the current and next year at M20". The decision is open.
11. **IN and US latency (CXA-002 a).** "measured on 10 nights per market [VERIFY]" needs 10 nights of IN and US data. The extract is not yet built, so the value cannot be measured offline. M19 kept the field `null`.
12. **CXA-012 and CXA-013 have no acceptance test.** Neither chapter names an AT for the M20 records. The M20 row names them as "per-market data-limit records". The survivorship formula is marked [PROPOSED]; the M20 record needs a test (PRD-039, BLD-055).
13. **Universe-cap names.** MKT-113 uses `us_universe_max` and `in_universe_max`. ch. 15 §15.11.1 and M19 D-1010 use `mkt.<CODE>.universe_max` (bounds 500–6,000). The build uses the ch. 15 name (the key is already registered in M19) and records the decision.
14. **MKT-113 projection method.** The spec gives the 20 % Turso line and "≤ 90 % of every other budget" but no formula for the projection. The M20 design must define it and record the formula as a decision. The Usage page (MKT-104, v1) is where the projection is shown.
15. **Rounding and FX rule for the seeds.** ARN-119 and DAT-241 say the IN seed is "A$600 at activation-day FX close rounded to ₹1,000" and the US seed "rounded to US$10". DAT-241 names the RBA daily rates as the FX source for IN and US as well as AU. The spec does not say which rate series converts INR or USD at the activation day; the orchestrator decides and records it.
16. **`sleeve_reality_cap` and `tiers` have no formula.** IN "set at M20 (SEBI margin rules)", US "set at M20 (Reg T 2×)", tiers "thresholds in ₹ set at M20 from the extract", ARN-118 "ADV buckets are set from each market's extract at M20 so that the bucket boundaries fall at the same ADV percentiles as AU's." The method is in the spec; the values are not.
17. **M19 items the spec does not place.** D-1086 (script factory wrapper) and D-1087 (one `--market` resolver) are M19 follow-ups marked M20. The spec does not mention them. They are build hygiene recorded in M19; they are included here because the M19 decision text says "at M20".
18. **Worker IN and US slot minutes.** D-1089 says the minute test must use the slot's own zone. The spec gives the batch schedule as "close + 60 / + 100 / + 130 min" (DAT-241 batch schedule row) and does not give the IN and US feed slot times. The D-1046 `FEED_SLOT_TIMES` values for IN and US are not in the spec.
19. **D-1090 sizing constant.** `sizing.ts` `STALL_FLOOR_SLIPPAGE_BPS` duplicates the AU `stall_floor_bps`. The IN and US values are not given in the spec.
20. **AT-M1 needs a DAT-101 workflow.** The spec says "on a workflow with `markets_enabled` limited to the test run and **no production database**". No workflow file is named. The build designs it (guess: `.github/workflows/`).
21. **`SOURCE_HOSTS` for IN and US.** DAT-253 adds `asic.gov.au` and `ssrn.com`. AT-81 (M18) refuses any host outside `SOURCE_HOSTS`. The spec does not list the NSE, BSE, EDGAR, FINRA, Nasdaq, SEC, RBI, MOSPI or Stooq hosts. The build must add them as the source rows pass DAT-101, and the spec does not say how.
22. **EDGAR User-Agent contact.** DAT-224 says the contact "is held as configuration in the secret store, never in the spec or repo (SEC-110)". The value is an input from the Owner and must not be invented. Setting it is an Owner step (or a secret-store task the orchestrator cannot do alone); the M20 code must refuse to call EDGAR without it.
23. **Stale M19 pointers.** The M19 requirements file says "D-951" for M19 (its header, line 3) and its Gaps list (gap 6) assigns `CXA-002 (j)` to M20. Both are carried over here as M20 work; the D-951 start is superseded by D-1005.
24. **Owner steps after merge.** Listed in the V3 PR (ch. 14 V3 "Owner-executed tests after the V3 merge"): switch IN or US to `data_only` and later `full` through the Markets page (AT-71 live); the first market section appears in the Evening Review. These are not M20 build tasks.

---

## O. Not in M20

- **Switch-on itself** (Owner step after the merge, §20.6, A-21/A-22).
- **UXN-318 labelling page** (M21 row; ch. 24 §24.6). See Gap 8 for the ownership question on "DAT-247 label sets".
- **UXN-319, UXN-320…324, UX-131, UXN-314…317, ARN-121/122/124, FAM-010, EML-043, VAL-121, PLT-078/079** (M21).
- **LLM items:** LLM-077…081, DAT-248 (FRED and prediction-market regime inputs), DAT-249/250 (stubs), KB-082…085, AGT-145…148 (M22).
- **Cortex research:** CXA-003 (new edge sources), CXA-004 (announcement angles at 252 sessions), CXA-005, CXA-006, CXA-007, CXA-008 exit evaluation, CXA-009 (sector series and IC test, M23; AT-75 series part), CXA-010 (monitors), CXA-011 (SHOCK), CXA-014 (movers), CXA-015 registry UI (M23 row). M20 uses the holdout rule per market but builds no new registry UI.
- **MKT-109** (the switch-on gate evaluation for AU is an Owner read of AT-M evidence).
- **AT-76…AT-79, AT-80, AT-81, AT-82, AT-83, AT-84** (other milestones).
- **D-932, D-938** (listed in ch. 00 progress as M20 build decisions, but their build sits in M21 and M22/M23).
- **Staging, ASX Worker poll, self-hosted infrastructure** (BLD-052, PRD-046, PRD-047).

---

## P. Carried over from M19 (M19 follow-ups now owned by M20)

- **Profile data:** the four "set at M20" fields for IN and US (`tiers`, `slippage_buckets`, `sleeve_reality_cap`, `bar_latency_p95_min`), and every IN and US `verify = 1` value (D-999, D-1010). `tests/market/completeness.test.ts` line 68 is the target test.
- **Stubs to replace (each throws `not built (M20)`):** `src/lib/cortex/profileReaders.ts` (`classificationReader`, `haltReader`, `categoryMapReader`), `src/lib/arena/costs.ts` (lines 112–117), `src/lib/arena/slippage.ts` (line 27), `src/lib/market/staticProfile.mjs` (lines 70–75), `src/lib/market/calendar` readers in `src/lib/data/calendar.ts` (line 53), `worker/src/localtime.ts` (line 62). Their tests assert the throw and must change in the same commit: `tests/cortex/profileStubs.test.ts`, `tests/arena/profileParams.test.ts` (lines 124–131), `tests/cortex/profileParams.test.ts` (lines 77–88), `tests/config/m19Keys.test.ts` (line 142).
- **Test fixtures:** tests that plant off-market rows use `plantOffMarketRow` (`tests/db/helpers.ts`); a direct insert throws (M19 design line 225). M20 tests planting IN or US rows follow the same rule.
- **Guard list frozen at schema 34:** `GUARD_BASE_VERSION`; "a later migration that adds such a table adds its own two triggers, and `tests/db/0035_m19_market_guard.test.ts` fails until it does" (D-1022). M20 migrations that add a market-keyed table must add triggers.
- **Cortex manifest hash (D-1016):** replace the `sqlite_master` scan in `loadStageRows` with a fixed table list when the night reads profile tables; re-record the AT-32 baseline as a visible change.
- **Replay tests:** `stage.ts` and `cortexReplay.ts` pass `angles` without `anglesForProfile` (D-1090, D-1031).
- **Scripts:** `--market` resolver (D-1087), script factory wrapper (D-1086, D-1020), Python fetchers' `suffix` and `currency` (D-1034, D-1090).
- **Worker:** Kolkata and New York tables with DST tests (D-1004, D-1046, TST-103), `Slot.tz` (D-1089).
- **Home seed helper:** `src/lib/market/homeMarket.mjs` derives from `homeProfile()` (D-1088).
- **Recorded days:** IN and US `data_only` recorded days need fixtures in `praxis-app-fixtures` (D-1085, TST-139).
- **Evening Review and Morning Brief:** per-market sections (D-1061, UXN-313, MKT-103, EML-016).
- **Per-market pages:** `formatMarketTime` call sites (D-1063).
- **Switch-on writer:** the two-step writer and rollback (D-994, MKT-111); `markets_enabled` and `PRAXIS_MARKETS_ENABLED` change only at the Owner's switch-on (M19 design §9).
- **Calendar decision:** whether `trading_calendar` IN and US rows are configuration (M19 design line 220; Gap 10).
- **Scan allow-list:** the D-1090 entries (`WorkerSlotsForm.tsx`, `TimeSeriesChart.tsx`, `view/costPlans.ts`, `yahoo_fetch.py` defaults) are per-market facts to parameterise (M19 exit §1).
- **M19 exit evidence to re-check:** `docs/test-reports/AT-67.md`, `AT-68.md`, `AT-75.md` (the AU part, with IN and US rows due in M20).
