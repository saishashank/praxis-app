// @vitest-environment node
// CXA-007 command entry (M23 T3; D-1738): forward only, a calm "no live model" in production, soft failures, and the live path
// through an injected night.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { proposalsMain } from "@/lib/research/proposals/cli";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterAll(cleanupTempDbs);

const FIX = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/research/proposals-20.json"), "utf8"),
) as { items: Array<{ item: unknown }> };
const NOW_MS = Date.parse("2031-03-03T01:00:00Z"); // 12:00 on 3 March in Melbourne
const ENV = { TURSO_MAIN_URL: "file:test" };

/** The test database with a `close` that keeps it open (the entry closes the client it was given). */
const open = (db: Client) => () =>
  new Proxy(db, {
    get: (t, k) =>
      k === "close"
        ? () => undefined
        : (t as never as Record<string | symbol, unknown>)[k] instanceof Function
          ? (
              (t as never as Record<string | symbol, (...a: unknown[]) => unknown>)[k] as (
                ...a: unknown[]
              ) => unknown
            ).bind(t)
          : (t as never as Record<string | symbol, unknown>)[k],
  });
const count = async (db: Client, t: string): Promise<number> =>
  Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);

const full = async (): Promise<Client> => {
  const db = await freshDb("main");
  await db.execute("UPDATE market SET mode = 'full' WHERE code = 'AU'");
  return db;
};

describe("proposalsMain", () => {
  it("refuses a replay flag and a date that is not today, and is calm without a database", async () => {
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await proposalsMain(["--replay"], ENV, { out })).toBe(0);
    expect(await proposalsMain([], {}, { out })).toBe(0);
    const db = await freshDb("main");
    expect(
      await proposalsMain(["--date", "2031-03-02"], ENV, {
        out,
        openDb: open(db),
        nowMs: () => NOW_MS,
      }),
    ).toBe(0);
    expect(lines[0]).toContain("refused");
    expect(lines[1]).toContain("database not configured");
    expect(lines[2]).toContain("not the current session");
    expect(await count(db, "angle_proposal")).toBe(0);
  });

  it("production today (no role listed): says 'no live model' and writes nothing", async () => {
    const db = await full();
    const lines: string[] = [];
    const code = await proposalsMain([], ENV, {
      out: (s) => lines.push(s),
      openDb: open(db),
      nowMs: () => NOW_MS,
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "arena-proposals AU 2031-03-03: no live model stored=0 refused=0 cut=0",
    ]);
    expect(await count(db, "angle_proposal")).toBe(0);
    expect(await count(db, "trial_ledger")).toBe(0);
    expect(await count(db, "app_log")).toBe(0);
  });

  it("a live R2 (injected night): one run stores the valid proposals; the line carries counts only", async () => {
    const db = await full();
    const lines: string[] = [];
    const router = {
      route: async (req: { rules: unknown }) => ({
        value: { proposals: FIX.items.slice(0, 7).map((f) => f.item) },
        source: "recorder",
        llmUsed: true,
        budgetExhausted: false,
        rules: req.rules,
      }),
    };
    const llm = async () =>
      ({ status: { roles: [{ role: "R2", live: true }] }, routerFor: () => router }) as never;
    const code = await proposalsMain([], ENV, {
      out: (s) => lines.push(s),
      openDb: open(db),
      nowMs: () => NOW_MS,
      llm,
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["arena-proposals AU 2031-03-03: stored stored=3 refused=0 cut=4"]);
    expect(await count(db, "angle_proposal")).toBe(3);
    expect(await count(db, "trial_ledger")).toBe(3);
  });

  it("says nothing on a data-only market, and on a night that is not the month's first session", async () => {
    const lines: string[] = [];
    const d = await freshDb("main");
    await d.execute("UPDATE market SET mode = 'data_only' WHERE code = 'AU'"); // silent, like the other stages
    await proposalsMain([], ENV, {
      out: (s) => lines.push(s),
      openDb: open(d),
      nowMs: () => NOW_MS,
    });
    const db = await full();
    await db.execute(
      "INSERT INTO trading_calendar (market, d, kind, confirmed, source) VALUES ('AU', '2031-03-01', 'session', 1, 'test')",
    );
    await proposalsMain([], ENV, {
      out: (s) => lines.push(s),
      openDb: open(db),
      nowMs: () => NOW_MS,
    });
    expect(lines).toEqual([]);
  });

  it("an unexpected failure is one degraded line and exit 0", async () => {
    const db = await full();
    const lines: string[] = [];
    const code = await proposalsMain([], ENV, {
      out: (s) => lines.push(s),
      openDb: open(db),
      nowMs: () => NOW_MS,
      llm: async () => {
        throw new TypeError("boom with an internal detail");
      },
    });
    expect(code).toBe(0);
    expect(lines).toEqual(["arena-proposals: degraded (unexpected error TypeError)"]);
  });
});
