# Chapter 14 — System Acceptance Suite (go-live and market activation)  (v2.0, session 10)

_New chapter. The system is "done" for AU go-live when AT-01…AT-31 pass, each in the home environment named by **TST-115** (the single source), **before trading starts**. Tests marked **(Owner-executed)** need the Owner's hands (real Google accounts, Gmail inbox, sign-off); the build agent prepares a script for each, in addition to each chapter's own acceptance criteria. A market (IN, then US) is activated only after AT-M1…AT-M5 pass for it. Each test names the requirements it proves. Results are stored as a test report in the repo (BLD-040)._

## 14.1 Platform, auth, operations (M1)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-01 | Sign-in matrix (Owner-executed, with TST-113 test accounts) | Owner, Editor, Viewer sign in; non-allowlisted account refused with a neutral message; revoked user refused on next request; Google `sub` mismatch refused **(s13)** With no ROL-107 acknowledgement row, Add-user is disabled with the hint 'Acknowledge sharing first'. | ROL-101…104, SEC-010, SEC-105 |
| AT-02 | Role enforcement | Every action not allowed for a role in ROL-102a returns 403 for that role (automated with staging test identities); each refusal audit-logged; for masked users no code, company name, trade price, trade date, source link or name inside LLM text appears in any page or API response (UX-009) **(s13)** A masked user never sees execution IDs (E01–E12), family codes (F1–F6) or company identifiers in any page or API response. | ROL-102a, ROL-107, UX-004 |
| AT-03 | Secrets hygiene | CI smoke test stages 1–2 pass in production (TST-115); secret scan of full git history clean; no secret in logs, DB or client bundle | SEC-101…104, PLT-040 |
| AT-04 | Backup & restore | Nightly main-DB and auth-DB backups present (auth via the encrypted Vercel export); the build-phase drill (in-run throwaway key pair, fresh staging backups) restores them into two throwaway Turso databases (main and auth, both deleted afterwards) within 4 h with matching checksums; the drill fails while the temporary token (l) remains; the real-key drill with cohort replay is part of AT-30 | PLT-022, ROL-101a, TST-108, OPS-040 |
| AT-05 | Scheduling & heartbeat (M2) | With YAML schedules disabled, the Worker dispatches every nightly job on time for 3 consecutive days; duplicate dispatch is a no-op; ASX requests only on ASX slots ≥ 65 s apart; with the Worker stopped, the Vercel Cron heartbeat raises an incident and the YAML watchdog's deliberate failure produces a GitHub failure email in the Owner's inbox; heartbeats no-op on staging; an expired dispatch token raises an immediate incident; Worker dispatches use `ref: release`; DST cases pass; a scheduled workflow disabled by GitHub is re-enabled by the Worker with an in-app notice (PLT-015); the inbox check is Owner-executed (email fallback paths are tested in AT-20) | PLT-071, PLT-074, PLT-076, DAT-122, NFR-006, TST-103 |
| AT-05a | Deploy isolation & public-repo hygiene | A nightly archive/backup to the private data repo triggers no Vercel deployment and no code-repo workflow; the code repo contains no data-like files, email addresses or the Owner's name, fixture-test logs show only test ids and pass/fail, logs of a full nightly run contain no secret values, emails, prices, position/signal codes or third-party text, no Actions artifact or cache contains data, and a fork PR runs only synthetic tests with no secrets | PLT-005, PLT-022a, SEC-110 |
| AT-05b | Release control | A merge to `main` deploys only staging (app and Worker); production and deploy-production environment secrets are unavailable to jobs on any other branch; production deploys wait for the Owner's approval in GitHub; a merged but unapproved release runs nothing new in production jobs (they check out the last approved commit); the production Worker deploy job and every production workflow refuse any ref other than `release`; `release` is the default branch; a web-merged approved release (same tree, new commit id) passes the nightly check while an extra unapproved commit fails it (pre-registered test incident, OPS-045 not triggered); the production Vercel project builds no previews; the production auth-export route rejects any caller-supplied key; pushing an unapproved commit to `release` raises an S1 incident the same night **(s13)** With the GitHub API unreachable (mocked 503), the nightly deployed-commit check uses the DB-signed record (SEC-108 d) and raises an S1 incident on mismatch. | SEC-108, OPS-041 |

## 14.2 Data (M2)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-06 | Source evaluation | DAT-101 report exists for AU with pass/fail per source and the chosen primary; licence register populated | DAT-101, DAT-120 |
| AT-07 | Quality gates | Injected bad bars (high<close, zero price, 60% unexplained jump) are flagged; U1 score < 95% blocks new entries but not exits | DAT-200, DAT-210 |
| AT-08 | Corporate actions | Golden split, consolidation, dividend, rights issue and delisting produce no artificial P/L; unconfirmed action appears in review queue and blocks entries | DAT-220…223 |
| AT-09 | Point-in-time | Part A (staging): perturbing data after D leaves decisions up to D unchanged. Part B (production): universe snapshots stored daily since M2 start | DAT-001, DAT-130, TST-109 |

