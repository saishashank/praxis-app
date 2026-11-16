// M21 A2 (D-1214, UX-131): no module of the Owner-tools section is imported on any page while the switch is off.
// Static check: nothing outside the section itself (src/app/(app)/(owner-tools)/**, src/lib/ownerTools/**,
// src/components/ownerTools/**) may hold a static `import` or `export ... from` of those modules; a dynamic
// `import()` behind the predicate is the only way in. `import type` is erased at build time and allowed.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");
const SECTION = /(?:^|\/)(?:lib|components)\/ownerTools(?:\/|["'])/;
const INSIDE = [
  "src/app/(app)/(owner-tools)/",
  "src/lib/ownerTools/",
  "src/components/ownerTools/",
];

/** Specifiers of static imports and re-exports that are not type-only. */
export function staticImports(text: string): string[] {
  // A statement has no ";" before its "from" (prettier-formatted source), so the match cannot run into later code.
  const re = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s*(["'])([^"']+)\1/g;
  return [...text.matchAll(re)].map((m) => m[2]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("the Owner-tools modules are loaded lazily only", () => {
  it("the detector sees static imports and re-exports, not dynamic imports or type imports", () => {
    const bad = `import { a } from "@/lib/ownerTools/x";\nimport b from "@/components/ownerTools/y";\nexport * from "@/lib/ownerTools/z";\nexport { q } from "../../lib/ownerTools/w";`;
    expect(staticImports(bad).filter((s) => SECTION.test(s))).toHaveLength(4);
    const ok = `import type { T } from "@/lib/ownerTools/x";\nconst m = await import("@/lib/ownerTools/x");\nimport { z } from "@/lib/other";`;
    expect(staticImports(ok).filter((s) => SECTION.test(s))).toEqual([]);
  });

  it("no file outside the section statically imports it", () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(root, "src"))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (INSIDE.some((p) => rel.startsWith(p))) continue;
      const hit = staticImports(fs.readFileSync(file, "utf8")).filter((s) => SECTION.test(s));
      if (hit.length) offenders.push(`${rel}: ${hit.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
