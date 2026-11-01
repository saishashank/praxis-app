// @vitest-environment node
// Expert review service (M13-lite WP6; UXN-295, KB-073, KB-075, LLM-069, D-529, D-530, D-535, D-594): roles,
// one audit row per action, illegal edges refused as values, edits as versions, bulk confirm in one
// transaction, cluster confirm formalises checked claims, cluster merge keeps the D-535 order.
import type { Client, Transaction } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  actorOf,
  bulkConfirmExpert,
  confirmClaim,
  confirmCluster,
  editClaim,
  mergeClaimToCluster,
  mergeCluster,
  parkClaim,
  rejectClaim,
  type ReviewCtx,
} from "@/lib/experts/review";
import {
  appendClaimStatus,
  claimById,
  currentClaimStatus,
  currentClusterState,
  eligibleClusters,
} from "@/lib/experts/store";
import { auditRows, ENV } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { f1Fit } from "./zzScreen";
import { zzWorld, type World } from "./uiWorld";

afterAll(cleanupTempDbs);

let w: World;
beforeEach(async () => {
  w = await zzWorld();
});

const ctx = (who: number, over: Partial<ReviewCtx> = {}): ReviewCtx => ({
  mainDb: w.main,
  authDb: w.auth,
  env: ENV,
  actorId: who,
  now: new Date("2030-03-05T08:00:00.000Z"),
  ...over,
});
const audits = async (prefix = "expert_") =>
  (await auditRows(w.auth)).filter((a) => String(a.action).startsWith(prefix));
const statusOf = (id: string) => currentClaimStatus(w.main, id);
const AT = "2030-03-05T00:00:00.000Z";

async function validCluster(id: string, supporters: string[]): Promise<void> {
  await w.main.execute({
    sql: `INSERT INTO cluster (id, name, category, statement, testability, external_grade, family_fit_json, created_at)
          VALUES (?, 'ZZ fit cluster', 'trend_momentum', 'ZZ fit statement.', 'testable_eod', 'none', ?, ?)`,
    args: [id, JSON.stringify(f1Fit(3)), "2030-03-01T00:00:00.000Z"],
  });
  await w.main.execute({
    sql: "INSERT INTO cluster_state (cluster_id, seq, state, actor, at) VALUES (?, 1, 'proposed', 'seed', ?)",
    args: [id, "2030-03-01T00:00:00.000Z"],
  });
  for (const s of supporters)
    await w.main.execute({
      sql: "INSERT INTO claim_cluster (claim_id, cluster_id, role) VALUES (?, ?, 'supports')",
      args: [s, id],
    });
}

const countByStatus = async (expert: string, status: string): Promise<number> => {
  const r = await w.main.execute({
    sql: `SELECT COUNT(*) AS n FROM claim_expert ce JOIN claim_status st ON st.claim_id = ce.claim_id
           AND st.seq = (SELECT MAX(seq) FROM claim_status WHERE claim_id = ce.claim_id)
          WHERE ce.expert_id = ? AND st.status = ?`,
    args: [expert, status],
  });
  return Number(r.rows[0]!.n);
};

describe("roles", () => {
  it("a Viewer cannot act: forbidden, nothing written, nothing audited", async () => {
    const r = await confirmClaim(ctx(w.viewer), "C-ZZ-001");
    expect(r).toEqual({ error: "forbidden" });
    expect(await statusOf("C-ZZ-001")).toBe("extracted");
    expect(await audits()).toEqual([]);
  });
  it("an unknown user and a revoked Editor are refused", async () => {
    expect(await confirmClaim(ctx(9999), "C-ZZ-001")).toEqual({ error: "forbidden" });
    await w.auth.execute({
      sql: "UPDATE app_user SET status='revoked' WHERE id=?",
      args: [w.editor],
    });
    expect(await confirmClaim(ctx(w.editor), "C-ZZ-001")).toEqual({ error: "forbidden" });
  });
  it("Owner and Editor can confirm", async () => {
    expect(await confirmClaim(ctx(w.editor), "C-ZZ-001")).toMatchObject({ ok: true });
    expect(await confirmClaim(ctx(w.owner), "C-ZZ-002")).toMatchObject({ ok: true });
    expect(await statusOf("C-ZZ-001")).toBe("owner_checked");
    expect(await statusOf("C-ZZ-002")).toBe("owner_checked");
  });
});

