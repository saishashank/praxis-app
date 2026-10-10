// @vitest-environment node
// Guard for D-058: SQLite's REPLACE deletes the old row without firing DELETE triggers, so an
// `INSERT OR REPLACE` / `REPLACE INTO` could silently overwrite rows in append-only and
// first-seen tables (DAT-002, NFR-023). Writers must use `INSERT … ON CONFLICT DO NOTHING`.
// This test fails if any non-test source file contains a REPLACE write.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SCAN_DIRS = ["src", "scripts", "worker/src", "db/migrations"];
const EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".sql", ".py"]);
const SKIP = new Set(["node_modules", ".next", "dist", "tests"]);
const REPLACE_WRITE = /\b(?:INSERT\s+OR\s+REPLACE|REPLACE\s+INTO)\b/i;

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(name))) out.push(full);
  }
  return out;
}

function offenders(): string[] {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
  const found: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/--.*$|\/\/.*$|#.*$/, ""); // ignore comments
        if (REPLACE_WRITE.test(code)) found.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
  }
  return found;
}

describe("no REPLACE writes (D-058)", () => {
  it("the pattern catches both spellings and ignores comments", () => {
    expect(REPLACE_WRITE.test("insert or replace into price_bar")).toBe(true);
    expect(REPLACE_WRITE.test("REPLACE INTO x VALUES (1)")).toBe(true);
    expect(REPLACE_WRITE.test("INSERT INTO x VALUES (1) ON CONFLICT DO NOTHING")).toBe(false);
  });

  it("no source file uses INSERT OR REPLACE / REPLACE INTO", () => {
    expect(offenders()).toEqual([]);
  });
});
