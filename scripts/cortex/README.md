# Cortex artefact import (Owner-run)

Loads the offline M15 artefacts (passports, ledger cells, maps, family evidence) into the main database. D-267: the artefacts are private data and live outside this repository; the script refuses a folder inside it.

```
node scripts/cortex/import.mjs <artefact-folder> --dry-run   # validates, prints counts only
node scripts/cortex/import.mjs <artefact-folder>             # writes; needs TURSO_MAIN_URL and TURSO_MAIN_TOKEN
```

Files (format `praxis-cortex-artefact/1`): `manifest.json`, `passports.json`, `cells.json`, `maps.json`, `evidence.json`. The full field list is the comment at the top of `import.mjs`.

- Every file is validated before anything is written; an error names the file and field, never a value.
- The target database must be at schema 19 or later.
- Matched cells are ledger cells of kind `matched_cell` (the cell statistic as the result); the per-family fields (`top3_min_s`, `family_mean_net`, `tiers`, `p_hidden`, `gain`, `loss`, `slots`) are in the map parameters (D-349); the placebo and NAV-at-risk results are ledger cells of kind `placebo` and `nav_at_risk` (D-357).
- A family status is never in the artefact: it comes from the CTX-053 rules (`src/lib/cortex/statusRules.mjs`) and is written as the evaluator row; an allowed family gets its "allowed to trade (weak test), live-tested pending" statement from the template. F7 is never allowed; an Owner kill is never overwritten.
- Re-running is safe: every insert is insert-or-ignore on its key; the output says what was written and what was already there.
