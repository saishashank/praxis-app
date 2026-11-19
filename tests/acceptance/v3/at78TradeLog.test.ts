// @vitest-environment node
// AT-78 "the trade log stores only the Owner's typed rows, is masked for other roles, and a planted trade changes no paper
// book" (M21 B2, ARN-121, D-1221, D-1275). The AT-32 golden ZZ world is built twice, once as it is and once with ten
// planted `owner_trade` rows and a void, and every table except `owner_trade` and `owner_trade_void` dumps identically
// (every book, order, signal, rule, alert, card and Cortex table). Also: the only writer is the trade-log store and it
// writes only the two sources (typed, csv); every role but the pinned Owner gets the missing route for /trades. Synthetic
// ZZ data only (SEC-110).
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { requireOwnerTools } from "@/lib/auth/ownerToolsGuard";
import type { CurrentUser } from "@/lib/auth/session";
import { appendTrades, voidTrade } from "@/lib/ownerTools/tradeLog/store";
import { cleanupTempDbs } from "../../db/helpers";
import { at32World, dump } from "./at32World";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.setConfig({ testTimeout: 900000, hookTimeout: 900000 });
afterAll(cleanupTempDbs);

const ROOT = path.resolve(import.meta.dirname, "../../..");

describe("AT-78: a planted trade moves nothing (D-1221)", () => {
  it("the golden world dumps identically with and without planted trades, except the two Owner tables", async () => {
    const plain = await at32World();
    const planted = await at32World(async (db) => {
      const rows = Array.from({ length: 10 }, (_, i) => ({
        market: "AU",
        code: `ZZT${i % 3}`,
        side: i % 2 === 0 ? ("buy" as const) : ("sell" as const),
        d: "2030-01-02",
        qty: 100 + i,
        priceMicro: BigInt(1_000_000 + i * 250_000),
        feesMicro: 5_000_000n,
        note: i === 0 ? "planted" : null,
      }));
      const when = new Date("2030-01-03T00:00:00.000Z");
      const saved = await appendTrades(
        db,
        rows,
        "csv",
        "user:0",
        when,
        "20300103T000000000Z-00000001",
      );
      expect(saved).toMatchObject({ ok: true });
      expect(await voidTrade(db, 1, "planted", when)).toEqual({ ok: true });
    });
    const a = await dump(plain);
    const b = await dump(planted);
    // not vacuous: the world has orders and the plant is there
    expect(a.rows.arena_order).toBeGreaterThan(0);
    expect(a.rows.owner_trade).toBe(0);
    expect(b.rows.owner_trade).toBe(10);
    expect(b.rows.owner_trade_void).toBe(1);
    expect(Object.keys(b.perTable).sort()).toEqual(Object.keys(a.perTable).sort());
    const differing = Object.keys(a.perTable)
      .filter((t) => a.perTable[t] !== b.perTable[t])
      .sort();
    expect(differing).toEqual(["owner_trade", "owner_trade_void"]);
    for (const t of Object.keys(a.rows).filter((t) => !t.startsWith("owner_trade"))) {
      expect(b.rows[t], `${t} row count`).toBe(a.rows[t]);
    }
  });
});

describe("AT-78: the log stores only the Owner's typed rows", () => {
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

  it("one module inserts into owner_trade; it writes only the typed and csv sources", () => {
    const writers = walk("src").filter((f) =>
      /\bINSERT\s+INTO\s+owner_trade\b/i.test(strip(read(f))),
    );
    expect(writers).toEqual(["src/lib/ownerTools/tradeLog/store.ts"]);
    expect(read(writers[0]!)).toMatch(/source: "typed" \| "csv"/);
  });

  it("the only callers of the store's writers are the Owner's trade actions, each asking requireOwnerTools first", () => {
    const callers = walk("src")
      .filter((f) => /\b(?:appendTrades|voidTrade)\s*\(/.test(strip(read(f))))
      .sort();
    expect(callers).toEqual([
      "src/app/(app)/(owner-tools)/trades/actions.ts",
      "src/lib/ownerTools/tradeLog/store.ts",
    ]);
    const actions = strip(read(callers[0]!));
    for (const fn of ["addTradesAction", "voidTradeAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${fn}`));
      const guard = body.indexOf("await requireOwnerTools(");
      expect(guard).toBeGreaterThan(-1);
      // nothing is awaited before the guard
      expect(body.slice(0, guard)).not.toMatch(/\bawait\b/);
    }
  });

  it("the form has no credential, broker or password field", () => {
    const form = read("src/components/ownerTools/TradesForm.tsx");
    expect(form).not.toMatch(
      /type=["']password["']|autoComplete=["'](?:current|new)-password|api[_-]?key|token/i,
    );
    expect(form).not.toMatch(/https?:\/\//);
  });
});

describe("AT-78: masked for every other role", () => {
  const u = (role: CurrentUser["role"], email: string): CurrentUser => ({
    id: 1,
    email,
    name: null,
    role,
  });
  const ENV = { OWNER_EMAIL: "owner@example.test" } as Record<string, string | undefined>;
  const deps = (user: CurrentUser | null) => ({
    env: ENV,
    getUser: async () => user,
    ownerToolsOn: async () => true,
  });

  it("/trades is the app's missing route for anonymous, Viewer, Editor and a second owner-role row, switch on", async () => {
    for (const user of [
      null,
      u("viewer", "v@example.test"),
      u("editor", "e@example.test"),
      u("owner", "second@example.test"),
    ]) {
      await expect(requireOwnerTools("/trades", deps(user))).rejects.toThrow("NEXT_NOT_FOUND");
    }
  });

  it("the pinned Owner with the switch on passes", async () => {
    const owner = u("owner", "owner@example.test");
    expect(await requireOwnerTools("/trades", deps(owner))).toEqual(owner);
  });
});
