// @vitest-environment node
// KB archive against an in-process fake GitHub (no network): only changed files, one commit,
// fast-forward only, path allow-list, token only to api.github.com, no request to the code repo,
// re-run = no commit, regenerated markdown equals the archived bytes (M6 T13, AT-24).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { archiveMain, archiveRun, pathAllowed } from "@/lib/kb/archiveCli";
import { createGitDataClient, gitBlobSha } from "@/lib/kb/gitData";
import { renderFile, type DocFront } from "@/lib/kb/render";
import { exec, kbWorld } from "./helpers";

afterEach(cleanupTempDbs);

const REPO = "zz-owner/praxis-app-data";
const TOKEN = "zz-test-token-not-a-secret";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

type Req = { method: string; url: string; auth: string | null; body: unknown };

/** An in-memory git repo behind the Git Data API routes the archive uses. */
function fakeGithub(opts: { failRefOnce?: boolean; status?: Record<string, number> } = {}) {
  const requests: Req[] = [];
  let failRef = opts.failRefOnce === true;
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Map<string, string>>(); // tree sha -> full file map
  const subs = new Map<string, Map<string, string>>(); // knowledge subtree sha -> relative map
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const mk = (files: Map<string, string>) => {
    const id = sha1(JSON.stringify([...files].sort()));
    trees.set(id, files);
    return id;
  };
  const readme = new Map([["README.md", sha1("readme")]]);
  const root = mk(readme);
  const c0 = sha1("c0");
  commits.set(c0, { tree: root, parents: [], message: "init" });
  let head = c0;
  const refUpdates: unknown[] = [];

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    requests.push({ method: String(init?.method), url, auth: headers.Authorization ?? null, body });
    expect(init?.redirect).toBe("error");
    const u = new URL(url);
    expect(u.origin).toBe("https://api.github.com");
    const p = u.pathname.replace(`/repos/${REPO}`, "");
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status });
    const forced = opts.status?.[`${init?.method} ${p}`];
    if (forced !== undefined) return json(forced, {});
    if (!u.pathname.startsWith(`/repos/${REPO}`)) return json(404, {});
    if (init?.method === "GET" && p === "") return json(200, { default_branch: "main" });
    if (init?.method === "GET" && p === "/git/ref/heads/main")
      return json(200, { object: { sha: head } });
    const cm = /^\/git\/commits\/([0-9a-f]{40})$/.exec(p);
    if (init?.method === "GET" && cm)
      return json(200, { tree: { sha: commits.get(cm[1]!)!.tree } });
    const tr = /^\/git\/trees\/([0-9a-f]{40})$/.exec(p);
    if (init?.method === "GET" && tr) {
      const id = tr[1]!;
      if (subs.has(id)) {
        return json(200, {
          truncated: false,
          tree: [...subs.get(id)!].map(([path, sha]) => ({ path, type: "blob", sha })),
        });
      }
      const files = trees.get(id)!;
      const k = new Map(
        [...files].filter(([f]) => f.startsWith("knowledge/")).map(([f, s]) => [f.slice(10), s]),
      );
      const entries: unknown[] = [...files]
        .filter(([f]) => !f.startsWith("knowledge/"))
        .map(([path, sha]) => ({ path, type: "blob", sha }));
      if (k.size > 0) {
        const sid = sha1(`sub:${JSON.stringify([...k].sort())}`);
        subs.set(sid, k);
        entries.push({ path: "knowledge", type: "tree", sha: sid });
      }
      return json(200, { tree: entries });
    }
    if (init?.method === "POST" && p === "/git/blobs") {
      const bytes = Buffer.from(String(body.content), "base64");
      const sha = gitBlobSha(bytes);
      blobs.set(sha, bytes);
      return json(201, { sha });
    }
    if (init?.method === "POST" && p === "/git/trees") {
      const files = new Map(trees.get(body.base_tree)!);
      for (const e of body.tree) {
        expect(e.mode).toBe("100644");
        expect(e.type).toBe("blob");
        expect(blobs.has(e.sha)).toBe(true);
        files.set(e.path, e.sha);
      }
      return json(201, { sha: mk(files) });
    }
    if (init?.method === "POST" && p === "/git/commits") {
      const id = sha1(JSON.stringify([body.message, body.tree, body.parents, commits.size]));
      commits.set(id, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha: id });
    }
    if (init?.method === "PATCH" && p === "/git/refs/heads/main") {
      refUpdates.push(body);
      if (failRef) {
        failRef = false;
        // A concurrent writer moved the branch first.
        const other = sha1("other");
        commits.set(other, { tree: commits.get(head)!.tree, parents: [head], message: "other" });
        head = other;
        return json(422, {});
      }
      if (!commits.get(body.sha)!.parents.includes(head)) return json(422, {});
      head = body.sha;
      return json(200, {});
    }
    return json(404, {});
  };

  return {
    fetchImpl: fetchImpl as typeof fetch,
    requests,
    refUpdates,
    get head() {
      return head;
    },
    commits,
    files: () => new Map(trees.get(commits.get(head)!.tree)!),
    blob: (sha: string) => blobs.get(sha)!.toString("utf8"),
    commitCount: () => commits.size,
  };
}

