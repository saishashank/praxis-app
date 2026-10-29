// @vitest-environment node
// KB-081 pre-registered challengers and the O-46 variant cap (M14 WP6; D-233, D-234, D-235).
import { afterEach, describe, expect, it } from "vitest";
import {
  PRE_REGISTERED,
  PRE_REGISTERED_BLOCKED,
  PRE_REGISTERED_NOTE,
  releasePreRegistered,
} from "@/lib/learning/preRegistered";
import { cleanupTempDbs } from "../db/helpers";
import { BASE, D0, LEARNING, MARKET, rows, world } from "./challengerFixtures";

afterEach(cleanupTempDbs);

const FAMILIES = ["F1", "F3", "F4", "F6"] as const;
const roomy = { ...LEARNING, maxChallengers: 20 };
const input = { market: MARKET, d: D0, learning: roomy, stats: BASE.stats };

describe("the fixed list", () => {
  it("is F1 x3, F3 x3, F4 x3 and F6 x1 with unique ids; F2 and F5 have none", () => {
    const count = (f: string) => PRE_REGISTERED.filter((x) => x.family === f).length;
    expect(PRE_REGISTERED).toHaveLength(10);
    expect([count("F1"), count("F3"), count("F4"), count("F6")]).toEqual([3, 3, 3, 1]);
    expect(count("F2") + count("F5")).toBe(0);
    expect(new Set(PRE_REGISTERED.map((x) => x.id)).size).toBe(10);
  });

  it("lists the director trade-type split as BLOCKED-DATA, outside the list", () => {
    expect(PRE_REGISTERED_BLOCKED.map((b) => [b.family, b.status])).toEqual([
      ["F6", "BLOCKED-DATA"],
    ]);
    expect(PRE_REGISTERED.some((x) => x.id === PRE_REGISTERED_BLOCKED[0]!.id)).toBe(false);
  });
});

describe("releasePreRegistered", () => {
  it("creates all ten as owner challengers, each charged one challenger trial, none for the split", async () => {
    const { db } = await world([...FAMILIES]);
    const r = await releasePreRegistered(db, input);
    expect(r.created).toHaveLength(10);
    expect(r.skipped).toEqual([]);
    expect(r.stoppedBy).toBeNull();
    const ch = await rows(db, "SELECT origin FROM challenger");
    expect(ch.every((c) => c.origin === "owner")).toBe(true);
    const trials = await rows(db, "SELECT lineage_id FROM trial_ledger WHERE kind = 'challenger'");
    expect(trials).toHaveLength(10);
    expect(trials.filter((t) => t.lineage_id === "AU:F6")).toHaveLength(1);
    const reasons = await rows(db, "SELECT reason FROM rule_version_status WHERE seq = 1");
    expect(
      reasons.filter((x) => String(x.reason).includes(PRE_REGISTERED_NOTE)).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it("each challenger is the incumbent plus its listed change, nothing else", async () => {
    const { db } = await world([...FAMILIES]);
    await releasePreRegistered(db, input);
    const v = async (id: string) =>
      JSON.parse(String((await rows(db, "SELECT params_json FROM rule_version WHERE id = ?", [id]))[0]!.params_json)) as Record<string, unknown>;
    const f1 = await v("F1.v1");
    expect(await v("F1.v2")).toEqual({ ...f1, f1_return_window_sessions: 252 });
    expect(await v("F1.v3")).toEqual({ ...f1, f1_momentum_variant: "skip_month_u2" });
    expect(await v("F1.v4")).toEqual({ ...f1, f1_rank_variant: "composite3" });
    const f3 = await v("F3.v1");
    expect(await v("F3.v2")).toEqual({ ...f3, f3_time_exit: 40 });
    expect(await v("F3.v3")).toEqual({ ...f3, f3_time_exit: 60 });
    expect(await v("F3.v4")).toEqual({ ...f3, f3_surprise_mode: "day0_ar" });
    const f4 = await v("F4.v1");
    expect(await v("F4.v2")).toEqual({ ...f4, f4_entry_variant: "reversal5_u2" });
    expect(await v("F4.v3")).toEqual({ ...f4, f4_rank_variant: "vol_scaled" });
    // the unscaled control arm names the default, so it is its own parameter set
    expect(await v("F4.v4")).toEqual({ ...f4, f4_rank_variant: "v1" });
    const f6 = await v("F6.v1");
    const w = f6.insider_score_weights as Record<string, number>;
    expect(await v("F6.v2")).toEqual({
      ...f6,
      insider_score_weights: { ...w, director_sale: 0.25 },
    });
  });

  it("releases in list order as slots free up and ends when the slots run out", async () => {
    const { db } = await world([...FAMILIES]);
    const tight = { ...input, learning: { ...LEARNING, maxChallengers: 4 } };
    const r = await releasePreRegistered(db, tight);
    expect(r.created).toEqual(["C-AU-F1-2", "C-AU-F1-3", "C-AU-F1-4", "C-AU-F3-2"]);
    expect(r.stoppedBy).toBe("max_challengers");
    // a second run with no free slot creates nothing and charges nothing
    const again = await releasePreRegistered(db, tight);
    expect(again.created).toEqual([]);
    expect(again.stoppedBy).toBe("max_challengers");
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind = 'challenger'")).toHaveLength(4);
  });

  it("is idempotent: a change already carried by a stored version is not created again", async () => {
    const { db } = await world([...FAMILIES]);
    await releasePreRegistered(db, input);
    const again = await releasePreRegistered(db, input);
    expect(again.created).toEqual([]);
    expect(again.alreadyRegistered).toHaveLength(10);
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind = 'challenger'")).toHaveLength(10);
  });

  it("skips a family without a lineage split and goes on with the others", async () => {
    const { db } = await world(["F1"]);
    const r = await releasePreRegistered(db, { ...input, families: ["F1", "F3"] });
    expect(r.created).toHaveLength(3);
    expect(r.skipped.length).toBe(3);
    expect(r.skipped.every((s) => s.reason === "no_split")).toBe(true);
  });

  it("stops when the lineage trial budget is used up", async () => {
    const { db } = await world(["F1"]);
    const r = await releasePreRegistered(db, {
      ...input,
      families: ["F1"],
      stats: { trialBudgetPerLineage: 2 },
    });
    expect(r.created).toHaveLength(2);
    expect(r.stoppedBy).toBe("budget_exhausted");
  });
});
