// @vitest-environment node
// SEC-014, M8 T4: when the rate-limit store fails, every write route and server action answers
// 503 and nothing changes (the request is never handed on). Cases come from the source tree.
import type { Client } from "@libsql/client";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { Claims } from "@/lib/auth/claims";
import { gate, isPublicPath, type GateDeps } from "@/lib/http/gate";
import { rateLimit } from "@/lib/http/rateLimit";
import { freshDb } from "../db/helpers";
import {
  actionsOf,
  concreteUrl,
  isAuthJsUrl,
  isMachineUrl,
  routesOf,
  snapshot,
  surfaces,
  WRITE_METHODS,
} from "./support";

const BASE = "https://app.example.test";
const CLAIMS: Claims = { uid: 5, sv: 1, si: 1, rec: false };
const LIMITS = { signin_per_min_ip: 10, writes_per_min_user: 60, exports_per_hour_user: 5 };
const all = surfaces();
const routes = routesOf(all);
const actions = actionsOf(all);
const urls = [
  ...new Set(
    routes
      .filter((r) => !isMachineUrl(r.url) && !isAuthJsUrl(r.url) && !isPublicPath(r.url))
      .map((r) => r.url),
  ),
];
const ACTION_PAGE = "/users";
const SAME = { origin: BASE };

const send = (method: string, url: string, headers: Record<string, string> = SAME) =>
  new NextRequest(new URL(concreteUrl(url), BASE), { method, headers });
const forwarded = (res: Response) => res.headers.get("x-middleware-next") === "1";

/** A store that fails on every statement. */
const down = (): Client =>
  ({
    execute: async () => {
      throw new Error("store down");
    },
  }) as unknown as Client;

/** Wraps a real database: statements on rate_limit throw; every other statement is recorded. */
function failingRateLimitTable(real: Client): { db: Client; others: string[] } {
  const others: string[] = [];
  const db = {
    execute: async (stmt: string | { sql: string }) => {
      const sql = typeof stmt === "string" ? stmt : stmt.sql;
      if (/rate_limit/i.test(sql)) throw new Error("rate_limit table unavailable");
      others.push(sql);
      return real.execute(stmt as never);
    },
  } as unknown as Client;
  return { db, others };
}

const mk = (db: Client, over: Partial<GateDeps> = {}): GateDeps => ({
  env: { APP_BASE_URL: BASE },
  dev: false,
  db: () => db,
  readClaims: async () => CLAIMS,
  limits: LIMITS,
  nowSec: () => 1_700_000_000,
  nonce: () => "NONCE",
  ...over,
});

describe("rateLimit() itself never turns a store error into an allowance", () => {
  it("rejects when the insert fails", async () => {
    await expect(rateLimit(down(), "write:1", 60, 60, 1_700_000_000)).rejects.toThrow();
  });
  it("rejects when only the housekeeping delete fails", async () => {
    const real = await freshDb("auth");
    const flaky = {
      execute: async (stmt: { sql: string; args: unknown[] }) => {
        if (/^\s*DELETE/i.test(stmt.sql)) throw new Error("delete failed");
        return real.execute(stmt as never);
      },
    } as unknown as Client;
    await expect(rateLimit(flaky, "write:1", 60, 60, 1_700_000_000)).rejects.toThrow();
  });
});

describe("SEC-014: a failing store answers 503 on every write route", () => {
  it("covers routes and methods", () => {
    expect(urls.length * WRITE_METHODS.length).toBeGreaterThan(80);
  });

  it("503 for every route and write method; the request is never forwarded", async () => {
    const d = mk(down());
    const bad: string[] = [];
    for (const url of urls) {
      for (const m of WRITE_METHODS) {
        const res = await gate(send(m, url), d);
        if (res.status !== 503 || forwarded(res)) bad.push(`${m} ${url} -> ${res.status}`);
        if (!res.headers.get("content-security-policy")) bad.push(`${m} ${url} lost its CSP`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("503 for every server action POST; the request is never forwarded", async () => {
    const d = mk(down());
    const bad: string[] = [];
    for (const a of actions) {
      const res = await gate(send("POST", ACTION_PAGE, { ...SAME, "next-action": a.name }), d);
      if (res.status !== 503 || forwarded(res)) bad.push(`${a.id} -> ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it("the 503 body is a bare code with no store detail", async () => {
    const res = await gate(send("POST", "/api/alerts/x/ack"), mk(down()));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("unavailable");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("changes nothing: no statement other than the failed rate-limit ones reaches the database", async () => {
    const real = await freshDb("auth");
    const before = await snapshot(real);
    const { db, others } = failingRateLimitTable(real);
    const d = mk(db);
    for (const url of urls) {
      for (const m of WRITE_METHODS) expect((await gate(send(m, url), d)).status).toBe(503);
    }
    for (const a of actions) {
      await gate(send("POST", ACTION_PAGE, { ...SAME, "next-action": a.name }), d);
    }
    expect(others).toEqual([]);
    expect(await snapshot(real)).toBe(before);
  });

  it("a failing session read is also a 503, never a pass-through", async () => {
    const d = mk(await freshDb("auth"), {
      readClaims: async () => {
        throw new Error("jwt backend down");
      },
    });
    for (const url of urls) {
      const res = await gate(send("POST", url), d);
      expect(res.status, url).toBe(503);
      expect(forwarded(res)).toBe(false);
    }
  });
});

describe("SEC-014: sign-in endpoints fail closed too", () => {
  const signin: [string, string][] = [
    ["GET", "/api/auth/callback/google"],
    ["GET", "/api/auth/signin/google"],
    ["POST", "/api/auth/signin/google"],
    ["POST", "/api/test-identity/login"],
    ["POST", "/signin"],
  ];
  for (const [m, p] of signin) {
    it(`${m} ${p} -> 503 with a failing store`, async () => {
      const res = await gate(send(m, p), mk(down(), { readClaims: async () => null }));
      expect(res.status).toBe(503);
      expect(forwarded(res)).toBe(false);
    });
  }
});

describe("SEC-014: the limit itself still bites when the store works", () => {
  it("answers 429 (not forwarded) once the per-user write limit is exceeded", async () => {
    const d = mk(await freshDb("auth"), { limits: { ...LIMITS, writes_per_min_user: 3 } });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await gate(send("POST", "/api/alerts/x/ack"), d)).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });
  it("answers 429 on the sign-in callback per IP", async () => {
    const d = mk(await freshDb("auth"), {
      readClaims: async () => null,
      limits: { ...LIMITS, signin_per_min_ip: 2 },
    });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const req = new NextRequest(new URL("/api/auth/callback/google", BASE), {
        headers: { "x-forwarded-for": "203.0.113.9" },
      });
      codes.push((await gate(req, d)).status);
    }
    expect(codes).toEqual([200, 200, 429, 429]);
  });
});

describe("SEC-014: what a failing store does not touch", () => {
  it("reads and signed machine routes do not depend on the rate-limit store", async () => {
    const d = mk(down());
    expect((await gate(send("GET", "/api/alerts", {}), d)).status).toBe(200);
    expect(forwarded(await gate(send("POST", "/api/internal/self-check", {}), d))).toBe(true);
    expect(forwarded(await gate(send("GET", "/api/health", {}), d))).toBe(true);
  });
});
