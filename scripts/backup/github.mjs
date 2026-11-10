// Minimal GitHub release client for the DATA repo (PLT-022a/b). Zero dependencies; the token
// only ever goes to api.github.com and uploads.github.com (hosts are fixed here, never taken from
// a response). Errors carry the HTTP status only: never a URL, a token or a response body.
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;

export class GithubError extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`github ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.step = step;
    this.status = status;
  }
}

/**
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch }} cfg
 */
export function createGithub({ repo, token, fetchImpl = fetch }) {
  if (!REPO_RE.test(repo) || typeof token !== "string" || token === "") {
    throw new Error("github client misconfigured");
  }
  const base = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function call(step, url, init, timeoutMs = TIMEOUT_MS) {
    try {
      return await fetchImpl(url, {
        ...init,
        headers: { ...base, ...(init.headers ?? {}) },
        redirect: init.redirect ?? "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new GithubError(step, null);
    }
  }

  async function getRelease(tag) {
    const res = await call(
      "get_release",
      `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { method: "GET" },
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw new GithubError("get_release", res.status);
    return normalise(await res.json());
  }

  /** INFRA T5: the bytes of one release asset (null when the release or the asset is missing). */
  async function downloadAsset(tag, name) {
    const res = await call(
      "get_release",
      `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { method: "GET" },
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw new GithubError("get_release", res.status);
    const raw = await res.json();
    const asset = Array.isArray(raw?.assets) ? raw.assets.find((a) => a?.name === name) : null;
    if (!asset || !Number.isInteger(asset.id)) return null;
    const first = await call(
      "download_asset",
      `${API}/repos/${repo}/releases/assets/${asset.id}`,
      { method: "GET", headers: { Accept: "application/octet-stream" }, redirect: "manual" },
      UPLOAD_TIMEOUT_MS,
    );
    let body = first;
    if (first.status >= 300 && first.status < 400) {
      // The storage host gets NO Authorization header and must be a GitHub content host.
      let loc;
      try {
        loc = new URL(String(first.headers.get("location")));
      } catch {
        throw new GithubError("download_asset", null);
      }
      if (loc.protocol !== "https:" || !/(^|[.])githubusercontent[.]com$/.test(loc.hostname)) {
        throw new GithubError("download_asset", null);
      }
      try {
        body = await fetchImpl(loc.href, {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch {
        throw new GithubError("download_asset", null);
      }
    }
    if (body.status !== 200) throw new GithubError("download_asset", body.status);
    return new Uint8Array(await body.arrayBuffer());
  }

  return {
    getRelease,
    downloadAsset,

    /** Existing release for the tag, or a newly created one (idempotent). */
    async ensureRelease(tag) {
      const found = await getRelease(tag);
      if (found) return found;
      const res = await call("create_release", `${API}/repos/${repo}/releases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          name: tag,
          body: "",
          draft: false,
          prerelease: false,
          make_latest: "false",
        }),
      });
      if (res.status === 201) return normalise(await res.json());
      // Lost a race with a parallel run: the release exists now.
      const again = res.status === 422 ? await getRelease(tag) : null;
      if (again) return again;
      throw new GithubError("create_release", res.status);
    },

    /** @param {number} releaseId @param {string} name @param {Uint8Array} bytes */
    async uploadAsset(releaseId, name, bytes) {
      const res = await call(
        "upload_asset",
        `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
        UPLOAD_TIMEOUT_MS,
      );
      if (res.status !== 201) throw new GithubError("upload_asset", res.status);
    },

    /** All releases, newest first (paged, capped at 10 pages of 100). */
    async listReleases() {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const res = await call(
          "list_releases",
          `${API}/repos/${repo}/releases?per_page=100&page=${page}`,
          { method: "GET" },
        );
        if (res.status !== 200) throw new GithubError("list_releases", res.status);
        const items = await res.json();
        if (!Array.isArray(items)) throw new GithubError("list_releases", null);
        out.push(...items.map(normalise));
        if (items.length < 100) break;
      }
      return out;
    },

    /** Delete a release and its tag. */
    async deleteRelease(id, tag) {
      const del = await call("delete_release", `${API}/repos/${repo}/releases/${id}`, {
        method: "DELETE",
      });
      if (del.status !== 204 && del.status !== 404)
        throw new GithubError("delete_release", del.status);
      const ref = await call(
        "delete_tag",
        `${API}/repos/${repo}/git/refs/tags/${encodeURIComponent(tag)}`,
        { method: "DELETE" },
      );
      if (ref.status !== 204 && ref.status !== 404 && ref.status !== 422) {
        throw new GithubError("delete_tag", ref.status);
      }
    },
  };
}

function normalise(r) {
  if (!r || typeof r !== "object" || !Number.isInteger(r.id) || typeof r.tag_name !== "string") {
    throw new GithubError("parse_release", null);
  }
  const assets = Array.isArray(r.assets) ? r.assets.map((a) => String(a?.name)) : [];
  // createdAt only when the API sent it (INFRA T5: "newest backup" compares real times).
  return {
    id: r.id,
    tag: r.tag_name,
    assets,
    ...(typeof r.created_at === "string" ? { createdAt: r.created_at } : {}),
  };
}
