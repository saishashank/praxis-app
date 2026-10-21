// @vitest-environment node
// SEC-011, M8 T4: every state-changing route and server action refuses a cross-origin or
// missing-origin write, and no GET / HEAD changes state. Cases are generated from the source tree
// (the route manifest is checked to match it), so a new route or action is covered automatically.
// Server actions are POSTs to their page, so they pass through the same gate as routes.
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import type { CurrentUser } from "@/lib/auth/session";
import { addUser, KEY } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import type { Claims } from "@/lib/auth/claims";
import { gate, isPublicPath, type GateDeps } from "@/lib/http/gate";
import { freshDb } from "../db/helpers";
import {
  actionsOf,
  concreteUrl,
  isAuthJsUrl,
  isMachineUrl,
  manifestIds,
  ROOT,
  routesOf,
  snapshot,
  surfaces,
  WRITE_METHODS,
} from "./support";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), forbidden: vi.fn() }));
vi.mock("@/auth", () => ({ handlers: { GET: vi.fn(), POST: vi.fn() }, auth: vi.fn() }));

const BASE = "https://app.example.test";
const CLAIMS: Claims = { uid: 5, sv: 1, si: 1, rec: false };
const LIMITS = { signin_per_min_ip: 10, writes_per_min_user: 100_000, exports_per_hour_user: 5 };
const all = surfaces();
const routes = routesOf(all);
const actions = actionsOf(all);
// Every gated route is probed with every write method: a method the file does not export must
// still be refused cross-origin at the gate (Next would answer 405 only after the gate).
const gated = routes.filter((r) => !isMachineUrl(r.url) && !isAuthJsUrl(r.url));
const urls = [...new Set(gated.map((r) => r.url))];
const writeCases = urls.flatMap((url) => WRITE_METHODS.map((m) => ({ url, m })));

async function deps(over: Partial<GateDeps> = {}): Promise<GateDeps> {
  const db = await freshDb("auth");
  return {
    env: { APP_BASE_URL: BASE },
    dev: false,
    db: () => db,
    readClaims: async () => CLAIMS,
    limits: LIMITS,
    nowSec: () => 1_700_000_000,
    nonce: () => "NONCE",
    ...over,
  };
}
const send = (method: string, url: string, headers: Record<string, string> = {}) =>
  new NextRequest(new URL(concreteUrl(url), BASE), { method, headers });
const forwarded = (res: Response) => res.headers.get("x-middleware-next") === "1";

// An action posts to the page that hosts it; the gate only ever sees the page path.
const ACTION_PAGE = "/users";

const BAD_ORIGINS: Record<string, Record<string, string>> = {
  "no Origin and no Referer": {},
  "cross-origin Origin": { origin: "https://evil.example" },
  "Origin null": { origin: "null" },
  "look-alike host (suffix)": { origin: `${BASE}.evil.example` },
  "look-alike host (prefix)": { origin: "https://evil-app.example.test" },
  "http instead of https": { origin: "http://app.example.test" },
  "other port": { origin: `${BASE}:8443` },
  "cross-origin Referer only": { referer: "https://evil.example/page" },
  "unparseable Referer only": { referer: "not a url" },
  "bad Origin overriding a good Referer": { origin: "https://evil.example", referer: `${BASE}/x` },
};

describe("the route manifest matches the source tree (new routes are swept automatically)", () => {
  it("lists exactly the generated routes and actions", () => {
    expect(manifestIds().sort()).toEqual(all.map((s) => s.id).sort());
  });
  it("finds a realistic number of surfaces", () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(actions.length).toBeGreaterThan(30);
  });
});

