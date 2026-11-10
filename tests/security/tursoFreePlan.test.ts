// @vitest-environment node
// PLT-080 (D-963; AT-83 clause (k), PRD-045): the system never relies on a paid Turso feature. A static
// scan of src, scripts and worker/src for the identifiers of paid-plan features: point-in-time restore,
// replicas / extra locations / groups, database branching, extensions and the vector API. The allow-list
// is empty and stays empty; a hit means a paid feature entered the code.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = new Set<string>([]);

/** What a paid-feature use looks like in code (identifiers and API paths, never plain English). */
export const PAID_FEATURES: ReadonlyArray<readonly [string, RegExp]> = [
  [
    "point-in-time restore",
    /point_in_time|pointInTime|\bPITR\b|restore_enabled\s*[:=]\s*true|\/timeline\b/,
  ],
  [
    "replicas and extra locations",
    /\bcreateReplica\b|\/locations\/[A-Za-z0-9_${}-]+\/replicas|\bsyncUrl\b|\bembeddedReplica/,
  ],
  [
    "branching",
    /\/databases\/[^"'`\s]*\/branch|\bseed\s*:\s*\{\s*type\s*:\s*["']database["']|\bturso\s+db\s+(create|branch)\b[^\n]*--from-db/,
  ],
  [
    "extensions",
    /\bloadExtension\b|\/extensions\b[^\n]*(enable|load)|\bturso\s+db\s+create\b[^\n]*--enable-extensions/,
  ],
  [
    "vector search",
    /\bvector_distance_(cos|l2)\b|\bvector_top_k\b|\bF32_BLOB\b|\blibsql_vector_idx\b|\bvector32\(|\bvector64\(/,
  ],
  [
    "organisation upgrade",
    /\/organizations\/[^"'`\s]*\/(plans|subscription|upgrade)\b|\bturso\s+plan\s+(upgrade|select)\b/,
  ],
];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Findings in one file's text: feature names only, never a line. */
export function scanText(text: string): string[] {
  return PAID_FEATURES.filter(([, re]) => re.test(text)).map(([name]) => name);
}

describe("no paid Turso feature (PLT-080, PRD-045)", () => {
  it("the allow-list is empty", () => {
    expect([...ALLOWED]).toEqual([]);
  });

  it("src, scripts and worker/src use none of them", () => {
    const hits: string[] = [];
    for (const dir of ["src", "scripts", "worker/src"]) {
      for (const f of files(path.join(ROOT, dir))) {
        const rel = path.relative(ROOT, f).split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        for (const feature of scanText(readFileSync(f, "utf8"))) hits.push(`${rel}: ${feature}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the scan catches a planted use of each feature, and not ordinary words", () => {
    expect(scanText("await db.loadExtension('vector')")).toEqual(["extensions"]);
    expect(scanText("SELECT vector_distance_cos(a, b) FROM t")).toEqual(["vector search"]);
    expect(scanText("CREATE TABLE t (e F32_BLOB(3))")).toEqual(["vector search"]);
    expect(scanText("fetch(`/v1/organizations/${o}/databases/${d}/branch`)")).toEqual([
      "branching",
    ]);
    expect(scanText("createClient({ url, syncUrl })")).toEqual(["replicas and extra locations"]);
    expect(scanText("await db.pointInTimeRestore(ts)")).toEqual(["point-in-time restore"]);
    expect(scanText("POST /v1/organizations/x/plans")).toEqual(["organisation upgrade"]);
    expect(
      scanText("a vector of branches, a replica of the table, extension of the deadline"),
    ).toEqual([]);
  });
});
