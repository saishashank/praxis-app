// @vitest-environment node
// M21 A2 (D-1210, D-1214, D-1215): the hidden-route predicate truth table, and the gate's use of it.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { Claims } from "@/lib/auth/claims";
import { HIDE_HEADER, gate, type GateDeps } from "@/lib/http/gate";
import {
  HIDDEN_ROUTES,
  hiddenEntryFor,
  hiddenFor,
  hiddenForEntry,
  type HiddenDeps,
} from "@/lib/http/hiddenRoutes";
import { freshDb } from "../db/helpers";

type Who = "anonymous" | "viewer" | "editor" | "owner_not_pinned" | "pinned_owner";
const WHO: Who[] = ["anonymous", "viewer", "editor", "owner_not_pinned", "pinned_owner"];
const deps = (on: boolean): HiddenDeps<Who> => ({
  isPinnedOwner: (s) => s === "pinned_owner",
  ownerToolsOn: () => on,
});
const subject = (w: Who): Who | null => (w === "anonymous" ? null : w);

const SAMPLES: Record<string, string[]> = {
  blueprint: ["/blueprint", "/blueprint/x", "/api/blueprint/model", "/api/blueprint"],
  owner_tools: [
    "/recommendations",
    "/holdings",
    "/trades",
    "/trades/new",
    "/api/owner-tools/x",
    "/api/owner-tools",
  ],
};