const NOW = new Date("2026-10-17T12:00:00.000Z");

function client(gh: ReturnType<typeof fakeGithub>) {
  return createGitDataClient({ repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl });
}

describe("path allow-list", () => {
  it("accepts knowledge/au and knowledge/common markdown only", () => {
    for (const p of [
      "knowledge/au/families/F1.md",
      "knowledge/au/lessons/L-AU-T-aaaa1111-F1.v1.md",
      "knowledge/common/source-register.md",
    ]) {
      expect(pathAllowed(p), p).toBe(true);
    }
    for (const p of [
      "README.md",
      "knowledge/us/families/F1.md",
      "knowledge/au/../../.github/workflows/x.md",
      "knowledge/au/a.txt",
      "../knowledge/au/a.md",
      "knowledge/au//a.md",
      "knowledge/au/.hidden.md",
      ".github/workflows/knowledge/au/a.md",
      "knowledge/au/a b.md",
    ]) {
      expect(pathAllowed(p), p).toBe(false);
    }
  });
});

describe("archiveRun", () => {
  it("commits every document once, then a re-run makes no commit", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    const git = client(gh);
    const before = gh.commitCount();

    const r1 = await archiveRun({ db, git, now: NOW });
    expect(r1.status).toBe("ok");
    expect(r1.filesChanged).toBe(r1.documents);
    expect(r1.filesChanged).toBeGreaterThan(8);
    expect(r1.commitSha).toBe(gh.head);
    expect(gh.commitCount()).toBe(before + 1);
    expect(gh.commits.get(gh.head)!.message).toBe(`kb: 2026-10-17 (${r1.filesChanged} files)`);
    // Only files under knowledge/ were added; the README is untouched.
    const files = gh.files();
    expect(files.get("README.md")).toBe(sha1("readme"));
    for (const f of files.keys()) expect(f === "README.md" || pathAllowed(f), f).toBe(true);
    expect(files.size).toBe(1 + r1.filesChanged);

    const reqsAfterFirst = gh.requests.length;
    const r2 = await archiveRun({ db, git, now: new Date(NOW.getTime() + 60_000) });
    expect(r2.status).toBe("ok");
    expect(r2.filesChanged).toBe(0);
    expect(r2.commitSha).toBeNull();
    expect(r2.versionsWritten).toBe(0);
    expect(gh.commitCount()).toBe(before + 1);
    // The re-run only read: no blob, tree, commit or ref write.
    expect(gh.requests.slice(reqsAfterFirst).every((q) => q.method === "GET")).toBe(true);

    const runs = (
      await exec(
        db,
        "SELECT status, files_changed, commit_sha FROM kb_archive_run ORDER BY started_at",
      )
    ).rows;
    expect(runs.map((x) => [x.status, Number(x.files_changed)])).toEqual([
      ["ok", r1.filesChanged],
      ["ok", 0],
    ]);
    expect(runs[0]!.commit_sha).toBe(gh.head);
    expect(runs[1]!.commit_sha).toBeNull();
  });

  it("commits only the changed file when one record changes", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    const git = client(gh);
    await archiveRun({ db, git, now: NOW });
    await exec(
      db,
      `INSERT INTO evening_review (d, version, kind, facts_json, facts_sha, html, text, markdown, size_html, narrative, created_at)
       VALUES ('2026-10-15', 1, 'full', '{}', ?, '', '', '# Review 2026-10-15', 0, 'rules', '2026-10-15T09:00:00.000Z')`,
      ["7".repeat(64)],
    );
    const before = gh.files();
    const r = await archiveRun({ db, git, now: new Date(NOW.getTime() + 3_600_000) });
    expect(r.filesChanged).toBe(1);
    expect(gh.commits.get(gh.head)!.message).toBe("kb: 2026-10-18 (1 files)");
    const after = gh.files();
    const diff = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
    expect(diff).toEqual(["knowledge/au/reviews/2026-10-15.md"]);
    // The commit adds one parent only: fast-forward, and the ref was never forced.
    expect(gh.refUpdates.every((u) => (u as { force: boolean }).force === false)).toBe(true);
  });

  it("archived bytes equal the markdown regenerated from the database", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    await archiveRun({ db, git: client(gh), now: NOW });
    const rows = (
      await exec(
        db,
        `SELECT path, front_json, body FROM document d
          WHERE version = (SELECT MAX(version) FROM document WHERE path = d.path)`,
      )
    ).rows;
    const files = gh.files();
    expect(rows.length).toBe(files.size - 1);
    for (const r of rows) {
      const bytes = renderFile(JSON.parse(String(r.front_json)) as DocFront, String(r.body));
      const blobSha = files.get(String(r.path))!;
      expect(gh.blob(blobSha)).toBe(bytes);
      expect(gitBlobSha(Buffer.from(bytes))).toBe(blobSha);
      expect(bytes.startsWith("---\nid: ")).toBe(true);
    }
  });

  it("retries once from the new head after a non-fast-forward, then succeeds", async () => {
    const db = await kbWorld();
    const gh = fakeGithub({ failRefOnce: true });
    const r = await archiveRun({ db, git: client(gh), now: NOW });
    expect(r.status).toBe("ok");
    expect(gh.refUpdates).toHaveLength(2);
    expect(gh.commits.get(gh.head)!.parents).toHaveLength(1);
  });

  it("two non-fast-forwards in a row fail the run and keep the row", async () => {
    const db = await kbWorld();
    const gh = fakeGithub({ status: { "PATCH /git/refs/heads/main": 422 } });
    const r = await archiveRun({ db, git: client(gh), now: NOW });
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe("update_ref");
    const run = (await exec(db, "SELECT status, commit_sha, finished_at FROM kb_archive_run"))
      .rows[0]!;
    expect(run.status).toBe("failed");
    expect(run.commit_sha).toBeNull();
    expect(run.finished_at).not.toBeNull();
  });

  it("a GitHub error fails the run with the step name only", async () => {
    const db = await kbWorld();
    const gh = fakeGithub({ status: { "POST /git/blobs": 500 } });
    const r = await archiveRun({ db, git: client(gh), now: NOW });
    expect(r).toMatchObject({ status: "failed", failedStep: "create_blob", filesChanged: 0 });
    expect(gh.commitCount()).toBe(1);
  });

  it("skips (no network call) when there are no documents", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    const r = await archiveRun({ db, git: client(gh), now: NOW, sync: false });
    expect(r.status).toBe("skipped");
    expect(gh.requests).toHaveLength(0);
  });

  it("a stored path outside the allow-list is never committed (partial)", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    await archiveRun({ db, git: client(gh), now: NOW });
    await exec(
      db,
      `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
       VALUES ('knowledge/us/families/F1.md', 1, 'US', 'family', ?, 'x', ?, '2026-10-17', '2026-10-17T00:00:00.000Z')`,
      [
        JSON.stringify({
          id: "x",
          market: "US",
          type: "family",
          created: "a",
          updated: "a",
          version: 1,
          grade: null,
          related: [],
        }),
        "a".repeat(64),
      ],
    );
    const r = await archiveRun({
      db,
      git: client(gh),
      now: new Date(NOW.getTime() + 60_000),
      sync: false,
    });
    expect(r.status).toBe("partial");
    expect(r.rejected).toBe(1);
    expect([...gh.files().keys()].some((k) => k.includes("/us/"))).toBe(false);
  });

  it("sends the token only to api.github.com and never touches another repo", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    await archiveRun({ db, git: client(gh), now: NOW });
    expect(gh.requests.length).toBeGreaterThan(5);
    for (const q of gh.requests) {
      expect(q.url.startsWith(`https://api.github.com/repos/${REPO}`)).toBe(true);
      expect(q.auth).toBe(`Bearer ${TOKEN}`);
      expect(["GET", "POST", "PATCH"]).toContain(q.method);
    }
    expect(
      gh.requests.some((q) => q.url.includes("/contents/") || q.url.includes("/releases")),
    ).toBe(false);
  });
});

