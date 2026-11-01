# M16 exit evidence: Blueprint page (V2)

_2026-10-31 (Melbourne time). Design: `docs/M16_design.md`; requirements: `docs/M16_requirements.md`; decisions D-360…D-372 and D-831. Built on `build` from the M15 line; WP1 to WP7 merged at 6963e25, WP8 on `v2/m16-wp8`. V2 ships in one PR at the end (O-73); nothing here is deployed or pushed yet._

## 1. Work packages
| WP | What | Commits | Tests |
|---|---|---|---|
| requirements, design | M16 extract, hygiene allow-list, design with D-360…D-370 | 7b44a6a, bec90c5 | none (documents) |
| WP1 access guard | pinned-Owner guard, proxy branch hiding `/blueprint*`, noindex, audit events; rework after the security review (D-371, D-831) | a22836f, 1255b20, 23e2149, b6356b2, merge f0d181a | `tests/blueprint/blueprintGuard.test.ts`, `e2e/m16-blueprint-access.spec.ts`; AT-57 a, b, e |
| WP2 model and generator | `architecture.json` schema, generator, `spec_map.yaml`, wider secret scan (D-372) | b2eb7b0, 70400fa, 67b6a2f, 2455341, merge 6b6959a | `scripts/architecture/generate.test.mjs`; AT-58 c, d |
| WP3 CI check | `scripts/ci/architecture-check.mjs`, `npm run test:architecture`, step in `ci.yml` | 96fa3f8, merge 0133959 | `scripts/architecture/check.test.mjs`; AT-58 a, b |
| WP4 live status | read-only status loader (ARC-002) | e8cb66c, merge e40c4fc | `tests/blueprint/loader.test.ts` |
| WP5 diagram page | eight view tabs, own SVG renderer, pan/zoom, hover, panel, search, model route | 15f120f, 3e39c16, merge 6963e25 | `tests/blueprint/blueprintPage.test.ts`, `e2e/m16-blueprint-page.spec.ts`; AT-59 a, d |
| WP6 export | `.drawio` and SVG writers, audited download route | 86b4ee6, merge 45f155c | `tests/blueprint/export.test.ts`; AT-59 b |
| WP7 spec browser | v1 chapters, decision log, config reference, ID index; no V2 bodies (D-360) | ef71895, merge 835e292 | `tests/blueprint/specBrowser.test.ts` |
| WP8 walk and exit | invisibility walk, six-kind completeness breaks, edge hover, AT-57/58/59 reports, this document | commits on `v2/m16-wp8` (hash in the merge) | `e2e/m16-blueprint-walk.spec.ts`, `scripts/architecture/check.test.mjs`, `e2e/m16-blueprint-page.spec.ts`; AT-57 c, d |

Decisions: D-360 (no V2 chapter bodies in the spec browser), D-361 (404 for non-owners, amended by D-371), D-362 to D-370 as adopted from Q1 to Q11 (no config key; exported constants only; host rule; own renderer; committed model with `--check`; pin check; two routes; audit events; draw.io open is an Owner check), D-371 (anonymous gets the ordinary redirect or 401), D-372 (model committed, served only to the Owner), D-831 (RSC rewrite-header residual).

## 2. Acceptance
| Test | Result | Report |
|---|---|---|
| AT-57 access and invisibility | pass locally (a, b, c, d, e); second owner-role identity is unit-tested only | `docs/test-reports/AT-57.md` |
| AT-58 model completeness | pass locally for a, b, c; (d) partly covered (shape scan only, see gap) | `docs/test-reports/AT-58.md` |
| AT-59 interaction | pass locally for a, b, d; (c) is an Owner check | `docs/test-reports/AT-59.md` |

## 3. Gates (local, Windows build machine, 2026-10-31, branch `v2/m16-wp8`)
- `npx vitest run tests/blueprint`: 62 of 62 pass (5 files).
- `node --test scripts/architecture/*.test.mjs`: 38 of 38 pass.
- `npm run test:routes`: ok (89 routes and actions generated, 89 in manifest). `npm run test:architecture`: model complete and up to date. `npm run test:hygiene`: OK.
- e2e (local production build, `turbopack.root` set temporarily and reverted, never committed): walk and access specs 18 of 18 pass; the page spec 3 of 3 pass after the edge test was made reachability-aware.
- The full Vitest, smoke and e2e suites were not re-run for this package; remote CI has not run.

## 3a. Integration-review fixes (branch `v2/m16-fix`, 2026-10-31)
- **B1 file tracing:** `next.config.ts` now sets `outputFileTracingIncludes` for `/blueprint` (model, `spec/*.md`, open questions, decision log, config reference) and `/api/blueprint/model`; `tests/blueprint/traceIncludes.test.ts` fails if the list drifts from `DOCS_ALLOW` or `SPEC_DIR`. **Staging confirmation is pending** (Vercel build after the Owner pushes `build`): open `/blueprint` and its spec tab on staging and confirm no 500.
- **S1 side panel:** config keys with current read-only values (known keys only), the last 5 runs per job, the source licence row, and spec IDs as links to `?tab=spec&q=<id>`; loader and tests in `tests/blueprint/panelData.test.ts`.
- **S2 spec map:** page, model and export routes carry their own spec IDs and generic purpose text; model regenerated.
- **S3/S4:** the access spec now includes the export route pair; the walk spec scans the Owner's responses for secret shapes and test-environment secrets (AT-57, AT-58 reports updated). The access spec also tolerates `x-nextjs-rewritten-query` for a signed-in non-owner on an RSC request (same D-831 residual).
- **S5:** the stale guard comment now states D-371. The route-handler guard's 404 is unit-tested only (AT-57).
- Gates: vitest tests/blueprint 69 of 69; the three m16 e2e specs 20 of 20; tsc, eslint, prettier, test:routes, test:architecture, test:hygiene green.

## 4. Open items for the Owner
- **draw.io desktop open check (D-369):** open an exported `.drawio` (and a view's SVG) in draw.io desktop and confirm the same elements and edges. Not automated; not blocking. Not done.
- **RSC residual (D-831):** a signed-in editor or viewer can tell `/blueprint` from a missing route by sending an `RSC: 1` request, because Next adds `x-nextjs-rewritten-path` after the proxy. Anonymous and plain page requests show nothing. Removing it needs a custom server or another not-found mechanism. Asserted as the known residual in `e2e/m16-blueprint-access.spec.ts`.
- **D-371 spec amendment:** ch. 18 says unauthenticated users receive 404; the governing clause "indistinguishable from a missing route" wins, so anonymous `/blueprint*` gets the ordinary sign-in redirect and `/api/blueprint*` the ordinary 401. Please approve the wording change in ch. 18 at merge.
- **D-360 no V2 bodies:** the spec browser shows v1 chapters, the decision log, the config reference and the ID index only; V2 chapter bodies stay out (SEC-110).
- **AT-58 (d):** the Owner's rendered responses are now scanned for secret shapes and the run's test secrets; `bundle-secret-scan` itself is still not run on them.
- **Edge hover (AT-59 a):** edges are mouse-only; 114 of 136 Platform-view edges were hovered, 22 are wholly covered by other drawing.
- Owner audit log (`/audit`) legitimately lists `blueprint.view` and `blueprint.export` rows; the walk allows "blueprint" there only.
- Push of `build`, remote CI (gitleaks history, e2e and Linux jobs can differ from local).

**M16 closed locally: yes, pending the Owner items above and remote CI.**
