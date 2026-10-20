# Operations guide

## What this is

This is your guide for running Praxis after go-live. Praxis is built to run on its own. Your main job is to read the 20:00 Evening Review. This guide lists the other jobs, when they are due, and what to do when something goes wrong. [OPS-001]

All times are Melbourne time. All money figures are simulated. Nothing here places a real order. [PRD-024]

Never paste a secret into chat, email, a file or a log. Enter secrets only in GitHub environment secrets, Vercel environment variables or Cloudflare Worker secrets. [SEC-101]

Never add a payment method to any provider. If a meter nears its limit, reduce the load instead. [PRD-007]

## How much time it takes

| How often | About how long | What |
|---|---|---|
| Every day | 3 minutes | Read the 20:00 Evening Review. |
| On an alert day | 1 minute per alert | Open the alert (P0 or P1) and act if it says so. |
| Every week | 30 minutes | The Saturday review. A release approval takes about 5 minutes. Releases come at most once a week. |
| Every month | 45 minutes | Licence check, $0 check, offsite backup download. |
| Every quarter | 1 to 2 hours | Restore drill, and any rotations that are due. |
| Once | about 2 hours | Go-live sign-off (see `M8_go_live.md`). |

There is no on-call rota. The response times below are targets for one person. [OPS-001]

## Where the checklist lives

Open the gear menu, then **Ops checklist**. It lists each task with a due date and a tick box. It is made by the app from the schedule below. The month and quarter counts start from your sign-off date. [OPS-020]

---

## Daily

1. Read the **20:00 Evening Review**. It arrives between 20:00 and 20:45. It is a short email. It also stays in the app under **Reviews**. [EML-010]
2. Look at section 9 of the review. It reports, for the night: whether jobs ran, whether the news watcher (Sentinel) was awake, the data-quality verdict, the corporate-action queue, the ledger checks, the quotas, the model fallbacks, the last backup, any source switched off and any open incident. [OPS-010]
3. If everything is green, you are done.
4. If a row is amber or red, open **System health** from the gear menu. Find that row and read its one-line reason and its fix link.

**What "partial" means.** If the pipeline ran late, the review says it is partial. It is still safe to read. The late parts follow. A missing review is a different case: see "Nightly job did not run" below. [EML-011]

**Alerts.** A P0 or P1 alert arrives by email and shows on the bell. Open it. Press **Acknowledge** to clear the bell count. Opening the list does not clear it. [UX-052]

**Morning email.** If you turned it on, it arrives at 08:00 on a trading day. [EML-016]

---

## Weekly (Saturday)

Allow about 30 minutes. [OPS-020]

1. **Corporate actions.** Open **Data review** from the gear menu. Only conflicts between sources land here. A single source that agrees with the price series is confirmed by itself. For each item compare the evidence (the announcement link and the price jump). Choose confirm, edit or reject. [DAT-221, OPS-033]
2. **System health trends.** Skim the trends. Look for a row that keeps going amber. [OPS-020]
3. **Challengers.** Review the challengers that wait for your approval. [VERIFY where this list sits; the Ops checklist row links to it]
4. **Release approval.** When the build agent has a release ready, it opens a pull request into `release`. You merge it. The deploy then waits for you in GitHub. You read it and approve it. Allow 5 minutes. See "Deploy" below. [OPS-041]

---

## Monthly

On the first Saturday of the month. Allow about 45 minutes. [OPS-020]

1. **Licence check.** Open `docs/source-licence-register.md` in the code repository, and the Data controls on System health. Re-check the terms of each source. If a source's terms forbid our use, switch it off. [DAT-120, OPS-036]
2. **Gmail filter.** Check the filter still sends reviews to the inbox, not to spam. [EML-036]
3. **SPF and DKIM.** Open one received Evening Review. In Gmail select the three dots, then **Show original**. Check SPF and DKIM both say PASS. [EML-036]
4. **Bake-off report.** Open **Usage** and read the latest model bake-off report. If no model passed, nothing changes: roles stay rules-only. [LLM-040, LLM-041]
5. **Usage trends.** Open **Usage**. Look for a meter that climbs month after month.
6. **$0 check.** Open the billing page of every provider and confirm no charge and no card. The list is in section I of `M8_go_live.md`. [PRD-007]
7. **GitHub settings.** Re-check three things: branch protection on `main` and `release`, "require approval for all external contributors" for fork pull requests, and secret scanning with push protection. [SEC-108 b, SEC-108 d, SEC-110 h]
8. **Tick** the row on the Ops checklist.

