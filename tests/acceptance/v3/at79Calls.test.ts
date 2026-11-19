// @vitest-environment node
// AT-79 (calls part, M22 E3; KB-084, D-1435) and the AT-73 no-path clause for the proposal path, on the ZZ world:
// (a) a proposal is not a call: proposing writes proposal rows and nothing the paper tracker reads;
// (b) the Owner's confirmation is the only way a proposed call is tracked, and it is tracked once;
// (c) an incomplete or not-trackable proposal cannot be confirmed (service and database);
// (d) the proposal path and the confirmation write only the three call tables (and the audit row in the other database):
//     every other table of the main database is byte-for-byte as it was, so no path leads from a proposal into ranking,
//     sizing, orders or any rule version (AT-73);
// (e) the paper tracker counts the confirmed call and no proposal.
// Synthetic ZZ data only (SEC-110).
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { settleCalls } from "@/lib/experts/calls";
import { latestProposals, proposePending } from "@/lib/experts/callProposals";
import { confirmCall, type CallCtx } from "@/lib/experts/review";
import { insertClaim } from "@/lib/experts/store";
import { auditRows, KEY } from "../../auth/helpers";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld, type World } from "../../experts/uiWorld";

afterAll(cleanupTempDbs);

const AT = "2026-01-06T00:00:00.000Z";
const CALL_TABLES = new Set(["expert_call", "expert_call_proposal", "expert_call_confirm"]);
let w: World;
let ctx: CallCtx;

beforeEach(async () => {
  process.env.PII_HASH_KEY = KEY;
  w = await zzWorld();
  ctx = {
    mainDb: w.main,
    authDb: w.auth,
    env: process.env,
    actorId: w.owner,
    market: "AU",
    now: new Date(AT),
  };
  await w.main.execute(
    `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
     VALUES ('AU', '2026-01-05', 'ZZU', 'active', 'U1', 1e9, 1e6, 0)`,
  );
  for (const [id, text] of [
    ["C-ZZ-A1", "Buy ZZU on 2030-02-04 for 20 trading days."],
    ["C-ZZ-A2", "ZZU looks weak, a sell."],
    ["C-ZZ-A3", "The index will fall from 2030-02-04 for 5 sessions."],
  ] as const)
    await insertClaim(w.main, {
      id,
      type: "call",
      testability: "testable_eod",
      clusterId: null,
      statement: text,
      actor: "extract",
      at: AT,
    });
});

/** A hash of every table outside `skip`, rows in primary-key order. */
async function hashTables(db: Client, skip: ReadonlySet<string>): Promise<Record<string, string>> {
  const names = (
    await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
  ).rows.map((r) => String(r.name));
  const out: Record<string, string> = {};
  for (const n of names) {
    if (skip.has(n)) continue;
    const rows = await db.execute(`SELECT * FROM "${n}"`);
    out[n] = createHash("sha256")
      .update(JSON.stringify(rows.rows.map((r) => JSON.stringify(Object.values(r))).sort()))
      .digest("hex");
  }
  return out;
}
const n = async (table: string) =>
  Number((await w.main.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n);

describe("AT-79 calls: a proposal is not tracked until confirmed", () => {
  it("(a)+(e) proposing adds proposal rows only; the tracker sees none of them", async () => {
    const calls = await n("expert_call");
    const tracked = (await settleCalls(w.main, "AU", "2030-12-31")).tracked;
    const rep = await proposePending(w.main, {
      market: "AU",
      day: "2026-01-06",
      now: () => new Date(AT),
    });
    expect(rep).toMatchObject({ looked: 3, complete: 1, incomplete: 1, notTrackable: 1 });
    expect(await n("expert_call_proposal")).toBe(3);
    expect(await n("expert_call")).toBe(calls);
    expect(await n("expert_call_confirm")).toBe(0);
    expect((await settleCalls(w.main, "AU", "2030-12-31")).tracked).toBe(tracked);
  });

  it("(b)+(e) the confirmation tracks the call once, and the tracker counts it", async () => {
    await proposePending(w.main, { market: "AU", day: "2026-01-06", now: () => new Date(AT) });
    const p = (await latestProposals(w.main)).get("C-ZZ-A1")!;
    const before = (await settleCalls(w.main, "AU", "2030-12-31")).tracked;
    expect(await confirmCall(ctx, { claimId: "C-ZZ-A1", proposalId: p.proposalId })).toEqual({
      ok: true,
      tracked: true,
    });
    expect((await settleCalls(w.main, "AU", "2030-12-31")).tracked).toBe(before + 1);
    expect(await confirmCall(ctx, { claimId: "C-ZZ-A1", proposalId: p.proposalId })).toEqual({
      error: "illegal_edge",
    });
    expect(await n("expert_call_confirm")).toBe(1);
  });

  it("(c) an incomplete or not-trackable proposal cannot be confirmed", async () => {
    await proposePending(w.main, { market: "AU", day: "2026-01-06", now: () => new Date(AT) });
    const all = await latestProposals(w.main);
    for (const id of ["C-ZZ-A2", "C-ZZ-A3"]) {
      const p = all.get(id)!;
      expect(p.state).not.toBe("complete");
      expect(await confirmCall(ctx, { claimId: id, proposalId: p.proposalId })).toEqual({
        error: "illegal_edge",
      });
    }
    expect(await n("expert_call_confirm")).toBe(0);
    expect((await auditRows(w.auth)).filter((a) => a.action === "expert_call_confirm")).toEqual([]);
  });
});

describe("AT-73 no path: the proposal path changes no table outside the call tables", () => {
  it("(d) proposing and confirming leave every other table byte for byte as it was", async () => {
    const before = await hashTables(w.main, CALL_TABLES);
    await proposePending(w.main, { market: "AU", day: "2026-01-06", now: () => new Date(AT) });
    const p = (await latestProposals(w.main)).get("C-ZZ-A1")!;
    expect(await confirmCall(ctx, { claimId: "C-ZZ-A1", proposalId: p.proposalId })).toMatchObject({
      ok: true,
    });
    const after = await hashTables(w.main, CALL_TABLES);
    expect(after).toEqual(before);
    expect(Object.keys(before).length).toBeGreaterThan(40);
  });

  it("the check is not vacuous: a row in another table does change its hash", async () => {
    const before = await hashTables(w.main, CALL_TABLES);
    await w.main.execute(
      "INSERT INTO claim_status (claim_id, seq, status, reason, actor, at) VALUES ('C-ZZ-A1', 2, 'owner_checked', NULL, 'u:x', '2026-01-06T00:00:00.000Z')",
    );
    const after = await hashTables(w.main, CALL_TABLES);
    expect(Object.keys(after).filter((t) => after[t] !== before[t])).toEqual(["claim_status"]);
  });
});
