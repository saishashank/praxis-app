# Test map (requirement ID to tests)

This page lists which tests check which requirement IDs. It follows [TST-133](../spec/10_nfr_testing.md): every MUST in chapters 01 to 12 should have at least one test, or be listed as Owner-executed in [chapter 14](../spec/14_system_acceptance.md). Only rows for tests that exist today are filled in. A row marked "not yet" is a gap, not a pass.

**Gap:** TST-133 says the map is generated and published in the CI summary, and that CI fails if a MUST loses its last test. Neither exists yet. This file is written by hand until that check is built.

## Map

| Requirement ID | What is tested | Test file(s) | Layer | Status |
|---|---|---|---|---|
| [BLD-012](../spec/12_build_plan.md) (Worker skeleton) | The heartbeat record has the right shape and time format; `fetch` returns 404 "Not found"; `scheduled` logs the heartbeat as JSON | `worker/test/index.test.ts` | unit | partial (skeleton only; the "no public workers.dev route" rule is not tested) |
| D-016 / PLT-035 (public `/privacy` and `/terms` pages) | Privacy page: scopes, 90-day retention, no sale or advertising sharing, "Last updated" line. Terms page: simulated trading, no financial advice, as-is with no warranty, "Last updated" line | `tests/pages.test.tsx` | unit | partial (page text only; no check of the Google consent screen or the links from the consent screen) |
| [AT-27](../spec/14_system_acceptance.md) (Simulated label) | Home page shows "All trades are simulated." and links to Privacy and Terms | `tests/pages.test.tsx` | unit | partial (home page only; the automated audit of every money element is not built) |
| [TST-107](../spec/10_nfr_testing.md) (security headers) | Nothing. No test checks response headers | none | none | not yet |
| [SEC-101](../spec/10_nfr_testing.md) (no secret in output) | The runner with the whole production suite passes and prints no secret value; a failing run still prints no secret value; missing secrets fail with no network call; the email check never echoes the value | `scripts/smoke/checks.test.mjs` | unit (no network) | partial (stage 1 only; stage 2 is not built) |
| [SEC-017](../spec/10_nfr_testing.md) (machine credential formats) | Hex secret format; age public key format; Vercel token check; Cloudflare account and user endpoint checks; GitHub repo read check | `scripts/smoke/checks.test.mjs` | unit (mocked network) | partial (formats and mocked responses only; live proof is Owner-executed) |
| D-024 (stage 1 proofs) | Turso round trip (exactly five requests, in order); Resend pass and payload, and failure cases; LLM key checks; Vercel and Cloudflare checks; table-name and URL handling | `scripts/smoke/checks.test.mjs` | unit (mocked network) | partial (live calls are Owner-executed in the smoke run) |
| D-023 (`deployment: false` on smoke jobs) | Nothing in the test suite. The workflow file is not tested | `.github/workflows/smoke-test.yml` | Owner-executed | not yet |
| [BLD-011](../spec/12_build_plan.md) (stage 1 credential smoke test) | Runner logic (above). The real run against real secrets | `scripts/smoke/checks.test.mjs`, `scripts/smoke/stage1.mjs`, `.github/workflows/smoke-test.yml` | unit and Owner-executed | partial |
| [NFR-006](../spec/10_nfr_testing.md) (failure email reaches the Owner) | A workflow that fails on purpose. The Owner checks the inbox | `.github/workflows/m0-failure-email-test.yml` | Owner-executed | not yet (no recorded Owner run) |
| [TST-112](../spec/10_nfr_testing.md) (PR gate) | CI runs format check, lint, typecheck, unit tests, smoke unit tests and build for the app; typecheck, unit tests and a Worker dry-run deploy for the Worker. Missing: header checks (TST-107), the ZAP baseline, the test map check (TST-133) | `.github/workflows/ci.yml` | workflow | partial |
| [SEC-017](../spec/10_nfr_testing.md) (signed calls: HMAC-SHA256 over body + timestamp, 300 s window, replay, POST only) | Known-answer signature shared by caller and server; valid / wrong signature / tampered body / 301 s old / 301 s future / malformed headers → 401; missing secret → 503; second use of a nonce → 401; replay-store failure → 503 (fail closed) | `tests/security/hmac.test.ts`, `tests/selfcheck/route.test.ts`, `scripts/smoke/stage2.test.mjs` | unit | partial (GET → 405 relies on Next.js; checked on first deployed run) |
| [SEC-101](../spec/10_nfr_testing.md) stage 2 (Vercel self-check), SEC-109 | Each Vercel-held secret reported pass/fail/pending without its value: formats, Turso main + auth round trips, Google OAuth client check, GitHub read token, LLM keys; `TEST_IDENTITY_SECRET` must be absent in production; environment derived and matched by the caller; no secret in the response | `tests/selfcheck/checks.test.ts`, `tests/selfcheck/route.test.ts`, `scripts/smoke/stage2.test.mjs` | unit + workflow (manual) | partial (run record on System Health and the Worker cron self-check not yet built) |

## Layers

- **unit:** runs in CI on every push, with no real services.
- **workflow:** a check in a GitHub Actions file.
- **Owner-executed:** you run it by hand, with real secrets or a real inbox. See the [M1 owner guide](owner-guide/M1_owner_guide.md).

## How to update

Every new test must:

1. Name the requirement IDs it checks in its title or in a comment at the top of the file (for example `// SEC-101, D-024`).
2. Add a row to the table above, or add its IDs to an existing row.
3. Set the status honestly. Use "partial" when only some of the rule is checked. Do not mark a row "covered" unless the whole rule is checked.

Do not delete or skip a test to make CI pass ([TST-131](../spec/10_nfr_testing.md)).
