// @vitest-environment node
// Call confirmation (M22 E3; KB-084, D-1435, D-524, AT-79): a proposal alone never creates `expert_call`; the Owner's
// confirmation does, once, in one transaction with its confirm row; `tracked` follows the active universe; the paper
// tracker reads confirmed calls only; and only the confirm path and the seed importer write `expert_call` (static scan).
// Synthetic ZZ data; the actions run through the same harness as the other queue actions.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { settleCalls } from "@/lib/experts/calls";
import {
  latestProposals,
  proposeForClaim,
  proposePending,
  resolveUniverse,
  storeProposal,
} from "@/lib/experts/callProposals";
import { insertClaim, appendClaimStatus } from "@/lib/experts/store";
import { auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { zzWorld, type World } from "./uiWorld";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { confirmCallAction, typedCallAction } from "@/app/(app)/reviews/experts/queue/actions";

afterAll(cleanupTempDbs);

const AT = "2026-01-06T00:00:00.000Z";
const FULL = "Buy ZZU on 2030-02-04 for 20 trading days at the close.";
let w: World;

beforeEach(async () => {
  requireUser.mockReset();
  process.env.PII_HASH_KEY = KEY;
  w = await zzWorld();
  mem.main = w.main;
  mem.auth = w.auth;
  await w.main.execute({
    sql: `INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted)
          VALUES ('AU', '2026-01-05', 'ZZU', 'active', 'U1', 1e9, 1e6, 0)`,
    args: [],
  });
});

const as = (id: number, role: string) =>
  requireUser.mockImplementation(async (need: string) => {
    if (need === "review_claims" && role === "viewer")
      throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return { id, role, email: `${role}@example.test`, name: null };
  });
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const callClaim = async (id: string, text = FULL, actor = "extract") => {
  await insertClaim(w.main, {
    id,
    type: "call",
    testability: "testable_eod",
    clusterId: null,
    statement: text,
    actor,
    at: AT,
  });
};
const count = async (table: string, claim?: string) => {
  const r = await w.main.execute({
    sql: `SELECT COUNT(*) AS n FROM ${table}${claim ? " WHERE claim_id = ?" : ""}`,
    args: claim ? [claim] : [],
  });
  return Number(r.rows[0]!.n);
};
const callAudits = async () =>
  (await auditRows(w.auth)).filter((a) => a.action === "expert_call_confirm");
/** A stored complete proposal of the claim (what the night's run would have written). */
const proposed = async (id: string, text = FULL) => {
  const u = await resolveUniverse(w.main, "AU", "2026-01-06", [text]);
  const p = await proposeForClaim(id, text, u, []);
  await storeProposal(w.main, p, AT);
  return p;
};

describe("a proposal alone never tracks", () => {
  it("proposing writes proposals only: no expert_call, no confirm, nothing for the tracker", async () => {
    await callClaim("C-ZZ-C1");
    const before = await count("expert_call");
    const rep = await proposePending(w.main, {
      market: "AU",
      day: "2026-01-06",
      now: () => new Date(AT),
    });
    expect(rep.complete).toBe(1);
    expect((await latestProposals(w.main)).get("C-ZZ-C1")?.state).toBe("complete");
    expect(await count("expert_call")).toBe(before);
    expect(await count("expert_call_confirm")).toBe(0);
    const s = await settleCalls(w.main, "AU", "2030-12-31");
    expect(s.tracked).toBe(1); // only the seed call of the ZZ world (AU, tracked), not the proposal
  });

  it("the database refuses a confirmation of an incomplete or untrackable proposal", async () => {
    await callClaim("C-ZZ-C2", "ZZU is weak, a sell.");
    const p = await proposed("C-ZZ-C2", "ZZU is weak, a sell.");
    expect(p.state).toBe("incomplete");
    await expect(
      w.main.execute({
        sql: "INSERT INTO expert_call_confirm (claim_id, proposal_id, price_basis, confirmed_by, confirmed_at) VALUES (?, ?, 'close', 'u:x', ?)",
        args: ["C-ZZ-C2", p.proposalId, AT],
      }),
    ).rejects.toThrow(/complete proposal/);
  });
});

describe("confirmCallAction: one click, once", () => {
  it("writes the confirm row and expert_call in one go, tracked for an active code, with one audit row of ids only", async () => {
    await callClaim("C-ZZ-C1");
    const p = await proposed("C-ZZ-C1");
    as(w.owner, "owner");
    const r = await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId }));
    expect(r).toEqual({ ok: true });
    const row = await w.main.execute(
      "SELECT market, code, direction, call_d, horizon_sessions, tracked FROM expert_call WHERE claim_id = 'C-ZZ-C1'",
    );
    expect(row.rows[0]).toMatchObject({
      market: "AU",
      code: "ZZU",
      direction: "long",
      call_d: "2030-02-04",
      horizon_sessions: 20,
      tracked: 1,
    });
    const conf = await w.main.execute(
      "SELECT proposal_id, price_basis, confirmed_by FROM expert_call_confirm WHERE claim_id = 'C-ZZ-C1'",
    );
    expect(conf.rows).toHaveLength(1);
    expect(conf.rows[0]).toMatchObject({ proposal_id: p.proposalId, price_basis: "close" });
    expect(String(conf.rows[0]!.confirmed_by)).toMatch(/^u:[0-9a-f]{16}$/);
    const a = await callAudits();
    expect(a).toHaveLength(1);
    expect(a[0]!.detail).toEqual({ proposal: p.proposalId, source: "rules" });
    expect(JSON.stringify(a[0])).not.toContain("ZZU");
  });

  it("a second confirmation is refused with no new row and no new audit row", async () => {
    await callClaim("C-ZZ-C1");
    const p = await proposed("C-ZZ-C1");
    as(w.owner, "owner");
    expect(await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId }))).toEqual({
      ok: true,
    });
    expect(await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId }))).toEqual({
      error: "illegal_edge",
    });
    expect(await count("expert_call", "C-ZZ-C1")).toBe(1);
    expect(await count("expert_call_confirm", "C-ZZ-C1")).toBe(1);
    expect(await callAudits()).toHaveLength(1);
  });

  it("a proposal that was not stored yet is recomputed from the claim and confirmed only when it is the one shown", async () => {
    await callClaim("C-ZZ-C1");
    const u = await resolveUniverse(w.main, "AU", "2026-01-06", [FULL]);
    const shown = await proposeForClaim("C-ZZ-C1", FULL, u, []);
    as(w.owner, "owner");
    // A stale id (the summary changed since it was shown) is refused.
    expect(await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: "a".repeat(64) }))).toEqual({
      error: "illegal_edge",
    });
    expect(await count("expert_call", "C-ZZ-C1")).toBe(0);
    expect(await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: shown.proposalId }))).toEqual(
      {
        ok: true,
      },
    );
    expect(await count("expert_call", "C-ZZ-C1")).toBe(1);
    expect((await latestProposals(w.main)).get("C-ZZ-C1")?.proposalId).toBe(shown.proposalId);
  });

  it("a code outside the active universe is stored but not tracked (D-524)", async () => {
    const text = "Buy ZZQ on 2030-02-04 for 20 trading days.";
    await w.main.execute(
      "INSERT INTO universe_snapshot (market, d, code, status, tier, mcap_est, adv, halted) VALUES ('AU', '2026-01-05', 'ZZQ', 'delisted', 'U1', 1e9, 1e6, 0)",
    );
    await callClaim("C-ZZ-C3", text);
    // ZZQ is not active, so the rules cannot find it; the person types it.
    as(w.owner, "owner");
    const r = await typedCallAction(
      form({
        claim: "C-ZZ-C3",
        code: "zzq",
        direction: "long",
        date: "2030-02-04",
        horizon: "20",
        basis: "close",
      }),
    );
    expect(r).toEqual({ ok: true });
    const row = await w.main.execute(
      "SELECT code, tracked FROM expert_call WHERE claim_id = 'C-ZZ-C3'",
    );
    expect(row.rows[0]).toMatchObject({ code: "ZZQ", tracked: 0 });
    const s = await settleCalls(w.main, "AU", "2030-12-31");
    expect(s.tracked).toBe(1); // the seed's tracked call only
  });

  it("refuses: an incomplete proposal, a proposal of another claim, a non-call claim, a rejected claim, a seed call, bad ids", async () => {
    await callClaim("C-ZZ-C1");
    await callClaim("C-ZZ-C2", "ZZU is weak, a sell.");
    await callClaim("C-ZZ-C4");
    const p1 = await proposed("C-ZZ-C1");
    const p2 = await proposed("C-ZZ-C2", "ZZU is weak, a sell.");
    const p4 = await proposed("C-ZZ-C4");
    await appendClaimStatus(w.main, {
      claimId: "C-ZZ-C4",
      to: "rejected",
      actor: "u:x",
      at: AT,
      reason: null,
    });
    as(w.owner, "owner");
    const go = (claim: string, proposal: string) => confirmCallAction(form({ claim, proposal }));
    expect(await go("C-ZZ-C2", p2.proposalId)).toEqual({ error: "illegal_edge" });
    expect(await go("C-ZZ-C2", p1.proposalId)).toEqual({ error: "invalid" });
    expect(await go("C-ZZ-001", p1.proposalId)).toEqual({ error: "invalid" });
    expect(await go("C-ZZ-C4", p4.proposalId)).toEqual({ error: "illegal_edge" });
    expect(await go("C-ZZ-019", p1.proposalId)).toEqual({ error: "illegal_edge" });
    expect(await go("../x", p1.proposalId)).toEqual({ error: "invalid" });
    expect(await go("C-ZZ-C1", "xyz")).toEqual({ error: "invalid" });
    expect(await go("C-NONE", p1.proposalId)).toEqual({ error: "not_found" });
    expect(await count("expert_call_confirm")).toBe(0);
    expect(await callAudits()).toEqual([]);
  });

  it("a Viewer is a 403 with no write, and a masked Editor is refused with no audit (like an edit, D-633)", async () => {
    await callClaim("C-ZZ-C1");
    const p = await proposed("C-ZZ-C1");
    as(w.viewer, "viewer");
    await expect(
      confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId })),
    ).rejects.toThrow(/403/);
    as(w.editor, "editor");
    expect(await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId }))).toEqual({
      error: "masked",
    });
    expect(await count("expert_call", "C-ZZ-C1")).toBe(0);
    expect(await callAudits()).toEqual([]);
  });

  it("settleCalls reads only confirmed calls: the tracked count moves by exactly the confirmation", async () => {
    await callClaim("C-ZZ-C1");
    const p = await proposed("C-ZZ-C1");
    const before = (await settleCalls(w.main, "AU", "2030-12-31")).tracked;
    as(w.owner, "owner");
    await confirmCallAction(form({ claim: "C-ZZ-C1", proposal: p.proposalId }));
    expect((await settleCalls(w.main, "AU", "2030-12-31")).tracked).toBe(before + 1);
  });
});

