// @vitest-environment node
// D-903 (O-81, Owner 2026-11-09): Turso bills every row a statement scans, and LIMIT/OFFSET makes the
// database scan all skipped rows again on every page, so paging a big table that way costs about
// N²/(2·page) reads (the nightly backup and the replay snapshot used up the free plan's 500 million
// monthly reads in eight days). Bulk reads page by key ("after the last key"); OFFSET stays only in
// the few user-driven UI lists below, where one page of a short list is read per click.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = new Set([
  "src/lib/ui/loaders/news.ts", // news list, one page per click
  "src/lib/ui/loaders/reviews.ts", // review list, one page per click
  "src/lib/maintenance/retention.ts", // one LIMIT 1 OFFSET lookup per run, not a page loop
]);

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("no LIMIT/OFFSET paging outside the allowed UI lists (D-903)", () => {
  it("finds OFFSET in SQL only in the allowed files", () => {
    const hits: string[] = [];
    for (const dir of ["src", "scripts", "worker/src"]) {
      for (const f of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f).split(path.sep).join("/");
        if (/\bOFFSET\s+\?/.test(readFileSync(f, "utf8")) && !ALLOWED.has(rel)) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });
});
