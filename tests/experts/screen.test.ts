// @vitest-environment node
// screenClusters lanes (D-514, D-515, D-534, D-536a, D-590...D-593) over a real migrated database with an
// injected replay: nothing eligible, skipped lanes, insufficiency, determinism, device view filtering.
import { afterAll, describe, expect, it } from "vitest";
import { makeExpertDevView } from "@/lib/experts/devView";
import { screenClusters } from "@/lib/experts/screen";
import { clusterStatistic, isInsufficient } from "@/lib/experts/screenStats";
import {
  appendClaimStatus,
  appendClusterState,
  currentClaimStatus,
  insertClaim,
  mergeClaimIntoCluster,
} from "@/lib/experts/store";
import { createLineageSplit, splitOf } from "@/lib/stats/splits";
import { cleanupTempDbs } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { BASE, insertSplit, MARKET } from "../learning/challengerFixtures";
import {
  addCluster,
  defaultFit,
  f1Fit,
  fakeReplay,
  NOW,
  RUN_D,
  SESSIONS,
  screenWorld,
} from "./zzScreen";

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

  it("a proposed cluster is not screened until a person confirms it (KB-075, D-594)", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001", { state: "proposed" }); // checked claim, LLM grouping unconfirmed
    const fake = fakeReplay(w.split, { "K-001": 0.03 });
    expect((await screenClusters(w.ctx, { replay: fake.replay })).status).toBe("nothing_eligible");
    expect(fake.calls).toEqual([]);
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("owner_checked");
    await appendClusterState(w.db, { clusterId: "K-001", state: "confirmed", actor: "u", at: NOW });
    const s = await screenClusters(w.ctx, { replay: fake.replay });
    expect(s).toMatchObject({ status: "ran", considered: 1, screened: 1 });
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("screened");
  });

  it("skips an invalid fit and a family without a split, and says why (D-515)", async () => {
    const w = await screenWorld(["F1"]);
    await addCluster(w.db, "K-001", { fit: { family: "F1", params: { f1_trail_atr: 3 } } }); // key set
    await addCluster(w.db, "K-002", { fit: defaultFit("F6") }); // valid F6, no F6 lineage here
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

  it("skips a family whose split is deferred or whose incumbent is not live, per family lane", async () => {
    const w = await screenWorld(["F1", "F2", "F3"]);
    // F2: a rolled split that is deferred (too little history), the stored newest version
    const deferred = createLineageSplit({
      market: MARKET,
      family: "F2",
      calendar: weekdayCalendar(100),
      maxHoldingUpper: 120,
      primaryRows: [],
      params: BASE.stats,
      version: 2,
      reason: "roll",
    });
    expect(deferred.deferred_until_d).not.toBeNull();
    await insertSplit(w.db, deferred);
    // F3: the seeded incumbent retired, nothing live
    await w.db.execute(
      `INSERT INTO rule_version_status (rule_version_id, seq, status, d, reason)
       SELECT 'F3.v1', MAX(seq) + 1, 'retired', '${RUN_D}', 'ZZ test' FROM rule_version_status WHERE rule_version_id = 'F3.v1'`,
    );
    await addCluster(w.db, "K-001"); // F1: screened
    await addCluster(w.db, "K-002", { fit: defaultFit("F2") });
    await addCluster(w.db, "K-003", { fit: defaultFit("F3") });
    const fake = fakeReplay(w.split, { "K-001": 0.02 });
    const s = await screenClusters(w.ctx, { replay: fake.replay });
    expect(s).toMatchObject({ status: "ran", considered: 3, eligible: 3, screened: 1 });
    expect(s.skipped).toEqual([
      { clusterId: "K-002", reason: "split_deferred" },
      { clusterId: "K-003", reason: "no_incumbent" },
    ]);
    expect(fake.calls).toEqual(["F1.expert:K-001"]);
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("owner_checked");
    expect(await currentClaimStatus(w.db, "C-K-003")).toBe("owner_checked");
    const run = (await w.db.execute("SELECT splits_json FROM screening_run")).rows[0]!;
    expect(JSON.parse(String(run.splits_json))).toEqual({ F1: w.split.version });
  });

  it("a cluster whose rows carry too few matched controls is skipped, never tested on mean net (D-595)", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001");
    await addCluster(w.db, "K-002");
    const fake = fakeReplay(w.split, { "K-001": 0.03, "K-002": 0.03 }, { noControls: ["K-002"] });
    const s = await screenClusters(w.ctx, { replay: fake.replay });
    expect(s).toMatchObject({ status: "ran", considered: 2, eligible: 2, screened: 1 });
    expect(s.skipped).toEqual([{ clusterId: "K-002", reason: "insufficient_controls" }]);
    const rows = await rowsOf(w.db, "SELECT cluster_id, mean_excess_ppm FROM screening_result");
    expect(rows.map((r) => r.cluster_id)).toEqual(["K-001"]);
    expect(rows[0]!.mean_excess_ppm).not.toBeNull();
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("owner_checked");
  });

  it("writes the run, its results and the claim moves in one transaction: a failed write leaves nothing and the day can be rerun", async () => {
    const w = await screenWorld();
    await addCluster(w.db, "K-001");
    await addCluster(w.db, "K-002");
    const fake = fakeReplay(w.split, { "K-001": 0.02 });
    // the second cluster's result row violates CHECK (rows >= 0) after the run row and the first result went in
    await expect(
      screenClusters(w.ctx, {
        replay: fake.replay,
        statistic: (sample, seed, opts) => {
          const st = clusterStatistic(sample, seed, opts);
          return isInsufficient(st) || seed.includes(":K-001:") ? st : { ...st, rows: -1 };
        },
      }),
    ).rejects.toThrow();
    expect(await rowsOf(w.db, "SELECT * FROM screening_run")).toHaveLength(0);
    expect(await rowsOf(w.db, "SELECT * FROM screening_result")).toHaveLength(0);
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("owner_checked");
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("owner_checked");
    const again = await screenClusters(w.ctx, { replay: fake.replay });
    expect(again).toMatchObject({ status: "ran", screened: 2 });
    expect(await currentClaimStatus(w.db, "C-K-001")).toBe("screened");
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
