# V2 go-live: your steps, in order

V2 is one pull request (`build` into `main`). Nothing below is done by the build. The same list is on the Go-live page under "V2 steps" (the tick marks there stay on your device only). Each step has an id in brackets; a test keeps this file and the page in step.

Rules of thumb: do the steps in this order; a step that says "after" needs the earlier one; production is a separate approval at the end.

## Before the first push

1. **Check the repo hygiene list** [v2_hygiene]. Every V2 document is on `scripts/ci/repo-hygiene.allow.json`. Run `npm run test:hygiene`.
2. **Push `build` and read the remote checks** [v2_push_ci]. The secret scan of history, the browser tests and the Linux jobs can differ from local. Merge only on green.

## On staging

3. **Migrations 0015 to 0025, in order** [v2_staging_migrations]. Check the 0020 rebuild of `email_message` (it copies every row of a live table, D-443) and the AT-42 recorded-day row. 0023 lets the nightly Cortex features be pruned after 400 days (V2-S2); the maintenance job does it. 0025 adds the listing table and a trigger that stops a delisted share from silently coming back (V1-S7).
4. **Vercel accepted the cron entries** [v2_cron_accepted]. After the first staging deploy, open the project's Cron Jobs list: all eight entries are there, each once, including the five whose path has a query string (`?try=2`, `?dst=aedt`). Vercel's own examples show plain paths; if any entry is missing or merged with another, tell the build before production (R2-I1, D-811). The evening check is accepted for the whole scheduled UTC hour plus Vercel's 59 minutes, by daylight-saving regime (D-800); the morning after a night it did not complete you get an alert (D-802).
5. **Run the two browser specs that never ran** [v2_e2e]: `e2e/picks-sections.spec.ts` (picks sections and the six-theme walk) and `e2e/m13l-experts.spec.ts`, against staging.
6. **Blueprint** [v2_blueprint]. Open `/blueprint` and its spec tab (no error 500). Open an exported `.drawio` in draw.io desktop and compare (D-369).
7. **Cortex import** [v2_cortex_import]. After 0020: `node scripts/cortex/import.mjs <artefact-folder>`. Confirm "families allowed 0". The CTX-052 AI warm-up then starts in staging; check that it ran. From then on the nightly review looks at every family once a quarter (V2-S1); on today's data that changes nothing.
8. **Review the 23 red-flag texts and `fits.json`** [v2_experts_review] (private folder `Requirement/v2/tools/m13/`). A wrong fit is parked at run time, never screened.
9. **Experts import** [v2_experts_import]. After 0022: `node scripts/experts/import.mjs <seed> --dry-run`; check 100 experts, 275 items, 60 groups, 347 claims; then run it without `--dry-run` with the staging database credentials.
10. **Add the regulator and paper hosts to `SOURCE_HOSTS`** [v2_source_hosts] (for example asic.gov.au, ssrn.com) so evidence links become real links (D-631).
11. **Confirm expert groups and claims** [v2_confirm_groups] in the claims queue ("Groups to confirm"). Until you do, the weekly experts stage reports "nothing eligible".
12. **Wire the R6 model** [v2_r6_model]. Run the bake-off (`llm-bake-off.yml`), assign the model in the roster, enable it. Review the 240,000 daily total against Groq's 200K tokens per model per day (D-481). Until then the steelman says "not written tonight".
13. **Quote source and slots** [v2_quote_slots]. Settle the endpoint note (V2-I3), then accept `yahoo_delayed` in Settings > Data sources (D-398) and list `quote-poll` and `intraday-scan`. Do not list the slots before the machine-route fix is deployed.

## Your approvals

14. **Tick the warned decisions** [v2_approvals] in the pull request description: D-371, D-443, D-445, D-462, D-481, D-490, D-510, D-527 and D-660, plus D-750 (intraday candidates are chosen on the sector-adjusted move where the industry has five or more stocks, else the raw move; the registered test text says so, D-806), D-740 to D-755 (the movers additions: shadow only, the Cortex v1 interpreter untouched), D-710 and D-718 (the money figures stay as the spec has them) and D-761 (the listing floor on lookbacks).
15. **Unmeasured items** [v2_unmeasured]: `node scripts/data/split-frequency.mjs --db ...` against staging (DAT-232), and the two free alternative universe sources in the licence register (O-53).
16. **Approve the money figures** [v2_money_constants]: the cost, tick, slippage and parcel figures listed on the Go-live page (V1-S2, D-710). Check them, then press "Approve the money figures" on that page and type the phrase it shows. It is Owner only and audited, and needs no code change (D-804, D-805). Production cannot switch to full mode until you have.

## Before production

17. **Time a production-size restore** [v2_restore_size]: `node scripts/restore/drill-size.mjs --rows 500000` once (synthetic rows, nothing leaves your machine). Write down the date, PASS or FAIL and the time it took, so the recovery time (NFR-004, at most 4 hours) is measured before the merge (R2-I7, D-813). Date run: ____ . Result and time: ____ .
18. **Try the rollback once on staging** [v2_rollback]. Follow `docs/runbooks/rollback-v2.md`: instant rollback first, the schema stays, and what a V1 rebuild needs.
19. **Green checks on the final commit, then approve production** [v2_production]. The Cortex stays in shadow and the steelman stays off in production until the Cortex import (step 7) and the R6 model (step 12) are done.
