# M19 requirements: Market-profile refactor

Delta extract from `Requirement/v3/spec/` (V3 draft, session V3-1, 2026-11-11): ch. 12 V3 (M19 row, BLD-048…BLD-055), ch. 20 (MKT-107…MKT-114, DAT-241, DAT-242), ch. 22 (CXA-001, CXA-002), ch. 24 (UXN-312, UXN-313 as defined in ch. 20 §20.5), ch. 26 (TST-139, AT-85 kept green), ch. 15 V3 (§15.11.1 keys), ch. 14 V3 (AT-67, AT-68, AT-75, AT-85), ch. 00 V3 (O-82, O-83, A-18…A-22, D-923…D-950), ch. 01 V3 (PRD-039, PRD-040, PRD-045…PRD-049). AT-32 and AT-50 are V2 replay tests (V2 ch. 14), not defined in the V3 files. Continues from M18 on `build`. Build decisions in this milestone start at **D-951** (BLD-054) and are recorded in `docs/M19_design.md`.

Source of truth: the V3 spec in `D:\Projects\Praxis\wt-v3-req\Requirement\v3\spec\` (read-only). Quotes below are copied from that text. Code paths are the files in `D:\Projects\Praxis\wt-v3` that most likely change; they come from a grep and are marked **(guess)** where the path is only a probable home. "new" means no existing file was found.

## Scope

M19 is the market-profile refactor (ch. 12 V3 row, D-942 order of value: M18 → M19 → M20). It is **6 build-agent days** in the estimate. Its exit is AT-67 (no market constant) and AT-68 (IN/US off in production) green, AT-75 (AU part) green, and the AU replay hash unchanged (AT-32 / AT-50). Production configuration stays `markets_enabled = ["AU"]` for the whole of V3 (BLD-050, PRD-040). No IN or US job, row or UI reaches production in M19.

It has five kinds of work:

1. **Profile model**: MKT-107 (single loader, remove every literal market constant), DAT-241 (`market_profile` table and `mkt.<CODE>.*` keys), DAT-242 (completeness check and versioning), MKT-114 (`built` status).
2. **Off-in-production proofs**: MKT-110 (a) dispatch refusal, (b) write guard and nightly invariant, (c) UI filter and 404. Also AT-68.
3. **Cortex parameterisation**: CXA-002 (a–j), with AU values byte-identical. Flagged **F** (money maths).
4. **UI**: UXN-312 (market switcher and Markets settings row), UXN-313 (currency, time and words per market).
5. **Test matrix**: TST-139 (market-aware test matrix), and AT-85 kept green.

Items in the M19 row that depend on M20 data are listed in **Gaps** below and under **Not in M19**.

## Hard constraints that apply to every M19 item

- **PRD-039 Everything in the backlog is built.** A stub carries a recorded reason (D-nnn) and a test. Not M19-specific; applies to any stubbed sub-item.
- **PRD-040 India and US are built now, off in production (O-83).** "In production no IN/US job runs, no IN/US row is written to Turso and no IN/US data UI is shown (MKT-110) until the Owner switches a market on after the AU confidence gate."
- **PRD-045 Cost ceilings.** $0 running cost. Turso stays on the FREE plan; at most 20 % of the free plan's monthly reads and writes; keyset paging, never OFFSET. M19 adds no new query pattern that would break this (the OFFSET static test is OPS-104, M18).
- **PRD-046 No staging.** Verification is CI plus prod-safe flags (§1.V3.3).
- **PRD-047 ASX Worker live fetch stays off.** `ASX_LIVE` stays off in the Worker (§1.V3.3). The Worker files in the MKT-107 list (`worker/src/asx/*`) are touched only for the literal-constant removal, not for re-enabling the poll.
- **PRD-048 One pull request.** No intermediate PRs; no Owner prompts (BLD-048).
- **PRD-049 Live-risk first.** M18 closes first; M19 starts after M18 exit (BLD-049).
- **PRD-041 / PRD-033.** No LLM output may create, size, change or cancel an order, thesis-breaker or rule. M19 has no LLM item; the AT-32 replay hash is the check.
- **BLD-051 / D-934.** Research honesty rules apply to any research item. None is in M19. CXA-002 j (per-market calibration) is a parameterisation, not research, so it does not start a holdout look in M19 (see Gaps).

---

## A. Build rules (ch. 12 V3, BLD-048…BLD-055)

These apply to every V3 milestone, including M19.

- **BLD-048 One PR (O-73 pattern, PRD-048).** V3 work is on `build`. Exactly one PR `build`→`main` titled "V3 build complete:" is opened when every milestone M18–M23 is done and green. "No intermediate PRs, no Owner prompts."
- **BLD-049 Order of value (D-942).** "M18 → M19 → M20 → M21 → M22 → M23, completed in this order on `build`. A milestone's tasks may run in parallel streams (≤ 5 Sonnet + ≤ 5 Haiku); never two sub-agents on the same files."
- **BLD-050 India and US together (O-83).** "M20 starts only after M19 exits (AT-67, AT-68 green)." "Neither track may write to production: `markets_enabled` in production stays `["AU"]` for the whole of V3 (AT-68 on every CI run)."
- **BLD-051 Research honesty (PRD-042, CXA-015).** Every research task pre-registers its hypothesis, grid point, split and n before any computation; one holdout look; no re-tuning after a look. Not in M19.
- **BLD-052 Self-hosted infrastructure is not V3.** `infra/selfhost` is standalone. M19 tasks neither depend on it nor touch it.
- **BLD-053 Progress recording and the resume task.** BUILD_SETUP §9 "V3" heading with rows "V3 current milestone" and "V3 last step done / next step". Write "V3 PR opened" in the milestone row only once the PR exists. The lock-file rule of CLAUDE.md §5 and the stale-lock rule (touch the lock each task) apply.
- **BLD-054 Decision numbering (D-924).** Build decisions continue from **D-951** in `docs/M19_design.md`. `docs/07_decision_log.md` is not edited for V3.
- **BLD-055 Milestone package (as v1/V2).** "Haiku requirements extract (`docs/M<nn>_requirements.md`) → design + decisions (`docs/M<nn>_design.md`) → tasks with tests first → Haiku review → Opus/Fable acceptance of the **F** items → `docs/M<nn>_exit_evidence.md` with every AT of the milestone and its evidence → §9 row update."

---

## B. Profile model (MKT-107, DAT-241, DAT-242, MKT-114)

### MKT-107 One market-profile model, no market constants (ch. 20 §20.0, line 6)
- **Summary:** One loader reads every market fact; literal market constants are removed from the code base.
- **Full text:** "Every rule, job, loader, e-mail and page that today assumes AU reads its market facts from the **market profile** (§20.1) of the market it is working on. A literal market code, timezone, cut-off time, currency, parcel floor, tick table, settlement cycle or index code outside the profile loader and the profile seed is a defect (AT-67 static test). The production code holds 73 files with a literal `"AU"` today [VERIFY count at build start; e.g. `src/lib/arena/cohort.ts` `ARENA_MARKET`, `src/lib/data/asxIngest.ts`, `src/lib/alerts/deliver.ts`, `src/lib/config/keys.ts` `MODE_MARKETS = ["AU"]`, `src/lib/data/calendarAdmin.ts` `CALENDAR_MARKETS`]; M19 removes them."
- **Tags:** **[VERIFY]** (73 file count). See the count check under Gaps.
- **Decisions:** D-925 (one model, static test forbids literal constants elsewhere), A-19 (about 73 files, count 2026-11-11, `src`, `scripts`, `worker/src`, tests excluded).
- **Acceptance:** AT-67; AT-32 hash.
- **Files:**
  - `src/lib/market/profile.ts` (new; the spec says "[name at build]", so the loader name is open).
  - `src/lib/config/keys.ts` (line 45 `MODE_MARKETS = ["AU"] as const`; becomes derived from the profile table, AT-67).
  - `src/lib/arena/cohort.ts` (line 52 `ARENA_MARKET = "AU"`).
  - `src/lib/data/calendar.ts` (exports `CALENDAR_MARKETS`, imported by `keys.ts`; the spec names `calendarAdmin.ts`, see Gaps).
  - `src/lib/data/calendarAdmin.ts`, `src/lib/data/asxIngest.ts`, `src/lib/alerts/deliver.ts` (named in the spec; exist).
  - Other files with a quoted `"AU"` literal in `src`, `scripts`, `worker/src` (non-test), 80 matches on the `build` tree at this extract, for example `src/lib/health/snapshot.ts`, `src/lib/ui/loaders/home.ts`, `src/lib/replay/runner.ts`, `worker/src/clock.ts`, `worker/src/routes.ts`, `worker/src/asx/slots.ts`, `worker/src/asx/universe.ts`, `scripts/data/make-au-calendar.mjs` (guess per grep, the full list is the build's first task).

### DAT-241 Profile record and keys (ch. 20 §20.1, lines 15–47)
- **Summary:** One `market_profile` row per market (forever table) plus `mkt.<CODE>.<field>` keys. A single loader is the only reader. AU values reproduce today's behaviour byte-for-byte.
- **Full text:** "One `market_profile` row per market (migration, forever table) plus namespaced configuration keys `mkt.<CODE>.<field>` (ch. 15 V3) for the Owner-editable fields; the profile loader (`src/lib/market/profile.ts` [name at build]) is the single reader. Fields (AU values are the current v1/V2 values and must reproduce today's behaviour byte-for-byte; IN and US values are provisional, **each marked [VERIFY] until confirmed at M20 start**)."
- **Field table (lines 18–47), summarised by the M19 build.** Each row maps one field to the value for AU (today), IN [VERIFY] and US [VERIFY], and the item it replaces. Fields: exchange/timezone; session; opening_auction_window; announcement hours; decision_cutoff; known_time rules per source class; batch schedule; review-date rule; currency and seed; parcel_floor; settlement_days; tick table and slippage buckets; size/liquidity tiers; cost_formula; benchmark, regime index, volatility index; control C1 instrument; classification scheme; short_data kind; insider_notice kind; halt model; index_change source; forward results dates; fundamentals source; macro series; dividend imputation; sleeve reality cap; calendar source; FX source. The full table is in `20_markets_in_us.md` lines 18–47; the M19 build reads it, not this extract.
- **Selected rows that M19 must reproduce for AU (line numbers in brackets):**
  - decision_cutoff AU "18:10 Melbourne (`decision_cutoff` key)" [24]; replaces CTX-010, ARN-020.
  - parcel_floor AU "A$500 (O-60)"; IN "none (1 share) → design floor ₹25,000 [PROPOSED, D-947]"; US "none → design floor US$300 [PROPOSED, D-947]" [29]; replaces CTX-027.
  - settlement_days AU 2 (T+2); IN 1 (T+1); US 1 (T+1) [30]; replaces CTX-027, ARN-025.
  - opening_auction_window AU "staggered 10:00–10:09 by code group" [22]; replaces CTX-028.
  - cost_formula AU P5 (ARN-031); IN IN-P1 (ARN-116); US US-P1 (ARN-117) [33].
  - tick table AU ARN-032; IN "NSE ₹0.05 for all [VERIFY, ₹0.01 below ₹250 since 2024]"; US "US$0.01 (sub-penny for < $1)" [31]; replaces ARN-032.
  - currency and seed: AU "AUD, A$600"; IN "INR, A$600 at activation-day FX close rounded to ₹1,000"; US "USD, same rule rounded to US$10" [28].
  - classification scheme AU "GICS industry group (ASX list)"; IN "NSE industry classification (4 levels; use level 2 as "industry group")"; US "SIC code (EDGAR) mapped to 2-digit groups" [36]; replaces CTX-025/026.
  - halt model AU "halt / suspension (CTX-016)"; IN "daily price bands 2/5/10/20 % (band-locked = no fill) + ASM/GSM lists"; US "LULD halts (Nasdaq feed) + SEC suspensions" [39]; replaces CTX-016, DAT-244.
  - dividend imputation AU "franking (A-D4-05)"; IN and US "none (angle dropped)" [44].
  - sleeve reality cap AU "5× (ASIC)"; IN "set at M20 (SEBI margin rules)"; US "set at M20 (Reg T 2×)" [45] — **not set in M19**.
  - tiers (ADV, price) AU "ARN-010 in A$"; IN "thresholds in ₹ set at M20 from the extract"; US "thresholds in US$ from the extract" [32] — **not set in M19**.
  - Source-type rows (fundamentals, short data, insider notices, index changes, macro, calendar, FX): IN/US sources are candidates (DAT-243 / DAT-244), each [VERIFY] at M20 under DAT-101 (see Gaps).
- **Tags:** **[VERIFY]** on every IN and US value; **[PROPOSED, D-947]** on IN/US design parcel floors.
- **Decisions:** D-925, D-947 (design parcel floors, Owner-editable within bounds, a change is a counted trial).
- **Acceptance:** AT-67 (no literal outside the loader, seed and migrations); AT-75 AU part (AU recorded night identical with every CXA-002 field read from the profile); AT-32 hash.
- **Files:**
  - `src/lib/market/profile.ts` (new), a migration for `market_profile` (new; the migration folder name is open), the profile seed (new).
  - `src/lib/config/keys.ts` (add `mkt.<CODE>.*` keys, derive `MODE_MARKETS`).

### DAT-242 Profile completeness check (ch. 20 §20.1, line 49)
- **Summary:** A profile is `complete` only when every field has a value and every [VERIFY] field has a `verified_at` date and an evidence reference.
- **Full text:** "A profile is `complete` only when every field has a value and every [VERIFY] field has a `verified_at` date and the evidence reference (the DAT-101 report or the licence register row). The switch-on checklist (MKT-111) requires `complete`. The profile is versioned (change ledger, NFR-023); a change to a cost, tick or settlement field is a counted trial for that market's lineages (VAL-112)."
- **Tags:** **[VERIFY]** dependency on M20 evidence (see Gaps, IN/US `complete` state in M19).
- **Decisions:** none directly; D-925, D-947.
- **Acceptance:** AT-67 and AT-68 (the completeness state is not directly a named AT clause; see Gaps).
- **Files:** `src/lib/market/profile.ts` (new), a profile change-ledger table (new; reuse of the NFR-023 ledger is a guess).

### MKT-114 Market work status with `built` (ch. 20 §20.0, line 13; amends MKT-106)
- **Summary:** The status set gains `built` between `testing` and `active`.
- **Full text:** "The status set gains `built` ("Built — off in production") between `testing` and `active`: `not started → in build → testing → built → active ⇄ paused`. A built market shows the date its AT-M evidence was recorded and the gate items still open (AT-M0/MKT-105 for AU days, Owner approval)."
- **Decisions:** D-950.
- **Acceptance:** AT-68 (c) (the Owner's Markets row reads "Built — off in production"); AT-71 is M20.
- **Files:** the status enum and its UI (location to be found at build; MKT-106 is v1, not in the V3 extract).

---

## C. Off-in-production proofs (MKT-110, MKT-108, MKT-109, MKT-111 context)

### MKT-110 Off in production, three proofs (ch. 20 §20.0, line 9)
- **Summary:** While a market's production mode is `off`, no job runs for it, no row is written for it, and no UI shows it.
- **Full text:** "While a market's production mode is `off`: **(a) no job** — the Worker master clock dispatches no workflow for that market and every workflow that takes a market input refuses a market not in `markets_enabled` (PLT-071 amended); **(b) no rows** — the data layer refuses any write whose `market` is not enabled (`MarketNotEnabled`, logged as an incident) and a nightly invariant counts rows by market in every market-keyed table and alarms on any IN/US row in production (OPS-104 extension); **(c) no UI** — loaders, routes, e-mails and the market switcher show only enabled markets; a route with a non-enabled market parameter returns 404 (SEC-112 pattern); the only IN/US text in production is the Owner-only Markets row of Settings → Region reading "Built — off in production" with the switch-on checklist (UXN-312). Non-Owner roles see nothing about IN/US. Development, CI and the local recorded-day harness run IN/US freely under `markets_enabled` set in the local configuration."
- **Tags:** the nightly invariant is the OPS-104 extension (M18 item); PLT-071 and SEC-112 are v1 IDs, text not in the V3 extract.
- **Decisions:** D-926 ("Off in production" = three proofs; the only IN/US text in production is the Owner-only Markets row).
- **Acceptance:** AT-68 (a), (b), (c) (see Acceptance tests).
- **Files:**
  - Worker master clock: `worker/src/clock.ts`, `worker/src/routes.ts`, `worker/src/runNow.ts` (guess; grep hit for literal `"AU"`).
  - Data-layer write guard: `src/lib/data/` write helpers (new `MarketNotEnabled` error; location to be decided at build, guess).
  - Loaders and routes: `src/lib/ui/loaders/*.ts`, `src/app/(app)/market/actions.ts` (line 55 uses `MODE_MARKETS`).
  - Nightly invariant: an OPS-104 extension, see M18 requirements OPS-104 (e).

### MKT-108 Both markets built together, switched on one at a time (ch. 20 §20.0, line 7) — context
- **Full text (abridged):** "India and the US are built in the same milestone on the shared profile model (BLD-050). The v1 sequential *build* order of O-29 (India, then the US) is superseded for the build only; the **switch-on order** stays the Owner's choice, default India first (O-29 go-live order)."
- **Use in M19:** none beyond the shared model. Not an M19 build item.

### MKT-109 The MKT-105 gate becomes the switch-on gate (ch. 20 §20.0, line 8) — context
- **Full text (abridged):** "MKT-105 ... no longer gates the *build* of a market; it gates the Owner's **switch-on** of a built market in production (§20.6). Until then a built market is `off` in production (MKT-110)."
- **Use in M19:** a built market is `off` in production (MKT-110). M19 has no switch-on code path.

### MKT-111 Switch-on and rollback (ch. 20 §20.0, line 10) — context, M20
- **Full text (abridged):** "The Owner switches a built market on in two steps from Settings → Region (Owner only): `off` → `data_only` ... then `data_only` → `full` ... **Rollback** is `full` → `off` in one click: existing rows are kept (forever tables stay), no new row is written, books are closed at the next session's open as a kill (CTX-028), and the audit event records the reason."
- **Use in M19:** none. M19 ships the `off` state and the `built` status only. Rollback is M20 (AT-71).

### MKT-112, MKT-113 — context, M20
- MKT-112 (development history at `D:\Projects\Praxis\data\history\<in|us>\`, never committed) and MKT-113 (quota budget, `us_universe_max` 2,500, `in_universe_max` 2,000 [PROPOSED, D-928]) are M20 items. Listed under **Not in M19**.

---

## D. Cortex parameterisation (CXA-001, CXA-002) **F**

### CXA-001 How amendments work (ch. 22 §22.0, line 6) — applies to M19
- **Full text (abridged):** "Each amendment states: the ch. 17 ID it changes, the exact change, whether it is a **parameterisation** (an AU constant becomes a market-profile field, behaviour for AU unchanged byte-for-byte) or a **research item**. The build's design docs cite the CXA ID, never a changed CTX text. An AT-32/AT-50 replay of a recorded AU night must hash identically before and after every parameterisation."
- **Tags:** the AT-32/AT-50 hash definitions are V2 tests (see Gaps).
- **Decisions:** D-923 (V3 is a delta; CXA amendments only; ch. 17 stays frozen v7).
- **Acceptance:** AT-67 (hash), AT-75 (AU part).

### CXA-002 Market-profile fields replace AU constants (ch. 22 §22.1, lines 9–19) **F** (money maths)
- **Summary:** Ten parameterisations (a–j) that replace CTX-level AU constants with profile fields. AU behaviour must not change.
- **Full text (each sub-item abridged, line in brackets):**
  - **(a)** [10] CTX-010 cut-off: "AU 18:10 Melbourne" → the market's `decision_cutoff` (local time stored, Melbourne shown); known-time rules per source class come from the profile (filings = publication/acceptance time; bars = close + the market's measured 95th-percentile latency, measured on 10 nights per market [VERIFY]; US index bars for a non-US market = D+1 09:00 Melbourne as today).
  - **(b)** [11] CTX-027 settlement and parcel: "T+2" → `settlement_days`; "A$500" → `parcel_floor` in the market currency (IN/US design floors per D-947); the stall predicate (ARN-071) and the "one value everywhere" rule apply per market.
  - **(c)** [12] CTX-028 open-time checks: "staggered 10:00–10:09" → `opening_auction_window` (IN single open after the 09:00–09:08 call auction; US 09:30 cross); the 09:55 re-check becomes "`preopen_recheck_min` minutes before the market's open" (AU 5 min → 09:55, unchanged).
  - **(d)** [13] CTX-022a cost: "fee with GST" and the A$ tier table → the market's `cost_formula` (ARN-116/117) and tick/ADV tables (ARN-118); the card's three break-even cost levels are scaled per market from its median round-trip cost.
  - **(e)** [14] CTX-025, CTX-026 classification: "GICS industry group from the ASX list" → the market's `classification_scheme`; the per-industry NAV cap (35 %) applies to that scheme's group level; sector indices (CXA-009) are built per market.
  - **(f)** [15] CTX-015, CTX-016 corporate actions and halts: the candidate/confirmation rules are unchanged; the notice source and the halt model come from the profile (DAT-246: IN bands and ASM/GSM; US LULD and SEC suspensions).
  - **(g)** [16] CTX-043, CTX-044 event verifiability and promotion flag: categories come from the DAT-245 map; "price-sensitive" where a market has no flag means "category materiality ≥ 2 in the map"; the U2/U3 parsed-statements rule stands for every market; IN adds the surveillance-list trigger (DAT-246).
  - **(h)** [17] CTX-017 regime: the one table is unchanged; the regime inputs (benchmark, volatility index, macro series) come from the profile (AGT-101 per market); the S&P 500 and VIX stay a **global** input for every market.
  - **(i)** [18] A-D4-05 franking is dropped for markets without imputation (profile flag); the angle count for IN/US is 99, the cluster K rule (CTX-012) is unchanged.
  - **(j)** [19] CTX-050/051/052 calibration, announcement history and warm-up run **per market** on that market's extract (MKT-112); "staging" in CTX-052 is read as "the local recorded-day harness and, after switch-on, production `data_only` mode" (PRD-046).
- **Tags:** **[VERIFY]** in (a) (95th-percentile latency, 10 nights per market). (j) is M20 work (see Gaps).
- **Decisions:** D-923, D-947 (parcel design floors), D-949 (per-market calibration, AU never transfers).
- **Acceptance:** AT-67 (no literal), AT-75 AU part (AU recorded night hashes identically with every CXA-002 field read from the profile), AT-32 / AT-50 hash.
- **Files:** the CTX-level modules that hold the AU constants, found by the grep in MKT-107; cortex modules named in the spec are `src/lib/cortex/night.ts`, `src/lib/cortex/gates/gates.ts` (guess; the M18 extract cites them for OPS-110).

---

## E. UI (UXN-312, UXN-313)

Both IDs are defined in ch. 20 §20.5 (lines 99–101). Ch. 24 §24.6 cross-refers to them and does not repeat the text.

### UXN-312 Market switcher and Markets settings (ch. 20 §20.5, line 100)
- **Summary:** The header switcher lists only enabled markets in production. The Settings → Region → Markets page is Owner-only.
- **Full text:** "The header switcher (UX-003) lists only **enabled** markets in production (MKT-110 c); development lists all built markets. Settings → Region → Markets (Owner only) shows every market with its MKT-114 status, the switch-on checklist (MKT-111) with each item's evidence link, the quota projection (MKT-113), and the `off` / `data_only` / `full` control with the two-step rule and the rollback button. Editors and Viewers never see IN/US rows while a market is off."
- **M19 scope:** the switcher filter (AT-68 c) and the `built` status row with "Built — off in production". The checklist, quota projection and the two-step control are M20 (MKT-111, MKT-113). See Gaps.
- **Acceptance:** AT-68 (c).
- **Files:** `src/components/shell/RegionMenu.tsx` (grep hit for literal `"AU"`), `src/app/(app)/settings/region/page.tsx`, `src/app/(app)/settings/region.ts` (grep hits, guess).

### UXN-313 Currency, time and words per market (ch. 20 §20.5, line 101)
- **Summary:** Every figure carries its market's currency and formatting; every market time is shown as local and Melbourne.
- **Full text (abridged):** "Every figure carries its market's currency symbol and formatting (₹ with Indian digit grouping; US$); every market time is shown as local **and** Melbourne ("09:15 IST · 14:45 Melbourne"), the freshness line stays in trading words ("End of day, Fri 6 Nov"; the plain-words rule of D-884/D-919/D-922); the family badge colours (UXN-311) are the same across markets; the Evening Review and Morning Brief gain one section per enabled market, never pooled (MKT-103), sent on that market's trading days (EML-016)."
- **M19 scope:** the formatting and time functions take the profile's currency and timezone. AU output must not change. The per-market Evening Review sections are M20 (only AU is enabled in M19).
- **Tags:** D-884, D-919, D-922, UXN-311, MKT-103, EML-016 are v1/V2 IDs; text not in the V3 extract.
- **Acceptance:** AT-68 (c), AT-82 (D-922 scan) is M21.
- **Files:** `src/lib/email/brief.ts`, `src/lib/review/send.ts` (grep hits for literal `"AU"`, guess), formatting helpers (location to find at build).

---

## F. Test matrix (TST-139)

### TST-139 Market-aware test matrix (ch. 26, line 10)
- **Summary:** Unit, job and contract tests run per built market with that market's profile fixture where the code path reads the profile. The recorded-day job runs AU in `full` and IN/US in `off`, and AT-68 is part of every CI run.
- **Full text:** "Unit, job and contract tests run per built market with that market's profile fixture (AU, IN, US) where the code path reads the profile; the recorded-day job runs AU in `full` and IN/US in `off` (the production shape) **and** one IN and one US recorded day in `data_only` (the development shape); AT-68 is part of every CI run."
- **M19 scope:** the matrix shape (per-market parameterised test runner, the `off`-shape job for IN/US). The `data_only` IN and US recorded days need IN/US fixtures that do not exist until M20 (see Gaps).
- **Decisions:** D-926 (AT-68), D-948 (AT-M1…AT-M5 development mode, context).
- **Acceptance:** AT-68 in every CI run; AT-85 (kept green through M23, ch. 14).
- **Files:** `e2e/` and `tests/` matrix config (location to find at build); the recorded-day job (`scripts/e2e-day/recorded-day.mjs`, grep hit for literal `"AU"`).

---

## Acceptance tests

### AT-67 No market constant (ch. 14 V3 line 7; ch. 20 line 113)
- **Pass condition (spec, ch. 14):** "0 literal market code, timezone, cut-off, currency, parcel, tick or index code outside the profile loader, seed and migrations; `MODE_MARKETS`/`CALENDAR_MARKETS` derived; AT-32 hash identical."
- **Full text (ch. 20):** "A static test fails on any literal market code, timezone, cut-off, currency symbol, parcel, tick or index code outside the profile loader, the profile seed and the migration files; `MODE_MARKETS` and `CALENDAR_MARKETS` are derived from the profile table; a recorded AU night replays byte-identically before and after the refactor (AT-32 hash)."
- **IDs covered:** MKT-107, DAT-241 (AU part), CXA-002 (AU part).
- **Gap:** the spec does not say whether test files and fixtures are exempt from the static scan (A-19 excludes tests from the 73-file count; AT-67 does not state the rule). See Gaps.

### AT-68 IN/US off in production (ch. 14 V3 line 8; ch. 20 line 114)
- **Pass condition (spec, ch. 14):** "(a) master clock and every market-taking workflow refuse IN/US; (b) `MarketNotEnabled` on a planted IN write + incident; nightly row-by-market invariant 0 and alarms on a planted row; (c) no IN/US item on any page, loader, e-mail or switcher; IN/US routes 404; Editor/Viewer walks `leaks()` empty; Owner Markets row reads "Built — off in production"."
- **Full text (ch. 20):** "With production configuration (`markets_enabled = ["AU"]`): (a) the master clock and every market-taking workflow refuse `IN`/`US` (unit + workflow contract tests); (b) a data-layer write with `market = "IN"` throws `MarketNotEnabled` and logs an incident; the nightly invariant job reports 0 IN/US rows across every market-keyed table (a planted row in a test database alarms); (c) every page, loader, e-mail and the switcher show no IN/US item; `/market/IN`-style routes 404; the Owner's Markets row shows "Built — off in production"; an Editor and a Viewer walk shows no IN/US text (e2e, `leaks()` empty)."
- **IDs covered:** MKT-110 (a, b, c), UXN-312, MKT-114, D-926.
- **Run:** every CI run from M19 on (ch. 14 "M19, every CI run thereafter").

### AT-75 Per-market Cortex parameterisation and sector series (ch. 14 V3 line 15; ch. 22 line 43) — **AU part only in M19**
- **Pass condition (ch. 22):** "The AU recorded night hashes identically with every CXA-002 field read from the profile; an IN fixture night applies T+1, the ₹ parcel floor, the single open and band-locking; a US fixture night applies the SEC/TAF costs and the SIC grouping; the sector index series for a fixture market reproduces hand-computed values; the text-label page stores Owner labels append-only per market and the evaluation refuses to run below 500 items."
- **M19 part:** the AU clause only. The IN and US clauses, the sector series (CXA-009) and the label page are M20 and M23 (ch. 14 milestone column "M19 (AU), M20 (IN/US), M23 (series)").
- **IDs covered in M19:** CXA-002 (a–i for AU; j per-market calibration is M20), DAT-241.

### AT-32 and AT-50 replay hash unchanged (V2 tests; referenced by AT-67, AT-75, CXA-001, CXA-002, A-20)
- **Pass condition in the V3 spec:** "a recorded AU night hashes identically before and after every parameterisation" (CXA-001, line 6); "any difference is a defect, not a tuning" (A-20, `00_README_and_progress.md` line 13).
- **Source:** AT-32 and AT-50 are defined in V2 ch. 14 (not in the V3 files). Their text, the recorded AU night, and the hash definition are not extracted here. See Gaps.

### AT-85 Test completeness (kept green through M19, ch. 14 V3 line 25; ch. 26 line 13)
- **Pass condition (ch. 26):** "CI lists and runs every e2e spec file ...; the market matrix runs AU/IN/US profile fixtures."
- **M19 part:** the market matrix is extended (TST-139). The IN/US fixture half is not runnable until M20 (see Gaps).

---

## AT coverage table (M19)

| Acceptance test | Covers |
|---|---|
| **AT-67** No market constant | MKT-107, DAT-241 (AU), CXA-002 (AU), AT-32 hash |
| **AT-68** IN/US off in production | MKT-110 (a, b, c), MKT-114, UXN-312, TST-139 (every CI run), D-926 |
| **AT-75** (AU part) | CXA-002 (a–i), CXA-001, DAT-241 |
| **AT-32 / AT-50** replay hash (V2) | CXA-001, CXA-002, AT-67 |
| **AT-85** (kept green) | TST-139 |
| *no AT named* | DAT-242 (completeness; see Gaps), UXN-313 (partly AT-68 c; AT-82 is M21) |

Coverage gaps (flagged, not fixed here): **DAT-242** has no AT clause in ch. 14 V3. **UXN-313** is covered only indirectly through AT-68 (c). **CXA-002 (j)** has no M19 clause (it belongs to AT-75 IN/US in M20). The M19 exit evidence must give DAT-242 and UXN-313 a test (guess, per PRD-039 and BLD-055).

---

## Configuration keys (ch. 15 V3, §15.11.1, M19 rows)

§15.11.1 "Markets and profiles" (`15_config_delta.md` lines 5–18). Every key is registered in `src/lib/config/keys.ts` with bounds and a spec reference, and shown on the Configuration page in plain words (D-922).

| Key | Default (production) | Bounds | Edit | Clause | State |
|---|---|---|---|---|---|
| `markets_enabled` | `["AU"]` | subset of built markets | E (production) / O via the Markets two-step (MKT-111) | MKT-110, MKT-111 | new (M19 registers it; the two-step is M20) |
| `market_mode` (per market, existing) | AU `full`; IN `off`; US `off` | off / data_only / full | O (two-step, checklist) | MKT-109, MKT-111 | exists; relation to `markets_enabled` not stated (see Gaps) |
| `mkt.<CODE>.decision_cutoff` | AU 18:10 Melbourne; IN/US per DAT-241 | HH:MM local | — (profile seed; change = counted trial) | CXA-002 a | new |
| `mkt.<CODE>.settlement_days` | AU 2; IN 1; US 1 | 0–3 | — | CXA-002 b | new |
| `mkt.<CODE>.parcel_floor` | AU 500 AUD; IN 25,000 INR; US 300 USD [D-947] | ≥ 0 in market currency | O (within bounds; counted trial) | CXA-002 b, O-60 | new |
| `mkt.<CODE>.opening_auction_window` | AU 10:00–10:09 staggered; IN 09:15 single; US 09:30 single | profile enum + minutes | — | CXA-002 c | new |
| `mkt.<CODE>.preopen_recheck_min` | 5 | fixed | — | CXA-002 c | new |
| `mkt.<CODE>.classification_scheme` | AU gics_group; IN nse_level2; US sic_2digit | enum | — | CXA-002 e | new |
| `mkt.<CODE>.cost_formula` | AU P5; IN IN-P1; US US-P1 | enum | O | ARN-116, ARN-117 | new |
| `mkt.<CODE>.universe_max` | AU none; IN 2,000; US 2,500 | 500–6,000 | O (only within the MKT-113 projection) | MKT-113, D-928 | listed in §15.11.1; **M20 content** (see Gaps) |
| `mkt.<CODE>.dividend_imputation` | AU true; IN false; US false | bool | — | CXA-002 i | new |

Also from ch. 22 §22.3 (per-market keys, M19 part): `mkt.<CODE>.decision_cutoff`, `settlement_days`, `parcel_floor`, `opening_auction_window`, `preopen_recheck_min` (fixed 5), `classification_scheme`, `cost_formula`.

Non-M19 keys in the same section (not listed above): `llm_proposals_per_month`, `sector_index_weighting`, `survivorship_loss_assumed_pct`, `label_golden_min`, `residual_monitor_alarm_pp` (ch. 22 §22.3, ch. 15 §15.11.4), which belong to M21–M23.

Given-clause from ch. 15 (line 65): "an edit to a `mkt.<CODE>.*` key that affects costs, parcels or settlement, **then** a counted trial is charged for that market's lineages and the change ledger records it (DAT-242, VAL-112)."

---

## Decisions linked to M19 (from ch. 00 V3)

| D-nnn | Decision (short) | M19 IDs |
|---|---|---|
| D-923 | V3 is a delta on v1 + V2; ch. 17 stays frozen v7; CXA amendments only | CXA-001, CXA-002 |
| D-924 | Build decisions from D-951 in milestone design docs | BLD-054 |
| D-925 | One market-profile model: `market_profile` table + `mkt.<CODE>.*` keys, a single loader, and a static test forbidding literal market constants elsewhere; AU values reproduce today's behaviour byte-for-byte | MKT-107, DAT-241, AT-67 |
| D-926 | "Off in production" = three proofs; the only IN/US text in production is the Owner-only Markets row | MKT-110, UXN-312, AT-68 |
| D-947 | Design parcel floors where the exchange has none: IN ₹25,000, US US$300; Owner-editable within bounds; a change is a counted trial **[PROPOSED]** | DAT-241, CXA-002 b |
| D-948 | AT-M1…AT-M5 run per built market in development mode; BLD-024 production data-only mode no longer applies to IN/US before switch-on (context) | §20.7 |
| D-949 | Each market has its own Cortex calibration; AU calibration never transfers (context, M20) | CXA-002 j |
| D-950 | MKT-106 work status gains `built` | MKT-114 |

Decisions in the progress table of ch. 00 that are M20 and are **not** M19: D-927 (history path), D-928 (universe caps), D-929 (switch-on and rollback), D-932 (non-goal safe forms), D-938 (Committee).

Cited in text but outside the V3 decision table (V1/V2 decisions, need the decision log): D-884, D-919, D-922 (UXN-313), O-60 (AU parcel floor), O-26 (Yahoo basis, M20), NFR-023 (change ledger), VAL-112 (counted trial), D-052 (not M19).

## Hard constraints restated for M19

- **Production stays `markets_enabled = ["AU"]`** for the whole of V3 (BLD-050, PRD-040). Any commit on `build` during M19 must leave AT-68 green (ch. 12 acceptance, line 30).
- **AU byte-identical.** A recorded AU night replays to the same hash before and after the refactor (AT-67, AT-32 / AT-50 hash, A-20). "Any difference is a defect, not a tuning."
- **No OFFSET, keyset paging only** (PRD-045). M19 does not add list queries.
- **Turso free plan ≤ 20 %** (PRD-045). M19 writes no IN/US row (MKT-110 b).
- **No staging** (PRD-046); verification is CI plus prod-safe flags.
- **ASX Worker live fetch stays off** (PRD-047).
- **No LLM output near orders** (PRD-041, PRD-033).

---

## Items in the M19 row whose text was not found or conflicts

None missing from the M19 row. All 9 row IDs (MKT-107, DAT-241, DAT-242, MKT-110, MKT-114, CXA-002, UXN-312, UXN-313, TST-139) were found. The gaps and contradictions below are flagged, not invented.

### Gaps and contradictions

1. **Literal `"AU"` file count (MKT-107, A-19).** The spec says 73 files (A-19, count 2026-11-11, `src`, `scripts`, `worker/src`, tests excluded). A grep on the `build` tree at this extract (quoted `"AU"` or `'AU'` or backtick-AU, excluding `.test.`, `.spec.`, `/test/`, `/tests/`, `__tests__`) gives **80 files**, including two `.d.mts` declaration files. The count method and the 2026-11-11 baseline differ, so the number is **[VERIFY] at M19 start**. The M19 first task is a scripted count with the rule written into `docs/M19_design.md`.
2. **MKT-107 example names.** The spec cites `src/lib/data/calendarAdmin.ts` `CALENDAR_MARKETS`. In the tree, `calendarAdmin.ts` exists, but `CALENDAR_MARKETS` is exported from `src/lib/data/calendar.ts` and imported by `src/lib/config/keys.ts`. The spec example is slightly off; the build should derive from the real symbol.
3. **`src/lib/market/profile.ts` does not exist.** It is named "[name at build]" in DAT-241, so the name is open. No file yet.
4. **IN/US profile values are [VERIFY] until M20 (DAT-241), but DAT-242 makes `complete` depend on `verified_at`.** M19 must build IN and US profile rows, yet a profile with unverified IN/US fields cannot be `complete`, and MKT-111 requires `complete` for switch-on. The spec does not state whether IN/US rows are `incomplete` in M19 by design. The M19 design decision should say so.
5. **AT-75 IN clause and TST-139 IN/US fixtures are M20 work, but the M19 matrix names them.** TST-139 in M19 requires "that market's profile fixture (AU, IN, US)". The `data_only` IN and US recorded days need fixtures in `praxis-app-fixtures`, which M19 does not create. AT-85 is M18-homed with "AU/IN/US profile fixtures run" (ch. 14 line 25), and M18 precedes M19. Contradiction in timing.
6. **CXA-002 (j) is in the M19 row but its substance is M20.** The M19 row says "CXA-002 (a–j, AU values byte-identical)". Item (j) (per-market calibration CTX-050/051/052 on each market's extract) needs the M20 extract (MKT-112), and the M20 row lists "per-market Cortex calibration on the extract (CTX-050 via CXA-002 j)". M19 can only do j for AU (identical). Scope to be recorded.
7. **CXA-002 (a) measured latency per market.** "measured on 10 nights per market [VERIFY]" cannot be measured in M19 (no IN/US data). M19 keeps the AU value; IN/US values stay [VERIFY] until M20.
8. **`universe_max` is in §15.11.1 but is M20 content (MKT-113, D-928).** It is listed among the M19 keys in the source table. M19 should register the key or defer it, and the spec does not say which.
9. **Two off-switches.** `markets_enabled` (E, production) and `market_mode` (per market: AU `full`; IN/US `off`) both express "off". MKT-110 uses "production mode is `off`" and "not in `markets_enabled`". The spec does not state which is authoritative when they disagree. Build decision needed.
10. **MKT-110 (a) cites PLT-071 (amended) and MKT-110 (c) cites SEC-112 pattern.** Both are v1 IDs; their text is not in the V3 extract.
11. **MKT-105, MKT-106, MKT-103, MKT-104, DAT-010, DAT-101, DAT-120/121, OPS-061, NFR-023, VAL-112, CTX-010…028, ARN-025/031/032, A-D4-05, AGT-101, EML-016, UXN-311, UX-003** are cited but are v1/V2 IDs. Their text is not in the V3 extract. Read from `Requirement/v1/spec/` and `Requirement/v2/spec/` at build.
12. **UXN-312 and UXN-313 are defined in ch. 20 §20.5, not ch. 24.** Ch. 24 §24.6 cross-refers. The M19 row cites the IDs without a chapter; the chapter reference used here is ch. 20 §20.5.
13. **UXN-312 scope split.** The Settings → Region → Markets page includes the switch-on checklist (MKT-111, M20) and the quota projection (MKT-113, M20). M19 can only ship the status row and the switcher filter. The spec does not state the M19/M20 split.
14. **AT-32 and AT-50 are V2 tests.** Their definitions (recorded AU night, hash method) are not in the V3 files. The M19 exit depends on them, so the V2 ch. 14 text must be read at build.
15. **AT-67 test scope.** AT-67 forbids literal constants "outside the profile loader, the profile seed and the migration files". It does not say whether test files and fixtures are exempt, while A-19 excludes tests from the count. The static test's exclusion list must be recorded in `docs/M19_design.md`.
16. **DAT-242 and AT clause.** DAT-242 has no AT clause in ch. 14 V3 (see AT coverage table).
17. **CXA-002 (d) and tick tables are M19 but IN/US tick values are [VERIFY]** (ARN-118, "NSE ₹0.05 for all [VERIFY, ₹0.01 below ₹250 since 2024]"). Same issue as item 4.
18. **Context reference "D-884, D-919, D-922" (UXN-313).** These are v1/V2 decisions not in the V3 decision table. Read from the decision log (`docs/V2_decisions.md`).

---

## Not in M19 (assigned to M20 or later by the chapters)

- **MKT-111** switch-on and rollback (two-step `off → data_only → full`, rollback). M20 (AT-71). M19 ships `off` only.
- **MKT-112** per-market history extract at `D:\Projects\Praxis\data\history\<in|us>\` (D-927). M20.
- **MKT-113** quota budget per market and universe caps `us_universe_max` 2,500 and `in_universe_max` 2,000 (D-928). M20.
- **MKT-109** switch-on gate evaluation (AU meets MKT-105). M20.
- **DAT-243, DAT-244** India and US source tables and [VERIFY] at M20 under DAT-101. M20.
- **DAT-245** per-market announcement category map and materiality. M20 (AGT-011a fixture table).
- **DAT-246** halt and band model per market (band-lock, ASM/GSM, LULD, SEC suspensions). M20 (AT-69, AT-70).
- **DAT-247** labelled announcements per market (≥ 500 Owner labels per market). M20 and M21 (UXN-318).
- **ARN-116, ARN-117** India and US cost profiles (IN-P1, US-P1). M20 (AT-69, AT-70).
- **ARN-118** tick tables and slippage buckets per market. M20 (values set from the extract).
- **ARN-119** seeds and conversion per market (activation-day FX rule). M20.
- **ARN-120** settlement and deployable cash per market (T+1 replay, AT-M4). M20.
- **CXA-002 (j)** per-market Cortex calibration (CTX-050/051/052) on each market's extract, and the M20 per-market calibration row. M20.
- **AT-69, AT-70** India and US known answers. M20.
- **AT-71** switch-on and rollback test. M20.
- **AT-M1…AT-M5** per built market in development mode (§20.7, D-948). M20.
- **UXN-318** golden-set labelling page (`/cortex/labels?market=`). M21 (per the M21 row; ch. 24 §24.6).
- **CXA-009** sector index series. M23 (AT-75 series part).
- **D-929, D-927, D-928** build decisions for switch-on, history path, caps. M20.
- **Owner steps** listed in the V3 PR (market switch-on, licence acceptances, A-22), not M19 build work.
