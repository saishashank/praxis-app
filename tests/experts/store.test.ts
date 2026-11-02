// @vitest-environment node
// Expert store over a real migrated database: eligibility (LLM-069), claim versions, the cluster merge order
// (D-535), currentClusterState on merged clusters (D-536), bulk confirm in one transaction.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendClaimRevision,
  appendClaimStatus,
  appendClusterState,
  claimById,
  claimsOf,
  clustersWith,
  confirmClaimsTx,
  currentClaimStatus,
  currentClusterState,
  eligibleClusters,
  insertClaim,
  mergeClaimIntoCluster,
  mergeClusterRows,
} from "@/lib/experts/store";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const NOW = "2030-03-05T08:00:00.000Z";
const FIT = JSON.stringify({ family: "F1", params: { f1_trail_atr: 3 } });
let db: Client;

const expert = (id: string) =>
  db.execute({
    sql: "INSERT INTO expert (id, name, status, tier, created_at, updated_at) VALUES (?, ?, 'tracked', 'core', ?, ?)",
    args: [id, `ZZ Expert ${id}`, NOW, NOW],
  });
/** A cluster at `proposed` (seq 1) and, unless `proposed: true`, confirmed by a person (seq 2; D-594). */
const cluster = async (
  id: string,
  over: { fit?: string | null; testability?: string; proposed?: boolean } = {},
) => {
  await db.execute({
    sql: `INSERT INTO cluster (id, name, category, statement, testability, external_grade, family_fit_json, created_at)
          VALUES (?, 'ZZ cluster', 'trend_momentum', 'A statement.', ?, 'none', ?, ?)`,
    args: [id, over.testability ?? "testable_eod", over.fit === undefined ? FIT : over.fit, NOW],
  });
  await appendClusterState(db, { clusterId: id, state: "proposed", actor: "seed", at: NOW });
  if (over.proposed !== true)
    await appendClusterState(db, { clusterId: id, state: "confirmed", actor: "u1", at: NOW });
};
const claim = async (id: string, clusterId: string | null = null, expertId = "X-1") => {
  await insertClaim(db, {
    id,
    type: "method",
    testability: "testable_eod",
    clusterId,
    statement: `ZZ statement ${id}`,
    vocabularyGapText: "ZZ gap",
    actor: "seed",
    at: NOW,
  });
  await db.execute({
    sql: "INSERT INTO claim_expert (claim_id, expert_id) VALUES (?, ?)",
    args: [id, expertId],
  });
  if (clusterId !== null) await mergeClaimIntoCluster(db, { claimId: id, clusterId });
};
const step = (claimId: string, to: Parameters<typeof appendClaimStatus>[1]["to"]) =>
  appendClaimStatus(db, { claimId, to, actor: "u1", at: NOW });

beforeEach(async () => {
  db = await freshDb("main");
  await expert("X-1");
});

describe("claims", () => {
  it("insertClaim writes claim, first revision and extracted; a repeat is a no-op", async () => {
    await claim("C-1");
    expect(
      (
        await insertClaim(db, {
          id: "C-1",
          type: "method",
          testability: "testable_eod",
          clusterId: null,
          statement: "x",
          actor: "seed",
          at: NOW,
        })
      ).inserted,
    ).toBe(false);
    expect(await currentClaimStatus(db, "C-1")).toBe("extracted");
    expect(await currentClaimStatus(db, "C-none")).toBeNull();
  });

  it("an edit is a new version, carrying unchanged fields", async () => {
    await claim("C-1");
    expect(
      await appendClaimRevision(db, {
        claimId: "C-1",
        statement: "ZZ edited",
        actor: "u1",
        at: NOW,
      }),
    ).toBe(2);
    const v = await claimById(db, "C-1");
    expect(v).toMatchObject({
      statement: "ZZ edited",
      vocabularyGapText: "ZZ gap",
      status: "extracted",
    });
    const n = await db.execute("SELECT COUNT(*) AS n FROM claim_revision WHERE claim_id = 'C-1'");
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("refuses an illegal edge as a value and the chain stays put", async () => {
    await claim("C-1");
    expect(await step("C-1", "screened")).toEqual({
      ok: false,
      reason: "illegal_edge",
      from: "extracted",
    });
    expect(await step("C-none", "owner_checked")).toMatchObject({ ok: false, reason: "no_claim" });
    expect(await step("C-1", "owner_checked")).toMatchObject({ ok: true, seq: 2 });
    expect(await currentClaimStatus(db, "C-1")).toBe("owner_checked");
  });

  it("claimsOf returns current text and status for an expert", async () => {
    await claim("C-1");
    await claim("C-2");
    await step("C-2", "owner_checked");
    const rows = await claimsOf(db, "X-1");
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ["C-1", "extracted"],
      ["C-2", "owner_checked"],
    ]);
  });
});

