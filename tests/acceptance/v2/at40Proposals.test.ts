// @vitest-environment node
// AT-40 (e)(f), proposals part (M13-lite WP5):
//  (e) survivors are proposed through createChallenger, at most expert_challengers_per_week created per week,
//      every result stored as an expert_proposal row, the trial ledger grows by exactly the created rows, a
//      refused survivor is retried the next week as a new row;
//  (f) the F7 gate is dormant below f7_min_clusters L2 clusters and writes one dormant row at the minimum.
import { afterAll, describe, expect, it } from "vitest";
import { evaluateF7 } from "@/lib/experts/f7";
import { proposeChallengers } from "@/lib/experts/proposals";
import { transitionChallenger } from "@/lib/learning/challengerLifecycle";
import { cleanupTempDbs } from "../../db/helpers";
import {
  addDays,
  expert,
  linkExpert,
  paramsWith,
  plantedWorld,
  RUN_D,
  rows,
} from "../../experts/zzProposals";

afterAll(cleanupTempDbs);

const trials = async (db: Parameters<typeof rows>[0]): Promise<number> =>
  Number(
    (await rows(db, "SELECT COUNT(*) AS n FROM trial_ledger WHERE kind = 'challenger'"))[0]!.n,
  );

describe("AT-40 (e) proposals", () => {
  it("proposes at most the weekly cap, stores every result, retries refused next week", async () => {
    const w = await plantedWorld(5);
    const tight = paramsWith({ maxChallengers: 1 });
    const run = await w.screen(RUN_D, tight);
    expect(run.survivors).toBeGreaterThanOrEqual(3);
    const t0 = await trials(w.db);
    const out = await proposeChallengers(w.ctxAt(RUN_D, tight), run);
    // one slot: the best survivor is created, the others are refused and stored (KB-042)
    expect(out[0]!.status).toBe("created");
    expect(out.slice(1).every((o) => o.status === "refused")).toBe(true);
    const wk1 = await rows(w.db, "SELECT status FROM expert_proposal WHERE d = ?", [RUN_D]);
    expect(wk1).toHaveLength(out.length); // every result stored
    expect((await trials(w.db)) - t0).toBe(1);
    expect(wk1.filter((r) => String(r.status) === "created").length).toBeLessThanOrEqual(
      tight.learning.expertChallengersPerWeek,
    );

    // next week the slots allow it: refused survivors are retried as NEW rows, up to the cap
    const d2 = addDays(RUN_D, 7);
    const run2 = await w.screen(d2);
    const out2 = await proposeChallengers(w.ctxAt(d2), run2);
    const cap = paramsWith().learning.expertChallengersPerWeek;
    expect(out2.filter((o) => o.status === "created")).toHaveLength(cap);
    expect(out2.every((o) => o.proposalId!.includes(d2))).toBe(true);
    expect((await trials(w.db)) - t0).toBe(1 + cap);
    expect(
      await rows(w.db, "SELECT id FROM expert_proposal WHERE d = ? AND status = 'refused'", [
        RUN_D,
      ]),
    ).toHaveLength(out.length - 1);
  });
});

describe("AT-40 (f) F7 gate", () => {
  it("is dormant with fewer than f7_min_clusters L2 clusters and records one dormant row at the minimum", async () => {
    const w = await plantedWorld(4);
    const p = paramsWith({
      expertChallengersPerWeek: 4,
      maxChallengers: 8,
    });
    const min = p.learning.f7MinClusters;
    expect(min).toBe(3);
    const run = await w.screen(RUN_D, p);
    const out = await proposeChallengers(w.ctxAt(RUN_D, p), run);
    const made = out.filter((o) => o.status === "created");
    expect(made.length).toBeGreaterThanOrEqual(3);
    for (const [i, o] of made.entries()) {
      await expert(w.db, `X-${i + 1}`);
      await linkExpert(w.db, `C-${o.clusterId}`, `X-${i + 1}`);
    }
    const pass = async (clusterId: string): Promise<void> => {
      const id = String(
        (
          await rows(w.db, "SELECT challenger_id FROM expert_proposal WHERE cluster_id = ?", [
            clusterId,
          ])
        )[0]!.challenger_id,
      );
      for (const to of ["replay", "shakedown"] as const) {
        await transitionChallenger(
          w.db,
          { id, to, d: RUN_D, actor: "A6", reason: "ZZ test edge" },
          p.learning,
        );
      }
    };
    const f7 = (): Promise<Awaited<ReturnType<typeof evaluateF7>>> =>
      evaluateF7(w.db, { market: "AU", d: RUN_D, min });
    const f7Rows = () =>
      rows(w.db, "SELECT status, cluster_id FROM expert_proposal WHERE kind = 'f7_lineage'");

    // survivors with challengers but no passed VAL-110: nothing is L2
    expect(await f7()).toMatchObject({ fires: false, l2Clusters: 0, recorded: false });
    await pass(made[0]!.clusterId);
    await pass(made[1]!.clusterId);
    expect(await f7()).toMatchObject({ fires: false, l2Clusters: 2, clusters: 2, recorded: false });
    expect(await f7Rows()).toHaveLength(0);

    await pass(made[2]!.clusterId);
    const fired = await f7();
    expect(fired).toMatchObject({ fires: true, l2Clusters: 3, distinctExperts: 3, recorded: true });
    const r = await f7Rows();
    expect(r).toHaveLength(1);
    expect(String(r[0]!.status)).toBe("dormant");
    expect(r[0]!.cluster_id).toBeNull();
    expect(
      await rows(w.db, "SELECT id FROM expert_proposal WHERE id = ?", [`expprop:AU:${RUN_D}:f7`]),
    ).toHaveLength(1);
    // a second evaluation writes nothing more
    expect(await f7()).toMatchObject({ fires: true, recorded: false });
    expect(await f7Rows()).toHaveLength(1);
  });
});
