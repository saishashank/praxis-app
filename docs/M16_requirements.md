# M16 requirements: Blueprint page

Delta extract from `Requirement/v2/spec/18_blueprint_page.md` (draft V2-2, 2026-10-22; Owner O-67; assumptions A-16, A-17), ch. 12 V2 (M16 row, BLD-046), ch. 14 V2 (the AT-57 to AT-59 rows), ch. 15 V2 (no Blueprint key), ch. 16 and 09 V2 (no Blueprint text; see "Findings"). Continues from M15 on `build`.

## Scope

M16 is the fourth V2 milestone (BLD-046: M8.1, M14, M15, **M16**, M17, M11-lite, M13-lite, M12). It is small and depends on nothing else in V2. It builds one hidden page, `/blueprint`, that shows the whole technical map of Praxis as an interactive diagram. Only the pinned Owner account can see it. Everyone else gets a 404.

Marks: **build** = build in M16. **exists** = already in the code, reuse it. **deferred** = not in M16, with the reason.

### Access (18.1)
| ID | Plain words | Mark |
|---|---|---|
| SEC-111 | Page, data route and export exist only for a session whose role is Owner and whose email is the pinned Owner (`OWNER_EMAIL`). All others (Editor, Viewer, anonymous, crawler, a second Owner-role row) get 404, never 403, with no tell-tale header. Check runs server-side on every request. Proxy gate SEC-014 still applies first. | build (pin check: exists in `session.ts`, see below) |
| SEC-112 | Route is in no nav, sitemap, footer, help text, email or search index. `noindex, nofollow`. Path is `/blueprint`. A test walks every page as each role and fails if the path shows in rendered HTML other than on the page itself. | build |
| SEC-113 | Page shows where a secret lives and its name (store, environment, key name). Never a value, fingerprint or hint. Names come from the M8 T13 secret table. | build (table exists) |

### What it shows (18.2)
| ID | Plain words | Mark |
|---|---|---|
| UXN-297 | One machine-readable architecture model (`architecture.json`), generated at build time, never drawn by hand. Eight views as tabs on the page: Platform, Data, Cortex pipeline, Agents and schedule, LLM router, Email and alerts, Security and roles, Learning loop. | build |
| UXN-298 | Every node and edge is a model element with name, purpose, spec IDs, owner, schedule, inputs/outputs, config keys, tables, failure behaviour and live status. Hover shows a summary. Click opens a side panel (spec clauses, config values read-only, workflow/route name, recent runs, runbook section, licence row). Edges show their contract. Search box finds an element or spec ID. Inline SVG, pan and zoom, keyboard use, phone use (panel becomes a sheet). | build |
| UXN-299 | "Download as draw.io" (`.drawio`, mxGraph XML) and "Download as SVG" for the current view. Nothing is sent to an outside service. | build |
| UXN-300 | A second tab: spec chapters (v1 and V2) rendered from the KB copy, the requirement index (ID to where implemented, from the model), the decision log and the config reference. Read-only. | build |

### Keeping it true (18.3)
| ID | Plain words | Mark |
|---|---|---|
| ARC-001 | A build step makes `architecture.json` from: route registry, `.github/workflows/*.yml`, migrations (tables, indexes), Worker slot table, source-licence register, secret-name table, LLM role table, Cortex passports (status only), and a hand-kept spec map `docs/architecture/spec_map.yaml` (element to spec IDs, purpose, runbook anchor). A CI check fails when code has a route, workflow, table, Worker slot, external host or secret name the model lacks, or the model names one that is gone. | build |
| ARC-002 | Live status is read-only and cheap: only existing tables (run_record, health, feed controls, family state). No new outside request, nothing triggered. Carries the standard "Simulated" and freshness lines. | build |
| ARC-003 | Each visit writes one audit event (route, time). Exports are audited too. | build (audit writer exists) |

### Deferred or out
| Item | Why |
|---|---|
| Editing anything from the page (config, secrets, runs) | Spec says read-only everywhere on this page. |
| Any external diagram service | UXN-299 and SEC-110: export is local. |
| Free-text wording of Cortex pipeline detail beyond status | ARC-001 says "passports (status only)". |
| Tab per-view bespoke art | Not in the spec; one generic renderer for all views. |

## Acceptance tests

