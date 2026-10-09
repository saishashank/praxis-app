// SEC-108 c, d; BLD-011. Finds the commit of the latest APPROVED `deploy-production` deployment.
// A deployment counts as approved when its newest status is "success" (GitHub records that after
// the required reviewer approves). Zero dependencies. Never prints the token.
// Writes `sha=<40 hex>` to $GITHUB_OUTPUT.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const API = "https://api.github.com";

class Fail extends Error {}

async function getJson(fetchImpl, url, token) {
  const res = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status !== 200) throw new Fail(`GitHub API returned HTTP ${res.status}`);
  return res.json();
}

function statusesUrl(u) {
  // Only follow statuses_url values that stay on the GitHub API host (the token must not leak).
  const url = new URL(u);
  if (url.origin !== API) throw new Fail("Unexpected statuses_url host.");
  url.searchParams.set("per_page", "10");
  return url.toString();
}

/** Returns the process exit code. `out(line)` prints a line; env supplies the inputs. */
export async function run(env, fetchImpl, out = console.log) {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  try {
    if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
    }
    const list = await getJson(
      fetchImpl,
      `${API}/repos/${repo}/deployments?environment=deploy-production&per_page=30`,
      token,
    );
    if (!Array.isArray(list)) throw new Fail("Unexpected deployments response.");
    let sha = null;
    for (const d of list) {
      const statuses = await getJson(fetchImpl, statusesUrl(d.statuses_url), token);
      if (!Array.isArray(statuses) || statuses.length === 0) continue;
      // Statuses come newest first; the latest one decides.
      if (statuses[0].state === "success") {
        sha = d.sha;
        break;
      }
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
