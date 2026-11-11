// @vitest-environment node
// The seed projections are checked, not trusted (M19 A1; D-992, D-1001): the migration SQL and the IN/US/AU test
// fixtures are generated from src/lib/market/seed/*.mjs, and `--check` fails when a committed file differs.
// The step-0 snapshot recorder refuses to run unnoticed: it only runs inside vitest with its record flag.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../db/helpers";

const run = (script: string, ...args: string[]): string =>
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "market", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

describe("market seed generators", () => {
  it("scripts/market/gen-fixtures.mjs --check: the three fixtures equal their seeds", () => {
    expect(run("gen-fixtures.mjs", "--check")).toContain("match their seeds");
  });

  it("scripts/market/gen-seed-sql.mjs --check: migration 0034 equals its seed", () => {
    expect(run("gen-seed-sql.mjs", "--check")).toContain("matches the seed");
  });
});