| ID | Pass condition (spec) | Evidence that proves each clause |
|---|---|---|
| AT-57 Access and invisibility | Editor, Viewer, unauthenticated and crawler requests to page, data and export return 404 with no distinguishing header. Pinned Owner gets the page. A second Owner-role identity gets 404. Path appears in no rendered page, nav model, sitemap or email. `noindex` present. | (a) Vitest on the guard: a table of role/identity x (page, data route, export route), asserts status 404 and an identical header set to a real missing route. (b) Test identity (`/api/test-identity`) for the pinned Owner and a second owner-role row. (c) Walk test: render every `(app)` page per role (reuse the nav/page walk used for ROL tests), grep HTML for `/blueprint`; only the Blueprint page itself may contain it. (d) `nav.ts` TABS/GEAR_ITEMS and `robots.ts`, sitemap, email templates contain no `blueprint` (grep test). (e) Page `metadata.robots` = noindex,nofollow, plus `X-Robots-Tag` on the data route. |
| AT-58 Model completeness | CI check lists every route, workflow, table, Worker slot, external host and secret name found in code and fails on any mismatch. Every element has at least 1 spec ID. No secret value or fingerprint in the model or page. | (a) Script test with a deliberately broken model (extra and missing item for each of the six kinds), asserts a non-zero exit and the named item. (b) Real run on the repo is green and wired into `ci.yml`. (c) Test: every element has `specIds.length >= 1` and each ID matches the spec ID pattern. (d) Secret scan: the generated JSON and the rendered page are run through the existing `bundle-secret-scan` rules and a check that no value from the test env appears. |
| AT-59 Interaction | Hover shows summary for every element. Click opens panel with spec clauses and live status. Search finds an element by spec ID. draw.io export opens in draw.io desktop with same elements and edges. Phone view pans and zooms. | (a) Playwright e2e: for each view, hover each node and edge, assert a summary appears; click one, assert panel has spec clauses and a status line; type a spec ID in search, assert the element is found. (b) Unit test of the drawio writer: parse the XML, node and edge counts equal the view's model counts. (c) Manual evidence note: the exported file opened in draw.io desktop (Owner step, recorded in exit evidence; cannot be automated). (d) Playwright at 375 px: pinch/drag pan and zoom changes the SVG transform; panel renders as a sheet. |

AT-59 is the only test with a manual clause (draw.io desktop). The spec word "same elements and edges" is tested by parsing; the desktop open is recorded as an Owner check.

## Configuration keys

None. Ch. 15 V2 has no Blueprint key and ch. 18 names none. The page shows other keys' current values, read-only, via the existing config loader (`src/lib/config`). A-16 fixes the path; no key is needed for it. Proposed: add none (decision D-362).

## Data and SEC-110 constraints

- Public repo holds only code, `docs/architecture/spec_map.yaml` and the generated `architecture.json` (or its generator). These must contain names and structure only: no secret value, no fingerprint, no real ticker, no real price, no Owner email, no private data repo path contents.
- The spec browser (UXN-300) reads the KB copy of the spec. Per SEC-110 only `Requirement/v1/spec/` may live in `praxis-app` (the repo already has `spec/` with v1 chapters 00 to 16). V2 chapters are in the private data repo and must **not** be copied in. See open question Q1.
- Owner email comes from the `OWNER_EMAIL` env var at run time. It is never in the model, the page or the tests (tests use the test identity).
- Test fixtures use ZZ codes and synthetic runs only.
- Secret names: from `src/lib/security/secretStores.ts` (names and stores only, already public per SEC-017).
- Live status shows counts, states and times, not data rows with money. Masked viewers cannot reach the page, so the masking layer is not needed here, but amounts, if any, stay out of the page anyway (status only).

## What exists and what is missing

