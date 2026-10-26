// @vitest-environment node
// TST-122 for the three JSON routes of M7 T8 (D-136 draft):
//   GET /api/news/[id]                 api/news/[id]
//   GET /api/market/[code]/overview    api/market/[code]/overview
//   GET /api/market/search             api/market/search
// Role matrix (Owner / Editor / Viewer read, anonymous refused), masking leak tests for Editor and
// Viewer (and a Viewer with a live unmask grant is unmasked), query validation, 404 without an oracle,
// and no-store headers.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import { findLeaks } from "@/lib/view/mask";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, fullWorld, NAMES, type World } from "./world";

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
vi.mock("@/auth", () => ({ auth: vi.fn() }));

import * as newsRoute from "@/app/api/news/[id]/route";
import * as overviewRoute from "@/app/api/market/[code]/overview/route";
import * as searchRoute from "@/app/api/market/search/route";

afterAll(cleanupTempDbs);

const BASE = "https://praxis-host.vercel.app";
let w: World;
let users: Record<"owner" | "editor" | "viewer" | "granted", CurrentUser>;
const user = (id: number, role: CurrentUser["role"], name: string): CurrentUser => ({
  id,
  email: `${name}@example.test`,
  name: null,
  role,
});
const get = (path: string) => new Request(`${BASE}${path}`, { method: "GET" });
const body = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const callNews = (id: string) =>
  newsRoute.GET(get(`/api/news/${id}`), { params: Promise.resolve({ id }) });
const callOverview = (code: string) =>
  overviewRoute.GET(get(`/api/market/${code}/overview`), { params: Promise.resolve({ code }) });
const callSearch = (q: string) =>
  searchRoute.GET(get(`/api/market/search?q=${encodeURIComponent(q)}`), undefined);

beforeAll(async () => {
  w = await fullWorld();
  mem.main = w.main;
  mem.auth = w.auth;
  users = {
    owner: user(w.ids.owner, "owner", "owner"),
    editor: user(w.ids.editor, "editor", "editor"),
    viewer: user(w.ids.viewer, "viewer", "viewer"),
    granted: user(w.ids.granted, "viewer", "granted"),
  };
});

const as = (u: CurrentUser | null) => {
  mem.user = u;
};

describe("role matrix", () => {
  it("anonymous is refused with 401 on all three routes", async () => {
    as(null);
    expect((await callNews("1")).status).toBe(401);
    expect((await callOverview("ZZUP")).status).toBe(401);
    expect((await callSearch("zz")).status).toBe(401);
  });
  it("Owner, Editor and Viewer all read (200) with no-store", async () => {
    for (const u of [users.owner, users.editor, users.viewer, users.granted]) {
      as(u);
      const res = await Promise.all([
        callNews(String(w.annIds.up)),
        callOverview(u === users.owner || u === users.granted ? "ZZUP" : "stock-b"),
        callSearch("zz"),
      ]);
      for (const r of res) {
        expect(r.status).toBe(200);
        expect(r.headers.get("Cache-Control")).toContain("no-store");
      }
    }
  });
});

describe("GET /api/news/[id]", () => {
  it("the Owner and a granted user see the real item", async () => {
    for (const u of [users.owner, users.granted]) {
      as(u);
      const b = await body(await callNews(String(w.annIds.oth)));
      expect(b).toMatchObject({ masked: false, stock: "ZZOTH", company: "Zed Other Group" });
      expect(b.url).toBe("https://news.example.test/doc.pdf");
    }
  });
  it("Editor and Viewer get a masked item and nothing about a stock outside the active set", async () => {
    for (const u of [users.editor, users.viewer]) {
      as(u);
      const r = await callNews(String(w.annIds.up));
      const b = await body(r);
      expect(b).toMatchObject({ masked: true, stock: "Stock B", company: null, url: null });
      expect(findLeaks(b, CODES, NAMES)).toEqual([]);
      expect(JSON.stringify(b)).not.toMatch(/example\.test|A\$\s?\d/);
      const hidden = await callNews(String(w.annIds.oth));
      expect(hidden.status).toBe(404);
      expect(JSON.stringify(await body(hidden))).not.toContain("ZZOTH");
      expect((await callNews("999999")).status).toBe(404); // same answer as a hidden item
    }
  });
  it("refuses a malformed id with 400", async () => {
    as(users.owner);
    for (const bad of ["abc", "1.5", "-1", "1e3", "9".repeat(13)]) {
      expect((await callNews(bad)).status).toBe(400);
    }
  });
});

