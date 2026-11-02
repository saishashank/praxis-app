import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FORBIDDEN_NAMES, registryNames, scanDir } from "./bundle-secret-scan.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bundle-scan-"));
}

test("a clean bundle has no hits", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "chunks"));
  fs.writeFileSync(path.join(dir, "chunks", "a.js"), "console.log('NEXT_PUBLIC_X')");
  assert.deepEqual(scanDir(dir), []);
});

test("every forbidden name is detected, in nested files", () => {
  for (const name of FORBIDDEN_NAMES) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "chunks", "deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "chunks", "deep", "b.js"), `var x=process.env.${name}x;`);
    const hits = scanDir(dir);
    assert.equal(hits.length, 1, name);
    assert.equal(hits[0].name, name);
    assert.equal(hits[0].file, path.join("chunks", "deep", "b.js"));
  }
});

test("hits report names and paths only, never content", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "c.js"), "AUTH_SECRET=SECRET-VALUE-123");
  assert.ok(!JSON.stringify(scanDir(dir)).includes("SECRET-VALUE-123"));
});

test("the list is derived from the secrets registry (V1-I12)", () => {
  const derived = registryNames();
  assert.ok(derived.length >= 25, "registry names were read");
  for (const n of derived)
    assert.ok(
      FORBIDDEN_NAMES.some((f) => n.includes(f)),
      n,
    );
  for (const n of [
    "WORKER_HMAC_SECRET",
    "BACKUP_PRIVATE_KEY",
    "FIXTURES_READ_TOKEN",
    "GITHUB_DISPATCH_TOKEN",
  ])
    assert.ok(
      FORBIDDEN_NAMES.some((f) => n.includes(f)),
      n,
    );
  assert.ok(FORBIDDEN_NAMES.includes("TURSO_"));
});
