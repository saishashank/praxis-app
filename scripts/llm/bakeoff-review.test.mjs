// TST-137 (D-969): the bake-off review script lists reports with their PASS/FAIL lines and prints the exact
// llm_live_roles edit. Fixture markdown only; no network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseReport, planEdit, run } from "./bakeoff-review.mjs";

const REPORT = `# LLM bake-off report

- Run: bk-2026-11-20
- Date: 2026-11-20
- Golden set: 0123456789abcdef (40 items)

## Summary

| Model | Items | JSON valid % | Invented numbers | Errors | Tokens | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| groq/zz-model-a | 40 | 100.00 | 0 | 0 | 1200 | PASS |
| gemini/zz-model-b | 40 | 90.00 | 2 | 1 | 1500 | FAIL |

## groq/zz-model-a

- trains_on_prompts: no; checked 2026-11-01
`;

function withDir(files, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-bakeoff-review-"));
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseReport reads the run, the date and each model's result; other markdown is not a report", () => {
  assert.deepEqual(parseReport(REPORT), {
    run: "bk-2026-11-20",
    date: "2026-11-20",
    models: [
      { model: "groq/zz-model-a", result: "PASS" },
      { model: "gemini/zz-model-b", result: "FAIL" },
    ],
  });
  assert.equal(parseReport("# AT-01 report\n| a | PASS |"), null);
  assert.equal(parseReport(""), null);
});

test("planEdit names only passed models, with the role when given", () => {
  const reports = [{ file: "r.md", report: parseReport(REPORT) }];
  assert.deepEqual(planEdit(reports, "R6"), [
    "llm_live_roles: add R6 for groq/zz-model-a (passed in r.md, run bk-2026-11-20)",
  ]);
  assert.match(planEdit(reports, null)[0], /add <role> for groq\/zz-model-a .* pass --role/);
});

test("lists the reports, ignores other files, prints the edit and the M22 note", () => {
  withDir({ "AT-01.md": "# AT-01\n", "bakeoff-1.md": REPORT, "notes.txt": "x" }, (dir) => {
    const lines = [];
    assert.equal(
      run(["--dir", dir, "--role", "R6"], (s) => lines.push(s)),
      0,
    );
    assert.deepEqual(lines.slice(0, 3), [
      "bakeoff-1.md (run bk-2026-11-20, 2026-11-20)",
      "  groq/zz-model-a: PASS",
      "  gemini/zz-model-b: FAIL",
    ]);
    assert.ok(
      lines.includes(
        "llm_live_roles: add R6 for groq/zz-model-a (passed in bakeoff-1.md, run bk-2026-11-20)",
      ),
    );
    assert.match(lines.at(-1), /arrives with milestone M22/);
  });
});

test("no report, no pass, a missing folder and a bad role each say so", () => {
  withDir({ "AT-01.md": "# AT-01\n" }, (dir) => {
    const lines = [];
    assert.equal(
      run(["--dir", dir], (s) => lines.push(s)),
      0,
    );
    assert.match(lines[0], /no bake-off report yet/);
  });
  withDir({ "b.md": REPORT.replace("| PASS |", "| FAIL |") }, (dir) => {
    const lines = [];
    run(["--dir", dir], (s) => lines.push(s));
    assert.ok(lines.includes("No model has passed: nothing to add to llm_live_roles."));
  });
  assert.equal(
    run(["--dir", path.join(tmpdir(), "praxis-no-such-folder-zz")], () => {}),
    1,
  );
  assert.equal(
    run(["--role", "R9"], () => {}),
    2,
  );
});
