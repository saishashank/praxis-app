// D-886 movers check over the Strategies test world: the Market lists are stubbed (the world's bars
// are too thin for the movers filters and price bars are immutable), everything else is real: the
// open trade of E01 in ZZUP, the evening-before ideas and the universe.
import { afterAll, describe, expect, it, vi } from "vitest";

const lists = vi.hoisted(() => ({ d: "2026-10-20" as string | null }));
vi.mock("@/lib/ui/loaders/market", async (orig) => {
  const real = await orig<typeof import("@/lib/ui/loaders/market")>();
  const row = (stock: string, changePpm: number) => ({ stock, name: `${stock} name`, changePpm });
  return {
    ...real,
    loadMarket: vi.fn(async (_env: unknown, q: { upPage: number }) => ({
      state: lists.d === null ? "empty" : "ok",
      d: lists.d,
      up: { rows: q.upPage === 1 ? [row("ZZUP", 80_000), row("ZZOTH", 50_000)] : [] },
      down: { rows: q.upPage === 1 ? [row("ZZDN", -90_000)] : [] },
    })),
  };
});

import { loadMoversCheck } from "@/lib/ui/loaders/moversCheck";
import { maskContextFor } from "@/lib/view/mask";
import { cleanupTempDbs } from "../db/helpers";
import { NOW } from "../loaders/seed";
import { strategiesWorld } from "./world";

afterAll(cleanupTempDbs);

describe("loadMoversCheck over stored trades and ideas (D-886)", () => {
  it("a held rise, an unheld rise and a fall, with the session before", async () => {
    const w = await strategiesWorld();
    const user = { id: 1, role: "owner" };
    const mask = await maskContextFor(user, w.auth, NOW);
    const env = { main: w.main, auth: w.auth, user, mask, now: NOW };
    const m = await loadMoversCheck(env);
    expect(m.d).toBe("2026-10-20");
    expect(m.prev).toBe("2026-10-19");
    const up = m.rises.find((r) => r.code === "ZZUP")!;
    expect(up.verdict).toBe("held");
    expect(up.strategies.length).toBeGreaterThan(0);
    expect(m.summary.risesHeld).toBeGreaterThanOrEqual(1);
    const oth = m.rises.find((r) => r.code === "ZZOTH")!;
    expect(["not_followed", "no_rule", "idea_not_bought"]).toContain(oth.verdict);
    expect(m.falls.map((r) => r.code)).toEqual(["ZZDN"]);
    expect(m.falls[0]!.text.length).toBeGreaterThan(10);

    lists.d = null;
    expect(await loadMoversCheck(env)).toMatchObject({ d: null, rises: [], falls: [] });
  });
});
