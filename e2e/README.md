# End-to-end and accessibility tests

Playwright (chromium) against a **local production build** (`npm run build:e2e`, `npm run start:e2e`
on `http://127.0.0.1:3100`). Run with `npm run test:e2e` (or `npx playwright test`).

## Spec requirements

- TST-126 UI end-to-end: "Playwright (free) on a production build against the staging test identity
  (TST-113): every page and tab, both roles' views, empty / stale / error states (UX-007), the six
  themes (UXN-280) at desktop and phone width, keyboard navigation, and the 'Simulated' label audit
  (AT-27). **Accessibility:** automated axe checks with no serious/critical issues on every page."
- TST-127 Visual regression: screenshot baselines live in the private fixtures repo, never here.
- TST-113 Test identities: "automated E2E on staging uses a staging-only signed test-identity login
  that is compiled out of production builds." SEC-109 / D-039: the login is a runtime guard.
- TST-115 Where tests run: TST-126 is a staging (recorded data) test. This suite is the CI subset
  that needs no real service; the staging run (real test-identity login) is still to be added.
- UXN-019: axe-core is MPL-2.0, which is on the licence allow-list.

## How it works

- `playwright.config.ts` generates a temp directory and random 64-hex `AUTH_SECRET`,
  `ACTIONS_HMAC_SECRET`, `PII_HASH_KEY` and `TEST_IDENTITY_SECRET` per run (never committed), and
  starts the server with them. `BACKUP_PUBLIC_KEY` and `OWNER_RECOVERY_EMAIL` are unset, so the
  test-identity guard is open (as on staging).
- `prepare-db.mjs` (first step of the web server command, because Playwright starts the web server
  before `globalSetup`) applies the real migrations to two local libSQL files and seeds
  `owner@`, `editor@` and `viewer@praxis.test`.
- `helpers.ts` signs in by minting the same session cookie the test-identity handler issues. The
  HTTP login route cannot run on `file:` databases (its replay store speaks only the Turso HTTP
  protocol), so it is exercised on staging only.
