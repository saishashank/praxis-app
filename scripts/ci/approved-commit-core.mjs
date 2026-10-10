// SEC-108 c, d. Pure logic shared by scripts/ci/approved-commit.mjs (Actions) and the production
// watchdog (src/lib/watchdog/approvedCommit.ts): find the commit of the latest APPROVED
// `deploy-production` deployment. A deployment counts as approved when its newest status is
// "success" (GitHub records that after the required reviewer approves). No dependencies, no file
// access. Error messages are fixed text or an HTTP status only; the token is never put in one.

export const SHA = /^[0-9a-f]{40}$/;
export const API = "https://api.github.com";
// GitHub owner (letters, digits, hyphens) / repo (no leading dot, so "." and ".." are refused).
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export class Fail extends Error {}

export function isValidRepo(repo) {
  return typeof repo === "string" && REPO.test(repo);
}

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

/**
 * Returns the 40-hex commit of the newest deployment (of at most 30) whose latest status is
 * "success", or null when none exists. Throws Fail on any GitHub or format problem.
 * @param {(url: string, init: object) => Promise<{ status: number, json: () => Promise<unknown> }>} fetchImpl
 * @param {string} token
 * @param {string} repo "owner/name"
 * @returns {Promise<string | null>}
 */
export async function findApprovedSha(fetchImpl, token, repo) {
  if (!token || !isValidRepo(repo))
    throw new Fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  const list = await getJson(
    fetchImpl,
    `${API}/repos/${repo}/deployments?environment=deploy-production&per_page=30`,
    token,
  );
  if (!Array.isArray(list)) throw new Fail("Unexpected deployments response.");
  for (const d of list) {
    const statuses = await getJson(fetchImpl, statusesUrl(d.statuses_url), token);
    if (!Array.isArray(statuses) || statuses.length === 0) continue;
    // Statuses come newest first; the latest one decides.
    if (statuses[0].state === "success") {
      if (typeof d.sha !== "string" || !SHA.test(d.sha)) {
        throw new Fail("Commit SHA is not a 40-character hex value.");
      }
      return d.sha;
    }
  }
  return null;
}