### Monthly, on the 1st: offsite backup

1. Open the private data repository. Open its **Releases**.
2. Download the latest encrypted backup and the history files.
3. Save them outside GitHub. Choose a place that does not depend on your sign-in Google account, such as a USB stick. [PLT-022b]
4. Run the local decrypt-only check with your offline key. The steps are in section I of `M1_owner_guide.md`.
5. Tick the Ops checklist row. System health warns you if it has been more than 40 days since the last tick. [PLT-022b]

---

## Quarterly

On 1 January, April, July and October. A reminder shows from day 75. The release gate needs a restore drill pass within 120 days. [OPS-020, TST-108]

1. **Restore drill.** Follow section H of `M8_go_live.md`. In short: add your offline private key and a new short-lived Turso token as secrets, run **Restore drill** with mode `drill`, then delete both secrets and revoke the token, then run again with mode `verify-removed`. From the first drill after go-live, the check replays one stored live cohort and compares it with its stored result. [TST-108]
2. **Staging sign-in.** Sign in once to staging, so Google keeps its OAuth client in use. [VERIFY Google's rule for unused clients]
3. **Rotations due.** If any secret is due, rotate it (see "Rotating a secret" below).

---

## Yearly

- **November: trading calendars.** Confirm the drafted calendars for next year. It is one click on System health. [DAT-160]
- **Secrets without an expiry date.** Rotate them once a year. Rows (c1) to (c4), (d), (e), (g), (n), (h), (i) and (j) are yearly. `PII_HASH_KEY` has no reminder in the app: put it in your own calendar. [SEC-021]
- **After 23 May 2027.** A review card asks for a re-check of the ASIC leverage label. If the card says "unchanged", do nothing. [ARN-049]

---

## Rotating a secret

1. You get reminders at 30, 14, 7 and 2 days before a date. System health lists every secret that expires in the next 60 days. Use that list before a planned absence. [SEC-021]
2. Use the table and steps in section F of `M8_go_live.md`. It lists, for each secret, every store to change.
3. Run the smoke test (section G). A rotation is done only when the smoke test passes for every rotated secret. [OPS-020, SEC-101]
4. Enter the new expiry date on System health.

---

## Incident response

### How bad is it?

| Level | Examples | Respond |
|---|---|---|
| S1 | A ledger check failed. Data may be corrupt. A secret leaked. Someone got in who should not. | The same day. Pause the market in System health, then follow the runbook. |
| S2 | The nightly run failed twice. The news watcher was blind for hours. The data-quality gate failed two nights. A quota is at 95 per cent. | Within 24 hours. |
| S3 | One data source is weak but the fallback works. One model provider is down. | At your next weekly review. |

[OPS-011, 11.4]

### Runbooks in plain words

For each: look, then act. Jobs are safe to run again. A job runs once per (job, market, date), so a repeat does nothing twice. [PLT-076]

**Nightly job did not run, or an email is missing (OPS-030).**

1. Open System health and read the run records.
2. Open GitHub **Actions** and look at the run list.
3. Check if a token has expired. The Worker dispatch token (b) is the usual cause. [PLT-074]
4. Start the workflow by hand: **Actions**, pick the workflow, **Run workflow**, branch `release`.
5. If the Worker itself is down, redeploy it (see "Redeploy the Worker").
6. If all steps ran but only the completion marker is missing, one re-run is enough. The re-run writes the marker.
7. During a Turso outage that ends within four hours, you may re-run the critical batch by hand the same night. If recovery takes longer than the next trading day, that day is skipped for trading and an incident shows in Settings. [OPS-030a]

**The news watcher (Sentinel) is blind (OPS-031).** Check the Worker logs and the last good poll for each source. Check the licence switches. Redeploy the Worker. If one source keeps failing, switch it off in Data controls. The others continue. [DAT-123]

**The data-quality gate failed (OPS-032).** Open System health, then the quality details for each tier. If the main source is down, check the fallback is used. If data is wrong for a few codes, leave them blocked: they resume on their own when checks pass. If it is wide, switch the source off and write it in the decision log.

**A corporate-action item (OPS-033).** Open **Data review**. Compare the evidence. Choose confirm, edit or reject. Blocked codes resume after reprocessing.

**A quota is at 90 per cent or more (OPS-034).** Open **Usage**. Find the user of the quota (market or job). Degrade mode already cuts non-essential work. You may pause a market that is in `testing` or `in build`. Never add a payment method.

**The model budget is used up, or a provider is down (OPS-035).** You do nothing. The system falls back to rules only. If it keeps happening, read the bake-off report. [LLM-050]

**A source objects or blocks us, for example ASX (OPS-036).** Switch the source off at once in Data controls. Write down the event and any letter in the licence register. Resume only with written permission.

**A secret may have leaked (OPS-037).** Use the emergency section (N) of `M8_go_live.md`. It has one short checklist for every secret: revoke, replace in every store, smoke test, record.

**The backup key may be exposed (OPS-037a).** Use the "(k)" block in section N of `M8_go_live.md`.

**Someone got in who should not (OPS-038).** Revoke the user in **Users & roles**. Sign everyone out. Rotate the session secret, row (c1). Read the audit events.

**A strange trade or profit figure (OPS-039).** Open the Decision Card and the fills. Check the corporate actions and the bars for those dates. If the data was wrong, correct it in **Data review**. The simulator reprocesses from that date. If it keeps happening, write a lesson.

**Restore a database (OPS-040).** The target is under four hours from when you start. [NFR-004]

1. **Step 0.** If a build-agent token exists, revoke it first. After go-live none exists.
2. **Step 1.** In Turso, create a short-lived platform token (narrowest create-database scope, shortest expiry). In GitHub environment `production`, add it as `TURSO_PLATFORM_TOKEN_TEMP`. Add your offline private key as `BACKUP_PRIVATE_KEY`.
3. **Step 2.** Run **Restore drill** with **mode** `restore`, **key** `real`, the backup tag you want (empty means latest), **targets** `main`, `auth` or `both`, and **confirm** `RESTORE`. It decrypts in memory, makes new databases, restores and checks the counts and checksums. It prints only the new database names.
4. **Step 3.** In Turso, create the new database's tokens, one per caller. Enter each token, with the new database address, in every store listed for it in the table in section F of `M8_go_live.md`. The main database goes in Vercel, GitHub and the Worker. The auth database goes in Vercel only. Then redeploy the current production deployment (same commit) and the Worker.
5. **Step 4.** Delete `TURSO_PLATFORM_TOKEN_TEMP` and `BACKUP_PRIVATE_KEY`. Revoke the token. The workflow fails until you do. Run it once with **mode** `verify-removed`.
6. **Step 5.** Run the smoke test. Record the incident.

If GitHub itself is down, the monthly offsite copy can be restored from a local machine with the same steps. That needs a technical helper or the build agent. The script is `scripts/restore/restore.mjs`. [OPS-040]

**You lost your Google account (OPS-040a).** Follow Google's own recovery first, with 2-step verification and your backup codes. If that fails, use the break-glass steps in section L of `M1_owner_guide.md`.

**A bad rule version (OPS-043).** Open Knowledge, then the family, then the version history. Choose rollback. It takes effect at the next cohort start. [KB-043]

**Vercel is paused or down for long (OPS-044).** The app is unreachable. The review arrives as the watchdog's short version. Open the Vercel dashboard and look for a usage or pause notice. Find the heavy user in the Usage history of the last short reviews. Reduce the load. Wait for the pause to lift or redeploy. Never add a payment method. The Actions batches keep data and ledgers current meanwhile.

**An unapproved production release (OPS-045).** This is an S1.

Signs: an S1 email, a watchdog failure, or a Vercel deployment email you did not expect.

1. Roll back production to the last approved commit (see "Roll back" below).
2. Rotate **every** production secret. Use the table in section F of `M8_go_live.md`. Also rotate the staging dispatch token (b-s) and the staging Resend key. Anything the bad code could read counts.
3. Sign everyone out: rotating row (c1) does it. The user session version is bumped too.
4. Reject any pending production deploy. Redeploy the known good commit with an explicit approval.
5. Compare **Users & roles** with the list you expect.
6. Run the ledger checks (ARN-101). If the user list, the audit trail or the ledgers look changed, restore from a backup from before the incident (OPS-040).
7. Review the commits on `release`.
8. Record the incident. Resume only after you approve a known good release.

The AT-05b test push is expected. It is not an incident. [AT-05b]

**Add or remove a user (OPS-060).** The first time, record the sharing acknowledgement. Then open **Users & roles**. The default role is Viewer. Removal is immediate. No Google console step is needed. [ROL-107]

**Start the next market (OPS-061).** Not part of the AU go-live. When AU meets the rules and you approve, the agent builds India, then the USA. [MKT-105, MKT-106]

---

## Deploy

All changes go in by pull request. [OPS-041]

- A merge into `main` deploys **staging only**: the staging app and the staging Worker. A failing test blocks it.
- For production, the agent opens a pull request into `release`, from a branch fixed at the chosen commit (`rc/<sha>`). You merge it.
- The `deploy-production` job then waits. GitHub emails you. Open **Actions**, open the run, select **Review deployments**, tick `deploy-production`, and select **Approve and deploy**. [SEC-108 c]
- The release gate must pass first. The gate checks the CI jobs, a staging full day, a restore drill in the last 120 days, a staging ZAP run and a recent nightly run. [TST-112]
- Every night the app checks the code that runs in production is the last approved commit. If the `release` head or the deployed commit differs and nobody approved it, you get an S1 incident. [SEC-108 d]
- Backups and archives go to the private data repository. They never start a deploy. [PLT-022a]

With the bot removed and "Do not allow bypassing" on, a pull request you wrote yourself cannot be approved by you. A code change needs the build agent to be added again with a new short-lived token (90 days at most). [SEC-102, SEC-108 e]

## Roll back (OPS-042)

Use this when the newest deployment is bad. It is fast and needs no pull request.

1. **Vercel.** Open the production project, then **Deployments**. Open the previous good deployment. Select **Promote to Production**. [VERIFY label]
2. **Worker.** Open the production Worker in Cloudflare, then **Deployments**. Roll back to the previous version.
3. Check the app and the next minute's Worker run record.
4. Revert the commit in the code. That needs a pull request, so ask for a build session. Until then the old deployment keeps running.
5. The nightly commit check compares the deployed commit with the last approved one. A rolled-back commit is an approved earlier commit, so it is accepted. [SEC-108 d, VERIFY]
6. Record what happened.

## Redeploy the Worker (OPS-050)

1. In GitHub **Actions**, run the Worker deploy workflow by hand on branch `release`. The first-step ref guard still applies. [VERIFY workflow name]
2. Approve `deploy-production` if it asks.
3. Check the next minute's run record on System health.

## Redeploy the app (same commit)

Use this after you change any Vercel environment variable. The new value is read only at the next deploy.

1. In GitHub **Actions**, open the last approved **Deploy production** run. Select **Re-run all jobs**.
2. Approve `deploy-production`. The commit is the same, so the approved-commit check stays green.

---

## Settings you can change, and ones you must not

| You may | You must not |
|---|---|
| Switch a market's data source on or off in Data controls. | Add a payment method to any provider. |
| Set email mode: `off`, `incidents` or `full`. In production, email cannot go `off` while a market is `full`. | Paste a key into chat, email or a file. |
| Tick or untick Worker slots on System health. Backup, maintenance and ingest batch 1 always run. | Put the backup private key on Vercel or Cloudflare. |
| Set the AU market to `data_only` to pause trading. | Put `TEST_IDENTITY_SECRET` in production. |
| Add or remove a user. | Approve a deploy you did not expect. |

## Known gaps to keep in mind

- The 20:40 and 21:50 watchdog runs are not on a schedule yet. The Watchdog workflow runs only when you or an Owner-approved schedule start it. You can start it by hand from **Actions** (slot `manual`). Ask the agent to add the schedule if you want it. [PLT-014a, M5 decision 11]
- Dividends are not included in pick tracking. The page says "Price only — dividends not included". [D-143]

## Where to find more

- `M8_go_live.md`: sign-off, the rotation table, the restore drill and the emergency checklist.
- `M1_owner_guide.md`: backups, decrypt a backup, maintenance and break-glass recovery.
- `M0_owner_guide.md`: accounts and where each secret goes.
- `docs/glossary.md`: plain meanings of the terms in the app and in the emails.
- `docs/config-reference.md`: every setting and its source.
- `docs/source-licence-register.md`: every data source and its terms.
