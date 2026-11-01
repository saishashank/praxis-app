<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/praxis-logo-tagline-dark.svg">
    <img src="public/brand/praxis-logo-tagline-light.svg" alt="Praxis — Learn. Earn. Repeat." width="320">
  </picture>
</p>

# Praxis

Praxis is a personal investment-research and **simulated** (paper) trading app, first for the ASX. It is a simulation for personal information only. It is **not financial advice**, it never places a real order, and no screen can. Every money figure is labelled "Simulated".

This README is the hand-off entry point (BLD-040). It tells a new maintainer what the system is, how it is laid out, how to run and test it, and where every other document lives. The requirements are in [`spec/`](spec/00_README_and_progress.md) (start there for the meaning of any ID such as PLT-073 or SEC-017).

## Architecture

| Part                | What it is                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App                 | Next.js 16 (React 19, TypeScript) on Vercel: pages, signed internal routes, Auth.js sign-in with Google. Source in `src/`.                                                                      |
| Databases           | Two Turso (libSQL) databases: **main** (market data, arena, knowledge, runs) and **auth** (users, sessions, audit). Migrations in `db/migrations/{main,auth}`, applied by `npm run db:migrate`. |
| Clock               | A Cloudflare Worker (`worker/`) is the master clock. It dispatches the nightly GitHub Actions workflows on time, polls ASX announcements, and reports to the app (PLT-070…076).                 |
| Pipelines           | GitHub Actions workflows in `.github/workflows/`: ingest, arena signals and close, backup, maintenance, watchdog, replay, backfill, KB archive, bake-off, restore drill.                        |
| Data repo (private) | `<code repo>-data`: nightly archives, backups and KB documents. Never receives code; never triggers a deployment (AT-05a).                                                                      |
| Fixtures repo       | Private recorded test data. Read-only in CI and on staging. Nothing from it is copied into this repo (SEC-110).                                                                                 |
| Email               | Resend: Evening Review, Morning Brief, incident and reminder emails to the Owner.                                                                                                               |

Secrets are never stored in this repository. They live only in GitHub **environment** secrets, Vercel environment variables and Cloudflare Worker secrets (SEC-017, SEC-101). [`.env.example`](.env.example) lists the variable **names** only.

## Environments

| Environment | Branch    | Deploys                                                                                         | Data                                                                                                  |
| ----------- | --------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Local       | any       | `npm run dev`                                                                                   | Throwaway local databases and synthetic fixtures                                                      |
| Staging     | `main`    | `deploy-staging.yml` on every merge to `main` (app and Worker)                                  | Recorded fixtures only; staging never calls Yahoo or ASX (NFR-040)                                    |
| Production  | `release` | `deploy-production.yml`, only after the **Owner approves** the deployment in GitHub (SEC-108 c) | Real data. Starts in data-only mode (BLD-024); trading starts only after the Owner's go-live sign-off |

Work happens on the `build` branch with CI on every push. The **approved-commit rule** (SEC-108 c, AT-05b): production runs only a commit that was approved for `deploy-production`; a nightly watchdog compares the deployed commit with the latest approved one (`scripts/ci/approved-commit.mjs`, `src/lib/watchdog/approvedCommit.ts`) and raises an incident on a mismatch. A merged but unapproved commit never reaches production.

## Local setup

1. Install Node 22 (`.nvmrc`; `engines` needs Node 20.19 or newer) and run `npm ci`.
2. Copy `.env.example` to `.env.local` and fill only the names a feature needs. Never commit real values.
3. `npm run dev` starts the app. For a local run with throwaway databases see `e2e/README.md`.
4. Worker: `cd worker && npm ci && npm test` (`npm run dev` there starts `wrangler dev --test-scheduled`).

## npm scripts (root `package.json`)

