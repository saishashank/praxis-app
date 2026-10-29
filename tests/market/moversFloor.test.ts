// @vitest-environment node
// D-199/D-200 (Owner 2026-10-27/28: "show real stocks"): while the history is too short for size
// groups, Top movers keeps to established companies (at least A$1 a share and A$1m traded on the
// day) and leaves out a code whose split or consolidation goes ex that day. All companies still lists
// every company. Synthetic ZZ data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMarket } from "@/lib/ui/loaders/market";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld, type World } from "../loaders/world";

let w: World;

async function stock(code: string, name: string, prev: number, c: number, volume: number) {
  await w.main.execute({
    sql: "INSERT INTO instrument (market, code, name, sector) VALUES ('AU', ?, ?, 'Class Pend')",
    args: [code, name],
  });
  for (const [d, p] of [
    ["2026-10-16", prev],
    [D, c],
  ] as const) {
    await w.main.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU', ?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [code, d, p, p, p, p, volume, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
  }
}

beforeAll(async () => {
  w = await fullWorld();
  await stock("ZZLIQ", "Zed Liquid Ltd", 20, 21, 100_000); // A$2.1m traded: listed
  await stock("ZZPEN", "Zed Penny Ventures", 0.001, 0.002, 1_060_000); // under A$1
  await stock("ZZTHN", "Zed Thin Trade", 50, 60, 100); // A$6,000 traded
  await stock("ZZCON", "Zed Consolidated", 5, 10, 500_000); // 2-for-1 consolidation, not a rise
  await w.main.execute({
    sql: `INSERT INTO corporate_action (market, code, type, ex_date, payload_json)
          VALUES ('AU', 'ZZCON', 'consolidation', ?, '{"old":2,"new":1}')`,
    args: [D],
  });
});
afterAll(cleanupTempDbs);

describe("Top movers without size groups (D-199, D-200)", () => {
  it("keeps penny, thinly traded and reshaped codes out of the movers but not out of All companies", async () => {
    const m = await loadMarket(envOf(w, "owner"), { tab: "movers", page: 1 });
    expect(m.sized).toBe(false);
    expect(m.up.map((r) => r.stock)).toEqual(["ZZLIQ"]);
    const movers = [...m.up, ...m.down, ...m.traded].map((r) => r.stock);
    for (const code of ["ZZPEN", "ZZTHN", "ZZCON"]) expect(movers).not.toContain(code);
    const all = await loadMarket(envOf(w, "owner"), { tab: "all", page: 1 });
    for (const code of ["ZZPEN", "ZZTHN", "ZZCON"]) {
      expect(all.rows.map((r) => r.stock)).toContain(code);
    }
  });

  it("an ASX placeholder sector reads as not classified yet", async () => {
    const s = await loadMarket(envOf(w, "owner"), { tab: "sectors", page: 1 });
    const names = s.sectors.map((x) => x.sector);
    expect(names).toContain("Not classified yet");
    expect(names.join()).not.toMatch(/Class Pend/);
  });
});

describe("Market without a readable corporate-action table (D-201)", () => {
  it("still lists the day, with nothing marked as reshaped", async () => {
    const bare = await fullWorld();
    await bare.main.execute("DROP TABLE corporate_action");
    const m = await loadMarket(envOf(bare, "owner"), { tab: "all", page: 1 });
    expect(m.state).not.toBe("empty");
    expect(m.rows.length).toBeGreaterThan(0);
  });
});
