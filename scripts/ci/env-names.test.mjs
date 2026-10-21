import test from "node:test";
import assert from "node:assert/strict";
import { codeNames, workflowEnvNames, parseEnvExample, compare, NOT_CONFIG } from "./env-names.mjs";

test("codeNames finds dotted, optional and bracket reads", () => {
  const t = 'const a = env.FOO_BAR; process.env.BAZ_1; deps.env?.QUX; env["ZED_ONE"]; other.FOO_X';
  assert.deepEqual([...codeNames(t)].sort(), ["BAZ_1", "FOO_BAR", "QUX", "ZED_ONE"]);
});

test("workflowEnvNames reads keys under env: only", () => {
  const y = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - run: x",
    "        env:",
    "          ONE_KEY: ${{ secrets.X }}",
    "          TWO_KEY: v",
    "        name: not-env",
    "      - env:",
    "          # note",
    "          THREE_KEY: z",
    "  with:",
    "    NOT_ENV: 1",
  ].join("\n");
  assert.deepEqual([...workflowEnvNames(y)].sort(), ["ONE_KEY", "THREE_KEY", "TWO_KEY"]);
});

test("parseEnvExample flags values, malformed lines and duplicates", () => {
  const { names, problems } = parseEnvExample("# c\nA_ONE=\nB_TWO=x\nbad line\nA_ONE=\n");
  assert.deepEqual([...names].sort(), ["A_ONE", "B_TWO"]);
  assert.equal(problems.length, 3);
});

test("a missing name fails", () => {
  const r = compare({ read: new Set(["A_ONE", "C_THREE"]), exampleText: "A_ONE=\n" });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /C_THREE/);
});

test("any value fails and is not echoed", () => {
  const r = compare({ read: new Set(["A_ONE"]), exampleText: "A_ONE=something\n" });
  assert.equal(r.errors.length, 1);
  assert.ok(!r.errors[0].includes("something"));
});

test("an unread name only warns", () => {
  const r = compare({ read: new Set(["A_ONE"]), exampleText: "A_ONE=\nZ_EXTRA=\n" });
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("platform names are not required in .env.example", () => {
  assert.ok(NOT_CONFIG.has("NODE_ENV"));
  const r = compare({ read: new Set(["NODE_ENV", "CI"]), exampleText: "" });
  assert.equal(r.errors.length, 0);
});
