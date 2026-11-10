// scripts/selfhost/seed-session.mjs against a local libSQL file with the real auth migrations: the cookie it writes
// decodes with the same secret and salt Auth.js uses, and the script refuses anything that is not a throwaway stack.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "next-auth/jwt";
import { COOKIE_NAME, main, seedSession } from "./seed-session.mjs";
import { tempDir } from "./testkit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const t = tempDir();
after(() => t.cleanup());
const SECRET = "a".repeat(64);

function migratedAuth(name) {
  const url = t.url(name);
  const r = spawnSync(process.execPath, ["scripts/db/migrate.mjs", "--db", "auth"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH, TURSO_AUTH_URL: url },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return url;
}

test("the cookie decodes to the seeded user's id and session_version; a second run reuses the user", async () => {
  const url = migratedAuth("auth.db");
  const a = await seedSession({ url, secret: SECRET });
  const b = await seedSession({ url, secret: SECRET });
  assert.equal(a.uid, b.uid);
  assert.ok(a.cookie.startsWith(`${COOKIE_NAME}=`));
  assert.match(a.cookie, /^authjs\.session-token=[\w.%~+/=-]+$/);
  const claims = await decode({
    token: a.cookie.slice(COOKIE_NAME.length + 1),
    secret: SECRET,
    salt: COOKIE_NAME,
  });
  assert.equal(claims.uid, a.uid);
  assert.equal(claims.sv, 1);
  assert.equal(claims.rec, false);
  const db = t.open("auth.db");
  const rows = (await db.execute("SELECT role, status FROM app_user")).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([String(rows[0].role), String(rows[0].status)], ["owner", "active"]);
});

test("refuses Turso, a real address and a missing secret", async () => {
  await assert.rejects(
    seedSession({ url: "libsql://x-y.turso.io", secret: SECRET }),
    /never Turso/,
  );
  await assert.rejects(seedSession({ url: "https://x.turso.io", secret: SECRET }), /never Turso/);
  await assert.rejects(
    seedSession({ url: t.url("auth.db"), secret: SECRET, email: "someone@example.com" }),
    /\.test/,
  );
  await assert.rejects(seedSession({ url: t.url("auth.db"), secret: "" }), /AUTH_SECRET/);
});

test("main writes the cookie file (mode 600) and prints no secret", async () => {
  const url = migratedAuth("auth2.db");
  const file = path.join(t.dir, "cookie.txt");
  const out = [];
  const code = await main([file], { TURSO_AUTH_URL: url, AUTH_SECRET: SECRET }, (s) => out.push(s));
  assert.equal(code, 0);
  const cookie = readFileSync(file, "utf8");
  assert.ok(cookie.startsWith(`${COOKIE_NAME}=`));
  assert.ok(
    !out.join("\n").includes(cookie.slice(COOKIE_NAME.length + 1, COOKIE_NAME.length + 30)),
  );
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(await main([], {}, () => {}), 2);
});
