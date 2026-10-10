// TST-108, AT-04 (build phase): the restore drill passes with a throwaway key and synthetic data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDrill } from "./drill.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "drill.mjs");

test("runDrill returns 0 and prints PASS for both databases", async () => {
  const lines = [];
  const code = await runDrill((l) => lines.push(l));
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^drill: PASS main\(tables=\d+ rows=\d+\) auth\(tables=\d+ rows=\d+\)$/);
  assert.equal(/MARKER|example\.test|Zo/.test(lines[0]), false); // no row text in the output
});

test("the CLI exits 0 and prints PASS", () => {
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /drill: PASS/);
});
