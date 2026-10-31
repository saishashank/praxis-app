// @vitest-environment node
// AT-57 (a)(b)(e): the Blueprint guard, 404 parity and the proxy branch.
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
  BLUEPRINT_PATH,
  isPinnedOwner,
  requirePinnedOwner,
  requirePinnedOwnerRoute,
  type BlueprintDeps,
} from "@/lib/auth/blueprintGuard";
import { resolveUser, type CurrentUser } from "@/lib/auth/session";
import { gate, isBlueprintPath, type GateDeps } from "@/lib/http/gate";
import { addUser, auditRows, authDb, ENV } from "../auth/helpers";
import { freshDb } from "../db/helpers";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ authDb: () => undefined }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));

const META = { ip: "9.9.9.9", userAgent: "UA" };

async function world() {
  const db = await authDb();
  const owner = await addUser(db, { email: ENV.OWNER_EMAIL!, role: "owner" });
  const editor = await addUser(db, { email: "e@example.test", role: "editor" });
  const viewer = await addUser(db, { email: "v@example.test", role: "viewer" });
  const events: string[] = [];
  const mk = (uid: number | null): BlueprintDeps => ({
    env: ENV,
    meta: async () => META,
    getUser: async () =>
      uid === null ? null : resolveUser(db, { uid, sv: 1, si: 1, rec: false }, ENV),
    recordEvent: async (user, action, route) => {
      events.push(`${action}:${route}:${user.id}`);
    },
  });
  return { db, ids: { owner, editor, viewer }, mk, events };
}

const digest = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e);
  }
};

describe("pin check", () => {
  it("needs role owner AND the pinned email", () => {
    const u = (role: CurrentUser["role"], email: string): CurrentUser => ({
      id: 1,
      email,
      name: null,
      role,
    });
    expect(isPinnedOwner(u("owner", "OWNER@example.test "), ENV)).toBe(true);
    expect(isPinnedOwner(u("owner", "other@example.test"), ENV)).toBe(false);
    expect(isPinnedOwner(u("editor", ENV.OWNER_EMAIL!), ENV)).toBe(false);
    expect(isPinnedOwner(null, ENV)).toBe(false);
    expect(isPinnedOwner(u("owner", "x@example.test"), {})).toBe(false); // no pin configured
  });
});

describe("AT-57 (a) owner passes, view is audited", () => {
  it("returns the user and records blueprint.view for page and route", async () => {
    const w = await world();
    const u = await requirePinnedOwner("/blueprint", w.mk(w.ids.owner));
    expect(u.email).toBe(ENV.OWNER_EMAIL);
    await requirePinnedOwnerRoute("/api/blueprint/export", "blueprint.export", w.mk(w.ids.owner));
    expect(w.events).toEqual([
      `blueprint.view:/blueprint:${w.ids.owner}`,
      `blueprint.export:/api/blueprint/export:${w.ids.owner}`,
    ]);
  });

  it("the default recorder writes an audit row with the route only", async () => {
    const w = await world();
    vi.resetModules();
    vi.doMock("@/lib/db/client", () => ({ authDb: () => w.db }));
    vi.stubEnv("PII_HASH_KEY", ENV.PII_HASH_KEY!);
    const mod = await import("@/lib/auth/blueprintGuard");
    await mod.defaultDeps.recordEvent(
      { id: w.ids.owner, email: ENV.OWNER_EMAIL!, name: null, role: "owner" },
      "blueprint.view",
      "/blueprint",
      META,
    );
    vi.unstubAllEnvs();
    vi.doUnmock("@/lib/db/client");
    const rows = await auditRows(w.db);
    const row = rows.find((r) => String(r.action) === "blueprint.view")!;
    expect(row).toBeTruthy();
    expect(row.target_id).toBe("/blueprint");
    expect(JSON.parse(String(row.detail_json))).toEqual({ route: "/blueprint" });
  });
});

