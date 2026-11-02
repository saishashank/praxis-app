# M17 requirements: Intraday watch and pick alerts

Delta extract from `Requirement/v2/spec/19_intraday_watch_and_pick_alerts.md` (V2 draft, 2026-10-29; Owner O-74, O-75, O-76, O-77), ch. 12 V2 (M17 row, BLD-046, BLD-047), ch. 14 V2 (AT-60 to AT-65), ch. 15 V2 (M17 keys), ch. 17 v7 (CTX-053, section 17.12a; read only where ch. 19 consumes the Cortex chance `p`), v1 UXN-048 (spec ch. 16). Continues from M16 on `build`. Decisions here start at D-381.

## Scope

M17 is the fifth V2 milestone (BLD-046: M8.1, M14, M15, M16, **M17**, M11-lite, M13-lite, M12). It adds two streams that are never mixed (ARN-110):

1. **Buy-price alerts** on the night picks (an e-mail when the delayed price reaches the pick's limit).
2. **Intraday watch** (a rule-based scan every 30 minutes during ASX hours that finds movers with a news or announcement catalyst), shown as its own section and e-mailed as "Attention needed".

Plus: pick tile stamps, "My alerts", Settings, a confidence % on night picks with sorting, a 10-pick list, and a family badge with an "i" sheet. Nothing in M17 places an order, changes a book, a ledger or a lesson (ARN-111, SEC-114).

Marks: **build** = build in M17. **exists** = already in the code, reuse. **deferred** = not in M17, with the reason. **blocked** = needs something M15 did not deliver (see "Cortex result").

### Cortex result that shapes M17

M15 calibration kept every family in shadow (D-379, D-380: no cell passes the CTX-021 economic gate). So, at M17 build time:
- No family is `allowed` or `live-tested`. UXN-308 therefore shows **"Not enough history yet"** on every night pick and no number. Sorting by chance (UXN-309) falls back to its own rule: all picks have no chance, so they sort last-in-group in **rank order**.
- The night picks on the Picks tab and Home are the **V1 picks** (table `pick`, families F1 to F6, `src/lib/picks`), because Cortex decisions are shadow (`cortex_decision.arm = 'shadow'`) and hold cash. Alerts therefore arm on **V1 picks** (limit = `buy_max_micro`, stop = `stop_micro`). Shadow Cortex decisions have a `limit_micro` and `stop_micro` too, but they are not published picks, so they are **not** armed (proposed D-381).
- The intraday stream is shadow by definition (VAL-117): candidates are found, shown, e-mailed as "unvalidated", and handed to the 18:10 run as input rows. The Cortex run evaluates them as shadow decisions; no book trades them. This is the same behaviour whether or not a family is allowed, so M17 works unchanged with no allowed family.
- The V2 limit price (CTX-*) exists only in shadow rows. Until a family is allowed, "limit_price" for an alert means the V1 pick's `buy_max_micro` (ch. 19 section 19.7: "v1 family stops until M15 lands").
- The family badge "i" sheet shows status **shadow** for every family (the truthful state), with its phrase-table text.

### Pick alerts (19.1)

| ID | Plain words | Mark |
|---|---|---|
| ARN-110 | Two streams, never mixed: night picks and intraday watch are stored, shown, e-mailed and measured apart. An intraday candidate never enters a book, family signal or Cortex score on its day. | build |
| ARN-111 | Alerts are a convenience, not an instruction. Books keep filling at the next open; alert state changes nothing in any book, ledger or lesson. No "stop hit" e-mail for picks (AGT-115 stop e-mails for simulated held positions stay as they are). | build (the books-byte-identical test is AT-60) |
| ARN-112 | At the 09:55 pre-open re-check, every current pick for an active market is armed with its limit and stop, unless the re-check removed it. Per user: Owner default all on, others off (`pick_alert` preference). Pick decided on D is armed on D+1 and later sessions while listed and unfilled. | build (re-check exists, see below) |
| ARN-113 | Hit = delayed last price at or below the limit, above the stop, not halted. One e-mail per pick per session. A later rise does not re-arm in the same session. | build |
| ARN-114 | Clear reasons: `left_list`, `below_stop` (price under stop before a hit), `above_chase_cap` (open or quote above limit by `chase_cap_pct`), `halted`, `expired` (`pick_alert_max_sessions`), `muted`. Reasons below_stop and above_chase_cap send one information e-mail; the rest are in-app only. Never re-armed unless the pick is re-issued at a later 18:10. | build |
| ARN-115 | Entity `pick_alert` with append-only transitions (armed, hit, cleared) and the fields in 19.1. | build (new table) |

### E-mails (19.2)

| ID | Plain words | Mark |
|---|---|---|
| EML-038 | "Buy price hit" e-mail: subject `[Praxis] Buy price hit - <CODE> (delayed)`, template text only, fixed fields, "place your own stop" line, simulated footer (SEC-016). To the alert's user only. | build |
| EML-039 | "Pick cleared" e-mail, two variants (below_stop, above_chase_cap). One per pick per session. | build |
| EML-040 | "Attention needed: new intraday candidate" e-mail: trigger, gates passed, indicative limit and stop, the words "Unvalidated stream", link, footer. No LLM text. | build |
| EML-041 | Own daily cap `pick_alert_emails_per_day` inside the EML-004 budget; bursts within 5 minutes batched (EML-020 style); suppressed mail listed in Evening Review section 9 and My alerts; P0 wins when the budget is tight; staging sends none to the inbox. | build (caps and claim exist) |
| EML-042 | Evening Review section 8 gets two lines (alerts today, candidates today) and an optional section listing candidates with their 18:10 outcome. | build |

### Intraday scan (19.3)

| ID | Plain words | Mark |
|---|---|---|
| AGT-139 | No LLM path. All selection, ranking and clearing is deterministic. | build (test: no LLM import in the new modules) |
| AGT-140 | Worker master clock calls a signed Vercel route every `intraday_scan_min` between 10:30 and 15:30 on trading days (early close ends at early close). Per run: fetch delayed quotes in batches, join today's Sentinel items by code, apply candidate rule and gates, write rows, e-mail. Idempotent per (market, session, slot); a failed slot is skipped. Request budget `intraday_scan_requests_max`; over budget narrows to tier 1 and reports "scan narrowed". | build (route-slot pattern exists; the delayed-quote fetch does not, see below) |
| DAT-239 | Scan universe = tiers 1 and 2 of the nightly universe snapshot plus watch-listed and held codes, capped at `intraday_scan_codes_max` (800; 0 = off). The scan never adds a code. | build |
| AGT-141 | Candidate rule: catalyst (Sentinel item today, materiality 2 or more) AND move (sector-adjusted, at least max(`intraday_move_min_pct`, 1.5 x 60-session sd)) AND volume (at least `intraday_rel_volume_min` x pro-rated 20-session average) AND fresh quote. A move without a catalyst is not a candidate. One row per code per session. | build ([VERIFY] cumulative volume in the delayed quote, see Q2) |
| AGT-142 | Gates as for a night pick: not halted, liquidity floor, no excluded corporate-action state, not already held, NAV caps, not on the do-not-trade list. A failing candidate is recorded with the gate, not e-mailed, not shown. | build |
| AGT-143 | Indicative limit and stop for display and e-mail only, labelled "indicative, delayed data". | build |
| AGT-144 | Every candidate is an input row of that evening's Cortex run; the Cortex evaluates it as any other code (no inherited levels or priority); outcome recorded (`night_pick`, `rejected:<gate or rank>`, `not_in_universe`). | build (input-row hook into `src/lib/cortex/night.ts`, see Q6) |
| DAT-240 | Entity `intraday_candidate` with catalyst, move, volume, gates, indicative levels, email id, outcome, and measurement fields. Point-in-time: never edited after the next session's close except measurement fields. | build (new table) |
| DAT-238 | Data honesty: all intraday prices are delayed quotes (UXN-048, about 20 min); every tile, e-mail and record carries the quote time and the word "delayed". No new paid source. | build (constraint on everything above) |

### UI (19.4 and 19.8)

| ID | Plain words | Mark |
|---|---|---|
| UXN-301 | Picks and Home show two labelled sections: "Tonight's picks" and "Intraday watch" (own accent, one-line explainer, empty state with last scan time; outside hours shows yesterday's with outcome). Masking (ROL-107) applies to both. | build |
| UXN-302 | Pick tile stamps: when published or found, the data basis, and the alert chip (Armed with limit, Hit time, Cleared with reason). | build |
| UXN-303 | "My alerts": list for the last 30 sessions by state, delivery status (sent, batched, suppressed); actions mute, unmute, "alerts for all picks". Reached from the bell and Settings. | build |
| UXN-304 | Settings -> Alerts rows: buy-price alerts, cleared-pick e-mails, intraday candidate e-mails, daily cap (read-only), quiet hours (held and sent as one digest; nothing here is P0). | build (quiet hours store exists: `QuietHoursForm.tsx`, preferences service) |
| UXN-305 | Home "Since yesterday" and "Needs you" rows for hits and candidates; candidates whose e-mail was suppressed by the cap appear in "Needs you". | build |
| UXN-306 | Company page header gets the stamp and chip, and the catalyst line for an intraday candidate. | build |
| UXN-307 | Up to 10 picks per profile, no per-family or per-sector cap, confidence floor `pick_min_chance` (55 %) as the only filter (fallback for uncalibrated families: top cell), "4 picks tonight" not filler, Home shows top 3, concentration line, Intraday section shows at most 5 with "n more". | build, but see Q3 (the floor cannot use `p` while all families are in shadow) |
| UXN-308 | Confidence on every night pick ("Chance of a net gain: 62 % (55-69 %) from 120 similar setups") only for allowed or live-tested families with a passing slope; else "Not enough history yet". Plus expected net gain line. | build the display and the guard; **no number will show now** (all shadow, D-379/380). Slope-hide threshold key = 1.0 (D-257, not 0.7 as in 17.12a text) |
| UXN-309 | Default sort by chance descending, ties by expected net gain; no-chance picks last in Cortex rank order; toggle "Sort by expected gain" remembered per user; Decision Card states the sort basis. | build (with no chance anywhere the order is rank order; toggle still built) |
| UXN-310 | Intraday candidates show "Unrated - no history yet", sorted by catalyst materiality then sector-adjusted move. Never a rules score or LLM number as confidence. | build |
| UXN-311 | Family badge (label, fixed colour, two-letter mark) on every pick tile; "+1" for a two-family pick; "i" sheet from a fixed phrase table with status, record and Strategies link. Not hidden by masking. Colours must pass contrast in six themes. | build (F1 to F7 and Intraday; F7 badge appears only where a pick is F7, none now) |

### Measurement (19.5)

| ID | Plain words | Mark |
|---|---|---|
| VAL-117 | Shadow first. Excess return over sector index at 1, 3, 5 sessions from the next open, and separately from the delayed quote at `found_at`, filled nightly. | build |
| VAL-118 | The stream is a lineage in the market-level ledger with a pre-registered hypothesis (mean 5-session excess return net of the cost model greater than 0; at least 60 candidates and 60 sessions; block-bootstrap lower bound as CTX-021). Pass lets the Owner approve a family next release; it never trades intraday. | build (the lineage and the test; the pass cannot happen in V2 because the sample takes at least 60 sessions of forward data) |
| VAL-119 | Monthly alert-usefulness report in Reviews (hit rate, time to hit, clear reasons, next-5-session return of hit vs cleared-above-limit), plus list-length distribution and ranks 1-5 vs 6-10 outcome (UXN-307). Descriptive only. | build (renders from fixtures; real data accrues) |

### Non-functional and platform (19.6)

| ID | Plain words | Mark |
|---|---|---|
| NFR-041 | Latency statement ("up to about 20 + refresh minutes after the trade") in help text and e-mail footer. No "real-time" claim anywhere. | build |
| NFR-042 | Scan and alert poll counted in the PLT-050/051 monitor as series "intraday scan" and "pick alerts"; at 80 % of a quota the scan narrows; at 95 % it stops for the day with a System Health line. | build |
| SEC-114 | No broker order, route, or deep link anywhere. Blueprint shows the scan read-only. | build (grep test for broker hosts and "order" links) |
| PLT-077 | Schedule rows: 09:55 arm; 10:00-16:00 poll every 5 min for armed, watchlist, held; 10:30-15:30 scan every 30 min; 18:10 hand-over; nightly measurement with the EOD batch. | build (new Worker route slots) |

### Deferred or out

| Item | Why |
|---|---|
| Live (non-delayed) prices, ASX real-time or any paid feed | Costs money and needs a licence; breaks the $0 rule (O-64, PRD-007, UXN-048 "Not in scope"). Delayed quotes only. |
| A dedicated intraday-watch family that trades | Needs VAL-118 pass (60 sessions of forward data) and Owner approval; and even then it fills at the next open. Not possible inside V2. |
| Stop-hit e-mails for picks | ARN-111: the Owner sets their own broker stop. |
| Owner trade logging and follow-through | 19.5 VAL-119: "nothing in V2 asks the Owner to log trades". |
| Other markets than ASX | One active market (AU) at V2; the code keeps a `market` column. |
| Any Cortex change to make a family allowed | M15 result is final for V2 (D-379/380); not an M17 task. |
| Pick-card UI for Cortex shadow decisions as picks | Shadow decisions are not published picks. |

## Acceptance tests

| ID | Pass condition (spec) | Evidence that proves each clause |
|---|---|---|
| AT-60 Alert state machine | Fixture quote streams for 10 armed picks (hit; hit then rise; below stop before hit; open above the chase cap; halt; expiry; left list at 18:10): exactly one `hit` e-mail per hit pick per session; one `cleared` e-mail for below_stop and above_chase_cap only; correct reason codes; no re-arming in the session; append-only transitions; My alerts shows every transition; books byte-identical with the feature on and off. | (a) Vitest on a pure `evaluateAlert(state, quote)` with the 7 stream shapes (10 picks: hit, hit-then-rise, below-stop, above-cap, halt, expiry, left-list, plus two more mixes). (b) E-mail count by `email_message` rows per pick per session. (c) Trigger test: UPDATE or DELETE on `pick_alert` aborts (same pattern as `cortex_decision_no_update`). (d) Component test on My alerts rows. (e) Byte-identity: run the arena replay (AT-32 path, `src/lib/replay`) with alerts off and on, compare the book tables' hash. |
| AT-61 Intraday scan | Recorded session of delayed quotes and Sentinel items: candidates exactly where catalyst + move + volume + gates hold; big move without catalyst is not a candidate; a gate failure is recorded and not e-mailed; slot run is idempotent; request count within budget and narrowing triggers at the threshold; every candidate appears as an input row of that session's Cortex run with an outcome; AT-32 replay still byte-identical. | (a) Table-driven test of `isCandidate` on ZZ fixtures (each of 4 conditions failing alone, all passing). (b) Run the slot twice, assert one row. (c) Request counter test at 80 %, 95 %, over `intraday_scan_requests_max`. (d) Hand-over test: candidate rows in `cortex` input, outcome written after a synthetic run. (e) AT-32 replay hash unchanged. |
| AT-62 UI and e-mail | Picks and Home show two labelled sections with stamps and chips in three roles (masking holds), two sizes, six themes; empty state shows the last scan time; e-mails render from fixtures with subject prefixes, "delayed", the latency line, no LLM text; batching, daily cap, quiet hours behave. | (a) Playwright (e2e) walk: 3 roles x 2 sizes x 6 themes, screenshot and DOM assertions (reuse the M8.1 theme walk). (b) Masking test for non-Owner roles. (c) E-mail fixture render tests extended from TST-129 (`src/lib/email/templates`). (d) Cap and batching test over `claimKey`. (e) Quiet-hours digest test. |
| AT-63 Measurement | Nightly fields filled for every candidate; lineage exists with its pre-registered hypothesis; null set (true mean excess 0) does not pass; planted +1.5 % passes at the stated sample; monthly report renders. | (a) Nightly job test on a synthetic set. (b) `trial_ledger` row with hypothesis text asserted. (c) Gate test on two seeded synthetic sets (reuse the M15 bootstrap code in `src/lib/stats`). (d) Report render test. |
| AT-64 Confidence display and ordering | Families in shadow / allowed / live-tested with slope upper bound above and below the threshold: chance shown only for allowed or live-tested with a passing slope, as a whole % with interval and n; "Not enough history yet" otherwise; default order by chance, toggle remembered; intraday "Unrated"; masking holds. | (a) Pure `chanceDisplay` table test over the 6 combinations (fixture states; the threshold read from the key, 1.0 per D-257). (b) Sort test with and without chances. (c) Preference round trip for the toggle. (d) Intraday tile never shows a number (DOM test). (e) Masking test. Note: in production data no row will show a number; the fixture states prove the code path. |
| AT-65 Family badge | Every tile in both sections, both sizes, six themes, three roles shows the right label, colour and two-letter mark; colours pass contrast; "i" sheet shows phrase-table text, status and record; "+1" lists both; same colour in Strategies and the concentration line. | (a) Component test per family. (b) Contrast calculation for every badge x theme (reuse the AT-66 palette checker from M8.1 if present). (c) Sheet content test. (d) One shared colour map module imported by tiles, Strategies and the concentration line (a test greps that no second colour table exists). |

AT-60 to AT-65 are all automatable. The one non-automatable point: the delayed-quote source contract ([VERIFY at build]: cumulative volume field, batch size, free limits) is checked by a recorded-response contract test and noted as an Owner item only if the source cannot give cumulative volume (Q2).

## Configuration keys

Ch. 15 V2 lists the keys below. Existing in `src/lib/config/keys.ts`: `intraday_codes_max`, `intraday_refresh_min` (UXN-048), `picks_per_profile` (default 5, max 10) and `picks_max_per_family` (default 2, range 1 to 5). All others are new. Note the revised `pick_alert_emails_per_day` = 12 (the later row in ch. 15 wins over 8).

| Key | Default | Range | Clause | State |
|---|---|---|---|---|
| pick_alerts_default_owner | on | on/off | ARN-112 | new |
| chase_cap_pct | 3 | 1-8 | ARN-114 | new |
| pick_alert_max_sessions | 3 | 1-10 | ARN-114 | new |
| pick_alert_emails_per_day | 12 | 0-20 | EML-041 | new (ch. 15 shows 8 then revised to 12; use 12) |
| intraday_scan_min | 30 | 15-60 | AGT-140 | new |
| intraday_scan_start / intraday_scan_end | 10:30 / 15:30 | within session | AGT-140 | new |
| intraday_scan_codes_max | 800 (0 = off) | 0-1,500 | DAT-239 | new |
| intraday_scan_requests_max | 40 per run [VERIFY batch size] | 10-100 | AGT-140 | new |
| intraday_move_min_pct | 4 | 2-10 | AGT-141 | new |
| intraday_rel_volume_min | 2.0 | 1.2-4 | AGT-141 | new |
| intraday_candidate_emails_per_day | 3 (inside pick_alert_emails_per_day) | 0-8 | EML-040/041 | new |
| intraday_stream_state | shadow | shadow / allowed / live-tested (set only by VAL-118 and Owner approval) | VAL-118 | new; must have no UI or API writer other than the VAL-118 evaluator (like `recordFamilyStatus`, CTX-072) |
| home_picks_shown | 3 | 1-5 | UXN-307 | new |
| intraday_candidates_shown_max | 5 | 1-20 | UXN-307 | new |
| picks_default_sort | chance | chance / expected_gain | UXN-309 | new (per-user override in preferences) |
| picks_per_profile | 10 (was 5) | 0-10 | UXN-307, O-76 | exists, change default |
| picks_max_per_family | 10 = off (was 2; range today 1-5, must widen to 1-10) | 1-10 | UXN-307, O-76 | exists, change default and range |
| pick_min_chance | 55 % | 50-70 % | UXN-307 | new |
| intraday_codes_max / intraday_refresh_min | 150 / 5 | existing | UXN-048 | exists |
| cortex slope-hide threshold | 1.0 | per D-257 (spec text says 0.7) | UXN-308 | exists in M15; reuse the key, do not add a second |

Also needed outside ch. 15: a `pick_alert` preference per user and quiet hours (preferences service exists). Config reference (`docs/config-reference.md`) is regenerated by `scripts/ci/config-reference.mjs`.

## Data and SEC-110 constraints

- The public repo gets code, migrations, phrase tables, fixtures with **ZZ codes** and synthetic prices only. No real ticker, price, announcement text, quote capture or Owner e-mail.
- Recorded quote sessions for AT-61 are **synthetic recordings** built by a fixture generator. A real capture of a delayed-quote response is not committed (it would be vendor data and a real ticker set).
- No copy of V2 spec chapters into `praxis-app` (SEC-110). Phrase tables (family descriptions for the "i" sheet) are new original text written for the app, derived from the v1 spec strategies chapter, which is allowed in the repo.
- Owner e-mail only from `OWNER_EMAIL` at run time. E-mail templates take fixture addresses in tests (Resend recipient constraint EML-003).
- Secrets: no new secret expected (same Resend, Turso, signing keys). Any new credential name goes in `secretStores.ts` and the Blueprint model; values never in files.
- Licence: delayed quotes come from an unofficial free source under the existing accepted risk O-26/UXN-048. A **new source or key is a licence decision for the Owner** (see Q1). The source register (`source_register` inserts in migrations, `docs/source-licence-register.md`, checked by `scripts/ci/licence-register.mjs`) needs a row for the quote endpoint before it is called.
- Money: the project stays at $0 (O-64). Worker, Vercel and Resend free quotas are the limit; NFR-042 narrows and stops the scan before anything else is hurt.
- Point-in-time: `found_at` = the delayed quote time; rows immutable except measurement fields; `pick_alert` append-only.

## What exists and what is missing

| Need | Exists (path) | Missing |
|---|---|---|
| Config keys | `src/lib/config/keys.ts` (`intraday_codes_max` l.846, `intraday_refresh_min` l.847, `picks_per_profile` l.526, `picks_max_per_family` l.527) | All M17 keys above; widened ranges; the verify text for ch. 19 keys (`src/lib/config/verify.ts`) |
| Delayed-quote fetch (UXN-048) | Only the label `DELAYED_PRICE_LABEL` in `src/lib/view/honesty.ts` and the two keys. Sources are `src/lib/data/sources/yahoo.ts` (daily bar parser only), `asx.ts`, `asxMarkit.mjs` (announcements/prices), `src/lib/data/controls.ts` (feed on/off) | **No delayed intraday quote fetcher, cache, or "Prices paused" path exists.** M17 must build it (shared cached quote set per refresh, batching, failure to "Prices paused"). Biggest risk item (Q1, Q2) |
| Worker schedule | `worker/src/schedule.ts` (AU slots, `route` runner, `needs`, `after`, `requiresListing`), `worker/src/routes.ts`, `worker/src/clock.ts` | New route slots: `pick-arm` (09:55 with pre-open), `quote-poll` (every 5 min 10:00 to 16:00), `intraday-scan` (30 min 10:30 to 15:30), nightly measurement; early-close handling (PLT-073 calendar exists in `src/lib/data/calendar.ts`); `scripts/ci` slot/route manifest updates (`tests/routes/manifest.json`) |
| Signed internal routes | `src/app/api/internal/preopen`, `alert-flush`, `evening-review`, `morning`, etc. | `/api/internal/pick-alerts` and `/api/internal/intraday-scan` (+ measurement), same signing guard |
| Pre-open re-check | `src/lib/arena/preopen.ts`, `preopenRoute.ts`, tables `preopen_run`, `preopen_result`, `pick_check` (0014) | Arm step that reads `pick` rows still valid after the re-check |
| Picks (V1) | `src/lib/picks/*` (`generate.ts`, `nightly.ts`, `store.ts`, `validity.ts`), table `pick` (market, d, profile, rank 1-10, family F1-F6, `reference_micro`, `buy_max_micro`, `stop_micro`, `aim_micro`, `valid_until_d`, `n_similar`), `pick_outcome`, `pick_check` | Count change to 10 with no family cap; floor logic (Q3); `family` CHECK allows F1-F6 only (F7 / intraday badge needs no column, badge is derived) |
| Picks UI | `src/app/(app)/picks/` (`PickCard.tsx`, `PickTabs.tsx`, `FamilyInfo.tsx` (an "i" already?), `SuccessStrip.tsx`, `data.ts`, `text.ts`), `src/app/(app)/home/HomeContent.tsx`, `home/familyMap.ts` | Two-section layout, stamps, chips, badge component, concentration line, sort toggle, intraday tiles, My alerts page, Settings -> Alerts. Check `FamilyInfo.tsx` and `familyMap.ts` first: they may already hold family labels to reuse for UXN-311 (one colour map) |
| Cortex data for chance | Tables `cortex_decision` (`p`, `arm`, `limit_micro`, `stop_micro`), `family_status` (shadow/allowed/suspended), `cortex_map`, `cortex_state`; `src/lib/cortex/status.ts`, `statements.ts`, `phrases.ts`, `store/*`; Cortex page `src/app/(app)/cortex/` | A read adapter "family status + p + slope bound for a pick" (shadow now, so mostly returns "Not enough history yet"); `intraday_candidate` input hook into `src/lib/cortex/night.ts` and the outcome write-back |
| Sentinel items | `src/lib/sentinel/*` (`materiality.ts` AGT-011, `ingest.ts`), tables `announcement`, `sentinel_ingest`, `item_assessment`, `watch_list_owner`, `alert` | A query "today's items by code with materiality >= 2 and polarity"; news mapping to a code (check `item_assessment` columns) |
| E-mail | `src/lib/email/` (`send.ts`, `caps.ts` claim and caps, `keys.ts` slot kinds, `templates/alerts.ts`, `core.ts`, `provider.ts`, `mock.ts`), tables `email_message`, `email_attempt`, `src/lib/alerts/*` (P0 flush, batching in `flush.ts`) | Templates EML-038 to 041, kind registrations in `keys.ts`, daily pick-mail cap and 5-minute batching, Evening Review lines (`src/lib/review`) |
| Preferences / settings | `src/lib/preferences/*`, `src/app/(app)/settings/*` (`QuietHoursForm.tsx`, `quiet-hours/`), `src/app/api/alerts/quiet-hours` | `pick_alert` and sort preferences; Alerts settings page; quiet-hours digest for pick mail (not P0) |
| Tables | Migrations to `0019_cortex.sql` in `db/migrations/main` | `0020_intraday.sql`: `pick_alert` (append-only triggers), `intraday_candidate`, quote cache/run record if stored (or reuse `run_record`), plus `source_register` row; update `src/lib/data/schema.ts` |
| Threshold monitor | `src/lib/health`, `src/lib/usage` (PLT-050/051), `src/lib/workerReport` | Series "intraday scan", "pick alerts"; narrowing at 80 %, stop at 95 % |
| Universe tiers | `src/lib/data/universe/`, `universe_snapshot`, `instrument_class` | Tier 1-2 list reader; liquidity-floor gate reuse from `src/lib/cortex/gates/` and `src/lib/cortex/economics/cost.ts` |
| Ledger lineage | `trial_ledger`, `lineage`, `src/lib/cortex/store/ledger.ts`, `src/lib/stats` (block bootstrap) | New lineage row for the intraday stream; nightly measurement job; monthly report in `src/app/(app)/reviews` |
| Blueprint | `src/lib/blueprint`, `docs/architecture/spec_map.yaml` | New routes, workflows, tables, secrets and the quote host must be added to the model or the CI completeness check (AT-58) fails |
| Replay byte-identity | `src/lib/replay/*`, `src/lib/arena/replay.ts` | A flag-off vs flag-on comparison harness |
| Workflows | `.github/workflows/*` (no intraday workflow; Worker route slots avoid Actions minutes) | None, if everything runs as route slots; confirm the nightly measurement runs in the EOD batch (`nightly.yml`) |

## Open questions and proposed decisions

Recommended default = what the spec says or the nearest safe reading. Numbered from D-381.

| # | Question | Recommended default | Proposed decision |
|---|---|---|---|
| Q1 | The delayed-quote source: UXN-048 names "the same unofficial source as end-of-day prices" (Yahoo, accepted risk O-26) but its request limit for 150 codes every 5 min, and for 800 codes every 30 min, is `[VERIFY at build]`. Does it fit free limits and the terms? | Use the existing source and a batched quote endpoint only if the contract test shows it fits; otherwise narrow (`intraday_scan_codes_max` falls to what fits). No paid source, no new licence, no scraping beyond the already-accepted source. If no free batched endpoint exists, ship armed-pick polling and the watchlist only and set scan codes to what the budget allows. | D-381: M17 uses only the already-accepted free delayed source; a new paid or newly licensed source is out (O-64). Source-register row added. Listed in the PR as an Owner licence note. |
| Q2 | Does the delayed quote carry cumulative session volume (AGT-141c)? | If yes, use it. If no, the volume condition is evaluated from the latest delayed 1-minute or 5-minute bars of the same source if free; if neither, drop condition (c) and raise `intraday_move_min_pct` weight? No: keep the spec rule, and when volume is unavailable record `rel_volume = null` and treat the candidate as **not passing** (fail-closed), so the stream stays small rather than noisier. | D-382: unknown volume fails the volume condition (fail-closed) and is shown in System Health as "volume unavailable". |
| Q3 | UXN-307 floor `pick_min_chance` needs `p`; with every family in shadow there is no `p`. The fallback ("only if in the family's top cell") needs the CTX-021 pooled top-3 cell, which also does not pass. Cutting the list to zero would empty the Picks tab of the live V1 list. | Do **not** change V1 pick generation to depend on Cortex output. Raise the list to 10 per the keys, no family cap, but apply the floor only where a calibrated `p` exists; for families with none, keep the existing V1 pick rules (their own thresholds in `src/lib/picks/generate.ts`) as the gate. Show "Not enough history yet" and the concentration line. Flag to the Owner that the floor is dormant until a family is allowed. | D-383: floor active only for allowed or live-tested families; V1 rules gate the rest; list length is whatever V1 yields up to 10. Listed in the PR. |
| Q4 | Arm picks from V1 `pick` (shadow Cortex decisions are not picks). | Arm V1 picks; limit = `buy_max_micro`, stop = `stop_micro`. When a family later becomes allowed, the same code reads the V2 limit from the Cortex decision (adapter function with one switch). | D-381 sibling D-384: arming reads one function `armableOrders(market, session)` returning V1 picks now and allowed-family Cortex orders later. |
| Q5 | Pick-alert default per role. | Owner on, others off (spec). | D-385: as spec. |
| Q6 | How does the candidate reach the Cortex run (AGT-144) when Cortex decisions are shadow? | Add a table-or-view of candidate codes as an extra **input** to `src/lib/cortex/night.ts`'s candidate set (code only; no levels, no priority). The Cortex gates decide as for any code. Outcome is read back after the run from `cortex_decision` (and `pick` for V1). Candidate not in the family universe records `not_in_universe`. Cortex stays deterministic and the replay hash must not change when no candidates exist. | D-386: hand-over adds codes only; empty candidate set leaves the Cortex output byte-identical. |
| Q7 | Where does scheduling run: Actions workflow or Worker route slots? | Worker route slots (signed POST), as for pre-open and alert-flush. Saves Actions minutes and meets the 30-minute cadence. | D-387: route slots; new slots ship `enabled: true, requiresListing: true`, off until the Owner lists them in `worker_state.slots_enabled`, consistent with the earlier slots. Staging enables them; production listing happens at the PR approval. |
| Q8 | Quiet hours digest for pick mail. | Reuse the stored quiet hours; held pick mail leaves as one digest at the end; nothing in this chapter is P0. | D-388: as spec. |
| Q9 | `pick_alert_emails_per_day`: ch. 15 shows 8 and then 12. | 12 (the revised row). | D-389: default 12. |
| Q10 | Slope-hide threshold: ch. 19 says 0.7, ch. 15/M15 D-257 sets 1.0. | Use the one key from M15 (1.0). | D-390: one key, value 1.0; no second key. |
| Q11 | `intraday_stream_state` writer. | Only the VAL-118 evaluator may set `allowed`; Owner can set shadow or kill; a test greps for other writers (as CTX-072). | D-391: as stated. |
| Q12 | Intraday section outside hours and on non-trading days. | Show the previous trading day's candidates with outcome (spec); on a weekend show Friday's. | D-392: as spec. |
| Q13 | Family badge for a V1 pick whose family is F1-F6 and the intraday accent for candidates; F7 has no V1 picks. | One shared module with the 8 labels, colours and marks; contrast checked per theme. Where UXR palette work (AT-66) already defines categorical colours, reuse them. | D-393: single colour map module `src/lib/ui/familyBadge.ts` (name proposed). |
| Q14 | Is the alert cleared when the pick is filled in the simulated book? | Spec: alerts exist while the pick is "unfilled in the book". When the book fills at the open the alert clears with reason `left_list`? No such reason fits. Add the reason `filled` (in-app only, no e-mail) since the pick can no longer be an unfilled idea. | D-394: add reason code `filled`; flagged as an addition to ARN-114's list in the PR. |
| Q15 | A pick armed on D+1 where the open already is above the limit: is that `above_chase_cap` only beyond `chase_cap_pct`, and between limit and cap simply "waiting"? | Yes (spec: only beyond the cap clears; within it the alert stays armed). | D-395: as spec. |
| Q16 | Does the monthly alert report need data before there is any? | Renders with "No data yet" states; descriptive only. | D-396: as stated. |

## Recommended work packages

Small packages; Sonnet builds. A Fable reviewer checks the risky ones, marked **R**. Order: WP1 and WP2 first (can run in parallel), then WP3 and WP4, then WP5 to WP8, then WP9 and WP10.

| WP | Content | Depends | Tests / evidence | Review |
|---|---|---|---|---|
| WP1 Quote source and cache | Delayed-quote fetcher (batched, shared cache per refresh, "Prices paused" on failure), source-register row, request counter and budget, fixture generator (synthetic ZZ sessions), `recorded` contract test; Q1/Q2 decisions. | none | Recorded-response contract test; counter tests; licence-register check green; Blueprint model updated. | **R (data licensing, free-quota risk)** |
| WP2 Schema and keys | Migration `0020_intraday.sql` (`pick_alert` append-only, `intraday_candidate`, source row), `schema.ts`, all new config keys with ranges and verify text, widened `picks_max_per_family`, preference fields, config reference regenerated. | none | Migration tests; trigger tests; key tests. | light |
| WP3 Alert state machine | Pure `evaluateAlert`, arming from the `armableOrders` adapter after the 09:55 re-check, poll route (signed), clear reasons including `filled`, no re-arm, record writes, no effect on books. | WP1, WP2 | AT-60 (a)(c)(e). | **R (alert delivery and "touches orders" boundary: confirm nothing writes `arena_order`, `fill`, `cash_ledger`)** |
| WP4 Pick e-mails | EML-038/039/040 templates, kinds in `keys.ts`, own daily cap and 5-min batching, suppressed list, quiet-hours digest, staging no-send, Evening Review lines (EML-042). | WP2 | AT-62 (c)(d)(e); AT-60 (b). | **R (alert delivery: no duplicates, cap, P0 priority intact)** |
| WP5 Scan route and candidate rule | `/api/internal/intraday-scan`, universe reader (DAT-239), `isCandidate`, gates (reuse Cortex gates), indicative levels, idempotent slot record, narrowing at 80 % and stop at 95 %, Sentinel join, Worker route slots (arm, poll, scan, measure). | WP1, WP2 | AT-61 (a)(b)(c). | **R (budget and scheduler; touches Worker clock)** |
| WP6 Cortex hand-over | Candidate codes as extra input to `night.ts`; outcome write-back; byte-identity when empty. | WP5 | AT-61 (d)(e); AT-32 replay unchanged. | **R (touches the decision path that orders come from)** |
| WP7 Confidence, order, badge logic | `chanceDisplay` (status + slope key 1.0), sort and toggle, UNRATED for candidates, concentration line, 10-pick count and floor (Q3), family badge module and phrase table, "i" sheet content. | WP2 | AT-64 (a)(b)(c), AT-65 (c)(d). | light (Q3 is an Owner-visible change to the V1 list: Fable checks that V1 generation tests still pass) |
| WP8 UI sections | Picks and Home two sections, stamps and chips, intraday tiles, company page header, My alerts page, Settings -> Alerts, Home rows, masking. | WP3, WP5, WP7 | AT-62 (a)(b); AT-65 (a)(b); e2e theme walk. | light |
| WP9 Measurement and ledger | Nightly measurement fields (EOD batch), lineage row with pre-registered hypothesis, VAL-118 evaluator (sole writer of `intraday_stream_state`), VAL-119 monthly report, threshold-monitor series. | WP5 | AT-63. | light |
| WP10 Exit | Blueprint model update (routes, slots, tables, host), SEC-114 grep test (no broker links), NFR-041 wording check, full AT-60 to AT-65 run, `docs/M17_design.md` decisions D-381 onward, `docs/M17_exit_evidence.md`, BUILD_SETUP section 9. | all | Full gate; remote CI green. | final Fable review |