describe("typedCallAction: the editable form", () => {
  const ok = {
    claim: "C-ZZ-C2",
    code: "ZZU",
    direction: "short",
    date: "2030-02-04",
    horizon: "15",
    basis: "open",
    target: "8.25",
    stop: "",
  };

  it("an incomplete claim becomes a call from the typed values, stored as an owner proposal, audited once", async () => {
    await callClaim("C-ZZ-C2", "ZZU is weak, a sell.");
    as(w.owner, "owner");
    expect(await typedCallAction(form(ok))).toEqual({ ok: true });
    const row = await w.main.execute("SELECT * FROM expert_call WHERE claim_id = 'C-ZZ-C2'");
    expect(row.rows[0]).toMatchObject({
      code: "ZZU",
      direction: "short",
      call_d: "2030-02-04",
      horizon_sessions: 15,
      target_micro: 8_250_000,
      stop_micro: null,
      tracked: 1,
    });
    const prop = (await latestProposals(w.main)).get("C-ZZ-C2");
    expect(prop).toMatchObject({ source: "owner", state: "complete" });
    expect(
      (
        await w.main.execute(
          "SELECT price_basis FROM expert_call_confirm WHERE claim_id = 'C-ZZ-C2'",
        )
      ).rows[0]!.price_basis,
    ).toBe("open");
    expect(await callAudits()).toHaveLength(1);
    expect(await typedCallAction(form(ok))).toEqual({ error: "illegal_edge" });
    expect(await count("expert_call", "C-ZZ-C2")).toBe(1);
  });

  it("refuses bad values with no audit row and no write", async () => {
    await callClaim("C-ZZ-C2", "ZZU is weak, a sell.");
    as(w.owner, "owner");
    for (const bad of [
      { code: "" },
      { code: "ZZ U" },
      { code: "ZZU;DROP" },
      { direction: "up" },
      { date: "2030-02-30" },
      { date: "04/02/2030" },
      { horizon: "0" },
      { horizon: "1001" },
      { horizon: "2.5" },
      { basis: "mid" },
      { target: "-1" },
      { stop: "abc" },
    ]) {
      expect(await typedCallAction(form({ ...ok, ...bad })), JSON.stringify(bad)).toEqual({
        error: "invalid",
      });
    }
    expect(await count("expert_call", "C-ZZ-C2")).toBe(0);
    expect(await count("expert_call_proposal", "C-ZZ-C2")).toBe(0);
    expect(await callAudits()).toEqual([]);
  });

  it("a masked Editor cannot type a call (no audit, no write)", async () => {
    await callClaim("C-ZZ-C2", "ZZU is weak, a sell.");
    as(w.editor, "editor");
    expect(await typedCallAction(form(ok))).toEqual({ error: "masked" });
    expect(await count("expert_call", "C-ZZ-C2")).toBe(0);
    expect(await callAudits()).toEqual([]);
  });
});