describe("hiddenFor: the truth table", () => {
  for (const entry of HIDDEN_ROUTES) {
    for (const path of SAMPLES[entry.id]!) {
      for (const on of [false, true]) {
        for (const who of WHO) {
          const visible =
            who === "pinned_owner" && (entry.visibleTo === "pinned_owner" || on === true);
          it(`${entry.id} ${path} tools ${on ? "on" : "off"} for ${who}: ${visible ? "visible" : "hidden"}`, async () => {
            expect(await hiddenFor(path, subject(who), deps(on))).toBe(!visible);
          });
        }
      }
    }
  }

  it("covers every prefix of every entry in the samples", () => {
    for (const e of HIDDEN_ROUTES) {
      for (const p of e.prefixes) {
        const base = p.endsWith("/") ? p.slice(0, -1) : p;
        expect(SAMPLES[e.id]).toContain(base);
      }
    }
  });

  it("other paths are never hidden by the table (unknown paths are the gate's business)", async () => {
    for (const p of ["/picks", "/", "/api/health", "/blueprintx", "/tradesx", "/holdings-x"]) {
      expect(await hiddenFor(p, "viewer" as Who, deps(false)), p).toBe(false);
    }
  });

  it("decodes and collapses slashes before matching; an undecodable path matches nothing", () => {
    for (const p of ["/%68oldings", "//holdings", "/api//owner-tools/x", "/trades%2Fnew"]) {
      expect(hiddenEntryFor(p)?.id, p).toBe("owner_tools");
    }
    expect(hiddenEntryFor("/%E0%A4%A")).toBeNull();
  });

  it("a config read failure hides; a pin read failure hides", async () => {
    const boom = () => {
      throw new Error("down");
    };
    expect(
      await hiddenForEntry("owner_tools", "pinned_owner", {
        isPinnedOwner: () => true,
        ownerToolsOn: boom,
      }),
    ).toBe(true);
    expect(
      await hiddenForEntry("owner_tools", "pinned_owner", {
        isPinnedOwner: boom,
        ownerToolsOn: () => true,
      }),
    ).toBe(true);
    expect(
      await hiddenForEntry("blueprint", "x", { isPinnedOwner: boom, ownerToolsOn: () => true }),
    ).toBe(true);
  });

  it("the Blueprint never reads the Owner switch", async () => {
    let reads = 0;
    await hiddenForEntry("blueprint", "pinned_owner", {
      isPinnedOwner: () => true,
      ownerToolsOn: () => {
        reads++;
        return false;
      },
    });
    expect(reads).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const BASE = "https://app.example.test";
const CLAIMS: Claims = { uid: 5, sv: 1, si: 1, rec: false };
const LIMITS = {
  signin_per_min_ip: 10,
  writes_per_min_user: 60,
  exports_per_hour_user: 5,
  reads_per_min_user: 600,
};
async function mk(over: Partial<GateDeps> = {}): Promise<GateDeps> {
  const db = await freshDb("auth");
  return {
    env: { APP_BASE_URL: BASE },
    dev: false,
    db: () => db,
    readClaims: async () => CLAIMS,
    limits: LIMITS,
    nowSec: () => 1_700_000_000,
    nonce: () => "N",
    ...over,
  };
}
const req = (p: string, headers?: HeadersInit) =>
  new NextRequest(new URL(p, BASE), { headers: new Headers(headers) });
const marked = (r: Response) => r.headers.get("x-middleware-request-" + HIDE_HEADER) === "1";

describe("gate: Owner tools and unknown paths take the same marking", () => {
  const ownerPaths = ["/recommendations", "/holdings", "/trades", "/api/owner-tools/anything"];

  it("tools off: marked for every signed-in role, the pinned Owner included", async () => {
    for (const pinned of [false, true]) {
      const d = await mk({ isPinnedOwner: async () => pinned, ownerToolsOn: async () => false });
      for (const p of ownerPaths) {
        expect(marked(await gate(req(p), d)), `${pinned} ${p}`).toBe(true);
      }
    }
  });

  it("tools on: marked for anyone who is not the pinned Owner", async () => {
    const d = await mk({ isPinnedOwner: async () => false, ownerToolsOn: async () => true });
    for (const p of ownerPaths) expect(marked(await gate(req(p), d)), p).toBe(true);
  });

  it("no switch dependency or a throwing one is off (fail closed)", async () => {
    const none = await mk({ isPinnedOwner: async () => true });
    const bad = await mk({
      isPinnedOwner: async () => true,
      ownerToolsOn: async () => {
        throw new Error("x");
      },
    });
    for (const d of [none, bad]) expect(marked(await gate(req("/holdings"), d))).toBe(true);
  });

  it("anonymous requests are not marked: sign-in redirect or 401, like any missing path", async () => {
    const d = await mk({ readClaims: async () => null });
    expect((await gate(req("/holdings"), d)).status).toBe(307);
    expect((await gate(req("/zz-missing"), d)).status).toBe(307);
    expect((await gate(req("/api/owner-tools/x"), d)).status).toBe(401);
  });

  it("a signed-in request for an unknown path is marked like a hidden one; known paths are not", async () => {
    const d = await mk({ isPinnedOwner: async () => true });
    for (const p of ["/zz-missing", "/api/zz-missing/model", "/market/a/b/c/d"]) {
      expect(marked(await gate(req(p), d)), p).toBe(true);
    }
    for (const p of ["/", "/market/BHP", "/api/market/search", "/blueprint", "/robots.txt"]) {
      expect(marked(await gate(req(p), d)), p).toBe(false);
    }
  });

  it("a hidden path and a missing path leave the gate with the same marking and headers", async () => {
    const d = await mk({ ownerToolsOn: async () => false, isPinnedOwner: async () => true });
    const a = await gate(req("/holdings"), d);
    const b = await gate(req("/zz-missing"), d);
    const strip = (r: Response) => [...r.headers.entries()].sort();
    expect(strip(a)).toEqual(strip(b));
    expect(a.status).toBe(b.status);
  });

  it("a client-sent hide header is dropped on a known path", async () => {
    const d = await mk({ isPinnedOwner: async () => true });
    const res = await gate(req("/picks", { [HIDE_HEADER]: "1" }), d);
    expect(marked(res)).toBe(false);
  });

  it("the manifest and the service worker are public: no sign-in, never marked", async () => {
    const d = await mk({ readClaims: async () => null });
    for (const p of ["/manifest.webmanifest", "/sw.js"]) {
      const r = await gate(req(p), d);
      expect(r.status, p).toBe(200);
      expect(marked(r), p).toBe(false);
    }
  });
});