| Script                          | What it does                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run dev`                   | Next.js dev server                                                                                        |
| `npm run build`                 | Applies migrations only on Vercel (`--if-vercel`), then `next build` (`prebuild` regenerates the notices) |
| `npm run build:e2e`             | Plain `next build` for the end-to-end run                                                                 |
| `npm start`                     | Serves the production build                                                                               |
| `npm run start:e2e`             | Serves the build on 127.0.0.1:3100 for Playwright                                                         |
| `npm run db:migrate`            | Applies the main and auth migrations                                                                      |
| `npm run lint`                  | ESLint                                                                                                    |
| `npm run typecheck`             | `tsc --noEmit`                                                                                            |
| `npm run format`                | Prettier, write                                                                                           |
| `npm run format:check`          | Prettier, check only                                                                                      |
| `npm test`                      | Vitest unit and integration suite                                                                         |
| `npm run test:coverage`         | Vitest with V8 coverage                                                                                   |
| `npm run test:smoke`            | Node test runner over `scripts/**` tests (smoke, e2e helpers, backup, restore, ingest, CI tools and more) |
| `npm run test:routes`           | Route coverage: every route has a test (81/81 at M7)                                                      |
| `npm run test:hygiene`          | Public-repo hygiene scan (SEC-110, AT-05a)                                                                |
| `npm run test:config-reference` | Checks `docs/config-reference.md` against the config keys                                                 |
| `npm run test:licences`         | Production licence allow-list (UXN-019)                                                                   |
| `npm run test:bundle`           | Client bundle gzip budgets                                                                                |
| `npm run test:lighthouse`       | Lighthouse mobile on Home (AT-26)                                                                         |
| `npm run test:e2e`              | Playwright end-to-end and accessibility                                                                   |

Env-names check (not yet an npm script): `node scripts/ci/env-names.mjs`. It fails if a name the code or a workflow reads is missing from `.env.example`, or if that file holds any value.

## Testing

- **Unit and integration** (`npm test`, Vitest): `tests/**` against real local libSQL files and synthetic data; `worker/test/**` for the Worker. Acceptance tests for M5/M6 are in `tests/acceptance/`.
- **Smoke and script tests** (`npm run test:smoke`): `node --test` over the pipeline, backup, restore, ingest and CI scripts, including per-workflow shape tests.
- **End-to-end** (`npm run test:e2e`): Playwright on a local production build with throwaway databases; includes axe accessibility, mobile, honesty-label and security-header specs. See [`e2e/README.md`](e2e/README.md).
- **CI checks** (`.github/workflows/ci.yml`): format, lint, contrast, typecheck, tests, smoke, route coverage, hygiene (M7), licence allow-list, synthetic backup/restore drill, build, client-bundle secret scan (AT-03), bundle budgets, E2E, readability, Lighthouse, a full-history gitleaks scan, the Worker checks and the fixture-backed tests. Further M8 checks (env names, audit, ZAP, diff coverage, test map, release gate) are wired by M8 task T17.
- **Credential smoke tests** (`smoke-test.yml`, Owner-dispatched): see [`scripts/smoke/README.md`](scripts/smoke/README.md).
- **Coverage per requirement**: [`docs/test-map.md`](docs/test-map.md).

## Where things live

| Looking for                        | Go to                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Requirements                       | [`spec/`](spec/00_README_and_progress.md) (chapters 01-16; acceptance tests in [`spec/14`](spec/14_system_acceptance.md))         |
| Decisions                          | [`docs/07_decision_log.md`](docs/07_decision_log.md) and [`docs/06_open_questions.md`](docs/06_open_questions.md)                 |
| Design notes per milestone         | `docs/M2_design.md` … [`docs/M8_design.md`](docs/M8_design.md); requirements digests in `docs/M*_requirements.md`                 |
| Exit evidence per milestone        | `docs/M1_exit_evidence.md` … `docs/M7_exit_evidence.md` (dated history)                                                           |
| Current status per acceptance test | [`docs/test-reports/`](docs/test-reports/) (one file per AT; Owner rows stay "pending" until the Owner runs them)                 |
| Config keys and defaults           | [`docs/config-reference.md`](docs/config-reference.md) (checked by `npm run test:config-reference`; spec chapter 15)              |
| Runbooks                           | [`spec/11_ops_runbook.md`](spec/11_ops_runbook.md) (OPS-030…061: restore, rotation, incidents, rollback)                          |
| Owner guides                       | [`docs/owner-guide/`](docs/owner-guide/) (M0 set-up, M1 sections A…M; the M8 operations and go-live guides are added by task T13) |
| Backup and restore scripts         | [`scripts/backup/README.md`](scripts/backup/README.md), [`scripts/restore/README.md`](scripts/restore/README.md)                  |
| Glossary                           | [`docs/glossary.md`](docs/glossary.md)                                                                                            |
| Brand files                        | [`docs/brand/`](docs/brand/BRAND.md)                                                                                              |

## Review and pull-request rule (D-022)

The build has only three review points, each a pull request from `build` with review requested from the Owner: **"M1 bootstrap:"**, **"M2 data start:"** and **"Build complete:"** (M8). Everything else accumulates on `build` with CI on every push. The agent never edits `deploy-*.yml`, never sees a production secret, and never approves or rotates anything; those steps belong to the Owner.
