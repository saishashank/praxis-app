# Expert seed import (Owner-run)

Loads the expert seed (experts, their source links, claims, technique clusters, dated calls) into the main database. The seed is private data: it lives outside this repository (SEC-110, D-531) and the script refuses a folder inside it. This repository holds only this format document, the validator, the importer and a synthetic `ZZ` fixture (`tests/experts/zzSeed.ts`).

```
node scripts/experts/import.mjs <seed-folder> --dry-run   # validates, prints counts only
node scripts/experts/import.mjs <seed-folder>             # writes; needs TURSO_MAIN_URL and TURSO_MAIN_TOKEN
```

The database must be at schema 22 or later. Output is counts only: never a name, a URL or a text. No network request and no LLM call is made.

## Format `praxis-expert-seed/1`

Five JSON files (plus one optional) in one folder. Every string has a length cap equal to the database CHECK; every object rejects unknown keys, so no field that could carry an article, transcript or page can arrive (PRD-036). An error names the file and the path, never the value.

| File                    | Content                                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`         | `{ format: "praxis-expert-seed/1", market, created_at }`                                                                                                                                                                                                            |
| `experts.json`          | `{ experts: [ { id, name, platforms[], handles{}, home_urls[], markets[], focus[], status candidate/tracked/paused/retired, tier core/discovered, no_feed bool, licence_status?, audience_size? + audience_d?, red_flags?: [ { text, source_url, noted_d } ] } ] }` |
| `items.json`            | `{ items: [ { expert_id, url, platform, title or null, published_at or null, content_hash or null, summary or null, quote or null, kind method/call/market_view/other, extraction_status } ] }`                                                                     |
| `claims.json`           | `{ claims: [ { id, type method/event_link/call/risk_rule, testability, statement, formalisation or null, vocabulary_gap or null, claimed_edge or null, experts[], items[] (item URLs), cluster_id or null } ] }`                                                    |
| `clusters.json`         | `{ clusters: [ { id, name, category, statement, canonical_text or null, testability, external_grade, evidence_links[ { url, note } ], vocabulary_gaps, closest_family or null, family_fit or null, supports[], contradicts[] (claim ids) } ] }`                     |
| `calls.json` (optional) | `{ calls: [ { claim_id (a claim of type call), market, code, direction long/short, call_d, horizon_sessions, target_micro or null, stop_micro or null, tracked bool } ] }`                                                                                          |

Rules the validator enforces:

- **Items are metadata only** (D-513): one item per `(url, content_hash)`; `summary` is our own text, at most 80 words and 800 characters; `quote` is one string of at most 15 words and 160 characters, one quoted span at most; all URLs are `http(s)`.
- **A red flag needs a source URL and a date** (D-521); an unsourced flag rejects the whole seed.
- **References resolve:** claim to experts, item URLs and cluster; cluster to claims; call to a claim of type `call`.
- **`family_fit`** (D-514) is `{ family: F1..F6, params: { key: finite number | boolean | enum word } }` (an enum word is `[a-z0-9_]{1,40}`, for a structural key such as `f1_momentum_variant`; never free text or an object) and only its shape is checked here; the keys and bounds are checked by the application at run time (every Lane-B key of the family must be present and inside its bounds), and a wrong fit is parked, never screened. F6 cannot be seeded this way (its `insider_score_weights` key is an object).
- **Expert arrays** (`platforms`, `home_urls`, `markets`, `focus`, `handles`) must also fit the 0022 JSON-column caps as JSON text (500 / 1,500 / 200 / 500 / 1,000 characters); `handles` keys are platform ids (`[a-z0-9_]{1,40}`).
- Licence status defaults to `unchecked` (D-520).

## What the import writes

In this order, one transaction (`INSERT ... ON CONFLICT DO NOTHING` on every key, so a re-run adds nothing): `expert`, `expert_red_flag`, `source_item` (id = lower-case hex sha256 of `url + '|' + (content_hash or '')`), `cluster`, `cluster_state` seq 1 `proposed`, `claim`, `claim_revision` seq 1, `claim_status` seq 1 `extracted` (every claim starts as an unchecked L0 hypothesis, D-512), `claim_expert`, `claim_item`, `claim_cluster` (supports/contradicts), `expert_call`. The chain rows (seq 1) are inserted only when missing, so a re-import never disturbs a later status.

## Converter contract

A private-side converter (not in this repository) turns the research notes into this folder. It must: emit the five files; write `family_fit` only for clusters approved by a reviewer; keep summaries to our own words; never store page text; and print counts only. `tests/experts/zzSeed.ts` is a complete synthetic example.
