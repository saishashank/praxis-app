// @vitest-environment node
// M23 A2 (D-1604, CXA-015): `src/lib/research/registry.ts` is the only code that writes `holdout_look`. A static scan of every
// source file outside the tests: no INSERT, UPDATE, DELETE or REPLACE names the table anywhere else, and the table name is not
// built up in pieces. The three first writers (short shadow, alternative regime, Committee trial) go through `takeLook`.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");
const SCAN = ["src", "scripts", "worker/src", "e2e"];
const OWNER = "src/lib/research/registry.ts";
// M23 M4 (D-1765): the e2e seed states fill a throwaway database with rows a spec renders; the one that seeds looks is listed.
const SEED_STATES = ["e2e/seed/states/cortex-research.mjs"];

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".next") walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
};

const stripComments = (t: string): string =>
  t
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const WRITE =
  /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+holdout_look(?![A-Za-z0-9_])/gi;

const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)));

describe("the holdout registry has one writer (D-1604)", () => {
  it("scans the source (not vacuous)", () => {
    const names = files.map((f) => posix(path.relative(ROOT, f)));
    expect(names).toContain(OWNER);
    expect(names).toContain("src/lib/committee/trial.ts");
    expect(names).toContain("src/lib/shortShadow/evaluate.ts");
    expect(names).toContain("src/lib/regime/alt/evaluate.ts");
  });

  it("only registry.ts writes holdout_look, and it does", () => {
    const writers: string[] = [];
    for (const f of files) {
      if (SEED_STATES.includes(posix(path.relative(ROOT, f)))) continue;
      if (WRITE.test(stripComments(fs.readFileSync(f, "utf8"))))
        writers.push(posix(path.relative(ROOT, f)));
      WRITE.lastIndex = 0;
    }
    expect(writers).toEqual([OWNER]);
  });

  it("the table name is never assembled from parts in a write (no dynamic table name beside the registry)", () => {
    const bad: string[] = [];
    for (const f of files) {
      const rel = posix(path.relative(ROOT, f));
      if (rel === OWNER || rel.startsWith("scripts/db/")) continue;
      const src = stripComments(fs.readFileSync(f, "utf8"));
      if (/["'`]holdout_?["'`]\s*\+|\$\{[^}]*\}_look/.test(src)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });

  it("the three first writers call the gate", () => {
    for (const f of [
      "src/lib/committee/trial.ts",
      "src/lib/shortShadow/evaluate.ts",
      "src/lib/regime/alt/evaluate.ts",
    ]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(src, f).toMatch(/takeLook\(/);
      expect(src, f).toMatch(/preregister\(/);
      expect(src, f).toMatch(/from "@\/lib\/research\/registry"/);
    }
  });

  it("the scan catches a writer (self-test)", () => {
    expect(WRITE.test("await db.execute('INSERT INTO holdout_look (lineage) VALUES (1)')")).toBe(
      true,
    );
    WRITE.lastIndex = 0;
    expect(WRITE.test("INSERT INTO holdout_look_refusal (lineage) VALUES (1)")).toBe(false);
    WRITE.lastIndex = 0;
  });
});
