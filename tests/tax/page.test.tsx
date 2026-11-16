// @vitest-environment node
// M21 B3 (ARN-122, D-1222, D-1223, D-1265): the page /reviews/tax and the CSV route /api/reports/tax. Owner only (an Editor
// gets 403, a Viewer too, a signed-out request is sent to sign in), the trade-log choice appears only with the Owner tools
// switch on, and nothing outside src/lib/tax/fromLog.ts names the Owner tables.
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUser, KEY } from "../auth/helpers";
import { parseCsv } from "./csvParse";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { seedBook } from "./fixtureBook";

const mem = vi.hoisted(() => ({
  main: null as unknown,
  auth: null as unknown,
  user: null as unknown,
  tools: false,
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getCurrentUser: async () => mem.user,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/http/hiddenRoutes", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/hiddenRoutes")>()),
  ownerToolsSwitchOn: async () => mem.tools,
}));

import TaxReportPage from "@/app/(app)/reviews/tax/page";
import { GET } from "@/app/api/reports/tax/route";

let main: Client;
let auth: Client;
const root = path.resolve(import.meta.dirname, "..", "..");

async function signIn(role: "owner" | "editor" | "viewer", email: string) {
  const id = await addUser(auth, { email, role });
  mem.user = { id, email, name: null, role };
}

const render = async (sp: Record<string, string> = {}) =>
  renderToStaticMarkup(await TaxReportPage({ searchParams: Promise.resolve(sp) }));
const csv = (q: string) =>
  GET(new Request(`http://localhost/api/reports/tax?${q}`), undefined as never);

beforeEach(async () => {
  process.env.OWNER_EMAIL = "owner@example.test";
  process.env.PII_HASH_KEY = KEY;
  main = await freshDb("main");
  auth = await freshDb("auth");
  mem.main = main;
  mem.auth = auth;
  mem.tools = false;
  mem.user = null;
  await seedBook(main);
}, 60_000);
afterEach(cleanupTempDbs);

describe("/reviews/tax", () => {
  it("shows the Owner the fixed words, both columns and the hand-computed totals", async () => {
    await signIn("owner", "owner@example.test");
    const html = await render({ fy: "2026" });
    expect(html).toContain("Paper results, not tax advice");
    expect(html).toContain("1 Jul 2025 to 30 Jun 2026");
    expect(html).toContain("Specific lot");
    expect(html).toContain("First in, first out (FIFO)");
    expect(html).toContain("net A$538.50"); // whole-market net gain 538_500_000 micro
    expect(html).toContain("12 months or less");
    expect(html).toContain("Over 12 months");
    expect(html).toContain("franking not recorded");
    expect(html).toContain("/api/reports/tax?market=AU&amp;fy=2026&amp;source=book");
  });

  it("an Editor and a Viewer get 403 (and the Owner row of another e-mail is not the pinned Owner)", async () => {
    await signIn("editor", "ed@example.test");
    await expect(render()).rejects.toThrow("FORBIDDEN");
    await signIn("viewer", "vi@example.test");
    await expect(render()).rejects.toThrow("FORBIDDEN");
    await signIn("owner", "second-owner@example.test");
    await expect(render()).rejects.toThrow("FORBIDDEN");
  });

  it("a signed-out request goes to sign in", async () => {
    mem.user = null;
    await expect(render()).rejects.toThrow("REDIRECT /signin");
  });

  it("the trade-log choice is absent while the tools are off, present when on; ?source=log is ignored while off", async () => {
    await signIn("owner", "owner@example.test");
    const off = await render({ fy: "2026", source: "log" });
    expect(off).not.toContain("Your own trade log");
    expect(off).not.toContain('value="log"');
    expect(off).toContain("Paper books");
    mem.tools = true;
    const on = await render({ fy: "2026" });
    expect(on).toContain('value="log"');
    const log = await render({ fy: "2026", source: "log" });
    expect(log).toContain("Your own trade log (typed by you), not the paper books");
    expect(log).toContain("Paper results, not tax advice");
  });

  it("an unknown market is a 404", async () => {
    await signIn("owner", "owner@example.test");
    await expect(render({ market: "ZZ" })).rejects.toThrow("NOT_FOUND");
  });

  it("calls requireUser with the admin action first", () => {
    const text = fs.readFileSync(path.join(root, "src/app/(app)/reviews/tax/page.tsx"), "utf8");
    expect(text).toMatch(/requireUser\("admin", "\/reviews\/tax"\)/);
  });
});

describe("GET /api/reports/tax", () => {
  it("serves the CSV to the Owner as an attachment, the fixed words first", async () => {
    await signIn("owner", "owner@example.test");
    const res = await csv("market=AU&fy=2026&source=book");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="praxis-paper-gains-AU-2026.csv"',
    );
    const body = await res.text();
    expect(parseCsv(body)[0]).toEqual(["Paper results, not tax advice"]);
    expect(body).toContain(
      "fifo,ZZAA,2025-08-01,2025-10-01,50,505.000000,742.500000,237.500000,12 months or less",
    );
  });

  it("answers 403 to an Editor, 401 to nobody, and a missing route to the log variant while the tools are off", async () => {
    await signIn("editor", "ed@example.test");
    expect((await csv("fy=2026")).status).toBe(403);
    mem.user = null;
    expect((await csv("fy=2026")).status).toBe(401);
    await signIn("owner", "owner@example.test");
    expect((await csv("fy=2026&source=log")).status).toBe(404);
    mem.tools = true;
    expect((await csv("fy=2026&source=log")).status).toBe(200);
    expect((await csv("market=ZZ")).status).toBe(400);
  });
});

describe("the Owner tables", () => {
  it("only src/lib/tax/fromLog.ts names them inside the tax code, the page and the route", () => {
    const files = ["src/lib/tax", "src/app/(app)/reviews/tax", "src/app/api/reports/tax"].flatMap(
      (d) => fs.readdirSync(path.join(root, d)).map((f) => `${d}/${f}`),
    );
    const names = files.filter((f) =>
      /owner_trade|owner_holding/.test(fs.readFileSync(path.join(root, f), "utf8")),
    );
    expect(names).toEqual(["src/lib/tax/fromLog.ts"]);
  });
  it("nothing outside fromLog is imported statically from it", () => {
    for (const f of [
      "src/lib/tax/report.ts",
      "src/app/(app)/reviews/tax/page.tsx",
      "src/app/api/reports/tax/route.ts",
    ]) {
      expect(fs.readFileSync(path.join(root, f), "utf8")).not.toMatch(
        /^import [^;]*from "(?:\.\/|@\/lib\/tax\/)fromLog"/m,
      );
    }
  });
});
