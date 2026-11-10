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
  const shas = await listApprovedShas(fetchImpl, token, repo, 1);
  return shas[0] ?? null;
}

/**
 * The commits of the newest approved deployments (of at most 30), newest first, distinct, at most
 * `max` of them (D-905: the replay-needed check compares the current deploy with the one before).
 * @param {(url: string, init: object) => Promise<{ status: number, json: () => Promise<unknown> }>} fetchImpl
 * @param {string} token
 * @param {string} repo "owner/name"
 * @param {number} max
 * @returns {Promise<string[]>}
 */
export async function listApprovedShas(fetchImpl, token, repo, max) {
  if (!token || !isValidRepo(repo))
    throw new Fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  const list = await getJson(
    fetchImpl,
    `${API}/repos/${repo}/deployments?environment=deploy-production&per_page=30`,
    token,
  );
  if (!Array.isArray(list)) throw new Fail("Unexpected deployments response.");
  const out = [];
  for (const d of list) {
    if (out.length >= max) break;
    const statuses = await getJson(fetchImpl, statusesUrl(d.statuses_url), token);
    if (!Array.isArray(statuses) || statuses.length === 0) continue;
    // Statuses come newest first; the latest one decides.
    if (statuses[0].state === "success") {
      if (typeof d.sha !== "string" || !SHA.test(d.sha)) {
        throw new Fail("Commit SHA is not a 40-character hex value.");
      }
      if (!out.includes(d.sha)) out.push(d.sha);
    }
  }
  return out;
}

/** GitHub's compare of two commits: the changed file names, or null when the list may be cut. */
export async function changedFiles(fetchImpl, token, repo, base, head) {
  const d = await changedFileDetails(fetchImpl, token, repo, base, head);
  return d === null ? null : d.map((x) => x.filename);
}

/**
 * The changed files with GitHub's patch text (null when GitHub leaves it out, e.g. a large or
 * binary file); null when the list is unknown (cut at 300, diverged or behind).
 */
export async function changedFileDetails(fetchImpl, token, repo, base, head) {
  if (!token || !isValidRepo(repo))
    throw new Fail("GITHUB_TOKEN and GITHUB_REPOSITORY are required.");
  if (!SHA.test(base) || !SHA.test(head))
    throw new Fail("Commit SHA is not a 40-character hex value.");
  const cmp = await getJson(fetchImpl, `${API}/repos/${repo}/compare/${base}...${head}`, token);
  const files = cmp?.files;
  if (!Array.isArray(files)) throw new Fail("Unexpected compare response.");
  // GitHub lists at most 300 files per compare; a longer change is treated as unknown.
  if (files.length >= 300 || cmp.status === "diverged" || cmp.status === "behind") return null;
  return files.map((f) => ({
    filename: String(f.filename),
    patch: typeof f.patch === "string" ? f.patch : null,
  }));
}
