# Rolling back from V2 to V1

Applies once migrations 0015 to 0026 have reached a database. Rehearse it once on staging before production (V2 go-live step "Try the rollback once").

## What stays true

- V1 code never reads the V2 tables and the V2 changes to old tables are additive, so a V1 deployment runs correctly on a V2 database. The Worker and the workflows on `main` keep working.
- Nothing in V2 trades money on its own: every Cortex family is in shadow, so there is no position to unwind.

## Level 1: instant rollback (no build, minutes)

Use this first. In Vercel, promote the last good V1 deployment (Deployments, the V1 build, "Instant Rollback"). No build runs, so the migration step is not involved. The schema stays at 0026. Before the V1 code runs against it, do the pre-check under "Before V1 runs on the V2 database" below. Re-promote the V2 deployment to go forward again.

## Level 2: a V1 rebuild or hotfix on the V2 database

A V1 build runs `node scripts/db/migrate.mjs --if-vercel`. The V1 copy of that script stops with `applied migration 15 has no file` because the database is ahead of the V1 tree. Pick one:

1. **Tolerate the newer schema (recommended, keeps data).** Put the V2 tolerance on `main`/`release` as one small commit and set `MIGRATE_ALLOW_NEWER=1` for the Production environment in Vercel:
   - in `src/lib/db/migrate-core.mjs` take the `migrateUp(db, migrations, opts)` change from the V2 tree: versions after the tree's last file are skipped when `allowNewer` is true; a changed checksum or a missing file inside the tree still throws;
   - in `scripts/db/migrate.mjs` pass `{ allowNewer: process.env.MIGRATE_ALLOW_NEWER === "1" }` to `migrateUp`.
   - With the variable unset the old strict behaviour stays. Remove the variable when you are back on V2.
2. **Step the schema down to V1.** From a V2 checkout, with the database credentials for that database in the environment:
   - `node scripts/db/migrate.mjs --db main --down-to 14 --confirm-down`
   - It runs the `-- +down` sections of 0026 to 0015, newest first, and then the V1 tree accepts the database with no flag. Going forward again is a normal `migrate.mjs --db main`.
   - **This deletes data.** Take a backup first (the nightly backup, or run `scripts/backup` by hand and keep the file). What goes: every Cortex, intraday, steelman and experts table with its rows; the 0024 movers tables `announcement_archive`, `halt_watch`, `intraday_arm`, `sector_composite_daily` and `angle_forward_flag`; the 0025 table `instrument_listing` and the trigger `instrument_no_revive`; the 0026 table `run_now_request` (the Owner's manual-run requests; the audit log keeps who asked); 0020 also deletes every `pick_*` e-mail row and attempt (it restores the narrower `email_message` kind list); 0016 and 0017 take back the "known at" and "first seen" additions.
   - The auth database has no V2 migrations; do not run `--db auth` down.
   - **`instrument_listing` holds Owner decisions** (the confirmed relist and code-reuse decisions, V1-S7) that cannot be rebuilt from any feed, and it is append-only by trigger, so a down section is the only thing that removes it. **Export it first**, from the V2 checkout with `TURSO_MAIN_URL` and `TURSO_MAIN_TOKEN` set (keep the file outside the repository):
     `node --input-type=module -e "import {createClient} from '@libsql/client'; import fs from 'node:fs'; const c=createClient({url:process.env.TURSO_MAIN_URL,authToken:process.env.TURSO_MAIN_TOKEN}); const r=await c.execute('SELECT * FROM instrument_listing'); fs.writeFileSync('instrument_listing.json',JSON.stringify(r.rows,null,1)); console.log(r.rows.length,'rows')"`
     The same listing is `SELECT * FROM instrument_listing`. After going forward again (`migrate.mjs --db main`), re-insert each saved row with `INSERT INTO instrument_listing (market, code, listed_on, name, prior_name, prior_delisted_on, decided_by, created_at) VALUES (...)`. The instrument rows keep their `reuse_confirmed` / `relist_confirmed` reasons through the rollback, so the decisions are not lost, but the lookback floor they set is gone until the rows are back.
   - The other dropped tables (the 0024 movers tables, intraday, Cortex, steelman, experts) are derived or re-collected data; accept their loss or copy them first the same way.

## Before V1 runs on the V2 database (Level 1 and Level 2 option 1; R3-I1, D-819)

The 0025 trigger `instrument_no_revive` is still in the schema. V1's nightly universe import reactivates every returning delisted code with `delisted_on = NULL, delist_reason = NULL` in one write batch, and a row V2 quarantined (`delist_reason` starting `code_reuse_suspected:`) trips the trigger and **aborts the whole V1 batch, every night**, until the row is decided. Check first, with the database credentials for that database:

`SELECT market, code, delisted_on, delist_reason FROM instrument WHERE delist_reason LIKE 'code_reuse_suspected:%';`

For each row returned, decide it (no row, nothing to do):

- **Still on V2 / V2 reachable:** use the Owner decision on the Data page (same company relisted, or a different company, code reuse). That is the audited path and writes the reason `relist_confirmed:...` or `reuse_confirmed:...`.
- **V2 is no longer reachable:** if it is the same company, `UPDATE instrument SET delist_reason = 'relist_confirmed:manual-rollback:' || substr(delist_reason, length('code_reuse_suspected:') + 1) WHERE market = ? AND code = ? AND delist_reason LIKE 'code_reuse_suspected:%'`. If it is a different company (code reuse), V1 cannot tell the two companies apart (it has no listing floor), so either leave the code delisted by keeping the row quarantined **and** accept that V1's import fails, or step down to V1 (option 2 above), which drops the trigger and lets V1 treat it as V1 always did. Record the choice.
- Do not clear `delist_reason` to NULL by hand: the trigger refuses that revival too.

## After a rollback

- Check System Health on the rolled-back deployment. The Worker slots `quote-poll` and `intraday-scan` call V2 routes: unlist them in System Health first if you rolled the app back (they would only fail).
- Record what you did and why in `docs/06_open_questions.md`.

## Tested

`tests/db/0023_feature_retention.test.ts` covers: an older tree failing by default and tolerating the newer database only on request; the checksum guard; `--down-to 14` from 0026 and back up to a schema identical to a fresh one; the CLI refusing `--down-to` without `--confirm-down`. `tests/db/0024_movers.test.ts` and `tests/db/0025_instrument_listing.test.ts` and `tests/jobs/runNowAction.test.ts` (0026: append-only triggers) (the 0025 down path at line 29: table and both triggers go, the schema comes back identical) cover each new step on its own. `tests/golive/v2steps.test.tsx` asserts that this runbook names the newest migration version in `db/migrations/main` (R3-S2).

## Migration "down" policy (V1-I5, D-798)

- **Production is forward-only.** The deploy build runs `migrate.mjs` up only (`--if-vercel`); it never runs a down section. A bad migration is fixed by a new forward migration (expand, then contract), or by Level 1 above while the fix is built.
- **`-- +down` sections exist for tests and for the staged rollback only.** TST-125 proves up, down and up again gives the same schema (`migrateDown` in `src/lib/db/migrate-core.mjs`). The one supported use outside tests is the Owner-run `--down-to <version> --confirm-down` of Level 2, option 2 (D-703), always after a backup, on a database where the loss of the newer tables' data is accepted.
- **A down section is not a promise of data recovery.** It restores the schema shape, not deleted rows (see "This deletes data").
- **Auth database:** no down path is used; never run `--db auth` down.
- D-030 ("TST-125 needs up and down") is read this way: the down sections serve the test, not a production workflow.
