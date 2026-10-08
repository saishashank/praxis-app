# Chapter 12 — Build Plan, Milestones and Hand-off  (v2.1, session 10)

_Replaces the imported draft v0.3 and `docs/project_imports/claude-code-handoff.md`. Milestones end with **exit tests**, not dates; durations are estimates only. Requirements only — no code._

## 12.1 How the build agent works
- **BLD-001** Read spec/00 first (precedence §0), then chapters 01–12, 14 and 15 in order. Chapter 13 is history and errata only.
- **BLD-001a (s9)** Text marked superseded or amended is void even where a row says "the rest still applies" for other parts; when in doubt the requirement's home chapter and the newest (s9) wording win.
- **BLD-002** Cite requirement IDs in every commit, test name and status report. Never renumber; mark superseded items instead.
- **BLD-003** When the spec is silent, choose the simplest option that satisfies $0, privacy and the roles model, record it in `docs/07_decision_log.md`, and continue. Questions for the Owner go into `docs/06_open_questions.md` with a recommended default; the agent continues with the default unless the item is marked blocking.
- **BLD-004** Values marked [VERIFY at build] are checked against live provider documentation and stored in configuration with a "last verified" date.
- **BLD-005** No paid endpoint, no payment card, no secret in chat (PRD-007, SEC-101).
- **BLD-006** Progress is reported only by the build digest (OPS-101) and milestone exit-test results — not by estimated percentages.

## 12.2 Owner prerequisites (milestone M0)
- **BLD-010 (s9) Owner checklist (M0).** The build agent turns this table into a step-by-step guide with exact screens. **The Owner never pastes a secret anywhere except the store named in the row.** No payment card anywhere (PRD-007).

