// KB archive (KB-001, PLT-022a, M6 T13, design 4.8, decisions 29-31): regenerates the `document`
// versions from the records (the first run back-fills every stored Evening Review), then commits
// only the changed files under `knowledge/` in the PRIVATE data repo through the Git Data API:
// one commit "kb: <d> (<n> files)", fast-forward only, nothing deleted, nothing outside `knowledge/`,
// the code repo never touched. Idempotent: a re-run with no change makes no commit. Every run writes
// a `kb_archive_run` row (running -> ok | partial | failed | skipped).
// Used by scripts/kb/archive.mjs (bundled) from the dispatch-only workflow kb-archive.yml.
// Output: statuses and counts only. Never a URL, a token, a path list or any document content.
import { createClient, type Client } from "@libsql/client";
import { buildAllDocuments, syncDocuments } from "./documents";
import {
  createGitDataClient,
  gitBlobSha,
  GitDataError,
  NotFastForward,
  type GitDataClient,
  type TreeEntry,
} from "./gitData";
import { renderFile, type DocFront } from "./render";

/** Archive path allow-list (design 4.8): only markdown under knowledge/{market}/ or knowledge/common/. */
const PATH_RE = /^knowledge\/(?:au|common)\/[A-Za-z0-9/_.-]+\.md$/;

export function pathAllowed(p: string): boolean {
  return PATH_RE.test(p) && !p.includes("..") && !p.includes("//") && !p.includes("/.");
}

const FAST_FORWARD_ATTEMPTS = 2; // one retry from the new head (design 4.8)

export function melbourneDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export type ArchiveStatus = "ok" | "partial" | "failed" | "skipped";
export type ArchiveResult = {
  readonly status: ArchiveStatus;
  readonly runId: string;
  readonly filesChanged: number;
  readonly commitSha: string | null;
  readonly documents: number;
  readonly rejected: number;
  readonly versionsWritten: number;
  readonly failedStep: string | null;
};

type File = { readonly path: string; readonly bytes: Uint8Array; readonly sha: string };

async function latestFiles(db: Client): Promise<{ files: File[]; rejected: number }> {
  const rows = (
    await db.execute(
      `SELECT path, front_json, body FROM document d
        WHERE version = (SELECT MAX(version) FROM document WHERE path = d.path) ORDER BY path`,
    )
  ).rows;
  const enc = new TextEncoder();
  const files: File[] = [];
  let rejected = 0;
  for (const r of rows) {
    const path = String(r.path);
    if (!pathAllowed(path)) {
      rejected += 1;
      continue;
    }
    const bytes = enc.encode(
      renderFile(JSON.parse(String(r.front_json)) as DocFront, String(r.body)),
    );
    files.push({ path, bytes, sha: gitBlobSha(bytes) });
  }
  return { files, rejected };
}

/** One commit attempt from the current head; returns null when nothing differs. */
async function commitOnce(
  git: GitDataClient,
  branch: string,
  files: readonly File[],
  d: string,
): Promise<{ commit: string; changed: number } | { commit: null; changed: 0 }> {
  const head = await git.headCommit(branch);
  const baseTree = await git.commitTree(head);
  const existing = await git.knowledgeBlobs(baseTree);
  const changed = files.filter((f) => existing.get(f.path) !== f.sha);
  if (changed.length === 0) return { commit: null, changed: 0 };
  const entries: TreeEntry[] = [];
  for (const f of changed) {
    entries.push({
      path: f.path,
      mode: "100644",
      type: "blob",
      sha: await git.createBlob(f.bytes),
    });
  }
  const tree = await git.createTree(baseTree, entries);
  const commit = await git.createCommit(`kb: ${d} (${changed.length} files)`, tree, head);
  await git.fastForward(branch, commit);
  return { commit, changed: changed.length };
}

