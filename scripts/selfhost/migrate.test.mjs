// INFRA T4: scripts/db/migrate.mjs --target sqld (a local file database stands in for the sqld
// namespace). The default target keeps its old behaviour.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./testkit.mjs";

const t = tempDir();
after(() => t.cleanup());
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../db/migrate.mjs");

function migrate(args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("--target sqld migrates a database, needs no token, and checks foreign_keys = 1", () => {
  const r = migrate(["--db", "auth", "--target", "sqld"], { TURSO_AUTH_URL: t.url("mig-auth.db") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrate auth: applied \d+ \(now at v\d+\)/);
  const again = migrate(["--db", "auth", "--target", "sqld"], {
    TURSO_AUTH_URL: t.url("mig-auth.db"),
  });
  assert.match(again.out, /applied 0/);
});

test("without --target the token is still required for a remote URL (unchanged)", () => {
  const r = migrate(["--db", "main"], { TURSO_MAIN_URL: "http://main.sqld:1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /migrate: TURSO_MAIN_TOKEN is not set/);
});

test("an unknown --target is a usage error; an unreachable admin API is a short fixed message", () => {
  const bad = migrate(["--db", "main", "--target", "mars"], { TURSO_MAIN_URL: t.url("x.db") });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /migrate: usage: --target turso\|sqld/);
  const down = migrate(["--db", "main", "--target", "sqld"], {
    TURSO_MAIN_URL: t.url("y.db"),
    SQLD_ADMIN_URL: "http://127.0.0.1:1",
  });
  assert.equal(down.code, 1);
  assert.match(down.out, /migrate: sqld: admin API unreachable/);
  assert.equal(/127\.0\.0\.1/.test(down.out), false);
});

test("--target sqld with SQLD_URL and no TURSO_AUTH_URL reaches the namespace through SQLD_URL (jobs.env has no auth URL)", () => {
  const needsUrl = migrate(["--db", "auth", "--target", "sqld"], {});
  assert.equal(needsUrl.code, 1);
  assert.match(needsUrl.out, /migrate: TURSO_AUTH_URL is not set/);
  // SQLD_URL given: the error is now about reaching that sqld (nothing listens on port 1), not about the missing URL
  // variable, and neither the address nor the token is printed.
  const viaBase = migrate(["--db", "auth", "--target", "sqld"], {
    SQLD_URL: "http://sqld:1",
    SQLD_TOKEN: "t0ken-value",
  });
  assert.equal(viaBase.code, 1);
  assert.doesNotMatch(viaBase.out, /TURSO_AUTH_URL is not set/);
  assert.equal(/t0ken-value|sqld:1/.test(viaBase.out), false, viaBase.out);
});
