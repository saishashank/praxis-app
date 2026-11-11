// @vitest-environment node
// M18 TST-136 (D-968; AT-85 "no retry wrapper, 20/20 deterministic"): no test is made green by running it
// again, and a timing check does not hide in the default suite. Supersedes D-820 (the CI-only retries of
// the three timing checks): those checks now count work, and their wall-clock variants live in tests/timing.
//   - `retry:` as an option key (vitest `{ retry: 1 }`, `describe(..., { retry })`) is forbidden in every
//     test file under tests/, worker/test/, worker/timing/ and scripts/;
//   - a test name that starts with the timing tag is allowed only in the wall-clock variants
//     (tests/timing/, worker/timing/), which the default suite excludes.
// Both scans have a planted-text self-test, so an edit that stops the scan from seeing anything fails here.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".next" && e.name !== "fixtures") walk(full, out);
    } else if (/\.(test|spec)\.(ts|tsx|mjs|mts)$/.test(e.name)) out.push(full);
  }
  return out;
};

const ROOTS = ["tests", "worker/test", "worker/timing", "scripts"];
const FILES = ROOTS.flatMap((r) => walk(path.join(ROOT, r)));
const rel = (f: string) => posix(path.relative(ROOT, f));

// `retry` as an object key: not part of a longer word or of a string like "pre-open-retry:2".
const RETRY_KEY = /(^|[\s{,(])retry\s*:/m;
const TAG = "[" + "timing" + "]"; // built so this file never contains the tag as one literal
const TIMING_NAME = new RegExp(`["'\`]\\s*${TAG.replace(/[[\]]/g, "\\$&")}`);
const WALL_DIRS = ["tests/timing/", "worker/timing/"];

/** Text with // line comments and /* block *\/ comments blanked, so a comment can say the word. */
const code = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

describe("no retry wrapper (TST-136)", () => {
  it("scans the test folders (not vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES.map(rel)).toContain("worker/test/m5Slots.test.ts");
    expect(FILES.map(rel)).toContain("tests/cortex/look.test.ts");
  });

  it("no test file uses a `retry:` option", () => {
    const bad = FILES.filter((f) => RETRY_KEY.test(code(fs.readFileSync(f, "utf8")))).map(rel);
    // this file names the key in its own self-test text below
    expect(bad.filter((f) => f !== "tests/static/noRetry.test.ts")).toEqual([]);
  });

  it("the scan catches a planted retry option and ignores look-alikes (self-test)", () => {
    const sample = `describe("x", { retry: process.env.CI ? 1 : 0 }, () => {});`;
    expect(RETRY_KEY.test(code(sample))).toBe(true);
    expect(RETRY_KEY.test(code(`it("y", { timeout: 5, retry: 2 }, f)`))).toBe(true);
    expect(RETRY_KEY.test(code('const k = "pre-open-retry:2@09:58";'))).toBe(false);
    expect(RETRY_KEY.test(code("// retry: only in a comment"))).toBe(false);
    expect(RETRY_KEY.test(code("const retryAfterS = 4;"))).toBe(false);
  });
});

describe("the timing tag stays in the wall-clock variants (TST-136)", () => {
  it("no test name outside tests/timing and worker/timing starts with the tag", () => {
    const bad = FILES.filter((f) => !WALL_DIRS.some((d) => rel(f).startsWith(d)))
      .filter((f) => TIMING_NAME.test(code(fs.readFileSync(f, "utf8"))))
      .map(rel);
    expect(bad.filter((f) => f !== "tests/static/noRetry.test.ts")).toEqual([]);
  });

  it("the wall-clock variants exist and are the only place the tag is used", () => {
    const wall = FILES.filter((f) => WALL_DIRS.some((d) => rel(f).startsWith(d))).map(rel);
    expect(wall.sort()).toEqual([
      "tests/timing/cohortReplay.wall.test.ts",
      "worker/timing/m5Slots.wall.test.ts",
    ]);
  });

  it("the default suite excludes tests/timing (vitest.config.mts) and the timing config includes only it", () => {
    const main = fs.readFileSync(path.join(ROOT, "vitest.config.mts"), "utf8");
    expect(main).toMatch(/exclude:[^\n]*tests\/timing\/\*\*/);
    const timing = fs.readFileSync(path.join(ROOT, "vitest.timing.config.mts"), "utf8");
    expect(timing).toMatch(/include:\s*\["tests\/timing\/\*\*\/\*\.wall\.test\.ts"\]/);
    const w = fs.readFileSync(path.join(ROOT, "worker/vitest.timing.config.mts"), "utf8");
    expect(w).toMatch(/include:\s*\["timing\/\*\*\/\*\.wall\.test\.ts"\]/);
    // and the worker's own default config never picks up worker/timing
    const wmain = fs.readFileSync(path.join(ROOT, "worker/vitest.config.mts"), "utf8");
    expect(wmain).toMatch(/include:\s*\["test\/\*\*\/\*\.test\.ts"\]/);
  });

  it("the tag scan catches a planted name (self-test)", () => {
    expect(TIMING_NAME.test(code(`it("${TAG} the busy minute", () => {})`))).toBe(true);
    expect(TIMING_NAME.test(code(`it("a minute with timing in the text", () => {})`))).toBe(false);
    expect(TIMING_NAME.test(code(`// "${TAG}" in a comment`))).toBe(false);
  });
});
