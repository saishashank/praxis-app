// SEC-108 c, d; BLD-011
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./approved-commit.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const HEAD = "d".repeat(40);
const TOKEN = "ghs_SECRETTOKEN123";

function setup(deployments, statusesById, listStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname.endsWith("/deployments")) {
      return { status: listStatus, json: async () => deployments };
    }
    const id = u.pathname.split("/")[5];
    return { status: 200, json: async () => statusesById[id] ?? [] };
  };
  const dir = mkdtempSync(join(tmpdir(), "ac-"));
  const file = join(dir, "out");
  writeFileSync(file, "");
  const lines = [];
  const env = {
    GITHUB_TOKEN: TOKEN,
    GITHUB_REPOSITORY: "o/praxis-app",
    GITHUB_SHA: HEAD,
    GITHUB_OUTPUT: file,
  };
  return { fetchImpl, env, lines, out: (l) => lines.push(l), file, calls };
}
const dep = (id, sha) => ({
  id,
  sha,
  statuses_url: `https://api.github.com/repos/o/praxis-app/deployments/${id}/statuses`,
});

test("picks the newest deployment whose latest status is success", async () => {
  const s = setup([dep(3, A), dep(2, B), dep(1, C)], {
    3: [{ state: "success" }],
    2: [{ state: "success" }],
    1: [{ state: "success" }],
  });
  assert.equal(await run(s.env, s.fetchImpl, s.out), 0);
  assert.equal(readFileSync(s.file, "utf8"), `sha=${A}\n`);
});

test("skips failure, inactive and pending-only deployments", async () => {
  const s = setup([dep(4, A), dep(3, B), dep(2, C), dep(1, HEAD)], {
    4: [{ state: "failure" }],
    3: [{ state: "inactive" }, { state: "success" }],
    2: [{ state: "pending" }],
    1: [{ state: "success" }, { state: "pending" }],
  });
  assert.equal(await run(s.env, s.fetchImpl, s.out), 0);
  assert.equal(readFileSync(s.file, "utf8"), `sha=${HEAD}\n`);
});

test("handles a full page of 30 deployments and sends per_page and auth", async () => {
  const deps = Array.from({ length: 30 }, (_, i) => dep(100 - i, B));
  const st = {};
  for (const d of deps) st[d.id] = [{ state: "failure" }];
  st[71] = [{ state: "success" }];
  deps[29].sha = A;
  const s = setup(deps, st);
  assert.equal(await run(s.env, s.fetchImpl, s.out), 0);
  assert.equal(readFileSync(s.file, "utf8"), `sha=${A}\n`);
  assert.match(s.calls[0].url, /environment=deploy-production&per_page=30/);
  assert.equal(s.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.match(s.calls[1].url, /per_page=10/);
});

test("none approved + bootstrap: uses release head and warns", async () => {
  const s = setup([], {});
  s.env.ALLOW_BOOTSTRAP = "true";
  assert.equal(await run(s.env, s.fetchImpl, s.out), 0);
  assert.equal(readFileSync(s.file, "utf8"), `sha=${HEAD}\n`);
  assert.ok(
    s.lines.some((l) => l.startsWith("::warning::") && l.includes("awaiting first approval")),
  );
});

test("none approved without bootstrap: exit 1, writes nothing", async () => {
  const s = setup([dep(1, A)], { 1: [{ state: "pending" }] });
  assert.equal(await run(s.env, s.fetchImpl, s.out), 1);
  assert.equal(readFileSync(s.file, "utf8"), "");
  assert.ok(s.lines.some((l) => l.includes("awaiting first approval")));
});

test("bad sha: exit 1", async () => {
  const s = setup([dep(1, "not-a-sha")], { 1: [{ state: "success" }] });
  assert.equal(await run(s.env, s.fetchImpl, s.out), 1);
  assert.equal(readFileSync(s.file, "utf8"), "");
});

test("non-200: exit 1 and only the status is printed", async () => {
  const s = setup([], {}, 403);
  assert.equal(await run(s.env, s.fetchImpl, s.out), 1);
  assert.ok(s.lines.join("\n").includes("HTTP 403"));
});

test("refuses a statuses_url on another host (token must not leak)", async () => {
  const s = setup([{ id: 1, sha: A, statuses_url: "https://evil.example/x" }], {});
  assert.equal(await run(s.env, s.fetchImpl, s.out), 1);
  assert.equal(s.calls.length, 1);
});

test("output never contains the token", async () => {
  const s = setup([dep(1, A)], { 1: [{ state: "success" }] });
  await run(s.env, s.fetchImpl, s.out);
  const bad = setup([], {}, 500);
  await run(bad.env, bad.fetchImpl, bad.out);
  const throwing = async () => {
    throw new Error(`boom ${TOKEN}`);
  };
  const t = setup([], {});
  await run(t.env, throwing, t.out);
  for (const l of [...s.lines, ...bad.lines, ...t.lines]) assert.ok(!l.includes(TOKEN));
});
