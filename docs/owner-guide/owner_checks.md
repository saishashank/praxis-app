# Owner-run checks

Five checks only you can do. Each has a script (or a button), the steps in plain words, and where Praxis reminds you. Never paste a secret into chat, email, a file, an issue or a log. [SEC-101]

| Check | How often | Script or button | Reminder |
|---|---|---|---|
| Restore drill with your real key | Every quarter | Actions, "Restore drill" workflow | System Health shows "Quarterly restore drill due" on the first day of each quarter until it is done |
| Golden-set spot check | When asked, and after a model change | `scripts/cortex/golden-spot-check.mjs` | Listed under "Owner steps after merge" in the pull request (no clock reminder yet) |
| Bake-off review | After each bake-off run | `scripts/llm/bakeoff-review.mjs` | Listed under "Owner steps after merge" in the pull request (no clock reminder yet) |
| Blueprint visual look | After a Blueprint change | The Blueprint page and its export | Listed under "Owner steps after merge" |
| Keyboard and screen-reader check (AT-26 s11) | At go-live and after a big screen change | Your keyboard and your screen reader | Listed under "Owner steps after merge" |

## 1. Restore drill with your real key (OPS-105, TST-137)

**What it proves.** That a real backup can be opened with your private key and rebuilt into a working database. A backup you have never restored is only a hope.

**Before you start.** Open the "Restore drill" workflow on the release branch (Actions tab). You need your private backup key and a temporary Turso platform token. Both are temporary secrets: you add them for this run and delete them after.

1. Add the two temporary secrets to the `production` GitHub environment. [SEC-017 l]
2. Run the workflow with `mode` = `drill`, `environment` = `production`, `key` = `real`, and `backup` empty (the latest backup). It restores into throwaway databases and deletes them.
3. Read the job summary. It shows table names, row counts, PASS or FAIL and the time taken. It never shows a row, a URL or a token.
4. Delete both temporary secrets.
5. Run the workflow again with `mode` = `verify-removed`. It skips the drill and ends green only when both secrets are gone. Until then the last step fails on purpose and GitHub emails you.

**Between real drills.** The "Restore dry run" workflow runs by itself on the first day of each quarter with synthetic backups and a throwaway key. It needs no secret and proves the drill still works. It is not a replacement for step 2: System Health keeps showing "Quarterly restore drill due" until a real-key drill and a green `verify-removed` run exist in that quarter.

**If it fails.** Do not delete the temporary secrets yet. Read the failing step name in the summary, then see `scripts/restore/README.md`.

## 2. Golden-set spot check (CXA-008, TST-137)

**What it shows.** How often your judgement and the stored label agree. Praxis draws 20 random labels, you write the label you would give each one without seeing the stored one, and the script prints the agreement and a chance-corrected score (Cohen's kappa). This milestone only measures; the pass mark that acts on it arrives in M23.

1. In a terminal in the repository, with the production database settings in your environment (never in a file): `node scripts/cortex/golden-spot-check.mjs --seed 1 --template answers.json`. It prints a table of 20 rows (execution, rule version, variant, day) and writes `answers.json` with an empty answer for each row id.
2. Fill in `answers.json`: for each id write one of the label words the script lists (for example `UNVALIDATED`, `FAILED`, `possible luck`). Leave a row empty if you cannot decide; it counts as unanswered.
3. Run it again with your answers: `node scripts/cortex/golden-spot-check.mjs --seed 1 --answers answers.json`. Use the same seed, so you are judging the same 20 rows.
4. It prints the agreement in percent with the counts, the kappa, and how many were unanswered. It records one run for that day (`golden-spot-check:<date>`), visible in the run records; a second run on the same day writes nothing more.
5. Tell the builder the two numbers. Keep `answers.json` out of the repository.

## 3. Bake-off review (LLM-077, TST-137)

**What it is for.** After the LLM bake-off workflow has run on a model, you read the report and decide which role (R1, R2, R3, R5 or R6) that model may serve in production.

1. Run the "LLM bake-off" workflow (Actions) with the candidate model. Commit the report it produces under `docs/test-reports/`.
2. Run `node scripts/llm/bakeoff-review.mjs --role R6` (use the role you are thinking of). It lists every bake-off report with the PASS or FAIL line of each model, and prints the exact `llm_live_roles` edit you would make for each model that passed.
3. Read the report itself before you decide: a PASS needs every check, a dated "trains on prompts" answer, and a model that does not train on prompts.
4. **The setting `llm_live_roles` does not exist yet.** It arrives with milestone M22 (LLM-077). Until then the script says so and the edit is a plan: do not try to type it anywhere.

## 4. Blueprint visual look (AT-59, UXN-324 c)

The tests prove the exported draw.io file has exactly the nodes and arrows of the model. They cannot tell whether the diagram looks right. After a Blueprint change:

1. Open the Blueprint page, pick each of the eight views, and use Export as draw.io.
2. Open the file in draw.io. Check that boxes do not overlap, labels are readable and each view tells the story its tab names.
3. Note anything that looks wrong and tell the builder. A wrong look does not block a release; a wrong count would have failed the tests.

## 5. Keyboard and screen-reader check (AT-26, s11)

The automated lanes (accessibility, mobile, Lighthouse and keyboard) run in CI. The one thing they cannot do is listen to a screen reader.

1. With only the keyboard, walk the six main tabs: Tab and Shift+Tab move, Enter opens, Escape closes. Every control you can see must be reachable and show where you are.
2. Turn on your screen reader (for example NVDA on Windows or VoiceOver on a Mac) and walk the same six tabs. Headings, buttons and the numbers on each screen should read in an order that makes sense, with the Simulated label read out where money is shown.
3. Report any screen where you got stuck or lost. Sign-off is yours.
