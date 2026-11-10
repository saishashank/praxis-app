// INFRA T4 follow-up: sqld verifies JWTs (SQLD_AUTH_JWT_KEY). Runs only against a real sqld started with a throwaway
// public key (branch CI, selfhost-check.yml job "sqld-jwt"); without the variables below every test is skipped.
//   SQLD_JWT_BASE        http://jwtsqld:8080   (jwtsqld, main.jwtsqld and auth.jwtsqld resolve to the server)
//   SQLD_JWT_ADMIN       http://127.0.0.1:8081
//   SQLD_JWT_KEYS        folder with good.pem (the pair sqld trusts) and other.pem (a different pair), see jwt.mjs
// Output rules of the scripts under test: a failed run must never print a token.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintToken } from "./jwt.mjs";
import { ensureNamespace, nodeHttpFetch, openNamespace } from "./sqld.mjs";

const BASE = process.env.SQLD_JWT_BASE ?? "";
const ADMIN = process.env.SQLD_JWT_ADMIN ?? "";
const KEYS = process.env.SQLD_JWT_KEYS ?? "";
const skip =
  !BASE || !ADMIN || !KEYS ? "SQLD_JWT_BASE, SQLD_JWT_ADMIN and SQLD_JWT_KEYS are not set" : false;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pem = (n) => readFileSync(path.join(KEYS, `${n}.pem`), "utf8");

// sqld answers 404 for a namespace that does not exist BEFORE it looks at the token: create it first (the admin API is
// not behind the JWT).
before(async () => {
  if (!skip) await ensureNamespace(ADMIN, "main");
});

/** One statement through the HTTP pipeline API with an optional bearer token. Returns the HTTP status. */
async function pipelineStatus(ns, token) {
  const u = new URL(BASE);
  const req = new Request(`${u.protocol}//${u.host}/v2/pipeline`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      requests: [{ type: "execute", stmt: { sql: "SELECT 1" } }, { type: "close" }],
    }),
  });
  const res = await nodeHttpFetch(req, `${ns}.${u.hostname}`);
  await res.arrayBuffer();
  return res.status;
}

test("without a token the database refuses", { skip }, async () => {
  const s = await pipelineStatus("main", null);
  assert.ok(s === 401 || s === 403, `expected 401/403, got ${s}`);
});

test("a token signed by another key is refused", { skip }, async () => {
  const s = await pipelineStatus("main", mintToken(pem("other")));
  assert.ok(s === 401 || s === 403, `expected 401/403, got ${s}`);
});

test("an expired token is refused", { skip }, async () => {
  const s = await pipelineStatus("main", mintToken(pem("good"), { ttlSec: -120 }));
  assert.ok(s === 401 || s === 403, `expected 401/403, got ${s}`);
});

test("a token signed by the trusted key works", { skip }, async () => {
  assert.equal(await pipelineStatus("main", mintToken(pem("good"))), 200);
});

test(
  "openNamespace (sqld.mjs) passes the token: valid works, missing and wrong fail",
  { skip },
  async () => {
    const good = mintToken(pem("good"));
    const ok = openNamespace({ base: BASE, ns: "main", token: good, mode: "host" });
    try {
      const r = await ok.execute("SELECT 1 AS one");
      assert.equal(Number(r.rows[0].one), 1);
    } finally {
      ok.close();
    }
    for (const token of [undefined, mintToken(pem("other"))]) {
      const bad = openNamespace({ base: BASE, ns: "main", token, mode: "host" });
      try {
        await assert.rejects(bad.execute("SELECT 1"));
      } finally {
        bad.close();
      }
    }
  },
);

function migrate(token) {
  const u = new URL(BASE);
  const r = spawnSync(
    process.execPath,
    ["scripts/db/migrate.mjs", "--db", "main", "--target", "sqld"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        TURSO_MAIN_URL: `${u.protocol}//main.${u.host}`,
        ...(token ? { TURSO_MAIN_TOKEN: token } : {}),
        SQLD_ADMIN_URL: ADMIN,
      },
    },
  );
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test(
  "migrate.mjs: no token and a wrong token fail without printing the token; a valid token applies",
  { skip },
  () => {
    const wrong = mintToken(pem("other"));
    for (const t of [undefined, wrong]) {
      const r = migrate(t);
      assert.notEqual(r.code, 0, "migrate must fail without a trusted token");
      if (t) assert.ok(!r.out.includes(t), "the token must never be printed");
    }
    const good = mintToken(pem("good"));
    const r = migrate(good);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /applied \d+/);
    assert.ok(!r.out.includes(good));
    const again = migrate(good);
    assert.equal(again.code, 0);
    assert.match(again.out, /applied 0/);
  },
);
