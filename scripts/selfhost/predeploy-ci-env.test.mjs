// scripts/selfhost/predeploy-ci-env.mjs: the full mode that feeds bootstrap.sh's name check, and the JWT mode.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ciEnv, completeSection, main, sectionNames } from "./predeploy-ci-env.mjs";
import { verifyToken } from "./jwt.mjs";
import { tempDir } from "./testkit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLE = path.join(ROOT, "deploy/selfhost/env.example");
const t = tempDir();
after(() => t.cleanup());
const names = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, l.indexOf("=")));

test("--full writes every name of every env.example section, CLOCK_ENABLED and EMAIL_LIVE off", () => {
  const dir = path.join(t.dir, "env");
  const out = [];
  assert.equal(main([dir, "--full", EXAMPLE, "--jwt", path.join(t.dir, "keys")]), 0, out.join());
  const example = readFileSync(EXAMPLE, "utf8");
  for (const [file, section] of [
    ["web.env", "web.env"],
    ["jobs.env", "jobs.env"],
    ["sqld.env", "sqld.env"],
  ]) {
    const text = readFileSync(path.join(dir, file), "utf8");
    assert.deepEqual(names(text), sectionNames(example, section));
  }
  const jobs = readFileSync(path.join(dir, "jobs.env"), "utf8");
  assert.match(jobs, /^CLOCK_ENABLED=0$/m);
  assert.match(jobs, /^EMAIL_LIVE=0$/m);
  assert.match(readFileSync(path.join(dir, "web.env"), "utf8"), /^CLOCK_ENABLED=0$/m);
});

test("--jwt: sqld.env holds the public key, the tokens verify against it, the private key stays out of the env dir", () => {
  const dir = path.join(t.dir, "env2");
  const keys = path.join(t.dir, "keys2");
  assert.equal(main([dir, "--jwt", keys, "--refresh-url", "http://fake-turso:8080"]), 0);
  const pub = /^SQLD_AUTH_JWT_KEY=(.+)$/m.exec(readFileSync(path.join(dir, "sqld.env"), "utf8"))[1];
  const jobs = readFileSync(path.join(dir, "jobs.env"), "utf8");
  const web = readFileSync(path.join(dir, "web.env"), "utf8");
  for (const [text, name] of [
    [jobs, "TURSO_MAIN_TOKEN"],
    [jobs, "SQLD_TOKEN"],
    [web, "TURSO_AUTH_TOKEN"],
  ]) {
    const tok = new RegExp(`^${name}=(.+)$`, "m").exec(text)[1];
    assert.equal(verifyToken(tok, pub), true, name);
  }
  assert.match(jobs, /^TURSO_REFRESH_MAIN_URL=http:\/\/fake-turso:8080$/m);
  assert.ok(!readFileSync(path.join(dir, "sqld.env"), "utf8").includes("PRIVATE"));
  assert.ok(readFileSync(path.join(keys, "jwt-private.pem"), "utf8").includes("PRIVATE KEY"));
});

test("without options nothing changes: sqld.env empty, random hex tokens", () => {
  const e = ciEnv();
  assert.equal(e.sqld, "");
  assert.match(e.jobs, /^TURSO_MAIN_TOKEN=[0-9a-f]{64}$/m);
  assert.equal(
    completeSection("# ===== BEGIN a =====\nX=\nY=\n# ===== END a =====\n", "a", "Y=2\n"),
    "X=\nY=2\n",
  );
});

test("usage errors are exit 2", () => {
  assert.equal(main([]), 2);
  assert.equal(main(["d", "--full"]), 2);
});
