// SEC-108 c, d; BLD-011. Finds the commit of the latest APPROVED `deploy-production` deployment.
// A deployment counts as approved when its newest status is "success" (GitHub records that after
// the required reviewer approves); the lookup lives in approved-commit-core.mjs (shared with the
// production watchdog). Zero dependencies. Never prints the token.
// Writes `sha=<40 hex>` to $GITHUB_OUTPUT.
// EXPECT_COMMIT (optional, D-197): the commit the Worker's post-deploy step was started for. The
// Worker comes up inside the deploy job, before GitHub marks that deployment a success, so the
// lookup waits until the approved commit is that one, and fails if it never becomes it.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Fail, findApprovedSha, SHA } from "./approved-commit-core.mjs";

export const EXPECT_WAIT_MS = 30_000;
export const EXPECT_TRIES = 40; // 20 minutes; a deploy job takes about two

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns the process exit code. `out(line)` prints a line; env supplies the inputs. */
export async function run(env, fetchImpl, out = console.log, sleep = pause) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  try {
    if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
    }
    const expect = (env.EXPECT_COMMIT ?? "").trim();
    if (expect !== "" && !SHA.test(expect)) {
      throw new Fail("EXPECT_COMMIT is not a 40-character hex value.");
    }
    let sha = await findApprovedSha(fetchImpl, token, repo);
    for (let i = 1; expect !== "" && sha !== expect; i++) {
      if (i >= EXPECT_TRIES) {
        out(`::error::The approved commit is ${sha ?? "none"}, not the expected ${expect}.`);
        return 1;
      }
      out(`Waiting for the deploy of ${expect} to be approved (now ${sha ?? "none"}).`);
      await sleep(EXPECT_WAIT_MS);
      sha = await findApprovedSha(fetchImpl, token, repo);
    }
    if (sha === null) {
      if (env.ALLOW_BOOTSTRAP === "true") {
        sha = env.GITHUB_SHA;
        out(
          "::warning::No approved deploy-production deployment yet (awaiting first approval) — bootstrap exemption BLD-011: using the release head.",
        );
      } else {
        out(
          "::error::No approved deploy-production deployment yet (awaiting first approval, SEC-108 d).",
        );
        return 1;
      }
    }
    if (typeof sha !== "string" || !SHA.test(sha))
      throw new Fail("Commit SHA is not a 40-character hex value.");
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `sha=${sha}\n`);
    out(`Approved commit: ${sha}`);
    return 0;
  } catch (e) {
    out(`::error::approved-commit failed: ${e instanceof Fail ? e.message : "request failed"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await run(process.env, fetch));
}
