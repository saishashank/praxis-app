// @vitest-environment node
// OPS-111 (12), D-977: docs/runbooks/replay-hash-policy.md names exactly the wall-clock columns the AT-32
// replay hash drops. A column added to the test without the page (or the page without the test) fails here.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const doc = readFileSync(path.join(ROOT, "docs/runbooks/replay-hash-policy.md"), "utf8");
const test = readFileSync(path.join(ROOT, "tests/acceptance/v2/at32Steelman.test.ts"), "utf8");

/** { table: [columns] } from the WALLCLOCK constant of the AT-32 test. */
function wallclock(src: string): Array<[string, string]> {
  const block = /const WALLCLOCK[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[2]!.matchAll(/"(\w+)"/g)].map((c): [string, string] => [m[1]!, c[1]!]),
  );
}

describe("replay hash policy page", () => {
  it("the test drops three columns", () => {
    expect(wallclock(test)).toEqual([
      ["schema_migrations", "applied_at"],
      ["source_register_history", "changed_at"],
      ["cortex_night", "runtime_ms"],
    ]);
  });

  it("the page names each dropped column in its table row and nothing else as dropped", () => {
    for (const [t, c] of wallclock(test)) {
      expect(doc).toContain(`| \`${t}\` | \`${c}\` |`);
    }
    const rows = doc.split("\n").filter((l) => /^\| `\w+` \| `\w+` \|/.test(l));
    expect(rows).toHaveLength(wallclock(test).length);
  });

  it("states the complement rule and that the stage on and off hashes are equal", () => {
    expect(doc).toMatch(/every main table except the steelman's own/);
    expect(doc).toMatch(/must be equal/);
  });
});
