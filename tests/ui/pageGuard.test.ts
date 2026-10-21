// M7 T3 "Pages guard": every src/app page.tsx is in the page registry (e2e/pages) with its allowed
// roles, and the page's server guard enforces what the registry says. Static source check.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES, allowedRoles } from "../../e2e/pages";
import { ROLES, can } from "@/lib/auth/permissions";

const root = path.resolve(import.meta.dirname, "..", "..");

function findPages(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findPages(full, out);
    else if (e.name === "page.tsx") out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

const onDisk = findPages(path.join(root, "src", "app")).sort();
const src = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("page registry", () => {
  it("lists every page.tsx, and nothing else", () => {
    expect(PAGES.map((p) => p.file).sort()).toEqual(onDisk);
  });

  it("has unique files and paths", () => {
    expect(new Set(PAGES.map((p) => p.file)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
  });

  it("derives the path from the file location", () => {
    for (const p of PAGES) {
      const rel = p.file.replace(/^src\/app\//, "").replace(/page\.tsx$/, "");
      const segs = rel.split("/").filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
      expect(p.path, p.file).toBe("/" + segs.join("/"));
    }
  });

  it("lists roles that match the role matrix", () => {
    for (const p of PAGES) {
      if (p.action === "public") continue;
      const expected = ROLES.filter((r) => can(r, p.action));
      expect([...allowedRoles(p)], p.file).toEqual(expected);
    }
  });
});

describe("page server guard", () => {
  for (const p of PAGES) {
    if (p.action === "public") {
      it(`${p.path} is public and calls no guard`, () => {
        expect(src(p.file)).not.toMatch(/requireUser\(/);
      });
      continue;
    }
    it(`${p.path} calls requireUser("${p.action}") before any other await`, () => {
      const text = src(p.file);
      const start = text.search(/export\s+default\s+(async\s+)?function/);
      expect(start, "default export").toBeGreaterThanOrEqual(0);
      const body = text.slice(start);
      // The first await other than reading params / searchParams must be the guard.
      const awaits = [...body.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].filter(
        (m) => m[1] !== "params" && m[1] !== "searchParams",
      );
      expect(awaits[0]?.[1]).toBe("requireUser");
      const call = body.match(/requireUser\(\s*"([^"]+)"/);
      expect(call?.[1]).toBe(p.action);
    });
  }
});