describe("client configuration", () => {
  it("refuses a repository that is not <owner>/<name>-data", () => {
    expect(() => createGitDataClient({ repo: "zz-owner/praxis-app", token: TOKEN })).toThrow();
    expect(() => createGitDataClient({ repo: REPO, token: "" })).toThrow();
    expect(() => createGitDataClient({ repo: "a/b-data/../c", token: TOKEN })).toThrow();
  });
});

describe("archiveMain", () => {
  it("exits 2 on bad usage or missing configuration and prints no secret", async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    expect(await archiveMain(["--bogus"], {}, { log })).toBe(2);
    expect(await archiveMain([], {}, { log })).toBe(2);
    expect(
      await archiveMain(
        [],
        {
          TURSO_MAIN_URL: "u",
          TURSO_MAIN_TOKEN: "t",
          DATA_REPO_TOKEN: TOKEN,
          DATA_REPO: "not-a-data-repo",
        },
        { log },
      ),
    ).toBe(2);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("runs end to end with an injected database and fetch; the log has counts only", async () => {
    const db = await kbWorld();
    const gh = fakeGithub();
    const lines: string[] = [];
    const code = await archiveMain(
      [],
      { TURSO_MAIN_URL: "x", TURSO_MAIN_TOKEN: "y", DATA_REPO_TOKEN: TOKEN, DATA_REPO: REPO },
      { db, fetchImpl: gh.fetchImpl, now: NOW, log: (l) => lines.push(l) },
    );
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^kb archive ok: documents=\d+ versions_written=\d+ files_changed=\d+ rejected=0$/,
    );
    expect(lines[0]).not.toMatch(/knowledge\/|http|Bearer/);
    const failing = fakeGithub({ status: { "GET /git/ref/heads/main": 500 } });
    const code2 = await archiveMain(
      ["--no-sync"],
      { TURSO_MAIN_URL: "x", TURSO_MAIN_TOKEN: "y", DATA_REPO_TOKEN: TOKEN, DATA_REPO: REPO },
      {
        db,
        fetchImpl: failing.fetchImpl,
        now: new Date(NOW.getTime() + 60_000),
        log: (l) => lines.push(l),
      },
    );
    expect(code2).toBe(1);
    expect(lines[1]).toContain("step=get_ref");
  });
});
