// Read side of the private DATA repo for the restore workflow (TST-108, OPS-040 step 2): finds the
// latest (or a named) `backup-<date>` release and downloads its encrypted assets. HIGH-RISK like
// scripts/replay/history.mjs: it holds the data-repo read token (f). The token goes only to
// api.github.com (fixed). An asset download answers with a redirect to a signed storage URL: that
// one hop is followed WITHOUT the token and only to a *.githubusercontent.com host. Errors carry
// the step name and status only: never a URL, a token or a body.
const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-data$/;
export const TAG_RE = /^backup-\d{4}-\d{2}-\d{2}$/;
const STORAGE_HOST = /^[a-z0-9.-]+\.githubusercontent\.com$/;
const TIMEOUT_MS = 120_000;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;

export class AssetError extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`data repo ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "AssetError";
  }
}

/**
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch }} cfg
 */
export function createBackupReader({ repo, token, fetchImpl = fetch }) {
  if (!REPO_RE.test(repo) || typeof token !== "string" || token === "") {
    throw new Error("data repo client misconfigured");
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const guarded = async (step, url, init) => {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AssetError(step, null);
    }
  };

  /** Backup releases, newest tag first: [{ tag, assets: Map<name, id> }]. */
  async function listBackups() {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const res = await guarded(
        "list_releases",
        `${API}/repos/${repo}/releases?per_page=100&page=${page}`,
        {
          method: "GET",
          headers,
        },
      );
      if (res.status !== 200) throw new AssetError("list_releases", res.status);
      const items = await res.json().catch(() => null);
      if (!Array.isArray(items)) throw new AssetError("list_releases", null);
      for (const r of items) {
        if (typeof r?.tag_name !== "string" || !TAG_RE.test(r.tag_name)) continue;
        const assets = new Map();
        for (const a of Array.isArray(r.assets) ? r.assets : []) {
          if (Number.isInteger(a?.id) && typeof a?.name === "string") assets.set(a.name, a.id);
        }
        out.push({ tag: r.tag_name, assets });
      }
      if (items.length < 100) break;
    }
    return out.sort((a, b) => (a.tag < b.tag ? 1 : -1));
  }

  async function download(id) {
    const first = await guarded("download_asset", `${API}/repos/${repo}/releases/assets/${id}`, {
      method: "GET",
      headers: { ...headers, Accept: "application/octet-stream" },
    });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      let target;
      try {
        target = new URL(String(first.headers.get("location")));
      } catch {
        throw new AssetError("download_asset", null);
      }
      if (target.protocol !== "https:" || !STORAGE_HOST.test(target.hostname)) {
        throw new AssetError("download_asset", null);
      }
      res = await guarded("download_asset", target.href, { method: "GET" });
    }
    if (res.status !== 200) throw new AssetError("download_asset", res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new AssetError("download_asset", null);
    return bytes;
  }

  return {
    listBackups,
    /**
     * Download the encrypted asset of each database for ONE backup release: the named tag, or the
     * newest release that holds every wanted asset.
     * @param {{ tag?: string, names: Record<string, (tag: string) => string> }} want
     * @returns {Promise<{ tag: string, data: Record<string, Uint8Array> }>}
     */
    async fetchBackup({ tag, names }) {
      const backups = await listBackups();
      const dbs = Object.keys(names);
      const pick = backups.find(
        (b) =>
          (tag === undefined || tag === "" || b.tag === tag) &&
          dbs.every((db) => b.assets.has(names[db](b.tag))),
      );
      if (!pick) throw new AssetError("find_backup", null);
      const data = {};
      for (const db of dbs) data[db] = await download(pick.assets.get(names[db](pick.tag)));
      return { tag: pick.tag, data };
    },
  };
}
