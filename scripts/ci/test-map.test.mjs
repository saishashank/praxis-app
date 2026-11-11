import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildMap, checkMap, idsIn, mergeBaseline, parseMapDoc } from "./test-map.mjs";

const script = fileURLToPath(new URL("./test-map.mjs", import.meta.url));

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testmap-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

const DOC = [
  "| Requirement ID | What | Test file(s) | Layer | Status |",
  "|---|---|---|---|---|",
  "| [SEC-010](../spec/x.md), ROL-101 (auth) | text | `tests/a.test.ts`, `tests/gone.test.ts` | unit | ok |",
  "| [TST-107](../spec/x.md) | nothing | none | none | not yet |",
  "| [BLD-011](../spec/x.md) | run | `.github/workflows/ci.yml` | wf | partial |",
].join("\n");

test("idsIn finds requirement IDs but not look-alikes such as UTF-8 or SHA-256", () => {
  assert.deepEqual(idsIn("AT-05a, TST-120 and D-016; UTF-8 SHA-256 ISO-8601"), [
    "AT-05a",
    "TST-120",
    "D-016",
  ]);
});

test("parseMapDoc reads IDs from column 1 and backticked files from column 3", () => {
  const rows = parseMapDoc(DOC);
  assert.deepEqual(rows[0].ids, ["SEC-010", "ROL-101"]);
  assert.deepEqual(rows[0].files, ["tests/a.test.ts", "tests/gone.test.ts"]);
  assert.deepEqual(rows[1].files, []);
});

test("buildMap joins doc rows and IDs cited inside test files; missing and non-test files are ignored", () => {
  const root = tree({
    "docs/test-map.md": DOC,
    "tests/a.test.ts": "// covers AT-02 and SEC-010\n",
    "worker/test/w.test.ts": "describe('TST-120 gate', () => {})",
    "tests/helper.ts": "// AT-99 in a helper is not a test",
  });
  const m = buildMap(root);
  assert.deepEqual(m["SEC-010"], ["tests/a.test.ts"]);
  assert.deepEqual(m["ROL-101"], ["tests/a.test.ts"]);
  assert.deepEqual(m["AT-02"], ["tests/a.test.ts"]);
  assert.deepEqual(m["TST-120"], ["worker/test/w.test.ts"]);
  assert.equal(m["AT-99"], undefined);
  assert.equal(m["BLD-011"], undefined);
});

test("checkMap: passes unchanged; new files and IDs are fine", () => {
  const base = { "AT-02": ["tests/a.test.ts"] };
  const cur = { "AT-02": ["tests/a.test.ts", "tests/b.test.ts"], "AT-03": ["tests/c.test.ts"] };
  assert.deepEqual(
    checkMap(base, cur, () => true),
    [],
  );
});

test("checkMap: a mapped file that disappeared fails", () => {
  const base = { "SEC-010": ["tests/a.test.ts", "tests/b.test.ts"] };
  const cur = { "SEC-010": ["tests/a.test.ts"] };
  const f = checkMap(base, cur, (p) => p !== "tests/b.test.ts");
  assert.equal(f.length, 1);
  assert.match(f[0], /SEC-010: mapped test file disappeared: tests\/b\.test\.ts/);
});

test("checkMap: an AT row that loses all tests fails, named as an acceptance row", () => {
  const f = checkMap({ "AT-04": ["tests/a.test.ts"] }, {}, () => false);
  assert.equal(f.length, 2);
  assert.match(f[1], /AT-04: acceptance row lost its last test/);
});

test("mergeBaseline keeps old entries unless pruning", () => {
  const base = { "AT-1": ["x.test.ts"], "AT-2": ["y.test.ts"] };
  const cur = { "AT-1": ["z.test.ts"] };
  assert.deepEqual(mergeBaseline(base, cur), {
    "AT-1": ["x.test.ts", "z.test.ts"],
    "AT-2": ["y.test.ts"],
  });
  assert.deepEqual(mergeBaseline(base, cur, { prune: true }), { "AT-1": ["z.test.ts"] });
});

test("CLI end to end: update writes a baseline, check passes, deleting a test file fails", () => {
  const root = tree({ "tests/a.test.ts": "// AT-02\n", "tests/b.test.ts": "// AT-02 TST-120\n" });
  const run = (...a) =>
    execFileSync(process.execPath, [script, "--root", root, ...a], { stdio: "pipe" });
  const bl = path.join(root, "tests", "test-map.baseline.json");
  run("--update");
  assert.deepEqual(JSON.parse(fs.readFileSync(bl, "utf8")).map["AT-02"], [
    "tests/a.test.ts",
    "tests/b.test.ts",
  ]);
  assert.doesNotThrow(() => run());
  fs.rmSync(path.join(root, "tests", "b.test.ts"));
  assert.throws(
    () => run(),
    (e) => e.status === 1 && /TST-120: acceptance|TST-120: requirement/.test(String(e.stderr)),
  );
  fs.rmSync(path.join(root, "tests", "a.test.ts"));
  assert.throws(
    () => run(),
    (e) => /AT-02: acceptance row lost its last test/.test(String(e.stderr)),
  );
});

test("the committed baseline holds against this repository", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const base = JSON.parse(
    fs.readFileSync(path.join(root, "tests", "test-map.baseline.json"), "utf8"),
  ).map;
  const f = checkMap(base, buildMap(root), (p) => fs.existsSync(path.join(root, p)));
  assert.deepEqual(f, []);
});

