import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scan } from "./repo-hygiene.mjs";

const ALLOW = { docs: ["docs/glossary.md", "docs/owner-guide/", "docs/brand/"], files: {} };

/** Temp git repo with the given { path: content } tracked. */
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hygiene-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [p, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), content);
  }
  execFileSync("git", ["add", "-A", "-f"], { cwd: dir, stdio: "pipe" });
  return dir;
}

const rules = (dir, allow = ALLOW) => scan(dir, allow).map((f) => `${f.rule} ${f.file}`);

test("a clean repo has no findings", () => {
  const dir = repo({
    "src/a.ts": "export const a = 1;\n",
    ".env.example": "KEY=\n",
    "docs/glossary.md": "# Glossary\n",
    "docs/owner-guide/x.md": "hi\n",
    "notes.md":
      "write to a@example.com, b@example.test, c@x.invalid, d@h.test, onboarding@resend.dev\n",
    "git.md": "1+x@users.noreply.github.com noreply@anthropic.com pkg@1.2.3 @types/node\n",
  });
  assert.deepEqual(rules(dir), []);
});

test("data-like extensions, .env files and *.local.* are flagged", () => {
  const names = ["a.csv", "a.tsv", "a.parquet", "a.xlsx", "a.xls", "a.db", "a.sqlite", "a.sqlite3"];
  names.push("a.ndjson", "a.jsonl", "a.gz", "a.zip", "a.age", "a.pem", "a.key", "a.p12", "a.pfx");
  names.push("a.env", ".env", ".env.production", "app.local.json", ".env.local");
  const dir = repo(
    Object.fromEntries(names.map((n) => [`data/${n}`.replace("/.env", "/.env"), "x"])),
  );
  const found = rules(dir);
  assert.equal(found.length, names.length);
  assert.ok(found.every((f) => f.startsWith("HYG-DATA ")));
});

test("files over 1 MB are flagged except package-lock.json and docs/brand", () => {
  const big = "a".repeat(1024 * 1024 + 1);
  const dir = repo({ "big.txt": big, "package-lock.json": big, "docs/brand/p.png": big });
  assert.deepEqual(rules(dir), ["HYG-SIZE big.txt"]);
});

test("paths copied from private repos are flagged", () => {
  const dir = repo({
    "log/s1.md": "x",
    "RESUME.md": "x",
    "sub/BUILD_SETUP.md": "x",
    "AGENT_PLAN.md": "x",
    "TOKEN_PLAN.md": "x",
    "PLUGINS.md": "x",
    "Requirement/v1/a.md": "x",
    "fixtures/a.json": "{}",
    "docs/project_imports/a.md": "x",
    "docs/other.md": "x",
    "src/fixtures/ok.ts": "x",
    "spec/ok.md": "x",
  });
  const found = rules(dir);
  assert.equal(found.length, 10);
  assert.ok(found.every((f) => f.startsWith("HYG-PRIVATE ")));
  assert.ok(!found.some((f) => f.includes("src/fixtures") || f.includes("spec/")));
});

test("the docs allowlist admits known docs only", () => {
  const dir = repo({ "docs/glossary.md": "x", "docs/brand/a.svg": "<svg/>", "docs/new.md": "x" });
  assert.deepEqual(rules(dir), ["HYG-PRIVATE docs/new.md"]);
  assert.deepEqual(rules(dir, { ...ALLOW, docs: [...ALLOW.docs, "docs/new.md"] }), []);
});

test("email addresses are flagged except placeholder domains; output has no contents", () => {
  const dir = repo({
    "a.md": "contact jane.doe@gmail.com",
    "b.md": "x@example.org",
    "c.md": "ok@example.com",
  });
  assert.deepEqual(rules(dir), ["HYG-EMAIL a.md", "HYG-EMAIL b.md"]);
  assert.ok(!JSON.stringify(scan(dir, ALLOW)).includes("jane"));
});

test("AU phone numbers are flagged", () => {
  for (const n of [
    "0412 345 678",
    "+61 412 345 678",
    "(03) 9123 4567",
    "03 9123 4567",
    "0412345678",
  ]) {
    assert.deepEqual(rules(repo({ "p.md": `call ${n} now` })), ["HYG-PHONE p.md"], n);
  }
  assert.deepEqual(rules(repo({ "p.md": "version 2026-10-10 build 12345678" })), []);
});

test("price-bar CSV headers are flagged outside test files", () => {
  const header = ["Date", "Open", "High", "Low", "Close", "Volume"].join(",");
  const dir = repo({
    "src/x.ts": `const h = "x";\n${header}\n`,
    "tests/y.ts": header,
    "z.test.mjs": header,
  });
  assert.deepEqual(rules(dir), ["HYG-MARKET src/x.ts"]);
});

test("per-rule file allowlist suppresses only that rule and path", () => {
  const dir = repo({ "fx/a.csv": "x", "fx/b.csv": "x", "m.md": "a@b.io" });
  const allow = { ...ALLOW, files: { "HYG-DATA": ["fx/a.csv"], "HYG-EMAIL": ["m.md"] } };
  assert.deepEqual(rules(dir, allow), ["HYG-DATA fx/b.csv"]);
  assert.deepEqual(rules(dir, { ...ALLOW, files: { "HYG-DATA": ["fx/"] } }), ["HYG-EMAIL m.md"]);
});

test("CLI exits 1 with rule and path only, 0 when clean", () => {
  const script = path.join(import.meta.dirname, "repo-hygiene.mjs");
  const bad = repo({ "a.csv": "topvalue,1" });
  assert.throws(
    () => execFileSync("node", [script, "--root", bad, "--allow", "none.json"], { stdio: "pipe" }),
    (e) =>
      e.status === 1 &&
      /HYG-DATA {2}a\.csv/.test(String(e.stderr)) &&
      !/topvalue/.test(String(e.stderr)),
  );
  const ok = repo({ "a.ts": "x" });
  execFileSync("node", [script, "--root", ok, "--allow", "none.json"], { stdio: "pipe" });
});