describe("AT-57 (b)(e) everyone else gets the same 404", () => {
  it("editor, viewer, second owner-role identity, anonymous, outage: identical not-found signal, no audit", async () => {
    const w = await world();
    const cases: [string, BlueprintDeps][] = [
      ["editor", w.mk(w.ids.editor)],
      ["viewer", w.mk(w.ids.viewer)],
      [
        // The DB allows one owner row, so an owner-role identity with another email can only
        // arrive from a broken session layer: the guard must still refuse it (D-367).
        "second owner-role identity",
        {
          ...w.mk(null),
          getUser: async () => ({
            id: 99,
            email: "second@example.test",
            name: null,
            role: "owner",
          }),
        },
      ],
      ["anonymous", w.mk(null)],
      [
        "auth outage",
        {
          ...w.mk(null),
          getUser: async () => {
            throw new Error("down");
          },
        },
      ],
      [
        "audit failure",
        {
          ...w.mk(w.ids.owner),
          recordEvent: async () => {
            throw new Error("audit down");
          },
        },
      ],
    ];
    for (const [name, d] of cases) {
      const page = await digest(requirePinnedOwner(BLUEPRINT_PATH, d));
      const route = await digest(
        requirePinnedOwnerRoute("/api/blueprint/model", "blueprint.view", d),
      );
      expect(page, name).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(route, name).toBe(page);
    }
    expect(w.events).toEqual([]);
  });

  it("the guard source has no 403, forbidden or redirect path", () => {
    const src = fs.readFileSync("src/lib/auth/blueprintGuard.ts", "utf8");
    expect(src).not.toMatch(/forbidden\(|redirect\(|status:\s*40[13]/);
  });
});

describe("proxy branch (Q2, D-361)", () => {
  const BASE = "https://app.example.test";
  async function deps(claims: GateDeps["readClaims"]): Promise<GateDeps> {
    const db = await freshDb("auth");
    return {
      env: { APP_BASE_URL: BASE },
      dev: false,
      db: () => db,
      readClaims: claims,
      limits: { signin_per_min_ip: 10, writes_per_min_user: 60, exports_per_hour_user: 5 },
      nowSec: () => 1_700_000_000,
      nonce: () => "N",
    };
  }
  const req = (p: string) => new NextRequest(new URL(p, BASE));
  const anon = async () => null;
  const authed = async () => ({ uid: 5, sv: 1, si: 1, rec: false });

  it("does not redirect an anonymous /blueprint* or /api/blueprint* request", async () => {
    const paths = [
      "/blueprint",
      "/blueprint/",
      "/blueprint/x?y=1",
      "/api/blueprint/model",
      "/api/blueprint/export",
    ];
    for (const p of paths) {
      const res = await gate(req(p), await deps(anon));
      expect(res.status, p).not.toBe(307);
      expect(res.headers.get("location"), p).toBeNull();
      expect(res.headers.get("x-middleware-rewrite"), p).toMatch(/\/_praxis-absent$/);
    }
    // other protected paths still redirect to sign-in
    const other = await gate(req("/picks"), await deps(anon));
    expect(other.headers.get("location")).toContain("/signin");
  });

  it("the rewrite target is a path no route serves, so the app 404 renders", () => {
    const dirs = (d: string): string[] =>
      fs
        .readdirSync(d, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? [e.name, ...dirs(path.join(d, e.name))] : []));
    expect(dirs("src/app")).not.toContain("_praxis-absent");
    expect(fs.existsSync("src/app/not-found.tsx")).toBe(true);
  });

  it("headers match a real missing route (authed request to an unknown path), apart from the rewrite marker", async () => {
    const missing = await gate(req("/no-such-page"), await deps(authed));
    const hidden = await gate(req("/blueprint"), await deps(anon));
    const pick = (r: Response) =>
      [...r.headers.entries()].filter(([k]) => !k.startsWith("x-middleware-")).sort();
    expect(pick(hidden)).toEqual(pick(missing));
    expect(hidden.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("isBlueprintPath is exact on the segment", () => {
    expect(isBlueprintPath("/blueprint")).toBe(true);
    expect(isBlueprintPath("/blueprintx")).toBe(false);
    expect(isBlueprintPath("/api/blueprint/model")).toBe(true);
    expect(isBlueprintPath("/picks")).toBe(false);
  });
});

describe("invisibility", () => {
  it("the page declares noindex and only calls the guard", () => {
    const src = fs.readFileSync("src/app/(app)/blueprint/page.tsx", "utf8");
    expect(src).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
    expect(src).toContain("requirePinnedOwner");
  });
  it("nav and robots do not mention blueprint; robots allows nothing new", () => {
    for (const f of ["src/app/robots.ts", "src/lib/ui/nav.ts"]) {
      expect(fs.readFileSync(f, "utf8").toLowerCase(), f).not.toContain("blueprint");
    }
    expect(fs.readFileSync("src/app/robots.ts", "utf8")).toContain('disallow: "/"');
  });
});