| Need | Exists (path) | Missing |
|---|---|---|
| Owner pin | `src/lib/auth/env.ts` `isOwnerEmail`; `src/lib/auth/session.ts` line 45 downgrades a stored owner role to viewer unless the email is the pinned one (ROL-101a). `src/lib/auth/guard.ts` `requireUser`. | A guard `requirePinnedOwner` that calls `notFound()` (page) or returns a bare 404 (routes) for everyone else, incl. unauthenticated. Check that the `src/proxy.ts` gate does not redirect an anonymous `/blueprint` request to sign-in (that would be a tell). See Q2. |
| 404 page | `src/app/not-found.tsx` (plain, already designed to leak nothing) | Parity test that the route 404 equals a real missing route. |
| Hidden from nav | `src/lib/ui/nav.ts` (TABS, GEAR_ITEMS), `src/app/robots.ts` (disallows all) | Metadata `noindex, nofollow`; the walk test. No sitemap exists, none to add. |
| Page pattern | `src/app/(app)/cortex/page.tsx` (server component, `Card`, `DataTable`, `Banner`); `src/lib/ui/loaders/cortex.ts`; `src/components/ui/*` (Card, Sheet, SheetPanel, Pill, Kpi, StatusStrip, Segmented for tabs) | `src/app/(app)/blueprint/page.tsx`, a client diagram component (SVG pan/zoom/hover/panel), `src/lib/ui/loaders/blueprint.ts` (live status). |
| Secret table | `src/lib/security/secretStores.ts`, `src/lib/sentinel/schema.ts` (CREDENTIAL_NAME_LIST) | Mapping into model nodes. |
| Licence register | `scripts/ci/licence-register.mjs` (reads `INSERT INTO source_register` in migrations), `docs/source-licence-register.md` | Reuse its parser in the generator. |
| Route registry | `scripts/ci/route-coverage.mjs` (route.ts files and server actions), `tests/routes/manifest.json` | Page routes (page.tsx) are not covered by it; the generator must add them. |
| Workflows | `.github/workflows/*.yml` (24 files), `scripts/ci/workflow-lint.mjs` | Parser for name, cron, jobs. |
| Tables | `db/migrations/` (main and auth), `src/lib/data/schema.ts` | SQL parser for CREATE TABLE/INDEX. |
| Worker slots | `worker/src`, `worker/wrangler.jsonc` | Slot table reader (find the existing slot table first, see Q4). |
| LLM roles | `src/lib/llm` | Role table reader. |
| Cortex status | `src/lib/ui/loaders/cortex.ts` (families, passports, state) | Read-only reuse for the Cortex view. |
| Live status sources | `src/lib/health/*`, run records, `src/lib/data/controls.ts` (feed on/off) | Small adapter returning status per element id. |
| Audit | `src/lib/auth/audit.ts` `audit()` | Event names `blueprint.view`, `blueprint.export`. |
| Spec text | `spec/00..16*.md` (v1), `docs/06_open_questions.md`, `docs/07_decision_log.md`, `src/lib/kb/render.ts`, `src/lib/kb/documents.ts` | V2 chapters not present (SEC-110). Config reference generator exists: `scripts/ci/config-reference.mjs`. |
| Spec map | none | `docs/architecture/spec_map.yaml` (hand-kept; large, about 100 or more elements). |
| Generator + CI check | none | `scripts/architecture/generate.mjs`, `scripts/ci/architecture-check.mjs`, a step in `ci.yml`, a `package.json` script. |
| Export | none | `.drawio` writer and SVG serializer (pure functions), an audited download route. |
| Dependencies | none for diagram | Prefer no new package: hand layout (layered columns from spec map coordinates or a simple layered auto-layout). Check licence if any is added (`licence-check.mjs`). |

## Findings from the spec

- Ch. 15, 16 and 09 V2 contain no Blueprint text. The only other mentions are in 00 (O-67, A-16, A-17), 12 (M16 row), 14 (go-live gate lists AT-57 to AT-59). The v7 ch. 14 table in `14_acceptance_delta.md` does not carry AT-57 to AT-59 rows; the pass conditions are in ch. 18 itself, used above.
- 18.4 says M16 "may be built with the M8.1 patch" and "depends on nothing in V2". Here it follows M15 as BLD-046 orders it.
- The model names "the Worker slot table", "the LLM role table", "Cortex passports": confirm each exists as a single readable source (Q4).
- AT-58 requires "external host" completeness: the generator must collect hosts from the code (fetch URLs, constants). Needs a defined scan rule (Q5).

## Open questions and proposed decisions

Recommended default = what the spec says or the nearest safe reading. Numbered from D-360.

