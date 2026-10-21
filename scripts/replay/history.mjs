// Read side of the private data repo for the replay job (M4 T16; D-065 layout, DAT-140). Downloads
// every history release asset (`history-<source>-<yyyy>` releases, `<source>-<yyyy>-<mm>.jsonl.gz`
// assets) into one flat folder for scripts/replay/snapshot.mjs. HIGH-RISK like dataRepo.mjs: it holds
// DATA_REPO_TOKEN. The token goes only to api.github.com (fixed). An asset download answers with a
// redirect to a signed storage URL: that one hop is followed WITHOUT the token and only to a
// *.githubusercontent.com host. Errors carry the step name and status only.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-data$/;
const TAG_RE = /^history-[a-z_]+-\d{4}$/;
const ASSET_RE = /^[a-z_]+-\d{4}-\d{2}\.jsonl\.gz$/;
const STORAGE_HOST = /^[a-z0-9.-]+\.githubusercontent\.com$/;
const TIMEOUT_MS = 120_000;

export class HistoryReadError extends Error {
  /** @param {string} step @param {number | null} status */
  constructor(step, status) {
    super(`data repo ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "HistoryReadError";
  }
}

/**
 * @param {{ repo: string, token: string, dir: string, fetchImpl?: typeof fetch }} cfg
 * @returns {Promise<{ files: number, bytes: number }>}
 */
export async function downloadHistory({ repo, token, dir, fetchImpl = fetch }) {
  if (!REPO_RE.test(repo) || typeof token !== "string" || token === "") {
    throw new Error("data repo client misconfigured");
  }
  const auth = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const call = async (step, url, init) => {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new HistoryReadError(step, null);
    }
  };
  mkdirSync(dir, { recursive: true });
  const assets = [];
  for (let page = 1; page < 100; page += 1) {
    const res = await call(
      "list_releases",
      `${API}/repos/${repo}/releases?per_page=100&page=${page}`,
      {
        headers: auth,
      },
    );
    if (res.status !== 200) throw new HistoryReadError("list_releases", res.status);
    const list = await res.json();
    if (!Array.isArray(list)) throw new HistoryReadError("parse_releases", null);
    for (const r of list) {
      if (!TAG_RE.test(String(r?.tag_name))) continue;
      for (const a of Array.isArray(r.assets) ? r.assets : []) {
        if (ASSET_RE.test(String(a?.name)) && Number.isInteger(a?.id) && a.state === "uploaded") {
          assets.push({ id: a.id, name: String(a.name) });
        }
      }
    }
    if (list.length < 100) break;
  }
  let bytes = 0;
  for (const a of assets.sort((x, y) => (x.name < y.name ? -1 : 1))) {
    const first = await call("asset_redirect", `${API}/repos/${repo}/releases/assets/${a.id}`, {
      headers: { ...auth, Accept: "application/octet-stream" },
    });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      let target;
      try {
        target = new URL(first.headers.get("location") ?? "");
      } catch {
        throw new HistoryReadError("asset_location", null);
      }
      if (target.protocol !== "https:" || !STORAGE_HOST.test(target.hostname)) {
        throw new HistoryReadError("asset_host", null);
      }
      res = await call("asset_download", target.href, {});
    }
    if (res.status !== 200) throw new HistoryReadError("asset_download", res.status);
    const buf = new Uint8Array(await res.arrayBuffer());
    writeFileSync(path.join(dir, a.name), buf);
    bytes += buf.length;
  }
  return { files: assets.length, bytes };
}
