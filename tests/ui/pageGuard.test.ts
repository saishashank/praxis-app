// M7 T3 "Pages guard": every src/app page.tsx is in the page registry (e2e/pages) with its allowed
// roles, and the page's server guard enforces what the registry says. Static source check.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES, allowedRoles } from "../../e2e/pages";
import { ROLES, can } from "@/lib/auth/permissions";
import { HIDDEN_ROUTES, hiddenEntryFor } from "@/lib/http/hiddenRoutes";
import { checkHiddenFile } from "./hiddenGuardCheck";

const root = path.resolve(import.meta.dirname, "..", "..");

function findPages(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findPages(full, out);
    else if (e.name === "page.tsx") out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

// M16 D-361/D-371, M21 A2 (D-1210): pages under a HIDDEN_ROUTES prefix (the Blueprint and the three Owner-tool pages)
// answer as a missing route to everyone but the pinned Owner, so they are not registry pages; each one must call
// its entry's guard first (checked below). Which pages those are is derived from HIDDEN_ROUTES, not listed here.
// D-884: the @modal slot holds the Decision Card popup (an overlay of /cards/[id], not an address of
// its own); the popup's guard is checked below like the page's.
const urlPath = (file: string): string => {
  const rel = file.replace(/^src\/app\//, "").replace(/page\.tsx$/, "");
  return (
    "/" +
    rel
      .split("/")
      .filter((x) => x && !(x.startsWith("(") && x.endsWith(")")))
      .join("/")
  );
};
const allPages = findPages(path.join(root, "src", "app")).filter((f) => !f.includes("/@modal/"));
const hiddenPages = allPages.filter((f) => hiddenEntryFor(urlPath(f)) !== null);
const onDisk = allPages.filter((f) => !hiddenPages.includes(f)).sort();
const src = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("Decision Card popup guard (D-884)", () => {
  it('the popup calls requireUser("read") before any other await, like the page', () => {
    const text = src("src/app/(app)/@modal/(.)cards/[id]/page.tsx");
    const body = text.slice(text.search(/export\s+default\s+async\s+function/));
    const awaits = [...body.matchAll(/await\s+([A-Za-z_$][\w$]*)/g)].filter(
      (m) => m[1] !== "params",
    );
    expect(awaits[0]?.[1]).toBe("requireUser");
    expect(body.match(/requireUser\(\s*"([^"]+)"/)?.[1]).toBe("read");
    // the empty slot calls nothing
    expect(src("src/app/(app)/@modal/default.tsx")).not.toMatch(/await|requireUser|Db\(/);
  });
});

describe("hidden pages (HIDDEN_ROUTES)", () => {
  it("the Blueprint page is one of them", () => {
    expect(hiddenPages).toContain("src/app/(app)/blueprint/page.tsx");
  });

  it("no registry page sits under a hidden prefix, and no hidden page is in the registry", () => {
    for (const p of PAGES) expect(hiddenEntryFor(p.path), p.file).toBeNull();
  });

  for (const file of hiddenPages) {
    const entry = hiddenEntryFor(urlPath(file))!;
    it(`${file} calls ${entry.guard} before any other await`, () => {
      expect(checkHiddenFile(file, src(file))).toEqual([]);
    });
  }

  // D-1247: route handlers and server actions are separate doors (Next dispatches an action by its id from any page URL).
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(path.join(root, dir))) return out;
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const candidates = [...walk("src/app"), ...walk("src/lib/ownerTools")];

  it("every route handler under a hidden prefix, and every server action of the Owner-tools section, is guarded", () => {
    const problems = candidates.flatMap((f) => checkHiddenFile(f, src(f)));
    expect(problems).toEqual([]);
  });

  it("the Blueprint route handlers are covered by the same check", () => {
    const routes = candidates.filter((f) => /api\/blueprint\/.*route\.ts$/.test(f));
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  describe("planted files fail the check", () => {
    const OK_PAGE = `export default async function P() {
  await requireOwnerTools("/holdings");
}
`;
    it("a good page, route and action pass", () => {
      const pg = "src/app/(app)/(owner-tools)/holdings/page.tsx";
      expect(checkHiddenFile(pg, OK_PAGE)).toEqual([]);
      expect(
        checkHiddenFile(
          "src/app/api/owner-tools/x/route.ts",
          `export async function GET() {
  await requireOwnerToolsRoute("/api/owner-tools/x");
}
`,
        ),
      ).toEqual([]);
      expect(
        checkHiddenFile(
          "src/lib/ownerTools/actions.ts",
          `"use server";
export async function save() {
  await requireOwnerTools("/x");
}
`,
        ),
      ).toEqual([]);
    });
    it("a route handler method without the guard first fails", () => {
      const bad = `export async function GET() {
  await requireOwnerToolsRoute("/x");
}
export async function POST() {
  const x = await load();
  await requireOwnerToolsRoute("/x");
}
`;
      const r = checkHiddenFile("src/app/api/owner-tools/x/route.ts", bad);
      expect(r).toHaveLength(1);
      expect(r[0]).toContain("POST");
    });
    it("a Blueprint route handler with the page guard instead of the route guard fails", () => {
      const r = checkHiddenFile(
        "src/app/api/blueprint/y/route.ts",
        `export async function GET() {
  await requirePinnedOwner();
}
`,
      );
      expect(r).toHaveLength(1);
    });
    it("a server action in the section without requireOwnerTools first fails", () => {
      const bad = `"use server";
export async function save() {
  await db();
  await requireOwnerTools("/x");
}
`;
      expect(checkHiddenFile("src/app/(app)/(owner-tools)/holdings/actions.ts", bad)).toHaveLength(
        1,
      );
      expect(checkHiddenFile("src/lib/ownerTools/a.ts", bad)).toHaveLength(1);
    });
    it("a page under (owner-tools) whose URL is not under a hidden prefix fails", () => {
      const r = checkHiddenFile("src/app/(app)/(owner-tools)/portfolio/page.tsx", OK_PAGE);
      expect(r.join()).toContain("not under a HIDDEN_ROUTES prefix");
    });
    it("generateMetadata in a hidden page fails unless it calls the guard first", () => {
      const bad =
        OK_PAGE +
        `export async function generateMetadata() {
  await load();
}
`;
      const good =
        OK_PAGE +
        `export async function generateMetadata() {
  await requireOwnerTools("/h");
}
`;
      const pg = "src/app/(app)/(owner-tools)/holdings/page.tsx";
      expect(checkHiddenFile(pg, bad).join()).toContain("generateMetadata");
      expect(checkHiddenFile(pg, good)).toEqual([]);
    });
    it("a hidden page with no guard fails", () => {
      const r = checkHiddenFile(
        "src/app/(app)/blueprint/page.tsx",
        `export default async function P() {
  const x = await load();
}
`,
      );
      expect(r).toHaveLength(1);
    });
  });

  it("every entry names a guard that exists", () => {
    const guards = {
      requirePinnedOwner: "src/lib/auth/blueprintGuard.ts",
      requireOwnerTools: "src/lib/auth/ownerToolsGuard.ts",
    };
    for (const e of HIDDEN_ROUTES) expect(src(guards[e.guard])).toContain(`function ${e.guard}`);
  });
});

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