describe("SEC-011: writes to routes need our own origin", () => {
  it("has cases", () => expect(writeCases.length).toBeGreaterThan(80));

  for (const [label, headers] of Object.entries(BAD_ORIGINS)) {
    it(`refuses (403) a write with ${label} on every route and method`, async () => {
      const d = await deps();
      const failures: string[] = [];
      for (const { url, m } of writeCases) {
        const res = await gate(send(m, url, headers), d);
        if (res.status !== 403) failures.push(`${m} ${url} -> ${res.status}`);
        if (forwarded(res)) failures.push(`${m} ${url} was forwarded`);
      }
      expect(failures).toEqual([]);
    });
  }

  it("forwards a same-origin write (Origin, or Referer when Origin is absent)", async () => {
    const d = await deps();
    for (const { url, m } of writeCases) {
      expect(forwarded(await gate(send(m, url, { origin: BASE }), d)), `${m} ${url}`).toBe(true);
      expect(
        forwarded(await gate(send(m, url, { referer: `${BASE}/page?a=1` }), d)),
        `${m} ${url}`,
      ).toBe(true);
    }
  });

  it("refuses a cross-origin write before any authentication or database work", async () => {
    let touched = 0;
    const d = await deps({
      readClaims: async () => {
        touched++;
        return CLAIMS;
      },
      db: () => {
        touched++;
        throw new Error("must not be used");
      },
    });
    for (const { url, m } of writeCases) {
      await gate(send(m, url, { origin: "https://evil.example" }), d);
    }
    expect(touched).toBe(0);
  });

  it("compares with the configured APP_BASE_URL, not the Host the request claims", async () => {
    const d = await deps();
    const req = new NextRequest(new URL("/api/alerts/x/ack", "https://evil.example"), {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect((await gate(req, d)).status).toBe(403);
  });

  it("ignores method-override headers (a POST stays a write)", async () => {
    const d = await deps();
    for (const h of ["x-http-method-override", "x-method-override", "x-http-method"]) {
      const res = await gate(
        send("POST", "/api/alerts/x/ack", { [h]: "GET", origin: "https://evil.example" }),
        d,
      );
      expect(res.status).toBe(403);
    }
  });
});

describe("SEC-011: writes to server actions need our own origin", () => {
  for (const [label, headers] of Object.entries(BAD_ORIGINS)) {
    it(`refuses (403) every action POST with ${label}`, async () => {
      const d = await deps();
      const failures: string[] = [];
      for (const a of actions) {
        // Actions post to the page path with a Next-Action header naming the action.
        const res = await gate(
          send("POST", ACTION_PAGE, { ...headers, "next-action": `id-of-${a.name}` }),
          d,
        );
        if (res.status !== 403) failures.push(`${a.id} -> ${res.status}`);
      }
      expect(failures).toEqual([]);
    });
  }

  it("no page path is exempt from the check", async () => {
    const d = await deps();
    for (const p of ["/", "/users", "/settings", "/health", "/signin", "/strategies/risk"]) {
      const res = await gate(send("POST", p, { origin: "https://evil.example" }), d);
      expect(res.status, p).toBe(403);
    }
  });

  it("every action is guarded: it reads the session or is the sign-in / sign-out action", () => {
    const open = actions.filter((a) => {
      const src = fs.readFileSync(path.join(ROOT, a.file), "utf8");
      return !/requireUser|getCurrentUser|signIn\(|signOut\(|authorize\(/.test(src);
    });
    expect(open.map((a) => a.id)).toEqual([]);
  });
});

describe("SEC-011: the exemptions are exactly the self-authenticating machine routes", () => {
  const publicWrites = routes.filter((r) => r.method !== "GET" && isPublicPath(r.url));

  it("the only public write routes are signed machine routes and Auth.js", () => {
    const unexpected = publicWrites.filter((r) => !isMachineUrl(r.url) && !isAuthJsUrl(r.url));
    expect(unexpected.map((r) => r.id)).toEqual([]);
  });

  it("every machine route builds a verifying handler (HMAC, CRON_SECRET, test identity)", () => {
    const missing = routes
      .filter((r) => isMachineUrl(r.url))
      .filter((r) => {
        const dir = path.join(ROOT, path.dirname(r.file));
        const text = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
          .join("\n");
        return !/Handler\(|testIdentityEnabled/.test(text);
      });
    expect(missing.map((r) => r.id)).toEqual([]);
  });

  it("unknown /api paths and pages are not public", () => {
    expect(isPublicPath("/api/alerts")).toBe(false);
    expect(isPublicPath("/api/internal/unknown")).toBe(false);
    expect(isPublicPath("/users")).toBe(false);
  });
});

describe("SEC-011: GET and HEAD never change state", () => {
  const reads = routes.filter((r) => r.method === "GET");

  it("no GET handler file holds a SQL write (cron GETs write only after CRON_SECRET)", () => {
    const writers = reads
      .filter((r) => !isMachineUrl(r.url) && !isAuthJsUrl(r.url))
      .filter((r) =>
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i.test(
          fs.readFileSync(path.join(ROOT, r.file), "utf8"),
        ),
      );
    expect(writers.map((r) => r.id)).toEqual([]);
  });

  it("a handler shared by GET and POST branches on the method", () => {
    const shared = routes.filter(
      (r) =>
        r.method === "GET" &&
        /export const GET = (\w+);[\s\S]*export const POST = \1;/.test(
          fs.readFileSync(path.join(ROOT, r.file), "utf8"),
        ),
    );
    expect(shared.map((r) => r.url)).toEqual(["/api/alerts/quiet-hours"]);
    expect(fs.readFileSync(path.join(ROOT, "src/lib/alerts/api.ts"), "utf8")).toMatch(
      /req\.method === "GET"/,
    );
  });

  it("the gate writes nothing for GET, HEAD or OPTIONS on any non-sign-in route", async () => {
    const d = await deps();
    const db = d.db();
    const before = await snapshot(db);
    for (const r of reads.filter((x) => !isAuthJsUrl(x.url))) {
      for (const m of ["GET", "HEAD", "OPTIONS"]) await gate(send(m, r.url), d);
    }
    expect(await snapshot(db)).toBe(before);
  });
});

describe("SEC-011: no GET handler changes state when called (as the Owner, real databases)", () => {
  const modules = import.meta.glob("../../src/app/api/**/route.ts");
  let main: Client;
  let auth: Client;

  beforeAll(async () => {
    vi.stubEnv("PII_HASH_KEY", KEY);
    main = await freshDb("main");
    auth = await freshDb("auth");
    mem.main = main;
    mem.auth = auth;
    const id = await addUser(auth, { email: "owner@example.test", role: "owner" });
    mem.user = { id, email: "owner@example.test", name: null, role: "owner" } satisfies CurrentUser;
  });
  afterAll(() => {
    cleanupTempDbs();
    vi.unstubAllEnvs();
  });

  const reads = routes.filter((r) => r.method === "GET" && !isAuthJsUrl(r.url));
  it("has GET handlers to call", () => expect(reads.length).toBeGreaterThan(10));

  for (const r of reads) {
    it(`GET ${r.url} leaves both databases unchanged`, async () => {
      const load = modules[`../../${r.file}`];
      expect(load, r.file).toBeDefined();
      const mod = (await load()) as Record<
        string,
        (req: Request, ctx?: unknown) => Promise<Response> | Response
      >;
      const ctx = { params: Promise.resolve({ key: "k", id: "sample-1", code: "ABC" }) };
      const before = [await snapshot(main), await snapshot(auth)];
      const res = await mod.GET(new Request(new URL(concreteUrl(r.url), BASE)), ctx);
      expect(res.status).toBeLessThan(600);
      expect([await snapshot(main), await snapshot(auth)]).toEqual(before);
    });
  }
});