| # | Item | Where | Stored as / in | Notes |
|---|---|---|---|---|
| 1 | **Public code** repo + **private data** repo (`<repo>-data`) + **private fixtures** repo (`<repo>-fixtures`); on the code repo branch protection with "Do not allow bypassing the above settings" and environments with "Prevent self-review" off; on the code repo: Issues/Discussions/Wiki/Projects off, "require approval for all external contributors" for workflows, secret scanning + push protection on, commit email set to the GitHub noreply address; environments `production` (branch `release`), `staging` (`main`), `ci-fixtures` (this repo's branches only), `deploy-production` (branch `release`, required reviewer = Owner), `deploy-staging` (`main`); branch protection on `main` and `release` (PR, required checks, no force-push/deletion); **no repository-level secrets** | GitHub (personal account) | — | O-29, SEC-108, SEC-110 |
| 2 | **Bot (machine) account** for the build agent (O-30): created by the Owner (separate email, two-step verification), invited to the **code repo only** as a Write collaborator, classic token with `repo` + `workflow` scopes, expiry ≤ 90 d. The build agent gives the Owner these instructions as a **separate step** when the build starts (alongside the other resource requests), not bundled into other rows | GitHub (bot account) → Settings → Developer settings → Tokens (classic) | given to the build agent's own secure config, never chat | SEC-102, SEC-017 (a) |
| 3 | Worker dispatch tokens — production (b) and staging (b-s), separate values (fine-grained, code repo only, Actions read/write, expiry ≤ 1 year) — **created in M0, entered in M1** right after the first CI deploy of the Worker, via the guide's "Worker secrets" step (with each Worker's copies of c2 and d for its environment) | GitHub | Cloudflare Worker secret | SEC-017 (b) |
| 4 | Data-repo token (fine-grained, data repo only, Contents read/write, expiry ≤ 1 year) | GitHub | GitHub environment `production`; plus a private **fixtures repo** (`<repo>-fixtures`) and its **read-only** token (f-r) in `staging` and `ci-fixtures` | SEC-017 (f, f-r); build-agent PAT must not reach the data repo |
| 5 | Vercel **production** project + **staging** project, linked to the code repo with git auto-deploy and previews **off** on both (deploys only via `deploy-*` jobs, PLT-006) | Vercel | — | Hobby, personal use |
| 6 | Turso production + staging **main** DBs (tokens per caller → Vercel env, GitHub environment and Worker secret of the same environment) and production + staging **auth** DBs (token → **Vercel env of the matching project only**, ROL-101a) | Turso | as listed | SEC-017 (d), (e) |
| 7 | **Cloudflare:** separate free account for staging (with its own API token scoped to that account), plus production Cloudflare account with its own API token; both tokens limited to "Edit Cloudflare Workers" **(s11)** | Cloudflare (2 accounts) | Production token → GitHub environment `deploy-production`; staging token → GitHub environment `deploy-staging`; plus a Vercel deploy token (n) in `deploy-production` only **(s11)** | SEC-017 (g, n); O-32 **(s11)** |
| 8 | Resend account **registered with the Owner's Gmail address** (the `OWNER_EMAIL` value) + one sending-only API key per environment; `OWNER_EMAIL` environment variable | Resend | Vercel env + GitHub environment of the same name | EML-003a, EML-004/005 |
| 9 | Gmail filter: from the Resend test sender → never spam, label "Investment AI" | Gmail | — | EML-036 |
| 10 | **Two** Google OAuth clients (web) — production and staging, each with its own redirect URI; consent screen **In production** with scopes openid/email/profile | Google Cloud | Vercel env of each environment | PLT-035, SEC-017 (j) |
| 11 | Per environment: session secret and `CRON_SECRET` (Vercel only), Worker→Vercel and Actions→Vercel HMAC secrets (separate values per environment), staging test-identity signing secret (staging Vercel only); backup key pair | generated by the Owner on their own computer following the guide's tested per-OS steps (macOS/Windows; official checksummed `age` download) | stores per the SEC-017 table; **backup public key** in GitHub environment `production` and production Vercel env; backup **private key kept offline** (paper copy + USB stick, not on a drive tied to the sign-in Google account); the Owner completes the guide's offline encrypt/decrypt test with the real key pair | SEC-017, PLT-022b, TST-108 |
| 12 | Free LLM keys: Google AI Studio, Groq, OpenRouter | provider sites | GitHub environment `production` + Vercel env | Ch. 03 |
| 13 | 2-step verification on Google, GitHub, Vercel, Cloudflare, Turso, Resend, Google Cloud, LLM providers | each site | — | SEC-020 |
| 13a | **Owner Google account recovery (O-33 **(s11)**):** the Owner's personal Google account MUST have 2-step verification and offline backup codes; a break-glass recovery email address is stored in `OWNER_RECOVERY_EMAIL` environment secret and allowlisted in authentication code but disabled until explicitly enabled by the documented OPS-040a recovery procedure; every successful sign-in using it MUST email the Owner and write an audit event **(s11)** | Google + GitHub/Vercel env | `OWNER_RECOVERY_EMAIL` in GitHub environment `production` and Vercel env | O-33 **(s11)**, PLT-035 **(s13)** Record that the Google backup codes are stored offline and were tested once; all accounts keep Google sign-in (O-38, accepted risk). |
| 14 | Three Google test accounts (Editor, Viewer, non-allowlisted) | Google | — | TST-113 |
| 15 | ASX confirmation request sent | email | — | not blocking (DAT-122) |
| 16 | Vercel settings: production **git auto-deploy off** (production is deployed only by the approved `deploy-production` job, SEC-108 c); Git fork protection on; Standard Deployment Protection on; production secrets scoped to Production only; **preview deployments disabled on the production project** (Ignored Build Step for any ref other than `release`); `release` set as the GitHub default branch (PLT-071) | Vercel | — | SEC-108 (e) |
| 16b | GitHub read token (m) for release detection (fine-grained, code repo only, contents, actions and deployments read, ≤ 1 year) → production Vercel env; Vercel production-deployment notification emails on [VERIFY on Hobby] | GitHub, Vercel | Vercel env | SEC-017 (m), SEC-108 b |
| 16a | GitHub notification settings: Actions failure emails on, sent to the Owner's Gmail address (the second alert channel, NFR-006); the Owner runs the prepared "deliberately failing" workflow and confirms the email arrives in the Gmail inbox | GitHub | — | NFR-006 |
| 17 | `release` branch created (default branch); production is deployed only from `release` after the Owner approves the deployment in GitHub | GitHub + Vercel | — | SEC-108 |
| 18 | Owner reads and ticks: merging a release and approving its deployment are done in one sitting (SEC-108 c); the trust statement (SEC-108, including that the code repo is **public** — code, workflow files and run logs visible to anyone (SEC-110) — and that any build-agent PAT has access equivalent to the `production` environment secrets while valid, and that during build-phase drills the temporary Turso token (l) is present alongside the PAT), the risk acceptances and their consequences (O-23 ASX, O-26 Yahoo → DAT-127 source-off modes; possible provider account suspension), and the minutes projection (PLT-014a) including the soft ceiling of PLT-014 | in-app/guide | decision log | informed consent |
| 19 **(s13)** | **Claude Code plugins and MCP servers installed on the build machine** per `Requirement/PLUGINS.md` (core P1–P9, design add-ons P10–P11; P12 optional). Vercel MCP limited to docs/read-only tools and Cloudflare MCP to the staging account; versions recorded in BUILD_SETUP §9 | build machine (Claude Code) | Claude user settings only — no keys in any repo | O-41 |