describe("eligibleClusters (LLM-069)", () => {
  it("needs a supporting claim at owner_checked or later", async () => {
    await cluster("K-1");
    await claim("C-1", "K-1");
    expect(await eligibleClusters(db, "AU")).toEqual([]);
    await step("C-1", "owner_checked");
    const e = await eligibleClusters(db, "AU");
    expect(e.map((x) => x.id)).toEqual(["K-1"]);
    expect(e[0]!.familyFit).toEqual({ family: "F1", params: { f1_trail_atr: 3 } });
  });

  it("a rejected or parked claim does not count, a contradicting claim does not count", async () => {
    await cluster("K-1");
    await cluster("K-2");
    await claim("C-1", "K-1");
    await claim("C-2", "K-2");
    await step("C-1", "owner_checked");
    await step("C-1", "parked");
    await step("C-2", "owner_checked");
    expect((await eligibleClusters(db, "AU")).map((x) => x.id)).toEqual(["K-2"]);
    // a claim that only contradicts K-1 does not make it eligible
    await claim("C-3");
    await mergeClaimIntoCluster(db, { claimId: "C-3", clusterId: "K-1", role: "contradicts" });
    await step("C-3", "owner_checked");
    expect((await eligibleClusters(db, "AU")).map((x) => x.id)).toEqual(["K-2"]);
  });

  it("skips clusters without a fit, not testable at end of day, parked or merged", async () => {
    await cluster("K-nofit", { fit: null });
    await cluster("K-intra", { testability: "needs_intraday" });
    await cluster("K-parked");
    await cluster("K-merged");
    await cluster("K-ok");
    for (const k of ["K-nofit", "K-intra", "K-parked", "K-merged", "K-ok"]) {
      await claim(`C-${k}`, k);
      await step(`C-${k}`, "owner_checked");
    }
    await appendClusterState(db, { clusterId: "K-parked", state: "parked", actor: "u1", at: NOW });
    await appendClusterState(db, {
      clusterId: "K-merged",
      state: "merged",
      mergedInto: "K-ok",
      actor: "u1",
      at: NOW,
    });
    expect((await eligibleClusters(db, "AU")).map((x) => x.id)).toEqual(["K-ok"]);
  });

  it("a proposed cluster is not eligible until a person confirms it (KB-075, D-594)", async () => {
    await cluster("K-llm", { proposed: true });
    await claim("C-1", "K-llm");
    await step("C-1", "owner_checked");
    expect(await eligibleClusters(db, "AU")).toEqual([]);
    await appendClusterState(db, { clusterId: "K-llm", state: "confirmed", actor: "u1", at: NOW });
    expect((await eligibleClusters(db, "AU")).map((x) => x.id)).toEqual(["K-llm"]);
    // parking a confirmed cluster takes it out again
    await appendClusterState(db, { clusterId: "K-llm", state: "parked", actor: "u1", at: NOW });
    expect(await eligibleClusters(db, "AU")).toEqual([]);
  });
});