| # | Question | Recommended default | Proposed decision |
|---|---|---|---|
| Q1 | Spec browser needs V2 chapters but SEC-110 forbids copying V2 spec into the public repo. | Show v1 spec chapters from the repo `spec/` plus the repo decision log, open questions and config reference. For V2, show the requirement index (IDs from the model and spec map) without chapter bodies. Revisit if the Owner moves V2 spec into `spec/`. | D-360: UXN-300 renders v1 chapters, decision log, config reference and the ID index only; V2 chapter bodies are not published (SEC-110). Listed in the PR for the Owner. |
| Q2 | An anonymous request to `/blueprint` could be redirected to sign-in by the proxy gate (a tell). | Return the plain 404 for any unauthenticated request on `/blueprint*` before the redirect. Spec says unauthenticated gets 404. | D-361: the proxy returns 404 (not redirect) for unauthenticated `/blueprint` paths; the page guard re-checks. |
| Q3 | Config key for anything? | None. | D-362: no config key in M16. |
| Q4 | Which sources are "Worker slot table" and "LLM role table"? | Use the existing code tables (worker cron/slot table and `src/lib/llm` roles); if one is not a single table, add a small exported constant, no behaviour change. | D-363: generator reads exported constants only; any new constant is data-only. |
| Q5 | How to find "external hosts"? | Scan `src` and `worker/src` for string URLs and a named host list (`ALLOWED_HOSTS`-style constants); the model must list each host; allow-list in `docs/architecture/spec_map.yaml` for hosts that are test-only. | D-364: host rule = every `https://` host literal in non-test source. |
| Q6 | Diagram layout: manual coordinates or auto? | Layered auto-layout in code (no new dependency); optional coordinate overrides in the spec map. | D-365: no diagram library; own SVG renderer with pan/zoom. |
| Q7 | Is `architecture.json` committed or built each time? | Generated at build and in CI check; committed copy kept so the page needs no build step at run time, and the CI check fails if the committed copy is stale (same pattern as `licence-register.mjs --check`). | D-366: committed, with `--check` in CI. |
| Q8 | Second Owner-role identity test. | Use the test identity with role owner and a different email; session logic already downgrades it to viewer, so the guard sees a non-pinned user. | D-367: pin check = `isOwnerEmail(env, email)` plus role owner, both. |
| Q9 | Data route and export: one route or two? | `GET /api/blueprint/model` (JSON) and `GET /api/blueprint/export?view=&format=drawio\|svg`, both guarded and audited. Same-origin GET only. Add to the route manifest. | D-368: two routes under `/api/blueprint/`. |
| Q10 | Does AT-59's draw.io desktop open step block exit? | No: the XML is validated by a parser test; the desktop open is an Owner check recorded in the PR list, not a blocker. | D-369: desktop open is an Owner check at merge time. |
| Q11 | Audit event shape. | One event per page visit and one per export, route and time only (no query strings beyond view). | D-370: events `blueprint.view` and `blueprint.export`. |

## Recommended work packages

Small packages; Sonnet builds, a Fable reviewer checks each. WP1 and WP2 are the high-risk ones (access and secrets) and need the reviewer's full attention.

| WP | Content | Depends | Tests / evidence |
|---|---|---|---|
| WP1 Access guard | `requirePinnedOwner` (page) and a route variant; 404 parity with a missing route; proxy handling of anonymous `/blueprint` (Q2); `noindex` metadata and `X-Robots-Tag`; audit events (ARC-003). Empty placeholder page. | none | AT-57 (a)(b)(e) unit tests; header-equality test. HIGH RISK (security). |
| WP2 Model schema + generator | `architecture.json` schema (types, ID pattern, element/edge fields); generator readers for routes (page + route.ts + actions), workflows, migrations, Worker slots, licence register, secret table, LLM roles, hosts; `spec_map.yaml` first full draft for all eight views; secrets-never rule. | none | Generator unit tests on synthetic repos; secret scan (AT-58 c, d). HIGH RISK (secrets). |
| WP3 CI completeness check | `architecture-check.mjs` (six kinds, both directions, spec-ID rule), `--check` freshness, wired into `ci.yml` and `package.json`; broken-model tests. | WP2 | AT-58 (a)(b)(c). |
| WP4 Live status loader | `loaders/blueprint.ts`: element id to status from run records, health, feed controls, family state; read-only; "Simulated" and freshness lines (ARC-002). | WP2 | Loader tests with ZZ fixtures; a test that it issues no outside request and writes nothing but the audit event. |
| WP5 Diagram page | Page with eight view tabs, SVG renderer, layered layout, pan/zoom, keyboard, hover summary, side panel (sheet on phone), search by name or spec ID, config values read-only. | WP1, WP2, WP4 | AT-59 (a)(d) Playwright; jest-dom unit tests for search. |
| WP6 Export | Pure `.drawio` writer and SVG serializer; audited download route (Q9). | WP2 (WP5 for SVG source) | AT-59 (b); the draw.io desktop Owner check. |
| WP7 Spec browser | Second tab: v1 chapters, ID-to-element index, decision log, config reference (Q1). Reuse `src/lib/kb/render.ts`. | WP2 | Render tests; no V2 body test (SEC-110). |
| WP8 Invisibility walk + exit | Walk every page as each role, nav/robots/email grep (AT-57 c, d); full AT-57 to AT-59 run; exit evidence `docs/M16_exit_evidence.md`; decisions D-360 onward into the log; update BUILD_SETUP section 9. | all | AT-57 (c)(d) walk. |

Suggested order: WP1, WP2 in parallel; then WP3, WP4; then WP5, WP6, WP7; then WP8.
