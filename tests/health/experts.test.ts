// @vitest-environment node
// D-518 / D-624 (M13-lite WP7): the experts health line. It counts what waits for a person, names the last
// screening and the parked clusters, and turns a degraded stage step or a fired F7 gate in the latest
// `experts` stat into a warning. Read-only; never throws.
import { afterEach, describe, expect, it } from "vitest";
import { expertsHealthOf, loadExpertsHealth, statWarnings } from "@/lib/health/experts";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { addProposal, addScreening, importZzSeed } from "../experts/zzWorld";

afterEach(cleanupTempDbs);

const none = { degraded: [], f7Fires: false };

describe("expertsHealthOf", () => {
  it("reads the three counts as one line", () => {
    const h = expertsHealthOf({
      claimsToCheck: 12,
      lastScreening: "2030-03-01",
      clustersParked: 3,
      stat: none,
    });
    expect(h.text).toBe(
      "Experts: 12 claims to check; last screening 2030-03-01; 3 clusters parked.",
    );
    expect(h.state).toBe("ok");
  });

  it("singulars and an empty world", () => {
    const h = expertsHealthOf({
      claimsToCheck: 1,
      lastScreening: null,
      clustersParked: 1,
      stat: none,
    });
    expect(h.text).toBe("Experts: 1 claim to check; last screening none yet; 1 cluster parked.");
  });

  it("warns on a degraded step and on a fired F7 gate", () => {
    const h = expertsHealthOf({
      claimsToCheck: 0,
      lastScreening: null,
      clustersParked: 0,
      stat: { degraded: ["degraded:screen", "degraded:docs"], f7Fires: true },
    });
    expect(h.state).toBe("attention");
    expect(h.warnings).toEqual([
      "degraded:screen",
      "degraded:docs",
      "F7 gate fired: needs an Owner decision",
    ]);
    expect(h.text).toContain("Attention: degraded:screen; degraded:docs; F7 gate fired");
  });
});

describe("statWarnings", () => {
  it("reads degraded entries and f7.fires, and tolerates any other shape", () => {
    expect(statWarnings({ degraded: ["degraded:f7", "junk", 3], f7: { fires: true } })).toEqual({
      degraded: ["degraded:f7"],
      f7Fires: true,
    });
    expect(statWarnings({ degraded: [], f7: null })).toEqual(none);
    expect(statWarnings(null)).toEqual(none);
    expect(statWarnings("x")).toEqual(none);
    expect(statWarnings({ f7: { fires: "yes" } })).toEqual(none);
  });
});

async function addStat(
  db: Awaited<ReturnType<typeof freshDb>>,
  runId: string,
  d: string,
  value: unknown,
  market = "AU",
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version, files_json, minutes)
          VALUES (?, 'learning', ?, 'a', 'b', 'c', 1, '22', '{}', 0)`,
    args: [runId, market],
  });
  await db.execute({
    sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, 'experts', ?, ?)",
    args: [runId, market, d, JSON.stringify(value)],
  });
}

describe("loadExpertsHealth", () => {
  it("is quiet on a world without expert data", async () => {
    const db = await freshDb("main");
    const h = await loadExpertsHealth(db, "AU");
    expect(h).toMatchObject({
      state: "ok",
      claimsToCheck: 0,
      lastScreening: null,
      clustersParked: 0,
    });
    expect(h.text).toBe("Experts: 0 claims to check; last screening none yet; 0 clusters parked.");
  });

  it("counts claims at extracted, the last screening and the parked clusters on the ZZ seed", async () => {
    const db = await freshDb("main");
    await importZzSeed(db);
    await addScreening(db, { market: "AU", d: "2030-03-01", clusterIds: ["K-ZZ1"] });
    await addScreening(db, { market: "AU", d: "2030-03-08", clusterIds: ["K-ZZ2"] });
    await db.execute({
      sql: "INSERT INTO expert_proposal (id, market, d, cluster_id, kind, family, status, created_at) VALUES ('expprop:AU:2030-03-08:K-ZZ3:nl', 'AU', '2030-03-08', 'K-ZZ3', 'new_lineage', NULL, 'parked_build_change', '2030-03-08T00:00:00.000Z')",
      args: [],
    });
    await addProposal(db, { market: "AU", d: "2030-03-08", clusterId: "K-ZZ1", status: "refused" });
    await db.execute({
      sql: "INSERT INTO cluster_state (cluster_id, seq, state, merged_into, reason, actor, at) VALUES ('K-ZZ4', 2, 'parked', NULL, NULL, 'u1', '2030-03-09T00:00:00.000Z')",
      args: [],
    });
    const h = await loadExpertsHealth(db, "AU");
    expect(h.claimsToCheck).toBe(20); // every seeded claim is still at extracted
    expect(h.lastScreening).toBe("2030-03-08");
    expect(h.clustersParked).toBe(2); // K-ZZ3 awaits a build change, K-ZZ4 was parked by a person
    expect(h.state).toBe("ok");
    await db.execute(
      "INSERT INTO claim_status (claim_id, seq, status, reason, actor, at) VALUES ('C-ZZ-001', 2, 'owner_checked', NULL, 'u1', '2030-03-10T00:00:00.000Z')",
    );
    expect((await loadExpertsHealth(db, "AU")).claimsToCheck).toBe(19);
  });

  it("reads the LATEST experts stat of the market and warns on it", async () => {
    const db = await freshDb("main");
    await addStat(db, "r1", "2030-03-01", { degraded: ["degraded:screen"], f7: { fires: false } });
    expect((await loadExpertsHealth(db, "AU")).warnings).toEqual(["degraded:screen"]);
    await addStat(db, "r2", "2030-03-08", { degraded: [], f7: { fires: true } });
    const h = await loadExpertsHealth(db, "AU");
    expect(h.warnings).toEqual(["F7 gate fired: needs an Owner decision"]);
    expect(h.state).toBe("attention");
    // another market's stat does not leak in
    await addStat(db, "r3", "2030-03-15", { degraded: ["degraded:docs"] }, "US");
    expect((await loadExpertsHealth(db, "AU")).warnings).toEqual([
      "F7 gate fired: needs an Owner decision",
    ]);
  });

  it("says so, and does not throw, when the tables cannot be read", async () => {
    const broken = { execute: () => Promise.reject(new Error("down")) };
    const h = await loadExpertsHealth(broken, "AU");
    expect(h.state).toBe("attention");
    expect(h.text).toBe("Experts: the expert counters could not be read.");
  });
});
