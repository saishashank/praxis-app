import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  evaluate,
  isAllowed,
  nameFromKey,
  normaliseLicence,
  productionPackages,
  run,
} from "./licence-check.mjs";

test("isAllowed: the UXN-019 list passes, others fail", () => {
  for (const l of [
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "MPL-2.0",
    "OFL-1.1",
  ]) {
    assert.ok(isAllowed(l), l);
  }
  for (const l of [
    "GPL-3.0",
    "LGPL-3.0-or-later",
    "CC-BY-4.0",
    "0BSD",
    "UNLICENSED",
    "",
    undefined,
  ]) {
    assert.ok(!isAllowed(l), String(l));
  }
});

test("isAllowed: OR needs one allowed branch, AND needs all", () => {
  assert.ok(isAllowed("(MIT OR GPL-3.0)"));
  assert.ok(isAllowed("MIT AND ISC"));
  assert.ok(!isAllowed("MIT AND LGPL-3.0-or-later"));
  assert.ok(!isAllowed("Apache-2.0 WITH LLVM-exception"));
});

test("normaliseLicence handles legacy shapes", () => {
  assert.equal(normaliseLicence({ type: "MIT" }), "MIT");
  assert.equal(normaliseLicence([{ type: "MIT" }, { type: "Apache-2.0" }]), "MIT OR Apache-2.0");
  assert.equal(normaliseLicence(undefined), "");
});

test("nameFromKey takes the innermost package", () => {
  assert.equal(nameFromKey("node_modules/@a/b"), "@a/b");
  assert.equal(nameFromKey("node_modules/x/node_modules/y"), "y");
});

const LOCK = {
  packages: {
    "": { name: "app" },
    "node_modules/ok": { version: "1.0.0", license: "MIT" },
    "node_modules/devonly": { version: "1.0.0", license: "GPL-3.0", dev: true },
    "node_modules/devopt": { version: "1.0.0", license: "GPL-3.0", devOptional: true },
    "node_modules/bad": { version: "2.0.0", license: "GPL-3.0" },
    "node_modules/nolicence": { version: "3.0.0" },
  },
};

test("productionPackages skips dev packages and the root; installed licence wins", () => {
  const pk = productionPackages(LOCK, (key) =>
    key === "node_modules/nolicence" ? { license: "ISC" } : null,
  );
  assert.deepEqual(
    pk.map((p) => `${p.name}:${p.licence}`),
    ["bad:GPL-3.0", "nolicence:ISC", "ok:MIT"],
  );
});

test("evaluate: disallowed and unknown fail; an Owner exception passes", () => {
  const pk = productionPackages(LOCK);
  const r = evaluate(pk);
  assert.deepEqual(
    r.failures.map((f) => [f.name, f.reason]),
    [
      ["bad", "not on the allow-list"],
      ["nolicence", "unknown licence"],
    ],
  );
  const r2 = evaluate(pk, [
    { package: "bad", licence: "GPL-3.0", approvedBy: "Owner", date: "2026-10-21" },
  ]);
  assert.deepEqual(
    r2.failures.map((f) => f.name),
    ["nolicence"],
  );
  assert.equal(r2.exceptionsUsed[0].name, "bad");
  const r3 = evaluate(pk, [{ package: "bad", licence: "MIT" }]);
  assert.ok(
    r3.failures.some((f) => f.name === "bad"),
    "exception for another licence is ignored",
  );
});

test("evaluate: a pending entry is not an approval — warning normally, failure in release mode", () => {
  const pk = productionPackages(LOCK);
  const ex = [{ package: "bad", licence: "GPL-3.0", approvedBy: "pending", date: null }];
  const normal = evaluate(pk, ex);
  assert.deepEqual(
    normal.pending.map((p) => p.name),
    ["bad"],
  );
  assert.equal(normal.exceptionsUsed.length, 0, "pending is never counted as an Owner exception");
  assert.ok(!normal.failures.some((f) => f.name === "bad"));
  const release = evaluate(pk, ex, undefined, { release: true });
  assert.ok(
    release.failures.some((f) => f.name === "bad" && f.reason === "Owner approval pending"),
  );
  assert.equal(release.pending.length, 0);
});

test("run: reads a temp project, installed licence wins, nothing is generated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "licence-"));
  try {
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(LOCK));
    fs.mkdirSync(path.join(root, "node_modules/ok"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules/ok/package.json"),
      JSON.stringify({ name: "ok", license: "ISC" }),
    );
    const r = run({ root });
    assert.equal(r.failures.length, 2);
    assert.equal(r.packages.find((p) => p.name === "ok").licence, "ISC");
    assert.ok(!fs.existsSync(path.join(root, "src")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
