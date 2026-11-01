// @vitest-environment node
// screenClusters lanes (D-514, D-515, D-534, D-536a, D-590...D-593) over a real migrated database with an
// injected replay: nothing eligible, skipped lanes, insufficiency, determinism, device view filtering.
import { afterAll, describe, expect, it } from "vitest";
import { FAMILY_PARAM_KEYS } from "@/lib/agents/families/ruleSchema";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { makeExpertDevView } from "@/lib/experts/devView";
import { screenClusters } from "@/lib/experts/screen";
import {
  appendClaimStatus,
  appendClusterState,
  currentClaimStatus,
  insertClaim,
  mergeClaimIntoCluster,
} from "@/lib/experts/store";
import { splitOf } from "@/lib/stats/splits";
import { cleanupTempDbs } from "../db/helpers";
import { addCluster, f1Fit, fakeReplay, NOW, SESSIONS, screenWorld } from "./zzScreen";

afterAll(cleanupTempDbs);

const rowsOf = async (db: Awaited<ReturnType<typeof screenWorld>>["db"], sql: string) =>
  (await db.execute(sql)).rows.map((r) => ({ ...r }));

describe("screenClusters lanes", () => {
  it("writes no run row when nothing is eligible (a later confirmation can still be screened that day)", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001", { claimStatus: "extracted" }); // unchecked
    await addCluster(w.db, "K-002", { claimStatus: "rejected" });
    await addCluster(w.db, "K-003", { fit: null }); // no fit
    await addCluster(w.db, "K-004", { testability: "needs_new_data" });
    const s = await screenClusters(w.ctx, { replay: fakeReplay(w.split, {}).replay });
    expect(s).toMatchObject({ status: "nothing_eligible", considered: 0, screened: 0 });
    expect(await rowsOf(w.db, "SELECT * FROM screening_run")).toHaveLength(0);
  });

  it("a parked or merged cluster is not screened", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001");
    await addCluster(w.db, "K-002");
    await appendClusterState(w.db, { clusterId: "K-001", state: "parked", actor: "u", at: NOW });
    await appendClusterState(w.db, {
      clusterId: "K-002",
      state: "merged",
      mergedInto: "K-001",
      actor: "u",
      at: NOW,
    });
    const s = await screenClusters(w.ctx, { replay: fakeReplay(w.split, {}).replay });
    expect(s.status).toBe("nothing_eligible");
  });

  it("skips an invalid fit and a family without a split, and says why (D-515)", async () => {
    const w = await screenWorld(["F1"]);
    await addCluster(w.db, "K-001", { fit: { family: "F1", params: { f1_trail_atr: 3 } } }); // key set
    const f6 = Object.fromEntries(
      FAMILY_PARAM_KEYS.F6.map((k) => [
        k,
        (CONFIG_KEYS as unknown as Record<string, { default: unknown }>)[k]!.default,
      ]),
    );
    await addCluster(w.db, "K-002", { fit: { family: "F6", params: f6 } }); // valid F6, no F6 lineage here
    await addCluster(w.db, "K-003");
    const fake = fakeReplay(w.split, { "K-003": 0.02 });
    const s = await screenClusters(w.ctx, { replay: fake.replay });
    expect(s.status).toBe("ran");
    expect(s.considered).toBe(3);
    expect(s.eligible).toBe(2); // the invalid fit is considered, not eligible
    expect(s.skipped).toEqual(
      expect.arrayContaining([
        { clusterId: "K-001", reason: "invalid_fit" },
        { clusterId: "K-002", reason: "no_split" }, // F6 weights pass fitCheck (D-590); only the lane is missing
      ]),
    );
    expect(fake.calls).toEqual(["F1.expert:K-003"]);
    // a skipped cluster's claims do not move
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("owner_checked");
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("owner_checked");
  });

  it("a cluster with too few development rows is skipped, gets no result row and its claims stay put", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001");
    const s = await screenClusters(
      {
        ...w.ctx,
        params: { ...w.ctx.params, stats: { ...w.ctx.params.stats, minTrades: 100_000 } },
      },
      { replay: fakeReplay(w.split, { "K-001": 0.02 }).replay },
    );
    expect(s).toMatchObject({
      status: "ran",
      considered: 1,
      eligible: 1,
      screened: 0,
      survivors: 0,
    });
    expect(s.skipped).toEqual([{ clusterId: "K-001", reason: "insufficient_rows" }]);
    expect(await rowsOf(w.db, "SELECT * FROM screening_result")).toHaveLength(0);
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("owner_checked");
  });

  it("is deterministic: two fresh databases give identical p, bounds and ranks", async () => {
    const out: unknown[] = [];
    for (let i = 0; i < 2; i += 1) {
      const w = await screenWorld();
      for (let k = 1; k <= 5; k += 1) await addCluster(w.db, `K-00${k}`);
      await screenClusters(w.ctx, {
        replay: fakeReplay(w.split, { "K-001": 0.02, "K-002": 0.015 }).replay,
      });
      out.push(
        await rowsOf(
          w.db,
          "SELECT cluster_id, params_sha, rows, blocks, mean_net_ppm, mean_excess_ppm, lower90_ppm, p, adjusted_p, rank FROM screening_result ORDER BY cluster_id",
        ),
      );
    }
    expect(out[0]).toEqual(out[1]);
    expect((out[0] as unknown[]).length).toBe(5);
  });

  it("claims already past owner_checked are advanced from where they are; a rejected claim is untouched", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001");
    // a second supporting claim that was rejected
    await insertClaim(w.db, {
      id: "C-extra",
      type: "method",
      testability: "testable_eod",
      clusterId: null,
      statement: "ZZ extra",
      actor: "seed",
      at: NOW,
    });
    await mergeClaimIntoCluster(w.db, { claimId: "C-extra", clusterId: "K-001" });
    await appendClaimStatus(w.db, { claimId: "C-extra", to: "rejected", actor: "u", at: NOW });
    await screenClusters(w.ctx, { replay: fakeReplay(w.split, { "K-001": 0.02 }).replay });
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("screened");
    expect(await currentClaimStatus(w.db, "C-extra")).toBe("rejected");
  });
});

describe("makeExpertDevView", () => {
  it("returns development rows only, indexed inside the development window", async () => {
    const w = await screenWorld();
    const fake = fakeReplay(w.split, { "K-001": 0.02 });
    const view = makeExpertDevView(w.ctx, "F1", w.split, { replay: fake.replay });
    const sample = view.evaluate(f1Fit(1).params, "F1.expert:K-001");
    expect(sample.split).toBe("development");
    expect(sample.rows.length).toBeGreaterThan(0);
    for (const r of sample.rows) expect(splitOf(w.split, r.entryD)).toBe("development");
    const dev = SESSIONS.filter((d) => splitOf(w.split, d) === "development");
    expect(sample.sessionCount).toBe(dev.length);
    expect(Math.max(...sample.rows.map((r) => r.session))).toBeLessThan(dev.length);
    expect(sample.blockSessions).toBe(w.split.block_sessions);
    expect(view.splitVersion).toBe(w.split.version);
  });
});
