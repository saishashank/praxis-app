// @vitest-environment node
// M14 fix B3 (D-286): one replay memo per weekly run shared by the challenger stage and the robustness
// stability neighbours, and the rankIc stage that computes only the days without rows. Synthetic ZZ world.
import { afterAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { rankIcStage } from "@/lib/learning/rankIcStage";
import { replayOf, type WeeklyContext } from "@/lib/learning/weeklyStages";
import { CENT, DOLLAR, makeBars, wobble } from "../fixtures/agents/families/builders";
import { buildWorld, type WorldCode } from "../fixtures/replay/ledgerWorld";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterAll(cleanupTempDbs);
const p = defaultAgentParams();
const codes: WorldCode[] = Array.from({ length: 40 }, (_, i) => ({
  code: `ZZP${String(i).padStart(2, "0")}`,
  tier: "U1" as const,
  bars: makeBars({ close: wobble(2n * DOLLAR + BigInt(i) * 3n * CENT) }),
}));

describe("replayOf memo", () => {
  const world = buildWorld(codes, p);
  const ctx = { world, params: p } as unknown as WeeklyContext;

  it("replays an incumbent +- step once; a controls-on run also answers a controls-off request", () => {
    const a = replayOf(ctx, "F1", "F1.dev", {});
    const calls = world.inputsCalls.length;
    expect(replayOf(ctx, "F1", "F1.dev", {})).toBe(a);
    expect(replayOf(ctx, "F1", "F1.dev", {}, false)).toBe(a);
    expect(world.inputsCalls.length).toBe(calls);
  });

  it("a different context or different params replays again", () => {
    const a = replayOf(ctx, "F1", "F1.dev", {});
    expect(replayOf({ ...ctx } as WeeklyContext, "F1", "F1.dev", {})).not.toBe(a);
    const calls = world.inputsCalls.length;
    const b = replayOf(ctx, "F1", "F1.dev", { x: 1 }, false);
    expect(b).not.toBe(a);
    expect(world.inputsCalls.length).toBeGreaterThan(calls);
    expect(replayOf(ctx, "F1", "F1.dev", { x: 1 }, false)).toBe(b);
  });
});

describe("rankIcStage computes only the missing days", () => {
  it("a second run builds no inputs, writes nothing and returns the same summaries", async () => {
    const db = await freshDb("main");
    const world = buildWorld(codes, p);
    Object.assign(world, { corpActions: () => [] });
    const ctx = { db, market: "AU", d: "2026-10-31", params: p, world } as unknown as WeeklyContext;
    const first = await rankIcStage(ctx);
    const rows = Number((await db.execute("SELECT COUNT(*) AS n FROM rank_ic_daily")).rows[0]!.n);
    expect(rows).toBeGreaterThan(0);
    expect(first.stats.length).toBeGreaterThan(0);
    const calls = world.inputsCalls.length;
    const second = await rankIcStage(ctx);
    expect(world.inputsCalls.length).toBe(calls);
    expect(Number((await db.execute("SELECT COUNT(*) AS n FROM rank_ic_daily")).rows[0]!.n)).toBe(
      rows,
    );
    expect(second).toEqual(first);
  }, 300000);
});