// M18 D4 (TST-138, D-970, AT-85): every acceptance row names a V3 home.
import { HOMES, acceptanceIds, homeFindings, parseHome } from "./test-map.mjs";

test("parseHome: the five homes, combined with ' + '; anything else is no home", () => {
  assert.deepEqual(HOMES, ["CI", "CI recorded-day", "local", "prod read-only", "Owner"]);
  assert.deepEqual(parseHome(" CI recorded-day "), ["CI recorded-day"]);
  assert.deepEqual(parseHome("CI + Owner"), ["CI", "Owner"]);
  for (const bad of ["", " ", undefined, "staging", "CI + staging", "ci", "CI recorded day"]) {
    assert.equal(parseHome(bad), null, String(bad));
  }
});

test("parseMapDoc reads the V3 home from column 6 (null when absent)", () => {
  const rows = parseMapDoc(
    [
      "| AT-01 | x | `tests/a.test.ts` | unit | ok | CI + Owner |",
      "| AT-02 | x | `tests/a.test.ts` | unit | ok |",
      "| AT-M4 | x | none | none | pending | CI recorded-day |",
    ].join("\n"),
  );
  assert.deepEqual(rows[0].home, ["CI", "Owner"]);
  assert.equal(rows[1].home, null);
  assert.deepEqual(rows[2].ids, ["AT-M4"]);
  assert.deepEqual(rows[2].home, ["CI recorded-day"]);
});

test("acceptanceIds: AT-01 to AT-85 and AT-M1 to AT-M5, from the constants and the spec copy", () => {
  const ids = acceptanceIds(fs.mkdtempSync(path.join(os.tmpdir(), "testmap-nospec-")));
  assert.equal(ids.length, 85 + 5);
  assert.ok(
    ids.includes("AT-01") &&
      ids.includes("AT-85") &&
      ids.includes("AT-M1") &&
      ids.includes("AT-M5"),
  );
  assert.ok(!ids.includes("AT-86") && !ids.includes("AT-M0"));
  const repo = acceptanceIds(fileURLToPath(new URL("../../", import.meta.url)));
  assert.deepEqual(repo, ids); // the repo's chapter copy adds nothing outside the range
});

test("homeFindings: an acceptance id with no row, or only rows without a home, is named", () => {
  const rows = parseMapDoc(
    [
      "| AT-01, AT-02a | x | none | none | ok | Owner |",
      "| AT-03 | x | none | none | ok |",
      "| AT-03 | y | none | none | ok | staging |",
    ].join("\n"),
  );
  assert.deepEqual(homeFindings(rows, ["AT-01", "AT-02", "AT-03", "AT-04"]), [
    `AT-03: no V3 home (one of ${HOMES.join(", ")}) in docs/test-map.md`,
    "AT-04: no row in docs/test-map.md",
  ]);
});

test("CLI --summary: a missing home fails (exit 1), a complete map passes; the plain check does not look", () => {
  const rowFor = (id, home) =>
    `| ${id} | x | \`tests/a.test.ts\` | unit | ok |${home ? ` ${home} |` : ""}`;
  const header = [
    "| Requirement ID | What | Test file(s) | Layer | Status | V3 home |",
    "|---|---|---|---|---|---|",
  ];
  const root = tree({ "tests/a.test.ts": "// AT-02\n" });
  const ids = acceptanceIds(root);
  const write = (lines) =>
    fs.mkdirSync(path.join(root, "docs"), { recursive: true }) ??
    fs.writeFileSync(path.join(root, "docs", "test-map.md"), [...header, ...lines].join("\n"));
  const run = (...a) =>
    execFileSync(process.execPath, [script, "--root", root, ...a], { stdio: "pipe" });
  run("--update");
  write(ids.map((id) => rowFor(id, id === "AT-30" ? "Owner" : "CI")));
  assert.doesNotThrow(() => run("--summary"));
  write(ids.map((id) => rowFor(id, id === "AT-30" ? "" : "CI")));
  assert.throws(
    () => run("--summary"),
    (e) => e.status === 1 && /AT-30: no V3 home/.test(String(e.stderr)),
  );
  write(ids.filter((id) => id !== "AT-85").map((id) => rowFor(id, "CI")));
  assert.throws(
    () => run("--summary"),
    (e) => e.status === 1 && /AT-85: no row in docs\/test-map\.md/.test(String(e.stderr)),
  );
  assert.doesNotThrow(() => run()); // the plain check protects the baseline only
});

test("the committed docs/test-map.md gives every acceptance row a V3 home (this repository)", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const rows = parseMapDoc(fs.readFileSync(path.join(root, "docs", "test-map.md"), "utf8"));
  assert.deepEqual(homeFindings(rows, acceptanceIds(root)), []);
  const home = (id) => rows.filter((r) => r.ids.includes(id)).flatMap((r) => r.home ?? []);
  for (const id of ["AT-42", "AT-60", "AT-61", "AT-62", "AT-M4"]) {
    assert.ok(home(id).includes("CI recorded-day"), id);
  }
  assert.ok(home("AT-30").includes("Owner"));
  assert.ok(home("AT-26").includes("CI") && home("AT-26").includes("Owner"));
});