## 14.3 Simulator and Arena (M3)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-10 | Known answers | All TST-101 cases pass exactly | ARN-020…036, ARN-040…050 |
| AT-11 | Arena start & terminal states | 12 executions (6 twin pairs) and controls C1–C3 each start a cohort with A$600; golden paths reach each terminal state (target, bust, **stalled**, timeout) exactly as defined; twins restart together after a terminal close and a stalled twin's partner continues as a shadow **(s13)** Twin cohorts with different resolution dates and overlapping shadow cohorts: effective N (ARN-053) counts each non-overlapping cohort once and matches the fixture value. | ARN-001…004, ARN-052, ARN-053 |
| AT-12 | Ledger invariants | Property tests and a 3-year golden replay show no invariant violation | ARN-101, TST-104 |
| AT-13 | Reproducibility | Two replays with identical inputs produce byte-identical trade lists and NAV series | ARN-102, NFR-022 |

## 14.4 Agents and strategies (M4)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-14 | Rules-only mode | With every LLM disabled, a full night produces signals, orders, Decision Cards and review numbers | AGT-001, LLM-002 |
| AT-15 | Family rules | For each family, a golden scenario triggers exactly the expected entry and exit; regime gates behave per §7.4 | §7.4, AGT-101 |
| AT-16 | Decision Cards | 100% of orders have a card with thesis-breakers and a percentile scenario table; no LLM-produced number on any card | AGT-110, LLM-034 |
| AT-17 | Replay engine | **Engine checks (M4):** on synthetic data with a known injected edge the trade-level test detects it and on ≥ 2,000 null runs (random-signal nulls on real ASX data, reduced B) the rejection rates at 0.05 and 0.01 lie within 99% binomial acceptance bounds and the lower-tail p-values pass a uniformity check; the extrapolated size at α_i is reported (not a pass condition); windows with < 15 blocks return "insufficient independent blocks"; signal-ledger de-duplication, C2 exit mapping, CIFs (target/bust/stalled/timeout), effective N, ARN-081 circular block bootstrap with B = max(1,000, 20 ÷ smallest level tested) bootstrap replications, test-size check with random-signal nulls on real ASX data, one-open-row-per-code ledger rule, DSR, PBO (n/a below 5 variants), survivorship missing-share series, delisting sensitivity, minimum detectable effect, and a measured compute/minutes report within budget. **Evidence run (after the DAT-125 backfill):** every family gets a label (including "insufficient evidence" / NOT-DEMONSTRATED where applicable) with n and MDE — no particular label is required to pass | ARN-071, ARN-080…087, ARN-100, DAT-125, DAT-131 |

## 14.5 Sentinel, alerts, email (M5)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-18 | Sentinel cycle | **Part A (production data-only):** over 3 announcement-hour sessions each source meets NFR-002 (ASX: ≥ 98% of scheduled **4-minute** polls); ASX requests never closer than 65 s; Worker within CPU limit; new items stored once. **Part B (staging, recorded items):** a pending order whose pre-open re-check did not run by 10:00 fills flagged "not re-checked" | NFR-002, PLT-070, AGT-010, DAT-122, ARN-020a |
| AT-19 | Alert tiers | Halt of a held code → first P0 email within NFR-012 (≤ 5 min median non-ASX, ≤ 9 min median ASX); P1/P2 only in-app/digest; daily cap, reserved slots and batching respected | AGT-115, EML-004, EML-020, NFR-012 |
| AT-20 | Evening Review (inbox check Owner-executed) | On a trading day and on a non-trading day, exactly one review is sent 20:00–20:45 to the Owner only (trading day: all 10 sections), ≤ 90 KB, arrives in the Gmail inbox (not spam), stored in-app and in KB; a late pipeline yields a "partial" review; with the email route disabled the 20:40 watchdog sends a minimal review directly via Resend (production, one forced run in M5, TST-115); staging emails carry "[STAGING]" **(s13)** Size measured per EML-013 (HTML part bytes before transfer encoding). | EML-010…015, EML-035/036, DAT-022, ROL-105 |
| AT-20a **(s13)** | Morning Brief | Given the Morning Brief is enabled, at 08:00 Melbourne on a trading day of an active market exactly one Morning Brief is sent by 08:45; on a non-trading day none is sent; when disabled none is sent | EML-016 |
| AT-20b **(s13)** | Attention reminder | With a fixture that makes one component amber, one reminder is sent at 08:00 Melbourne (weekend day included) listing the item, days open, deadline and fix link; with all green none is sent; snooze suppresses it; a red item cannot be snoozed; never more than one per day | EML-023 |
| AT-21 | Kill switch | Turning the ASX source off stops requests within one cycle; review lists it | DAT-123, OPS-036 |