describe("GET /api/market/[code]/overview", () => {
  it("the Owner gets facts only, the last five announcements and the pending-summary text", async () => {
    as(users.owner);
    const b = await body(await callOverview("zzup"));
    expect(b).toMatchObject({ stock: "ZZUP", name: "Zed Upward Holdings", sector: "Technology" });
    expect(b.close).toEqual({ micro: "10500000", currency: "AUD", simulated: true });
    expect(b.summary).toBe(
      "A description of the business needs a company-profile source the app does not have yet.",
    );
    expect(b.announcements.length).toBeLessThanOrEqual(5);
    expect((await callOverview("NOSUCH")).status).toBe(404);
  });
  it("Editor and Viewer address it by slug and get derived numbers only", async () => {
    for (const u of [users.editor, users.viewer]) {
      as(u);
      const b = await body(await callOverview("stock-b"));
      expect(b).toMatchObject({
        masked: true,
        stock: "Stock B",
        name: null,
        close: null,
        changePpm: 50000,
      });
      expect(findLeaks(b, CODES, NAMES)).toEqual([]);
      expect(JSON.stringify(b)).not.toMatch(/example\.test|Technology|10500000|A\$\s?\d/);
      // A real code, a stock outside the set and an unknown slug all look the same: 404.
      const answers = await Promise.all(["ZZUP", "ZZOTH", "stock-z", "NOSUCH"].map(callOverview));
      expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404]);
      const texts = await Promise.all(answers.map(async (r) => JSON.stringify(await body(r))));
      expect(new Set(texts).size).toBe(1);
    }
  });
  it("refuses a malformed code with 400", async () => {
    as(users.owner);
    for (const bad of ["a%20b", "a".repeat(17), "x%3Cy"]) {
      expect((await callOverview(bad)).status).toBe(400);
    }
  });
});

describe("GET /api/market/search", () => {
  it("the Owner finds by code prefix and by name, at most 20 results", async () => {
    as(users.owner);
    const b = await body(await callSearch("zz"));
    expect(b.results.map((r: { code: string }) => r.code)).toEqual(["ZZDN", "ZZOTH", "ZZUP"]);
    expect(b.results.length).toBeLessThanOrEqual(20);
    const byName = await body(await callSearch("Mining"));
    expect(byName.results.map((r: { code: string }) => r.code)).toEqual(["ZZDN"]);
    const none = await body(await callSearch("qqqq"));
    expect(none).toMatchObject({ state: "empty", results: [] });
  });
  it("Editor and Viewer get an empty list: a typed code cannot be tested against masked rows", async () => {
    for (const u of [users.editor, users.viewer]) {
      as(u);
      for (const q of ["ZZUP", "Zed Upward", "zz"]) {
        const b = await body(await callSearch(q));
        expect(b.results).toEqual([]);
        expect(b.masked).toBe(true);
        expect(findLeaks(b, CODES, NAMES)).toEqual([]);
        expect(JSON.stringify(b).toLowerCase()).not.toContain("upward");
      }
    }
  });
  it("validates q: missing, empty, too long, control characters and markup give 400", async () => {
    as(users.owner);
    expect((await searchRoute.GET(get("/api/market/search"), undefined)).status).toBe(400);
    for (const bad of ["", "   ", "a".repeat(41), "a\u0000b", "<script>", "a%b"]) {
      expect((await callSearch(bad)).status).toBe(400);
    }
    // A dot is a plain character, not a pattern.
    expect((await body(await callSearch("z."))).results).toEqual([]);
  });
});

describe("a database failure is a 503, never a masked-looking success", () => {
  it("answers 503 on all three routes", async () => {
    const real = mem.main;
    mem.main = { execute: async () => Promise.reject(new Error("db down")) };
    as(users.owner);
    expect((await callNews("1")).status).toBe(503);
    expect((await callOverview("ZZUP")).status).toBe(503);
    expect((await callSearch("zz")).status).toBe(503);
    mem.main = real;
  });
  it("a failed grant lookup masks (the auth database is down)", async () => {
    const real = mem.auth;
    mem.auth = { execute: async () => Promise.reject(new Error("auth down")) };
    as(users.viewer);
    const b = await body(await callNews(String(w.annIds.up)));
    expect(b.masked).toBe(true);
    mem.auth = real;
  });
});
