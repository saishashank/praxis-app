# Chapter 02 — Platform, Hosting, Scheduling, Data Store & Authentication  (v2.0, session 10)

_Requirement-level only; no code. Facts marked (V) were read from provider documentation in session 3; (T) from third-party sources; all limits are **[VERIFY at build]** and MUST live in configuration._

## 2.1 Hosting and source control
- **PLT-001** The web app MUST be hosted on **Vercel's Hobby plan** (free, personal/non-commercial use only) (V).
- **PLT-002** Source code MUST live in a **public GitHub repository owned by the Owner's personal account** (O-29), with a separate **private** data repository (PLT-022a). (Vercel Hobby cannot connect repositories owned by a GitHub organisation (V).)
- **PLT-003** The app SHOULD be a TypeScript full-stack web application on a framework Vercel supports natively (recommended: Next.js App Router). It MUST be fully usable on a phone browser.
- **PLT-004** The app MUST be served only on the Vercel-provided `*.vercel.app` address. No custom domain and no DNS records MUST be created [OWNER]. Pages MUST be marked non-indexable. (The address still resolves publicly; protection comes from authentication, PLT-030+.)
- **PLT-005** Vercel Hobby allows 100 deployments/day and pauses features for 30 days if free usage is exceeded (V). Agent outputs, data updates and documents MUST NOT trigger redeployments; they are written to the database (runtime) and archived to git (backup) only.
- **PLT-006 (s10)** Preview deployments MUST be disabled on **both** Vercel projects (the code repo is public, so previews of forks or branches and the Vercel bot's preview URLs in public PR comments are not allowed); staging is deployed only by the `deploy-staging` job and production only by the approved `deploy-production` job (git auto-deploy off on both); GitHub environments have no public environment URL.

## 2.2 What "24x7" means [PROPOSED — owner to confirm]
- **PLT-010** ASX company announcements are published on the ASX Market Announcements Platform between **07:00 and 19:30 Australia/Sydney time** (V, ASX Guidance Note 14); trading is 10:00–16:00. Therefore:
  - The **Sentinel** (news/announcement monitor) MUST poll at a high cadence (per-source intervals: ASX every 4 minutes per the DAT-122 slot schedule, other sources every 1–2 minutes) during 07:00–19:30 on ASX business days, and at a low cadence (e.g. every 15–30 minutes) overnight and on weekends/holidays for global, macro and commodity news.
  - **Heavy analysis** (data refresh, simulations, backtests, learning) MUST run off-hours (target: after 16:30 and overnight).
- **PLT-011** Vercel Cron MUST NOT be relied on for any time-sensitive job: on Hobby it runs at most once per day and fires **anywhere within the configured UTC hour** [VERIFY], and faster schedules fail deployment (V). It MAY be used only for a low-priority daily housekeeping/heartbeat. Owner-facing wording for the two heartbeats: "00:xx UTC = 10:00–10:59 AEST / 11:00–11:59 AEDT" and "11:xx UTC = 21:00–21:59 AEST / 22:00–22:59 AEDT".

## 2.3 Schedulers (free, external to Vercel)
| ID | Requirement |
|---|---|
| PLT-012 | The **Sentinel poller and master clock** MUST run as a **Cloudflare Worker with Cron Triggers** under the limits and rules of PLT-070/071/075 (Workers Free, 2026-09 [VERIFY]: 10 ms CPU per invocation, 5 cron triggers **per account** (production and staging are separate Cloudflare accounts, O-32 **(s11)**, so each has its own budget), 50 subrequests per invocation, 100,000 requests/day, no automatic retries). It MUST only fetch/normalise/enqueue, and hand parsing or LLM work to a Vercel route or the next batch. **(s11)** Parsing routes invoked by the Worker MUST finish within the Vercel Hobby function timeout [VERIFY at build]; on timeout the route logs failure and the Worker defers the item to the next tick, with a maximum of 3 attempts before an in-app notice is raised. |
| PLT-013 | **Batch jobs** (data refresh, indicator/pattern computation, portfolio steps, backtests, research, learning loop, backups, digest assembly) MUST run as **GitHub Actions workflows** in the public code repo (dispatched by the Worker, PLT-071; minutes per PLT-014). Constraints: 5-minute minimum interval, frequent 5–30 minute start delays, no SLA (T); standard-runner minutes are free on the public code repo (PLT-014); a private repo on the Free plan would have 2,000 minutes/month (V). |
| PLT-014 | _(s10, O-29)_ **Actions minutes:** the code repo is **public**, so GitHub-hosted standard runners are free with no monthly minute stop [V]; the private data repo runs **no** workflows. The system still meters usage (self-counted from run records, labelled estimate) and keeps a self-imposed **soft ceiling of 3,000 minutes/month** (alert at 70%/90%) so jobs stay fast and within fair use. Workflows MUST use Linux standard runners. |
| PLT-014a | _(s9/s10)_ **Minutes table (information).** The build agent publishes a per-job table (billed minutes per run × runs per month, per market, plus staging and CI) on the Usage page and in docs/. **(s11)** Structure: per market **two dispatched workflows per trading night** (batch 1 at 17:30; batches 2–3 and the LLM/Critic steps back-to-back from ≈ 18:15); light tasks (email send, late sweep, pre-open re-check, heartbeat checks, ASX fetching) run as **Vercel routes invoked by the Worker or Vercel Cron**; **one** YAML watchdog workflow at 20:40 and 21:50 Melbourne (dual UTC triggers). Indicative: ≈ 1,130 minutes/month for AU (incl. CI), ≈ +450 per further market with **weekly** replays for every market — ≈ 2,000 for three markets, inside the soft ceiling. No cut set is needed while the code repo is public; if it were made private again the 2,000-minute private allowance would apply and the Owner must re-plan (O-29). **(s13)** The minutes projection MUST be re-measured at M4 including AGT-112 and UXN-272 nightly work if accepted; if AU exceeds 1,400 minutes/month, `overview_max_per_night` is reduced first. |
| PLT-015 | _(s10)_ In a **public** repo GitHub **disables scheduled workflows after 60 days without repository activity** (V). Therefore: Worker-dispatched workflows (batches, replays, backups) have **no `schedule:` trigger** (`workflow_dispatch` only); the YAML backup-trigger and watchdog workflows are the only scheduled ones; the Worker checks their state daily (token b, actions read/write), **re-enables** any that GitHub disabled and raises an in-app notice each time; stale or missing jobs are still detected by PLT-017. [VERIFY that dispatch-only workflows are unaffected] |
| PLT-016 | Every job MUST be **idempotent** (safe to run twice), **short** (respect platform time limits), and MUST support **catch-up** of missed periods. |
| PLT-017 | Every scheduled run MUST write a run record: job name, scheduled time, start/end, status, items processed, duration, token usage, error summary. The dashboard MUST show each job's last success and flag any job older than 2× its expected interval. |
| PLT-018 | Because Cloudflare Cron has no retries/alerts, the Sentinel MUST implement its own retry with backoff and a "Sentinel blind" alert (email via Chapter 04) when no successful poll occurs for 15 minutes during MAP hours. |
| PLT-019 | Cron schedules are expressed in UTC; the builder MUST convert Australia/Melbourne local times correctly across daylight-saving changes (e.g. run the digest job at two UTC times and have the job itself no-op unless it is the correct local time). The guard MUST use **which trigger fired** (`github.event.schedule`) together with the current Melbourne UTC offset — never the wall-clock time at start, because scheduled runs start 5–30 min late. |

## 2.4 Data store
- **PLT-020** One **free managed database** MUST hold application state, run logs, alerts, portfolios, trades, documents and market data aggregates. **Primary choice: Turso (SQLite/libSQL)** — free tier (turso.tech/pricing, checked 2026-09-24): 5 GB storage, 500M rows read and 10M rows written per month, 1-day point-in-time restore (V). Backtests MUST NOT read history from Turso row-by-row (DAT-140). **Alternative:** none currently meets all criteria below (Neon's free storage is below 1 GB) [VERIFY at build]. Selection criteria for the builder: free without a card; no auto-pause/deletion; ≥ 1 GB; supports the app's access pattern; supports export.
- **PLT-021** Storage MUST stay ≤ 60% of the free allowance; the design MUST include retention/compaction rules (Chapter 06).
- **PLT-022a (s9)** Backups and `knowledge/` archives MUST go to a **separate private data repository** (`<repo>-data`), never to the code repository, so they never trigger deployments; the Vercel project also uses an Ignored Build Step and code-repo workflows use `paths-ignore` for `docs/**`.
- **PLT-022b (s9)** Backups MUST be encrypted (e.g. `age`) to a public key (stored in the GitHub environment `production` and in the production Vercel env for the auth-DB export); the **private key is never stored on GitHub** except as a temporary secret during a restore or drill (then deleted, TST-108). Encrypted backups are stored as release assets of the data repo (not commits), retained 14 daily / 8 weekly / 12 monthly. Each month the Owner downloads the latest encrypted backup and history files to storage outside GitHub (OPS-020). Personal data in backups follows NFR-030 (identity fields of users revoked > 90 days are hashed).
- **PLT-022** The system MUST run a **nightly export/backup** of critical tables and all documents to the private data repository (PLT-022a) so the database can be rebuilt if the free tier changes or is lost. Restore MUST be documented and tested.
- **PLT-023** All timestamps MUST be stored in UTC and displayed in Australia/Melbourne.

## 2.5 Authentication and authorisation (allowlist and roles — see ROL-101…107, Ch. 10)
| ID | Requirement |
|---|---|
| PLT-030 | _(Superseded in part s9 by ROL-101…106, Ch. 10: an allowlist of Google emails with Owner/Editor/Viewer roles replaces "single owner"; the rest of this row still applies.)_ Sign-in MUST use **Google OAuth**. Only the **single owner email address** stored in configuration MAY sign in; the Google account's email MUST be verified. Every other account MUST be rejected **server-side**. No sign-up, invitation, or password flows. |
| PLT-031 | **Every** page, API route, server action and data endpoint MUST require a valid session of an **allowlisted user whose role permits the action** (ROL-101/102a). The only unauthenticated surfaces are the sign-in page and a minimal, non-informative liveness response. |
| PLT-032 | Machine-to-machine calls (Cloudflare Worker → app/DB, GitHub Actions → app/DB) MUST use secrets: separate secret per caller, constant-time comparison, rotation procedure documented, rate-limited. Secrets MUST NOT be usable from a browser. |
| PLT-033 | Sessions MUST be HttpOnly, Secure, SameSite cookies with a bounded lifetime (default 14 days) and a sign-out action. |
| PLT-034 | Enabling Vercel's free "Vercel Authentication" as an extra gate is OPTIONAL (it requires a Vercel account sign-in, not Gmail (V)). |
| PLT-035 | _(s9)_ The Google OAuth consent screen is set to **In production** with only the basic scopes `openid email profile` (no Google verification needed for these [VERIFY]); access control is the server-side allowlist (ROL-101). **(s11)** Redirect URIs MUST be exactly `https://<production host>/api/auth/callback/google` and the staging equivalent, registered in the Google Cloud console and verified distinct in the M0 smoke test. **(s11)** The Owner's Google account MUST have 2-step verification and offline backup codes enabled; a break-glass recovery email address (`OWNER_RECOVERY_EMAIL`, stored only in environment secrets) is allowlisted but disabled in authentication code until explicitly enabled via the OPS-040a recovery procedure; every sign-in using it MUST send a notification email to the Owner and write an audit event. **(s13)** `<production host>` = the Vercel production project's assigned domain, recorded in the M0 checklist and in `APP_BASE_URL`; the staging host is the staging project's domain, recorded separately. |
| PLT-036 | No third-party analytics, ad or tracking scripts. `robots` directives MUST disallow indexing. |

## 2.6 Secrets and configuration
- **PLT-040** Secrets MUST live only in the platform secret stores (Vercel environment variables, **GitHub environment secrets** — never repository-level secrets, SEC-108 a — and Cloudflare secrets). They MUST NOT appear in the repository, markdown files, logs, emails, screenshots or client-side bundles.
- **PLT-041** Tunable values (free-tier limits, model IDs, budgets, schedules, cost profiles, thresholds) MUST live in versioned configuration, changeable without code changes where practical.
- **PLT-042** A CI check SHOULD scan commits for secret patterns.

## 2.7 Free-tier guardrails
- **PLT-050** The system MUST meter usage against each free allowance: Vercel (invocations, active CPU), GitHub Actions minutes, database storage/reads/writes, Cloudflare requests, each LLM provider's requests/tokens, Resend emails. A **Usage page** MUST show current/limit/percentage. Where no read-only usage credential is held, the figure is **self-counted** by the system from its own run records and labelled "estimate" (the Owner can compare it with the provider dashboard during the monthly $0 check).
- **PLT-051** Thresholds are measured **per quota period** (monthly quotas: Actions, Turso, Vercel, Resend monthly; daily quotas: LLM, Resend daily, Worker requests). For **monthly** quotas: 70% → notice in the daily email; 90% → alert email and reduce non-essential work; 95% → **degrade mode**. A **daily** quota reaching its limit only switches that provider to fallback/rules-only until its reset (no global degrade mode) (pause non-essential jobs; LLM rules-only; keep Sentinel and digest alive). The self-imposed Actions soft ceiling (PLT-014) only **warns**; it never triggers degrade mode.
- **PLT-052** If any provider changes or removes a free tier, the system MUST continue in degrade mode and tell the owner.

## 2.8 Observability
- **PLT-060** Vercel runtime logs are kept only 1 hour on Hobby (V), so the app MUST keep its own structured logs (job runs, errors, provider calls, decisions) in the database with 30-day retention.
- **PLT-061** A **System Health page** MUST show: job freshness, Sentinel last poll, data freshness (last bar date per feed), LLM provider status, quota usage, last backup, last email. **(s13)** After every production deploy a post-deploy smoke check (sign-in page, health route, one DB read) MUST run within 10 minutes; failure raises an S1 incident whose email includes the OPS-042 rollback steps.

## 2.9 Accounts the owner will need (summary — the full M0 checklist is BLD-010, Ch. 12)
| Account | Purpose | Status |
|---|---|---|
| GitHub (personal account): public code repo + private data repo | Code and Actions (public); knowledge archive, backups, fixtures (private) | Have |
| Vercel (Hobby) | Hosting | Have |
| Resend (free) | Daily email | Have (confirm account email, Q-034) |
| Cloudflare (free) | Sentinel worker cron, optional Workers AI | To create |
| Turso | Database (production + staging) | To create |
| Google Cloud project (OAuth client) | Gmail sign-in | To create |
| Google AI Studio | Free Gemini API key | To create |
| Groq | Free LLM API key | To create |
| OpenRouter | Free-model API key | To create |
| Data provider accounts | Chapter 06 | TBD |
All accounts MUST be created **without a payment card** (PRD-007).

## 2.10 Worker limits, master clock, languages and canonical timeline (moved from Ch. 13, s9)
- **PLT-070 Sentinel on Cloudflare Workers Free.** Limits (2026-09, [VERIFY]): 10 ms CPU per invocation (network wait excluded), 5 cron triggers per account, 50 subrequests per invocation, 100,000 requests/day. The Worker only fetches small feeds (RSS/JSON) with conditional requests, de-duplicates by hash, writes new items, and hands parsing/LLM work to a Vercel API route or the next batch. It never parses PDFs or large HTML.
- **PLT-071 One master clock.** The Worker's per-minute cron is the master clock: at configured local times it triggers GitHub Actions via `workflow_dispatch` **with `ref: release`** (fine-grained token stored as a Worker secret). The repository's **default branch is `release`**, so YAML `schedule:` backups also run released code; every production workflow's first step exits unless the checked-out ref is `release` (SEC-108 b). YAML `schedule:` triggers are a backup (one UTC time per workflow; late in one DST season is acceptable for a backup). A 19:50 check raises an in-app incident if the nightly completion marker is missing (channels: NFR-006). (Scheduled Actions start 5–30 min late and there are unconfirmed 2026 reports of `schedule` not firing reliably; public repos also disable schedules after 60 idle days, PLT-015.)
- **PLT-072 Languages.** Web app: TypeScript on Next.js. Batch/backtest jobs in Actions MAY be Python. No separate Express server.
- **PLT-073 (s9) Canonical AU trading-day timeline** (Australia/Melbourne; Sydney shares the clock; each step's deadline is the next step's start): **(s13)** On ASX early-close days the fixed evening times (18:10 cut-off, batches, 20:00 email) are unchanged; only the session close comes from the calendar. Each market's nightly batches run on that market's own schedule (DAT-010); the 20:00 Evening Review reports each active market's latest completed block and never waits for a later market; AU times do not change when IN/US are added. The 19:35 late sweep is started by the Worker and MUST finish before the 19:45 completion marker.

| Time | Step | Content |
|---|---|---|
| 07:00–19:30 | Sentinel | High-cadence polling; items after the cut-off are D+1 inputs |
| 09:55 | Pre-open re-check | ARN-020a (Worker → signed Vercel route) |
| 10:00–10:59 AEST / 11:00–11:59 AEDT (Vercel Cron 00:xx UTC) | Morning heartbeat | PLT-074: Worker last poll fresh? |
| ≈ 16:10 | Market closed | After closing auction [VERIFY] |
| _Times in this table are start times for dispatched items and **deadlines** for steps that run back-to-back inside a workflow._ | | |
| 17:30 | Batch 1 — data | DAT-020 stages 1–9 → data completion marker |
| 18:10 | **Decision cut-off**; Batch 2 — books then decisions | ARN-060 close the books (D's fills, stops, corporate actions, dividends, financing, mark-to-market, invariants, cohort/sleeve checks) → A2–A4 → A5 signals, Decision Cards, next-open orders |
| 18:40 | Batch 3 — learning (deterministic) | A6 attribution, comparisons, controls, lesson candidates |
| (≤ 19:10) | LLM wording + Critic | A6 wording, A7 checks and concerns, A8 assembly — runs **back-to-back inside workflow 2** after batch 3 |
| 19:35 | Late sweep | Announcements after the cut-off, stored for D+1 |
| 19:45 | Completion marker | Watchdog checks at 19:50 (in-app incident if missing) |
| 20:00–20:45 | Email job | Evening Review (partial decision at 20:30) |
| 20:40 | YAML watchdog | sends the review itself if none was sent (NFR-006) |
| 21:00–21:59 AEST / 22:00–22:59 AEDT (Vercel Cron 11:xx UTC) | Independent heartbeat | PLT-074 |

  Non-trading days: reduced pipeline and `non-trading` marker (DAT-022). IN and US steps follow DAT-010 and appear in the next 20:00 review.
- **PLT-074 (s9) Independent heartbeat.** Outside the Worker: two daily **Vercel Cron** checks (Hobby-permitted; configured as the 00:xx and 11:xx UTC hours — wording per PLT-011: the morning check tests the Worker's last successful poll; the evening check tests the Worker's last poll, today's completion marker and email record (email checks skipped for markets in data-only mode), local-date aware) and the single YAML watchdog (20:40, 21:50; ~1 billed min per run) each email an incident when something is missing, and the watchdog run **fails on purpose** so GitHub's own failure email reaches the Owner even if Resend is down (NFR-006). Heartbeat routes are GET (Vercel Cron) authenticated with `CRON_SECRET`, idempotent, and **no-op outside the production environment** (staging never raises heartbeat incidents). Token expiry dates per SEC-017; warnings at 14/7/2 days; a 401/403 from a provider raises an immediate incident.
- **PLT-075 (s9) Worker batching.** Each invocation processes ≤ 40 new items (rest carried over), writes to Turso in one batched request, keeps per-minute state in the database (never Workers KV), and respects the shared ASX rate token (DAT-122).
- **PLT-076 (s9) Idempotent dispatch.** Every workflow declares a concurrency key (job, market, local date) without cancelling in-progress runs, and exits in its first step if a success run record already exists for that key.

## Acceptance criteria — Chapter 02
- **Given** a Google account that is not on the allowlist, **when** it signs in, **then** access is denied and nothing about the system is revealed.
- **Given** no session, **when** any API route or page (other than sign-in/liveness) is requested, **then** it is refused.
- **Given** seven consecutive days, **when** job records are inspected, **then** the Sentinel met NFR-002 per source (≥ 98% of each source's scheduled polls in announcement hours), and batch jobs ran nightly.
- **Given** Actions usage passes 70% of the budget, **when** the next digest is sent, **then** it contains a usage warning.
- **Given** the database is wiped in a test, **when** the documented restore is followed, **then** documents, portfolios and trades are recovered from the backup.
- **Given** a search engine or unauthenticated crawler, **when** it fetches any page, **then** it receives no content and no index permission.