## 14.6 Learning and knowledge (M6)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-22 | Nightly loop | Attribution, comparisons, graded lessons and ≤ 5-item plan written before 19:45; Lane A changes logged; no rule changed by Lane A | ARN-060…069, KB-030/031 |
| AT-23 | Challenger lifecycle | A seeded challenger goes proposed → replay → shakedown → review; a failing VAL-110 component or deterministic Critic check blocks promotion; a passing one promotes only at a cohort boundary | KB-040…043, AGT-041/042 |
| AT-24 | KB archive | Every record of the day has a regenerated markdown document in the **private data repo** (never the code repo; no deployment triggered) | KB-001…003, PLT-022a |

## 14.7 UI (M7)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-25 | Page coverage | Every page of Ch. 09 renders with real staging data, empty states and stale banners **(s13)** Data older than 2× its expected interval shows a stale banner with the last good time, cleared after a fresh run (UX-007); executions with overlapping 90% intervals show as one tied group (ARN-078). **(s14)** The page list includes the accepted ch. 16 P1 pages (O-38): Picks (incl. track record), Market, company page and the Control Room, each meeting its ch. 16 acceptance criteria; picks never exceed `picks_max_per_family` per profile per night. | Ch. 09 |
| AT-26 | Mobile & a11y | 360 px width usable; WCAG 2.2 AA automated checks pass; Lighthouse ≥ 80 on Home (ex-Dashboard); **(s11)** Owner performs a manual keyboard + screen-reader check of the six main tabs (UXN-270, s14) at M8 | UX-001, UX-005 |
| AT-27 | Honesty labels | "Simulated", reality panels, validation labels and "not yet measured" appear where required; no uncalibrated probability anywhere; **(s11)** cites PRD-001/UX-042 to verify no screen or route can place a real order **(s13)** Coverage: Home, each Strategy page, Picks, Market company page, Reviews, Evening Review email and every API response carrying money; an automated check asserts every money/return/NAV element carries the Simulated label; probabilities without a VAL-101 calibration report show 'not yet calibrated'. | UX-002, UX-104, VAL-101, REV-003, PRD-001, UX-042 |

## 14.8 Go-live (M8)
| ID | Test | Pass condition | Proves |
|---|---|---|---|
| AT-28 | Staging E2E day | One full trading day on staging meets every PLT-073 deadline; **(s11)** includes at least one first-trading-day (cold start, empty DB) run | TST-106 |
| AT-29 | Security baseline | ZAP baseline no high findings; headers present; dependency audit no high/critical unfixed | SEC-010…014, SEC-104 |
| AT-30 | Owner sign-off (Owner-executed) | Every production token rotated and the build-agent PAT revoked/expired (SEC-108 c); first real-key restore drill with cohort replay passes (TST-108); Owner walkthrough of Home, Picks, Market, Strategies, News, Reviews and the gear-menu pages (s14); $0 confirmed on every provider; sign-off recorded in decision log | PRD-007, BLD-030 |

## 14.9 Market activation (per market: India M9, USA M10)
| ID | Test | Pass condition |
|---|---|---|
| AT-M0 | Gate | MKT-105 met for the previous market and the Owner approved starting this market (work status `in build`) |
| AT-M1 | Sources | DAT-101 report and licence register for the market; exchange-site access decided (DAT-121); market profile DAT-010 complete |
| AT-M2 | Calendar & time | Market calendar loaded; DST/holiday tests for its jobs pass; results appear in the next 20:00 Melbourne review |
| AT-M3 | Costs | Market cost profile known-answer tests pass (DAT-010) |
| AT-M4 | Quality & replay | Five consecutive days of quality verdicts; rolling-start replay runs for all families on the market; **(s11)** pass criterion = replay completes without error for every family and every label is computed or shows its "not reachable" reason |
| AT-M5 | Isolation | The market's arena, ledgers and labels never mix with other markets; `testing` → `active` switch starts cohorts next trading day |
| AT-31 **(s13)** | Test-suite completeness | Test map shows every MUST (ch. 01–12) and accepted ch. 16 P1 item covered or Owner-executed; route list = tested-route list; a deliberately untested change in a sample PR fails the diff-coverage gate; nightly full suite (E2E, visual, email, jobs, Worker) green; mutation score ≥ 80% on money/statistics modules | TST-120…133 |

## Acceptance criteria — Chapter 14
- **Given** a go-live request, **when** any AT-01…AT-31 is failing, **then** production go-live does not proceed.
- **Given** a market activation, **when** any AT-M test fails for it, **then** the activation switch stays disabled.
