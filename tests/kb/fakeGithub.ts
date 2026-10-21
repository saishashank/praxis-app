// An in-process fake GitHub (Git Data API routes the KB archive uses). No network. Shared by the
// archive tests and the AT-24 acceptance test (M6 T13/T18). Synthetic names only.
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { gitBlobSha } from "@/lib/kb/gitData";

export const REPO = "zz-owner/praxis-app-data";
export const TOKEN = "zz-test-token-not-a-secret";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export type Req = { method: string; url: string; auth: string | null; body: unknown };

/** An in-memory git repo behind the Git Data API routes the archive uses. */
export function fakeGithub(opts: { failRefOnce?: boolean; status?: Record<string, number> } = {}) {
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