describe("cluster links and merge", () => {
  it("mergeClaimIntoCluster sets the primary cluster only when NULL", async () => {
    await cluster("K-1");
    await cluster("K-2");
    await claim("C-1");
    expect(await mergeClaimIntoCluster(db, { claimId: "C-1", clusterId: "K-1" })).toEqual({
      linked: true,
      primarySet: true,
    });
    expect(await mergeClaimIntoCluster(db, { claimId: "C-1", clusterId: "K-2" })).toEqual({
      linked: true,
      primarySet: false,
    });
    expect(await mergeClaimIntoCluster(db, { claimId: "C-1", clusterId: "K-2" })).toEqual({
      linked: false,
      primarySet: false,
    });
    expect((await claimById(db, "C-1"))!.clusterId).toBe("K-1");
    expect(await clustersWith(db, "C-1")).toEqual([
      { clusterId: "K-1", role: "supports" },
      { clusterId: "K-2", role: "supports" },
    ]);
  });

  it("D-535: mergeClusterRows writes merged first, moves claims, appends links; merged is final", async () => {
    await cluster("K-A");
    await cluster("K-B");
    await claim("C-1", "K-A");
    await claim("C-2", "K-A");
    const r = await mergeClusterRows(db, { from: "K-A", into: "K-B", actor: "u1", at: NOW });
    expect(r.claimsMoved).toBe(2);
    expect((await claimById(db, "C-1"))!.clusterId).toBe("K-B");
    expect((await clustersWith(db, "C-1")).map((x) => x.clusterId)).toEqual(["K-A", "K-B"]);
    await expect(
      appendClusterState(db, { clusterId: "K-A", state: "confirmed", actor: "u1", at: NOW }),
    ).rejects.toThrow(/final/);
  });

  it("currentClusterState treats merged as terminal and resolves merged_into (chains too)", async () => {
    await cluster("K-A", { proposed: true });
    await cluster("K-B");
    await cluster("K-C");
    expect(await currentClusterState(db, "K-A")).toEqual({
      state: "proposed",
      mergedInto: null,
      resolvedId: "K-A",
    });
    await appendClusterState(db, {
      clusterId: "K-A",
      state: "merged",
      mergedInto: "K-B",
      actor: "u1",
      at: NOW,
    });
    await appendClusterState(db, {
      clusterId: "K-B",
      state: "merged",
      mergedInto: "K-C",
      actor: "u1",
      at: NOW,
    });
    expect(await currentClusterState(db, "K-A")).toEqual({
      state: "merged",
      mergedInto: "K-B",
      resolvedId: "K-C",
    });
    expect(await currentClusterState(db, "K-nope")).toBeNull();
  });
});

describe("confirmClaimsTx", () => {
  it("confirms extracted and parked claims, skips the rest, runs the hook in the transaction", async () => {
    await claim("C-1");
    await claim("C-2");
    await claim("C-3");
    await step("C-2", "rejected");
    let hooked = 0;
    const r = await confirmClaimsTx(db, {
      claimIds: ["C-1", "C-2", "C-3", "C-none"],
      actor: "u1",
      at: NOW,
      inTx: async (tx, result) => {
        hooked = result.confirmed.length;
        await tx.execute("SELECT 1");
      },
    });
    expect(r).toEqual({ confirmed: ["C-1", "C-3"], skipped: ["C-2", "C-none"] });
    expect(hooked).toBe(2);
    expect(await currentClaimStatus(db, "C-1")).toBe("owner_checked");
    expect(await currentClaimStatus(db, "C-2")).toBe("rejected");
  });

  it("rolls everything back when the hook throws", async () => {
    await claim("C-1");
    await claim("C-2");
    await expect(
      confirmClaimsTx(db, {
        claimIds: ["C-1", "C-2"],
        actor: "u1",
        at: NOW,
        inTx: async () => {
          throw new Error("audit failed");
        },
      }),
    ).rejects.toThrow("audit failed");
    expect(await currentClaimStatus(db, "C-1")).toBe("extracted");
    expect(await currentClaimStatus(db, "C-2")).toBe("extracted");
  });
});
