// D-1854: the weekly mutation run's test set (stryker.config.mjs + vitest.mutation.config.mts).
// Every weekly run from 24 Oct 2026 failed with "Initial test run timed out": Stryker's dry run was
// given nearly the whole suite (its "related" set for the mutated parameter registry) and the 5-minute
// default limit. These checks keep the dry run small enough to finish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../stryker.config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const text = readFileSync(path.join(root, "vitest.mutation.config.mts"), "utf8");
const listed = [...text.matchAll(/"(tests\/[^"]+\.test\.tsx?)"/g)].map((m) => m[1]);

// the database writer, replay-parity and acceptance tests (13 s to 215 s a file on a laptop)
const SLOW = [
  "tests/replay/cohortParity.test.ts",
  "tests/replay/cohortReplay.test.ts",
  "tests/replay/breakerParity.test.ts",
  "tests/replay/nullRuns.test.ts",
  "tests/arena/ledgerWriter.test.ts",
  "tests/arena/closeBooks.test.ts",
  "tests/arena/closeBooks.kill.test.ts",
  "tests/arena/sleeveWriter.test.ts",
  "tests/arena/cohortWriter.test.ts",
  "tests/arena/fillWriter.test.ts",
  "tests/arena/acceptance.test.ts",
];

test("Stryker runs only the listed unit tests, with a dry-run limit above the 5-minute default", () => {
  assert.deepEqual(config.vitest, { configFile: "vitest.mutation.config.mts", related: false });
  assert.ok(config.dryRunTimeoutMinutes >= 10 && config.dryRunTimeoutMinutes <= 60);
});

test("the mutation config uses the list and the suite's alias, environment and setup", () => {
  const suite = readFileSync(path.join(root, "vitest.config.mts"), "utf8");
  assert.match(text, /include: MUTATION_TESTS/);
  for (const s of [
    '"@": path.resolve(import.meta.dirname, "src")',
    'environment: "jsdom"',
    'setupFiles: ["./vitest.setup.ts"]',
    'globalSetup: ["./vitest.global-setup.mts"]',
  ]) {
    assert.ok(suite.includes(s), `the suite config no longer has ${s}`);
    assert.ok(text.includes(s), `the mutation config lacks ${s}`);
  }
});

test("every listed test exists, is listed once and is not a slow database or parity test", () => {
  assert.ok(listed.length >= 40, `only ${listed.length} tests listed`);
  assert.equal(new Set(listed).size, listed.length);
  for (const f of listed) assert.ok(existsSync(path.join(root, f)), `${f} is missing`);
  for (const f of SLOW) assert.ok(!listed.includes(f), `${f} would rerun for every mutant`);
});

test("each mutated group has at least one listed test, and the database loaders are not mutated", () => {
  const groups = [
    /^tests\/money\//,
    /^tests\/arena\//,
    /^tests\/stats\//,
    /^tests\/replay\//,
    /^tests\/agents\/families\//,
  ];
  for (const g of groups)
    assert.ok(
      listed.some((f) => g.test(f)),
      `no test for ${g}`,
    );
  const mutated = config.mutate
    .flatMap((p) => globSync(p, { cwd: root }))
    .map((f) => f.replaceAll("\\", "/"));
  assert.ok(!mutated.includes("src/lib/agents/candidates.ts"));
  assert.ok(!mutated.includes("src/lib/agents/params.ts"));
  assert.ok(mutated.some((f) => f.startsWith("src/lib/money/")));
  assert.ok(mutated.some((f) => f.startsWith("src/lib/stats/")));
});

// D-1855: vitest-runner 10.0.0 built each mutant's test-name filter with spaces; vitest 5 matches names
// joined with " > ", so no test ran and every mutant survived (score 0 %). 10.1.1 is the first fix.
const atLeast = (v, min) => {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

test("the vitest runner joins test names the way vitest 5 matches them (D-1855)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const vitest = pkg.devDependencies.vitest;
  for (const name of ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"]) {
    const v = pkg.devDependencies[name];
    if (atLeast(vitest.replace(/^\D*/, ""), "5.0.0"))
      assert.ok(atLeast(v, "10.1.1"), `${name} ${v} cannot filter tests under vitest ${vitest}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, v, `${name}: lockfile differs`);
  }
});

test("vitest's github-actions reporter is off in the mutation run (D-1855: 1 MB summary limit)", () => {
  const reporters = text.match(/^\s*reporters: (.*)$/gm) ?? [];
  assert.deepEqual(
    reporters.map((l) => l.trim()),
    ['reporters: ["dot"],'],
  );
  assert.ok(config.concurrency >= 2 && config.concurrency <= 4);
});

test("the job has room for the run (D-1854)", () => {
  const wf = readFileSync(path.join(root, ".github/workflows/mutation.yml"), "utf8");
  const m = /timeout-minutes: (\d+)/.exec(wf);
  assert.ok(m !== null && Number(m[1]) >= 240 && Number(m[1]) <= 360);
});