describe("claim actions", () => {
  it("confirm writes exactly one audit row, with ids only and a hashed actor", async () => {
    await confirmClaim(ctx(w.editor), "C-ZZ-001");
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      action: "expert_claim_confirm",
      target_type: "expert_claim",
      target_id: "C-ZZ-001",
      actor_user_id: w.editor,
    });
    expect(JSON.stringify(a[0]!.detail)).not.toContain("ZZ synthetic claim");
    const st = await w.main.execute(
      "SELECT actor FROM claim_status WHERE claim_id='C-ZZ-001' ORDER BY seq DESC LIMIT 1",
    );
    const actor = String(st.rows[0]!.actor);
    expect(actor).toBe(actorOf(ENV, w.editor));
    expect(actor).toMatch(/^u:[0-9a-f]{16}$/);
  });

  it("an illegal edge is a value: no audit row, no write", async () => {
    await confirmClaim(ctx(w.owner), "C-ZZ-001");
    const before = (await audits()).length;
    expect(await confirmClaim(ctx(w.owner), "C-ZZ-001")).toEqual({ error: "illegal_edge" });
    await rejectClaim(ctx(w.owner), "C-ZZ-002");
    expect(await confirmClaim(ctx(w.owner), "C-ZZ-002")).toEqual({ error: "illegal_edge" });
    expect(await parkClaim(ctx(w.owner), "C-ZZ-002")).toEqual({ error: "illegal_edge" });
    expect((await audits()).length).toBe(before + 1); // only the reject
    expect(await statusOf("C-ZZ-002")).toBe("rejected");
  });

  it("rejects bad ids, missing claims and over-long reasons without a write", async () => {
    expect(await confirmClaim(ctx(w.owner), "../x")).toEqual({ error: "invalid" });
    expect(await confirmClaim(ctx(w.owner), 7)).toEqual({ error: "invalid" });
    expect(await confirmClaim(ctx(w.owner), "C-NOPE")).toEqual({ error: "not_found" });
    expect(await rejectClaim(ctx(w.owner), "C-ZZ-001", "x".repeat(301))).toEqual({
      error: "invalid",
    });
    expect(await audits()).toEqual([]);
  });

  it("park keeps the reason and a parked claim can be reopened by confirm", async () => {
    await parkClaim(ctx(w.owner), "C-ZZ-003", " not now ");
    const st = await w.main.execute(
      "SELECT status, reason FROM claim_status WHERE claim_id='C-ZZ-003' ORDER BY seq DESC LIMIT 1",
    );
    expect(st.rows[0]).toMatchObject({ status: "parked", reason: "not now" });
    expect(await confirmClaim(ctx(w.owner), "C-ZZ-003")).toMatchObject({ ok: true });
    expect(await statusOf("C-ZZ-003")).toBe("owner_checked");
  });

  it("edit saves a NEW claim_revision and marks the claim checked; the old text stays", async () => {
    const before = await claimById(w.main, "C-ZZ-004");
    const r = await editClaim(ctx(w.editor), {
      claimId: "C-ZZ-004",
      statement: "  ZZ corrected statement.  ",
      formalisationText: "ZZ corrected draft rule.",
    });
    expect(r).toMatchObject({ ok: true, revision: 2, status: "owner_checked" });
    const after = await claimById(w.main, "C-ZZ-004");
    expect(after?.statement).toBe("ZZ corrected statement.");
    expect(after?.formalisationText).toBe("ZZ corrected draft rule.");
    expect(after?.status).toBe("owner_checked");
    const revs = await w.main.execute(
      "SELECT seq, statement FROM claim_revision WHERE claim_id='C-ZZ-004' ORDER BY seq",
    );
    expect(revs.rows.map((x) => String(x.statement))).toEqual([
      before!.statement,
      "ZZ corrected statement.",
    ]);
    expect((await audits()).map((a) => a.action)).toEqual(["expert_claim_edit"]);
    // editing again while checked adds a version and keeps the status
    expect(
      await editClaim(ctx(w.owner), { claimId: "C-ZZ-004", statement: "ZZ third." }),
    ).toMatchObject({ ok: true, revision: 3 });
  });

  it("edit refuses empty and over-long text, and a claim that is already formalised", async () => {
    expect(await editClaim(ctx(w.owner), { claimId: "C-ZZ-004", statement: "  " })).toEqual({
      error: "invalid",
    });
    expect(
      await editClaim(ctx(w.owner), { claimId: "C-ZZ-004", statement: "x".repeat(601) }),
    ).toEqual({ error: "invalid" });
    expect(
      await editClaim(ctx(w.owner), {
        claimId: "C-ZZ-004",
        statement: "ok",
        formalisationText: "y".repeat(1201),
      }),
    ).toEqual({ error: "invalid" });
    await appendClaimStatus(w.main, {
      claimId: "C-ZZ-005",
      to: "owner_checked",
      actor: "t",
      at: AT,
    });
    await appendClaimStatus(w.main, { claimId: "C-ZZ-005", to: "formalised", actor: "t", at: AT });
    expect(await editClaim(ctx(w.owner), { claimId: "C-ZZ-005", statement: "ZZ late." })).toEqual({
      error: "illegal_edge",
    });
    expect(await audits()).toEqual([]);
  });

  it("a failed main write leaves the audit row and a _failed row (no change without a trail)", async () => {
    const broken = new Proxy(w.main, {
      get(t, p, r) {
        if (p === "execute")
          return (s: { sql?: string } | string) => {
            const sql = typeof s === "string" ? s : (s.sql ?? "");
            if (sql.startsWith("INSERT INTO claim_status")) throw new Error("disk full");
            return t.execute(s as never);
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    const r = await confirmClaim(ctx(w.owner, { mainDb: broken }), "C-ZZ-006");
    expect(r).toEqual({ error: "unavailable" });
    expect((await audits()).map((a) => a.action)).toEqual([
      "expert_claim_confirm",
      "expert_claim_confirm_failed",
    ]);
    expect(await statusOf("C-ZZ-006")).toBe("extracted");
  });
});

describe("clusters", () => {
  it("confirm moves the cluster to confirmed and formalises owner_checked supporters with a valid fit", async () => {
    await validCluster("K-ZZ9", ["C-ZZ-001", "C-ZZ-002", "C-ZZ-003"]);
    await confirmClaim(ctx(w.owner), "C-ZZ-001");
    await confirmClaim(ctx(w.owner), "C-ZZ-002");
    await rejectClaim(ctx(w.owner), "C-ZZ-003");
    const r = await confirmCluster(ctx(w.editor), "K-ZZ9");
    expect(r).toEqual({ ok: true, formalised: 2 });
    expect((await currentClusterState(w.main, "K-ZZ9"))?.state).toBe("confirmed");
    expect(await statusOf("C-ZZ-001")).toBe("formalised");
    expect(await statusOf("C-ZZ-002")).toBe("formalised");
    expect(await statusOf("C-ZZ-003")).toBe("rejected");
    expect((await eligibleClusters(w.main, "AU")).map((c) => c.id)).toContain("K-ZZ9");
    const a = await audits("expert_cluster");
    expect(a.map((x) => x.action)).toEqual(["expert_cluster_confirm"]);
  });

  it("a cluster is not eligible for screening before it is confirmed, however many claims are checked (D-594)", async () => {
    await validCluster("K-ZZ9", ["C-ZZ-001"]);
    await confirmClaim(ctx(w.owner), "C-ZZ-001");
    expect((await eligibleClusters(w.main, "AU")).map((c) => c.id)).not.toContain("K-ZZ9");
  });

  it("confirming without a valid fit formalises nothing; confirming twice is an illegal edge", async () => {
    await confirmClaim(ctx(w.owner), "C-ZZ-005");
    // K-ZZ2 has no family_fit in the ZZ seed
    const r = await confirmCluster(ctx(w.owner), "K-ZZ2");
    expect(r).toEqual({ ok: true, formalised: 0 });
    expect(await statusOf("C-ZZ-005")).toBe("owner_checked");
    expect(await confirmCluster(ctx(w.owner), "K-ZZ2")).toEqual({ error: "illegal_edge" });
    expect(await confirmCluster(ctx(w.owner), "K-NOPE")).toEqual({ error: "not_found" });
  });

  it("claim to cluster needs a confirmed cluster; the primary cluster is set only when empty", async () => {
    expect(
      await mergeClaimToCluster(ctx(w.owner), { claimId: "C-ZZ-014", clusterId: "K-ZZ3" }),
    ).toEqual({ error: "not_confirmed" });
    await confirmCluster(ctx(w.owner), "K-ZZ3");
    const own = await claimById(w.main, "C-ZZ-012"); // contradicts K-ZZ1 in the seed; cluster_id null
    expect(own?.clusterId).toBeNull();
    const r = await mergeClaimToCluster(ctx(w.owner), {
      claimId: "C-ZZ-012",
      clusterId: "K-ZZ3",
      role: "contradicts",
    });
    expect(r).toEqual({ ok: true, linked: true, primarySet: true });
    // a claim that already has a primary cluster gets the link and keeps its primary
    const again = await mergeClaimToCluster(ctx(w.owner), {
      claimId: "C-ZZ-001",
      clusterId: "K-ZZ3",
    });
    expect(again).toEqual({ ok: true, linked: true, primarySet: false });
    expect((await claimById(w.main, "C-ZZ-001"))?.clusterId).toBe("K-ZZ1");
    expect(
      await mergeClaimToCluster(ctx(w.owner), {
        claimId: "C-ZZ-001",
        clusterId: "K-ZZ3",
        role: "x",
      }),
    ).toEqual({ error: "invalid" });
  });

  it("merge follows D-535: merged state first, claims move, claim_cluster rows appended; merged is final", async () => {
    await confirmCluster(ctx(w.owner), "K-ZZ2");
    const r = await mergeCluster(ctx(w.editor), { from: "K-ZZ1", into: "K-ZZ2" });
    expect(r).toMatchObject({ ok: true });
    expect((r as { claimsMoved: number }).claimsMoved).toBeGreaterThan(0);
    const st = await currentClusterState(w.main, "K-ZZ1");
    expect(st).toMatchObject({ state: "merged", mergedInto: "K-ZZ2", resolvedId: "K-ZZ2" });
    expect((await claimById(w.main, "C-ZZ-001"))?.clusterId).toBe("K-ZZ2");
    const links = await w.main.execute(
      "SELECT cluster_id FROM claim_cluster WHERE claim_id='C-ZZ-001' ORDER BY cluster_id",
    );
    expect(links.rows.map((x) => String(x.cluster_id))).toEqual(["K-ZZ1", "K-ZZ2"]);
    expect(await mergeCluster(ctx(w.owner), { from: "K-ZZ1", into: "K-ZZ2" })).toEqual({
      error: "final",
    });
    expect(await confirmCluster(ctx(w.owner), "K-ZZ1")).toEqual({ error: "final" });
    expect(await mergeCluster(ctx(w.owner), { from: "K-ZZ2", into: "K-ZZ2" })).toEqual({
      error: "invalid",
    });
    expect((await audits("expert_cluster")).map((a) => a.action)).toEqual([
      "expert_cluster_confirm",
      "expert_cluster_merge",
    ]);
  });
});

describe("bulk confirm", () => {
  it("confirms every extracted claim of an expert in ONE transaction with one audit row", async () => {
    let transactions = 0;
    const spy = new Proxy(w.main, {
      get(t, p, r) {
        if (p === "transaction")
          return (...a: unknown[]) => {
            transactions += 1;
            return (t.transaction as (...x: unknown[]) => unknown)(...a);
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    await rejectClaim(ctx(w.owner), "C-ZZ-001"); // X-ZZ1's first claim is rejected: left alone
    const expected = await countByStatus("X-ZZ1", "extracted");
    expect(expected).toBeGreaterThan(1);
    const r = await bulkConfirmExpert(ctx(w.editor, { mainDb: spy }), "X-ZZ1");
    expect(r).toEqual({ ok: true, confirmed: expected, skipped: 0 });
    expect(transactions).toBe(1);
    expect(await statusOf("C-ZZ-001")).toBe("rejected");
    expect(await countByStatus("X-ZZ1", "owner_checked")).toBe(expected);
    expect((await audits("expert_claims")).map((a) => a.action)).toEqual([
      "expert_claims_bulk_confirm",
    ]);
  });

  it("rolls the whole batch back when one write fails", async () => {
    const broken = new Proxy(w.main, {
      get(t, p, r) {
        if (p === "transaction")
          return async (...a: unknown[]) => {
            const tx = await (
              t.transaction as unknown as (...x: unknown[]) => Promise<Transaction>
            )(...a);
            const exec = (tx.execute as unknown as (s: unknown) => Promise<unknown>).bind(tx);
            let writes = 0;
            return new Proxy(tx, {
              get(tt, pp, rr) {
                if (pp === "execute")
                  return (s: { sql?: string }) => {
                    if (typeof s === "object" && s.sql?.startsWith("INSERT INTO claim_status")) {
                      writes += 1;
                      if (writes === 2) throw new Error("boom");
                    }
                    return exec(s);
                  };
                const v = Reflect.get(tt, pp, rr);
                return typeof v === "function" ? v.bind(tt) : v;
              },
            });
          };
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as Client;
    const r = await bulkConfirmExpert(ctx(w.owner, { mainDb: broken }), "X-ZZ1");
    expect(r).toEqual({ error: "unavailable" });
    expect(await countByStatus("X-ZZ1", "owner_checked")).toBe(0);
    expect((await audits("expert_claims")).map((a) => a.action)).toEqual([
      "expert_claims_bulk_confirm",
      "expert_claims_bulk_confirm_failed",
    ]);
  });

  it("an unknown expert and a Viewer are refused; nothing to do is not an error", async () => {
    expect(await bulkConfirmExpert(ctx(w.owner), "X-NOPE")).toEqual({ error: "not_found" });
    expect(await bulkConfirmExpert(ctx(w.viewer), "X-ZZ1")).toEqual({ error: "forbidden" });
    await bulkConfirmExpert(ctx(w.owner), "X-ZZ1");
    expect(await bulkConfirmExpert(ctx(w.owner), "X-ZZ1")).toEqual({
      ok: true,
      confirmed: 0,
      skipped: 0,
    });
  });
});