describe("only the confirmation and the importer write expert_call (static)", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".next") walk(full, out);
      } else if (/\.(ts|tsx|mjs|js|sql|yml)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const strip = (t: string) =>
    t
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*|--|#)/.test(l))
      .join("\n");
  // A write to the table `expert_call` itself (not `expert_call_confirm`, `_proposal` or `_outcome`).
  const WRITE = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO)\s+expert_call(?![A-Za-z0-9_])/gi;
  // The importer names the table as a tag of its statement list instead of writing the SQL itself.
  const IMPORTER_TAG = /["']expert_call["']\s*,\s*["']calls["']/;

  it("finds the confirmation in review.ts and nothing else under src, worker and the scripts", () => {
    const files = [
      ...walk(path.join(ROOT, "src")),
      ...walk(path.join(ROOT, "worker/src")),
      ...walk(path.join(ROOT, "scripts")),
    ];
    const writers = files
      .filter((f) => {
        const t = strip(fs.readFileSync(f, "utf8"));
        WRITE.lastIndex = 0;
        return WRITE.test(t) || IMPORTER_TAG.test(t);
      })
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .sort();
    expect(writers).toEqual(["scripts/experts/import.mjs", "src/lib/experts/review.ts"]);
  });

  it("the scan catches a writer (self-test)", () => {
    WRITE.lastIndex = 0;
    expect(WRITE.test("INSERT INTO expert_call (a) VALUES (1)")).toBe(true);
    WRITE.lastIndex = 0;
    expect(WRITE.test("INSERT INTO expert_call_confirm (a) VALUES (1)")).toBe(false);
    WRITE.lastIndex = 0;
    expect(WRITE.test("insert or ignore into expert_call(a) values (1)")).toBe(true);
  });
});
