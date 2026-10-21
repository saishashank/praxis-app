// Git Data API client for the PRIVATE data repo (KB-001, PLT-022a, M6 T13, decisions 29-30).
// HIGH-RISK: it holds DATA_REPO_TOKEN. Rules (the same as scripts/replay/history.mjs and
// src/lib/data/backfill/dataRepo.mjs):
//  - the token is sent only to https://api.github.com (fixed here); no host or URL is ever taken
//    from a response, and a redirect is an error (`redirect: "error"`);
//  - errors carry the step name and the HTTP status only: never a URL, a token or a body;
//  - the repo name must be `<owner>/<name>-data` (the private data repository, never the code repo);
//  - nothing is deleted, no ref is forced: the branch is moved fast-forward only.
import { createHash } from "node:crypto";

export const GITHUB_API = "https://api.github.com";
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+-data$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 60_000;

export class GitDataError extends Error {
  readonly step: string;
  readonly status: number | null;
  constructor(step: string, status: number | null) {
    super(`data repo ${step} failed${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "GitDataError";
    this.step = step;
    this.status = status;
  }
}

/** The ref moved since it was read (HTTP 422 on a non-forced update). */
export class NotFastForward extends Error {
  constructor() {
    super("data repo update_ref refused: not a fast-forward");
    this.name = "NotFastForward";
  }
}

/** Git blob id of a file's bytes (what the tree listing reports), to skip unchanged files. */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export type TreeEntry = { path: string; mode: "100644"; type: "blob"; sha: string };

export function createGitDataClient(cfg: {
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}) {
  const { repo, token } = cfg;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  if (!REPO_RE.test(repo) || typeof token !== "string" || token === "") {
    throw new Error("data repo client misconfigured");
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  async function call(
    step: string,
    method: "GET" | "POST" | "PATCH",
    pathAndQuery: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    // The URL is built from the fixed host and a path made here; the path never starts with a scheme.
    const url = `${GITHUB_API}/repos/${repo}${pathAndQuery}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GitDataError(step, null);
    }
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
    } catch {
      /* an empty or non-JSON body: the status decides */
    }
    return { status: res.status, json };
  }

  const sha = (step: string, v: unknown): string => {
    if (typeof v !== "string" || !SHA_RE.test(v)) throw new GitDataError(step, null);
    return v;
  };

  return {
    /** Default branch of the data repo. */
    async defaultBranch(): Promise<string> {
      const r = await call("get_repo", "GET", "");
      if (r.status !== 200) throw new GitDataError("get_repo", r.status);
      const b = r.json.default_branch;
      if (typeof b !== "string" || !BRANCH_RE.test(b) || b.includes("..")) {
        throw new GitDataError("parse_repo", null);
      }
      return b;
    },

    /** Commit id at the head of a branch. */
    async headCommit(branch: string): Promise<string> {
      const r = await call("get_ref", "GET", `/git/ref/heads/${branch}`);
      if (r.status !== 200) throw new GitDataError("get_ref", r.status);
      const o = r.json.object as Record<string, unknown> | undefined;
      return sha("parse_ref", o?.sha);
    },

    /** Root tree id of a commit. */
    async commitTree(commit: string): Promise<string> {
      const r = await call("get_commit", "GET", `/git/commits/${commit}`);
      if (r.status !== 200) throw new GitDataError("get_commit", r.status);
      const t = r.json.tree as Record<string, unknown> | undefined;
      return sha("parse_commit", t?.sha);
    },

    /**
     * Blob ids of every file under `knowledge/` at a tree (empty when the folder does not exist yet).
     * A truncated listing is an error: skipping by id would not be safe.
     */
    async knowledgeBlobs(rootTree: string): Promise<Map<string, string>> {
      const root = await call("get_tree", "GET", `/git/trees/${rootTree}`);
      if (root.status !== 200) throw new GitDataError("get_tree", root.status);
      const entries = Array.isArray(root.json.tree)
        ? (root.json.tree as Record<string, unknown>[])
        : [];
      const k = entries.find((e) => e.path === "knowledge" && e.type === "tree");
      const out = new Map<string, string>();
      if (k === undefined) return out;
      const sub = await call(
        "get_tree",
        "GET",
        `/git/trees/${sha("parse_tree", k.sha)}?recursive=1`,
      );
      if (sub.status !== 200) throw new GitDataError("get_tree", sub.status);
      if (sub.json.truncated === true) throw new GitDataError("tree_truncated", null);
      for (const e of Array.isArray(sub.json.tree)
        ? (sub.json.tree as Record<string, unknown>[])
        : []) {
        if (e.type === "blob" && typeof e.path === "string") {
          out.set(`knowledge/${e.path}`, sha("parse_tree", e.sha));
        }
      }
      return out;
    },

    async createBlob(bytes: Uint8Array): Promise<string> {
      const r = await call("create_blob", "POST", "/git/blobs", {
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
      });
      if (r.status !== 201) throw new GitDataError("create_blob", r.status);
      return sha("parse_blob", r.json.sha);
    },

    async createTree(baseTree: string, entries: readonly TreeEntry[]): Promise<string> {
      const r = await call("create_tree", "POST", "/git/trees", {
        base_tree: baseTree,
        tree: entries,
      });
      if (r.status !== 201) throw new GitDataError("create_tree", r.status);
      return sha("parse_tree", r.json.sha);
    },

    async createCommit(message: string, tree: string, parent: string): Promise<string> {
      const r = await call("create_commit", "POST", "/git/commits", {
        message,
        tree,
        parents: [parent],
      });
      if (r.status !== 201) throw new GitDataError("create_commit", r.status);
      return sha("parse_commit", r.json.sha);
    },

    /** Moves the branch to `commit`, never forced. */
    async fastForward(branch: string, commit: string): Promise<void> {
      const r = await call("update_ref", "PATCH", `/git/refs/heads/${branch}`, {
        sha: commit,
        force: false,
      });
      if (r.status === 422) throw new NotFastForward();
      if (r.status !== 200) throw new GitDataError("update_ref", r.status);
    },
  };
}

export type GitDataClient = ReturnType<typeof createGitDataClient>;
