// M8 T12: the mutation summary and stryker.config.mjs (TST-130: score >= 80 %, decision 22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../stryker.config.mjs";
import { FLOOR, main, summarise } from "./mutation-summary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const m = (status) => ({
  id: "1",
  mutatorName: "x",
  replacement: "SECRET_SOURCE",
  status,
  location: {},
});
const file = (...statuses) => ({
  language: "typescript",
  source: "const secret = 1",
  mutants: statuses.map(m),
});

test("the floor is TST-130's 80 % and is the Stryker break threshold", () => {
  assert.equal(FLOOR, 80);
  assert.equal(config.thresholds.break, 80);
  const spec = readFileSync(path.join(root, "spec/10_nfr_testing.md"), "utf8");
  assert.match(spec, /TST-130[^\n]*score ≥ 80%/);
});

test("score = (killed + timeout) / (killed + timeout + survived + no coverage)", () => {
  const r = summarise({
    files: {
      "src/lib/money/micro.ts": file(
        "Killed",
        "Killed",
        "Timeout",
        "Survived",
        "Ignored",
        "CompileError",
      ),
      "src/lib/stats/ks.ts": file("Killed", "NoCoverage"),
    },
  });
  assert.equal(r.rows.find((x) => x.file.endsWith("micro.ts")).score, 75);
  assert.equal(r.total, (100 * 4) / 6);
  assert.equal(r.fail, true);
  assert.equal(r.rows[0].file, "src/lib/stats/ks.ts"); // worst first
});

test("at or above the floor passes; an empty report fails", () => {
  const ok = summarise({
    files: { "src/lib/stats/a.ts": file("Killed", "Killed", "Killed", "Killed", "Survived") },
  });
  assert.equal(ok.total, 80);
  assert.equal(ok.fail, false);
  assert.equal(summarise({}).fail, true);
});

test("the table never prints mutant source, replacement or an odd path", () => {
  const r = summarise({
    files: { "src/lib/stats/a.ts": file("Killed"), "evil|path": file("Killed") },
  });
  assert.doesNotMatch(r.text, /SECRET_SOURCE|const secret/);
  assert.match(r.text, /\(unprintable path\)/);
});

test("the CLI: exit codes and the summary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mut-"));
  try {
    const rep = path.join(dir, "m.json");
    const sum = path.join(dir, "s.md");
    writeFileSync(
      rep,
      JSON.stringify({ files: { "src/lib/stats/a.ts": file("Killed", "Killed") } }),
    );
    assert.equal(
      main([rep], { GITHUB_STEP_SUMMARY: sum }, () => {}),
      0,
    );
    assert.match(readFileSync(sum, "utf8"), /PASS/);
    writeFileSync(rep, JSON.stringify({ files: { "src/lib/stats/a.ts": file("Survived") } }));
    assert.equal(
      main([rep], {}, () => {}),
      1,
    );
    assert.equal(
      main([path.join(dir, "none.json")], {}, () => {}),
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stryker.config.mjs: every mutate pattern matches a real file, tests stay out of scope", () => {
  assert.equal(config.testRunner, "vitest");
  assert.ok(config.plugins.includes("@stryker-mutator/vitest-runner"));
  for (const pattern of config.mutate) {
    const files = globSync(pattern, { cwd: root }).map((f) => f.replaceAll("\\", "/"));
    assert.ok(files.length > 0, `no file matches ${pattern}`);
    assert.ok(
      files.every((f) => f.startsWith("src/") && !/\.test\./.test(f)),
      pattern,
    );
  }
  assert.equal(config.jsonReporter.fileName, "reports/mutation/mutation.json");
});
