// PLT-022a: the data-repo release client. Errors carry the step and HTTP status only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithub, GithubError } from "./github.mjs";

const TOKEN = "ghp_SECRET";
const resp = (status, body) => ({ status, json: async () => body });
const client = (handler) => createGithub({ repo: "o/r-data", token: TOKEN, fetchImpl: handler });

test("refuses a bad repo name or empty token", () => {
  assert.throws(() => createGithub({ repo: "no-slash", token: TOKEN }), /misconfigured/);
  assert.throws(() => createGithub({ repo: "a/b/c", token: TOKEN }), /misconfigured/);
  assert.throws(() => createGithub({ repo: "o/r", token: "" }), /misconfigured/);
});

test("errors show the step and status, never the token, URL or body", async () => {
  const gh = client(async () => resp(500, { message: `secret ${TOKEN}` }));
  await assert.rejects(gh.getRelease("backup-2026-01-01"), (e) => {
    assert.ok(e instanceof GithubError);
    assert.equal(e.message, "github get_release failed (HTTP 500)");
    assert.equal(e.step, "get_release");
    assert.equal(e.status, 500);
    return true;
  });
  const down = client(async () => {
    throw new Error(`ECONNRESET https://api.github.com ${TOKEN}`);
  });
  await assert.rejects(down.listReleases(), (e) => {
    assert.equal(e.message, "github list_releases failed");
    assert.equal(e.status, null);
    return true;
  });
});

test("ensureRelease: create failure other than 422 is an error; 422 without a release is an error", async () => {
  const calls = [];
  const gh = client(async (url, init) => {
    calls.push(init.method);
    if (init.method === "GET") return resp(404, {});
    return resp(403, {});
  });
  await assert.rejects(gh.ensureRelease("backup-2026-01-01"), /create_release failed \(HTTP 403\)/);
  const gh2 = client(async (url, init) => (init.method === "GET" ? resp(404, {}) : resp(422, {})));
  await assert.rejects(
    gh2.ensureRelease("backup-2026-01-01"),
    /create_release failed \(HTTP 422\)/,
  );
});

test("a malformed release object is rejected", async () => {
  const gh = client(async () => resp(200, { id: "x", tag_name: 5 }));
  await assert.rejects(gh.getRelease("t"), /parse_release failed/);
  const ok = client(async () => resp(200, { id: 3, tag_name: "t" }));
  assert.deepEqual(await ok.getRelease("t"), { id: 3, tag: "t", assets: [] });
});

test("deleteRelease: 404s are fine, other statuses fail with the step", async () => {
  const mk = (relStatus, tagStatus) =>
    client(async (url) => resp(url.includes("/git/refs/") ? tagStatus : relStatus, null));
  await mk(204, 204).deleteRelease(1, "t");
  await mk(404, 404).deleteRelease(1, "t");
  await mk(204, 422).deleteRelease(1, "t");
  await assert.rejects(mk(500, 204).deleteRelease(1, "t"), /delete_release failed \(HTTP 500\)/);
  await assert.rejects(mk(204, 500).deleteRelease(1, "t"), /delete_tag failed \(HTTP 500\)/);
});

test("uploadAsset needs 201; listReleases rejects a non-array body and a non-200", async () => {
  const up = client(async () => resp(422, {}));
  await assert.rejects(
    up.uploadAsset(1, "a", new Uint8Array(1)),
    /upload_asset failed \(HTTP 422\)/,
  );
  await assert.rejects(client(async () => resp(200, {})).listReleases(), /list_releases failed/);
  await assert.rejects(client(async () => resp(403, {})).listReleases(), /HTTP 403/);
});
