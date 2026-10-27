// @vitest-environment node
// D-199 (Owner 2026-10-27): while the history is too short for size groups, Top movers still leaves
// out stocks below the ARN-010 U3 price floor (A$0.10), so an A$0.00 stock never tops Biggest rises.
// All companies still lists every company. Synthetic ZZ data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMarket } from "@/lib/ui/loaders/market";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld, type World } from "../loaders/world";

let w: World;

beforeAll(async () => {
  w = await fullWorld();
  await w.main.execute(
    "INSERT INTO instrument (market, code, name, sector) VALUES ('AU','ZZPEN','Zed Penny Ventures','Materials')",
  );
  for (const [d, c] of [
    ["2026-10-16", 0.001],
    [D, 0.002],
  ] as const) {
    await w.main.execute({
      sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
            VALUES ('AU','ZZPEN', ?, ?, ?, ?, ?, 1060000, 'test', ?, ?)`,
      args: [d, c, c, c, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    });
  }
});
afterAll(cleanupTempDbs);

describe("Top movers without size groups (D-199)", () => {
  it("leaves a penny stock out of the movers lists but not out of All companies", async () => {
    const m = await loadMarket(envOf(w, "owner"), { tab: "movers", page: 1 });
    expect(m.sized).toBe(false);
    expect(m.up.map((r) => r.stock)).toContain("ZZUP");
    expect([...m.up, ...m.down, ...m.traded].map((r) => r.stock)).not.toContain("ZZPEN");
    const all = await loadMarket(envOf(w, "owner"), { tab: "all", page: 1 });
    expect(all.rows.map((r) => r.stock)).toContain("ZZPEN");
  });
});
