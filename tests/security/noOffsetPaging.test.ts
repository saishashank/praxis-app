// @vitest-environment node
// D-903 (O-81, Owner 2026-11-09): Turso bills every row a statement scans, and LIMIT/OFFSET makes the
// database scan all skipped rows again on every page, so paging a big table that way costs about
// N²/(2·page) reads (the nightly backup and the replay snapshot used up the free plan's 500 million
// monthly reads in eight days). Bulk reads page by key ("after the last key").
// M18 (OPS-104 d, D-959): the three UI lists that were still allowed (news, reviews, the retention
// keep-N lookup) now page by keyset cursor or MIN over a bounded subquery, so OFFSET has ZERO
// exceptions: the allow-list is empty and stays empty.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = new Set<string>([]);

/** `OFFSET ?`, `OFFSET 5` and `OFFSET :n` as SQL; the identifier OFFSET_RE does not match. */
export const OFFSET_SQL = /\bOFFSET\s+(\?|\d+|:\w+)/;

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

describe("no LIMIT/OFFSET paging anywhere (D-903, D-959)", () => {
  it("the allow-list is empty", () => {
    expect([...ALLOWED]).toEqual([]);
  });

  it("finds no OFFSET in SQL in src, scripts or worker/src", () => {
    const hits: string[] = [];
    for (const dir of ["src", "scripts", "worker/src"]) {
      for (const f of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f).split(path.sep).join("/");
        if (OFFSET_SQL.test(readFileSync(f, "utf8")) && !ALLOWED.has(rel)) hits.push(rel);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the pattern catches a planted LIMIT 10 OFFSET 5 and the placeholder forms, not an identifier", () => {
    expect(OFFSET_SQL.test("SELECT a FROM t LIMIT 10 OFFSET 5")).toBe(true);
    expect(OFFSET_SQL.test("SELECT a FROM t LIMIT ? OFFSET ?")).toBe(true);
    expect(OFFSET_SQL.test("SELECT a FROM t LIMIT 10 OFFSET :skip")).toBe(true);
    expect(OFFSET_SQL.test("select a from t limit 1\n  OFFSET   ?")).toBe(true);
    expect(OFFSET_SQL.test("const OFFSET_RE = /([+-]\\d\\d:\\d\\d)$/;")).toBe(false);
    expect(OFFSET_SQL.test("// the timezone OFFSET of the quote")).toBe(false);
  });

  it("a planted file with OFFSET is reported by the same scan", () => {
    const planted = "const sql = `SELECT x FROM t ORDER BY x LIMIT 10 OFFSET 5`;";
    expect(OFFSET_SQL.test(planted)).toBe(true);
  });
});
