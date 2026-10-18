// Write-once history files in the PRIVATE data repo (M2 T9; DAT-140 release assets, PLT-022a,
// D-044 release layout, D-048-style fixed hosts). Zero dependencies. HIGH-RISK: it holds
// DATA_REPO_TOKEN. Rules:
//  - the token is sent only to api.github.com and uploads.github.com, both fixed here; no host is
//    ever taken from a response, a redirect is an error (`redirect: "error"`);
//  - errors carry the step name and the HTTP status only: never a URL, a token or a body;
//  - a file that is already there with the same SHA-256 is skipped (idempotent re-run); a file
//    with the same name and DIFFERENT content is a conflict and is never overwritten or deleted
//    (the private repo is the long-term copy once Turso has pruned the rows, DAT-142);
//  - nothing is ever deleted from the data repo by this module.
import { sha256Hex } from "./rules.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-data$/;
// M4 T16: replay outputs use release `replay-<yyyy>-<mm>`, assets `replay-<run>-<part>.jsonl.gz`.
const TAG_RE = /^(history-[a-z_]+-\d{4}|replay-\d{4}-\d{2})$/;
const ASSET_RE = /^([a-z_]+-\d{4}-\d{2}|replay-[a-z0-9-]{1,150})\.jsonl\.gz$/;
const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export class HistoryError extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`data repo ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "HistoryError";
    this.step = step;
    this.status = status;
  }
}

export class HistoryConflict extends Error {
  /** @param {string} asset */
  constructor(asset) {
    super(`history file ${asset} exists with different content`);
    this.name = "HistoryConflict";
    this.asset = asset;
  }
}

/**
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch }} cfg
 *   `repo` must be `<owner>/<name>-data` (the private data repository, PLT-022a).
 */
export function createHistoryStore({ repo, token, fetchImpl = fetch }) {
  if (!REPO_RE.test(repo) || typeof token !== "string" || token === "") {
    throw new Error("data repo client misconfigured");
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
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HistoryError(step, null);
    }
  }

  const json = async (step, res) => {
    try {
      return await res.json();
    } catch {
      throw new HistoryError(step, null);
    }
  };

  /** The release for a tag with its assets, or null when it does not exist. */
  async function getRelease(tag) {
    const res = await call(
      "get_release",
      `${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { method: "GET" },
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw new HistoryError("get_release", res.status);
    const r = await json("get_release", res);
    if (!r || !Number.isInteger(r.id) || r.tag_name !== tag) {
      throw new HistoryError("parse_release", null);
    }
    const assets = Array.isArray(r.assets) ? r.assets : [];
    return {
      id: /** @type {number} */ (r.id),
      assets: assets.map((a) => ({
        name: String(a?.name),
        size: Number(a?.size),
        digest: typeof a?.digest === "string" ? a.digest : null,
        state: typeof a?.state === "string" ? a.state : "uploaded",
      })),
    };
  }

  async function ensureRelease(tag) {
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
    if (res.status === 201)
      return { id: Number((await json("create_release", res)).id), assets: [] };
    // Lost a race with a parallel run: the release exists now.
    const again = res.status === 422 ? await getRelease(tag) : null;
    if (again) return again;
    throw new HistoryError("create_release", res.status);
  }

  return {
    /**
     * Write one month file unless it is already there with the same content.
     * @param {{ tag: string, asset: string }} location  from `historyLocation`
     * @param {Uint8Array} bytes
     * @returns {Promise<{ result: "uploaded" | "skipped", sha256: string }>}
     */
    async put(location, bytes) {
      if (!TAG_RE.test(location.tag) || !ASSET_RE.test(location.asset)) {
        throw new Error("bad history location");
      }
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error("bad history size");
      const sha256 = sha256Hex(bytes);
      const release = await ensureRelease(location.tag);
      const existing = release.assets.find((a) => a.name === location.asset);
      if (existing) {
        const same =
          existing.state === "uploaded" &&
          (existing.digest !== null && existing.digest.startsWith("sha256:")
            ? existing.digest === `sha256:${sha256}`
            : existing.size === bytes.length);
        if (same) return { result: "skipped", sha256 };
        throw new HistoryConflict(location.asset);
      }
      const res = await call(
        "upload_asset",
        `${UPLOADS}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(location.asset)}`,
        { method: "POST", headers: { "Content-Type": "application/gzip" }, body: bytes },
        UPLOAD_TIMEOUT_MS,
      );
      if (res.status !== 201) throw new HistoryError("upload_asset", res.status);
      return { result: "uploaded", sha256 };
    },
  };
}