- **BLD-012 (s9)** Before M0 the build agent delivers the plain-English **Owner guide for M0** and the **glossary** (CIF, PBO, DSR, stalled, degrade mode, S1–S3 and every other term that appears in the UI or email); the UI and email link each such term to its one-line meaning. The Worker (cron-only, no public `workers.dev` route) is first deployed from CI in M1 as a skeleton (heartbeat record only); its master-clock, rate-token and slot-schedule functions arrive in M2; the Owner never runs `wrangler`.
- **BLD-011 (s9) Exit M0:** Owner ticks all rows; the **CI credential smoke test** runs in two stages: stage 1 (Actions-visible secrets) is the first task of M1 and must pass before any other M1 work; stage 2 (Vercel self-check route and Worker cron self-check, SEC-101) passes as soon as the M1 skeleton is deployed. **Release bootstrap sequence:** (1) the bootstrap release — skeleton plus the smoke-test workflow — is merged by the Owner into `release` via the guide (exempt from the release gate, since the gate needs the smoke test); (2) smoke test stage 1; (3) stage 2 once the skeleton is deployed; (4) M0 exit. The bootstrap release's `deploy-production` job is the **first approval**, given by the Owner in GitHub (SEC-108 c); until then the nightly check shows an in-app "awaiting first approval" notice instead of an S1. PAT hand-off (row 2): the Owner stores it in the build agent's own secret configuration (e.g. the agent platform's environment secrets), never in chat, issue text or a file in the repo.

## 12.3 Milestones (AU first; each ends with its exit tests)
| # | Milestone | Main content | Exit tests (Ch. 14 ids) |
|---|---|---|---|
| M1 | Platform skeleton | Repo layout, CI, staging + production, auth with roles and audit (separate auth DB, ROL-101a), configuration store, run records, System Health and Usage meters, nightly backup + restore, gitleaks | AT-01…AT-04, AT-05a, AT-05b |
| M2 | AU data | **Worker master clock, ASX rate token and slot schedule, Worker dispatch and heartbeats (in-app + GitHub-failure channels)**; DAT-101 source evaluation (≥ 5 trading days — start early), pipeline stages, quality gates, calendar, **daily universe snapshots start immediately** (DAT-130), staged history backfill into history files | AT-05, AT-06…AT-09 |
| M3 | Simulator & Arena | Cost profiles P0–P5, fills/stops, settlement, sleeve and lockout, cohorts, controls C1–C3, ledger invariants, reproducibility | AT-10…AT-13 |
| M4 | Agents & families | A2–A5, regime, indicators, events, insider/flow, family rules §7.4, Decision Cards, rolling-start replay engine with VAL-102 statistics | AT-14…AT-17 |
| M5 | Sentinel, alerts, email | A1 alerting on the M2 Worker + Vercel route, heartbeat and watchdog **email** paths, alert tiers, thesis-breakers, Evening Review with all 10 sections, partial mode, DST handling | AT-18…AT-21 incl. AT-20a, AT-20b (s14) |
| M6 | Learning & knowledge | A6/A7, lessons, Lane A/B, challengers, Critic, KB documents and archive | AT-22…AT-24 |
| M7 | UI | All pages of Ch. 09, role-aware, mobile | AT-25…AT-27 |
| M8 | AU go-live | Staging E2E day, security tests, restore test, bake-off, **rotation of every production token and revocation of the build-agent PAT (SEC-108 c)**, Owner walkthrough and sign-off | AT-28…AT-31 + all previous (s14) |
| M9 | India (after MKT-105 gate) | Market profile, sources, costs, calendar, backfills, activation | AT-M1…AT-M5 for IN |
| M10 | USA (after India gate) | Same for US | AT-M1…AT-M5 for US |

- **BLD-020** M2 source evaluation and universe snapshots SHOULD start in the first days, because they need real trading days and every day of snapshots reduces future survivorship bias.
- **BLD-021 (s9, O-27)** Markets are strictly sequential: M9 (India) starts only when AU meets MKT-105 and the Owner approves; M10 (USA) only when India meets the same gate (O-29). No IN/US pipelines run before their milestone starts; the Dashboard shows each market's work status (MKT-106).
- **BLD-022 Estimate (not a commitment):** M1–M8 ≈ 4–8 calendar weeks of build-agent work, plus the DAT-125 announcement backfill which may take several weeks at the ASX rate limit (runs in the background from M2; M4's AT-17 validation results that need it are completed when it finishes, and AT-17's engine checks do not wait for it); India and USA each ≈ 2–3 weeks after their gate opens. Re-estimated at each milestone in the digest.
- **BLD-024 (s9) Production data-only mode from M2.** From M2 the production deployment runs the real nightly data pipeline and universe snapshots (DAT-130) with the Arena, emails and decision agents (A2–A8) disabled — the A1 Sentinel polling and the DAT-125 backfill do run — so real-data days accumulate and quotas are measured on production; staging never calls ASX/Yahoo (DAT-122, NFR-040) and uses recorded fixtures.
- **BLD-023 (s10) Minutes table.** At the end of M1 and each later milestone the build agent publishes the per-job GitHub Actions minutes table (PLT-014a) as information; standard-runner minutes on the public code repo are free (O-29), so there is no hard monthly cap, only the self-imposed soft ceiling of PLT-014.

**(s13) Ch. 16 items:** built only after Owner acceptance. Accepted P1 items join M7 (pages) and their back-end parts (AGT-112, AGT-113, ARN-095, Market data) join M5/M6; P2/P3 items follow go-live. Design-system items UXN-001–018 are the first task of the first milestone that builds pages. [OWNER, O-38]

## 12.4 After go-live
- **BLD-030** Live paper trading starts the next AU trading day after M8 sign-off: 12 executions and controls each open a cohort with A$600 (ARN-001). **(s11)** The first trading day runs the normal PLT-073 pipeline with no special cold-start path, seeded by cohorts already created at M8 exit.
- **BLD-031** Expectations set in-app: labels stay UNVALIDATED until evidence accumulates (ARN-086, VAL-102 timeline); rolling-start replays provide most early evidence (ARN-080).
- **BLD-032** Market pivots and resource shifts follow VAL-103 and the Owner's decision, never an "accuracy %".

## 12.5 Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| No free EOD source passes DAT-101 for full ASX coverage | Medium | Narrow U3 first; keep yfinance as personal-use fallback; record gaps; ask Owner before any paid option (PRD-007 forbids spending) |
| ASX objects to automated access | Low–medium | Kill switch (DAT-123); Sentinel continues on other sources; F3/F5 degrade to price/volume-only variants as Lane-B challengers |
| Free-tier limits change | Medium | Metering + degrade mode (PLT-050…052); configuration, not code |
| Strategies don't beat luck | High (normal) | This is a valid outcome; the system reports it honestly and keeps testing challengers |
| Scheduled Actions unreliable; public repos disable schedules after 60 idle days | Known | Worker master clock (PLT-071) + independent heartbeat (PLT-074) |
| Public code repo exposes strategy code and logs (O-29) | Accepted | SEC-110 rules: no data, fixtures or personal data in the repo, logs or artifacts; CI check for data-like files; secret scanning + push protection |
| A$600 seed too small for many trades after costs | High | Honest labels (ARN-094); outcome is information, not failure |
| Scope growth (roles, three markets) | Medium | Milestone exits; IN/US activation gated |

## 12.6 Hand-off package
- **BLD-040** At M8 the repository contains: README (architecture, setup, environments), `.env.example` with names only, configuration reference with every [VERIFY] value and its date, runbook links (Ch. 11), test reports for AT-01…AT-31, the source-licence register, and the complete Owner guide in plain English (extending the M0 guide and glossary of BLD-012; replaces the imported layman guide).

## Acceptance criteria — Chapter 12
- **Given** any milestone is declared done, **then** its exit tests in Ch. 14 pass in the home environment named by TST-115 and the result is in the build digest.
- **Given** M0 is incomplete, **then** no production deployment happens other than the bootstrap release (BLD-011); the first production release is approved by the Owner in GitHub's deployment review (SEC-108 c).
- **Given** the build agent meets an unspecified detail, **then** a decision-log entry exists for the choice made (BLD-003).
