// @vitest-environment node
// The weekly `experts` stage (M13-lite WP5; D-517, D-599): stats shape, failure isolation, stage registration.
import { afterAll, describe, expect, it } from "vitest";
import { expertsStage, skipCounts, SKIP_REASONS } from "@/lib/experts/weeklyStage";
import { LEARNING_STAGES } from "@/lib/learning/weeklyRun";
import type { WeeklyContext } from "@/lib/learning/weeklyStages";
import { cleanupTempDbs } from "../db/helpers";
import { addCluster, screenWorld } from "./zzScreen";
import { cid, rows } from "./zzProposals";

afterAll(cleanupTempDbs);

const asWeekly = (c: object): WeeklyContext => c as unknown as WeeklyContext;
const valueOf = (out: Awaited<ReturnType<typeof expertsStage>>) =>
  out.stats[0]!.value as Record<string, unknown>;

describe("expertsStage", () => {
  it("is registered last, after rankIc", () => {
    expect(LEARNING_STAGES[LEARNING_STAGES.length - 1]).toBe("experts");
    expect(LEARNING_STAGES[LEARNING_STAGES.length - 2]).toBe("rankIc");
  });

  it("nothing eligible is the normal state: no run row, no proposal, no degraded step", async () => {
    const w = await screenWorld();
    const out = await expertsStage(asWeekly(w.ctx));
    expect(out.stats).toHaveLength(1);
    expect(out.stats[0]!.scope).toBe("AU");
    expect(out.stats[0]!.metric).toBe("experts");
    const v = valueOf(out);
    expect(v.degraded).toEqual([]);
    expect(v.screening).toMatchObject({ status: "nothing_eligible", considered: 0, survivors: 0 });
    expect((v.screening as { skipped: Record<string, number> }).skipped).toEqual(SKIP_REASONS);
    expect(Object.keys(SKIP_REASONS)).toHaveLength(7);
    expect(v.proposals).toEqual({});
    expect(v.f7).toMatchObject({ fires: false, l2_clusters: 0, recorded: false });
    expect(await rows(w.db, "SELECT run_id FROM screening_run")).toHaveLength(0);
    expect(await rows(w.db, "SELECT id FROM expert_proposal")).toHaveLength(0);
  });

  it("parks a new-lineage cluster and reports it", async () => {
    const w = await screenWorld();
    await addCluster(w.db, cid(1), { fit: null });
    const v = valueOf(await expertsStage(asWeekly(w.ctx)));
    expect(v.parked).toBe(1);
    expect(await rows(w.db, "SELECT status FROM expert_proposal")).toEqual([
      expect.objectContaining({ status: "parked_build_change" }),
    ]);
  });

  it("a failing step is recorded as degraded and the stage still returns; the other steps run", async () => {
    const w = await screenWorld();
    // eligible cluster, but the context has no ledger or replay: screening throws inside the stage
    await addCluster(w.db, cid(2));
    const out = await expertsStage(asWeekly(w.ctx));
    const v = valueOf(out);
    expect(v.degraded).toEqual(["degraded:screen"]);
    expect(v.screening).toBeNull();
    expect(v.proposals).toBeNull();
    expect(v.f7).toMatchObject({ fires: false });
  });

  it("never throws even when the database is gone", async () => {
    const w = await screenWorld();
    const broken = { ...w.ctx, db: { execute: () => Promise.reject(new Error("down")) } };
    const out = await expertsStage(asWeekly(broken));
    expect(valueOf(out).degraded).toEqual(["degraded:parked", "degraded:screen", "degraded:f7"]);
  });
});

describe("skipCounts", () => {
  const base = {
    runId: "r",
    considered: 0,
    eligible: 0,
    screened: 0,
    survivors: 0,
    ranked: [],
  } as const;
  it("counts every reason, zero-filled", () => {
    const c = skipCounts({
      ...base,
      status: "ran",
      skipped: [
        { clusterId: "K-1", reason: "insufficient_controls" },
        { clusterId: "K-2", reason: "insufficient_controls" },
        { clusterId: "K-3", reason: "no_split" },
      ],
    });
    expect(c).toEqual({ ...SKIP_REASONS, insufficient_controls: 2, no_split: 1 });
  });
  it("does not re-derive skips for a run read back", () => {
    expect(skipCounts({ ...base, status: "exists", skipped: [] })).toBeNull();
  });
});
