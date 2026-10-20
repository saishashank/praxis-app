// @vitest-environment node
// GET /api/learning/plan and GET /api/learning/documents (M7 T4, TST-122, D-132 draft): the role
// matrix (Owner / Editor / Viewer read, anonymous refused), the stored rows come back parsed,
// bad parameters are refused with 400, an absent document is 404. Real migrated database.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/session";
import { addUser, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";

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

import * as docsRoute from "@/app/api/learning/documents/route";
import * as planRoute from "@/app/api/learning/plan/route";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

const BASE = "https://praxis-host.vercel.app";
const SHA = "a".repeat(64);
let main: Client;
let users: Record<"owner" | "editor" | "viewer", CurrentUser>;

const mkUser = async (auth: Client, role: CurrentUser["role"]): Promise<CurrentUser> => {
  const email = `${role}@example.test`;
  return { id: await addUser(auth, { email, role }), email, name: null, role };
};
const get = (path: string) => new Request(`${BASE}${path}`, { method: "GET" });
const json = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function addDoc(path: string, version: number, type: string, body: string, d: string) {
  await main.execute({
    sql: `INSERT INTO document (path, version, market, doc_type, front_json, body, body_sha, d, created_at)
          VALUES (?, ?, 'AU', ?, '{"title":"t"}', ?, ?, ?, '2026-10-05T00:00:00Z')`,
    args: [path, version, type, body, SHA, d],
  });
}

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  main = await freshDb("main");
  const auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  users = {
    owner: await mkUser(auth, "owner"),
    editor: await mkUser(auth, "editor"),
    viewer: await mkUser(auth, "viewer"),
  };
  mem.user = users.viewer;
  for (const [d, rank] of [
    ["2026-10-05", 1],
    ["2026-10-06", 1],
    ["2026-10-06", 2],
  ] as const) {
    await main.execute({
      sql: `INSERT INTO plan_item (market, d, rank, kind, reason, lesson_id, lane, measure_json)
            VALUES ('AU', ?, ?, 'data_weakness', 'no-lesson:data_weakness r', NULL, 'ops', ?)`,
      args: [d, rank, JSON.stringify({ metric: "flags", threshold: 0, check_d: d, ref: {} })],
    });
  }
  await main.execute(
    `INSERT INTO plan_review (market, plan_d, rank, reviewed_d, outcome, evidence_json)
     VALUES ('AU', '2026-10-05', 1, '2026-10-06', 'met', '{"open":0}')`,
  );
  await addDoc("knowledge/families/F1.md", 1, "family", "v1 body", "2026-10-01");
  await addDoc("knowledge/families/F1.md", 2, "family", "v2 body", "2026-10-02");
  await addDoc("knowledge/lessons/L1.md", 1, "lesson", "lesson body", "2026-10-03");
});

describe("GET /api/learning/plan", () => {
  it("every signed-in role reads; anonymous is refused", async () => {
    for (const u of Object.values(users)) {
      mem.user = u;
      expect((await planRoute.GET(get("/api/learning/plan"), undefined)).status).toBe(200);
    }
    mem.user = null;
    expect((await planRoute.GET(get("/api/learning/plan"), undefined)).status).toBe(401);
  });

  it("returns the latest plan by default, with parsed measures, and no-store", async () => {
    const res = await planRoute.GET(get("/api/learning/plan"), undefined);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const b = await json(res);
    expect(b.d).toBe("2026-10-06");
    expect(b.items.map((i: { rank: number }) => i.rank)).toEqual([1, 2]);
    expect(b.items[0].measure.metric).toBe("flags");
    expect(b.reviews).toEqual([]);
  });

  it("returns the plan of a given date with its review, and an empty view for none", async () => {
    const b = await json(await planRoute.GET(get("/api/learning/plan?d=2026-10-05"), undefined));
    expect(b.items).toHaveLength(1);
    expect(b.reviews).toEqual([
      { rank: 1, reviewed_d: "2026-10-06", outcome: "met", evidence: { open: 0 } },
    ]);
    const none = await json(await planRoute.GET(get("/api/learning/plan?d=2026-01-01"), undefined));
    expect(none).toEqual({ market: "AU", d: null, items: [], reviews: [] });
  });

  it("refuses a malformed date or market", async () => {
    for (const q of ["d=yesterday", "market=A%20U", "market=" + "X".repeat(40)]) {
      expect((await planRoute.GET(get(`/api/learning/plan?${q}`), undefined)).status).toBe(400);
    }
  });
});

describe("GET /api/learning/documents", () => {
  it("every signed-in role reads; anonymous is refused", async () => {
    for (const u of Object.values(users)) {
      mem.user = u;
      expect((await docsRoute.GET(get("/api/learning/documents"), undefined)).status).toBe(200);
    }
    mem.user = null;
    expect((await docsRoute.GET(get("/api/learning/documents"), undefined)).status).toBe(401);
  });

  it("lists the latest version of each document without bodies, filtered by type and text", async () => {
    const all = await json(await docsRoute.GET(get("/api/learning/documents"), undefined));
    expect(
      all.documents.map((x: { path: string; version: number }) => [x.path, x.version]),
    ).toEqual([
      ["knowledge/families/F1.md", 2],
      ["knowledge/lessons/L1.md", 1],
    ]);
    expect(all.documents[0].body).toBeUndefined();
    const lessons = await json(
      await docsRoute.GET(get("/api/learning/documents?type=lesson"), undefined),
    );
    expect(lessons.documents).toHaveLength(1);
    const q = await json(await docsRoute.GET(get("/api/learning/documents?q=famil"), undefined));
    expect(q.documents).toHaveLength(1);
    const pct = await json(await docsRoute.GET(get("/api/learning/documents?q=%25"), undefined));
    expect(pct.documents).toHaveLength(0); // a literal percent sign, not a wildcard
  });

  it("reads one document: the latest version, or the version asked for; 404 when absent", async () => {
    const p = "path=knowledge/families/F1.md";
    const latest = await json(await docsRoute.GET(get(`/api/learning/documents?${p}`), undefined));
    expect(latest.document.version).toBe(2);
    expect(latest.document.body).toBe("v2 body");
    const v1 = await json(
      await docsRoute.GET(get(`/api/learning/documents?${p}&version=1`), undefined),
    );
    expect(v1.document.body).toBe("v1 body");
    const miss = await docsRoute.GET(
      get("/api/learning/documents?path=knowledge/none.md"),
      undefined,
    );
    expect(miss.status).toBe(404);
  });

  it("refuses bad parameters", async () => {
    for (const q of [
      "type=bogus",
      "limit=abc",
      "version=x",
      "path=etc/passwd",
      "path=knowledge/../x.md",
      "path=knowledge/a.txt",
    ]) {
      expect((await docsRoute.GET(get(`/api/learning/documents?${q}`), undefined)).status).toBe(
        400,
      );
    }
  });
});