export async function archiveRun(deps: {
  db: Client;
  git: GitDataClient;
  now: Date;
  /** Regenerate the document versions first (default true). */
  sync?: boolean;
}): Promise<ArchiveResult> {
  const { db, git, now } = deps;
  const d = melbourneDay(now);
  const runId = `kb-${d}-${now.getTime()}`;
  const startedAt = now.toISOString();
  await db.execute({
    sql: "INSERT INTO kb_archive_run (run_id, d, status, files_changed, started_at) VALUES (?, ?, 'running', 0, ?)",
    args: [runId, d, startedAt],
  });
  let status: ArchiveStatus = "failed";
  let filesChanged = 0;
  let commitSha: string | null = null;
  let documents = 0;
  let rejected = 0;
  let versionsWritten = 0;
  let failedStep: string | null = null;
  try {
    if (deps.sync !== false) {
      versionsWritten = (
        await syncDocuments(db, { d, now: startedAt, docs: await buildAllDocuments(db) })
      ).written.length;
    }
    const { files, rejected: bad } = await latestFiles(db);
    documents = files.length;
    rejected = bad;
    if (files.length === 0) {
      status = "skipped";
    } else {
      const branch = await git.defaultBranch();
      for (let attempt = 1; ; attempt += 1) {
        try {
          const r = await commitOnce(git, branch, files, d);
          commitSha = r.commit;
          filesChanged = r.changed;
          break;
        } catch (e) {
          if (e instanceof NotFastForward && attempt < FAST_FORWARD_ATTEMPTS) continue;
          throw e;
        }
      }
      status = rejected > 0 ? "partial" : "ok";
    }
  } catch (e) {
    status = "failed";
    failedStep =
      e instanceof GitDataError ? e.step : e instanceof NotFastForward ? "update_ref" : "internal";
  }
  await db.execute({
    sql: "UPDATE kb_archive_run SET status = ?, files_changed = ?, commit_sha = ?, finished_at = ? WHERE run_id = ?",
    args: [status, filesChanged, commitSha, new Date().toISOString(), runId],
  });
  return {
    status,
    runId,
    filesChanged,
    commitSha,
    documents,
    rejected,
    versionsWritten,
    failedStep,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

const REQUIRED = ["TURSO_MAIN_URL", "TURSO_MAIN_TOKEN", "DATA_REPO_TOKEN", "DATA_REPO"] as const;

export type CliDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly db?: Client;
  readonly now?: Date;
  readonly log?: (line: string) => void;
};

/**
 * @returns 0 ok / partial / skipped, 1 failed, 2 usage or missing configuration.
 */
export async function archiveMain(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: CliDeps = {},
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const known = new Set(["--no-sync"]);
  if (argv.some((a) => !known.has(a))) {
    log("usage: archive.mjs [--no-sync]");
    return 2;
  }
  const missing = REQUIRED.filter(
    (k) => (env[k] ?? "") === "" && !(k.startsWith("TURSO") && deps.db),
  );
  if (missing.length > 0) {
    log(`missing configuration: ${missing.join(", ")}`);
    return 2;
  }
  let git: GitDataClient;
  try {
    git = createGitDataClient({
      repo: env.DATA_REPO ?? "",
      token: env.DATA_REPO_TOKEN ?? "",
      fetchImpl: deps.fetchImpl,
    });
  } catch {
    log("misconfigured data repo (needs <owner>/<name>-data)");
    return 2;
  }
  const db =
    deps.db ?? createClient({ url: env.TURSO_MAIN_URL ?? "", authToken: env.TURSO_MAIN_TOKEN });
  try {
    const r = await archiveRun({
      db,
      git,
      now: deps.now ?? new Date(),
      sync: !argv.includes("--no-sync"),
    });
    log(
      `kb archive ${r.status}: documents=${r.documents} versions_written=${r.versionsWritten} files_changed=${r.filesChanged} rejected=${r.rejected}${r.failedStep === null ? "" : ` step=${r.failedStep}`}`,
    );
    return r.status === "failed" ? 1 : 0;
  } finally {
    if (!deps.db) db.close();
  }
}
