// @vitest-environment node
// Claims-queue server actions (M13-lite WP6; UXN-295, D-529, D-530, D-633): the eight actions called through
// the same harness as the other action tests (guard, next/cache and the two databases mocked; ZZ world from
// the real importer). A Viewer is refused with no write and no audit row; Owner and Editor succeed with the
// expected state change and one audit row; a bad id is "invalid" with no audit row; a masked Editor cannot
// edit a claim (D-633).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { currentClaimStatus, currentClusterState } from "@/lib/experts/store";
import { auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { zzWorld, type World } from "./uiWorld";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import {
  bulkConfirmExpertAction,
  confirmClaimAction,
  confirmClusterAction,
  editClaimAction,
  mergeClaimAction,
  mergeClusterAction,
  parkClaimAction,
  rejectClaimAction,
} from "@/app/(app)/reviews/experts/queue/actions";

afterAll(cleanupTempDbs);

let w: World;
beforeEach(async () => {
  requireUser.mockReset();
  process.env.PII_HASH_KEY = KEY;
  w = await zzWorld();
  mem.main = w.main;
  mem.auth = w.auth;
});

/** The "review_claims" guard as the real one: Owner and Editor pass, a Viewer is a 403. */
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
const audits = async () =>
  (await auditRows(w.auth)).filter((a) => String(a.action).startsWith("expert_"));
const status = (id: string) => currentClaimStatus(w.main, id);
const revisions = async (id: string) => {
  const r = await w.main.execute({
    sql: "SELECT COUNT(*) AS n FROM claim_revision WHERE claim_id = ?",
    args: [id],
  });
  return Number(r.rows[0]!.n);
};
const clusterOf = async (id: string) => {
  const r = await w.main.execute({ sql: "SELECT cluster_id FROM claim WHERE id = ?", args: [id] });
  return r.rows[0]!.cluster_id;
};

type Case = {
  name: string;
  call: (fd: FormData) => Promise<unknown>;
  valid: Record<string, string>;
  bad: Record<string, string>;
  action: string;
  prep?: () => Promise<void>;
  check: () => Promise<void>;
  untouched: () => Promise<void>;
};

const confirmedCluster = (id: string) => async () => {
  as(w.owner, "owner");
  expect(await confirmClusterAction(form({ cluster: id }))).toMatchObject({ ok: true });
};

const cases = (): Case[] => [
  {
    name: "confirmClaimAction",
    call: confirmClaimAction,
    valid: { claim: "C-ZZ-001" },
    bad: { claim: "../x" },
    action: "expert_claim_confirm",
    check: async () => expect(await status("C-ZZ-001")).toBe("owner_checked"),
    untouched: async () => expect(await status("C-ZZ-001")).toBe("extracted"),
  },
  {
    name: "rejectClaimAction",
    call: rejectClaimAction,
    valid: { claim: "C-ZZ-002", reason: "ZZ no" },
    bad: { claim: "../x" },
    action: "expert_claim_reject",
    check: async () => expect(await status("C-ZZ-002")).toBe("rejected"),
    untouched: async () => expect(await status("C-ZZ-002")).toBe("extracted"),
  },
  {
    name: "parkClaimAction",
    call: parkClaimAction,
    valid: { claim: "C-ZZ-003", reason: "later" },
    bad: { claim: "../x" },
    action: "expert_claim_park",
    check: async () => expect(await status("C-ZZ-003")).toBe("parked"),
    untouched: async () => expect(await status("C-ZZ-003")).toBe("extracted"),
  },
  {
    name: "editClaimAction",
    call: editClaimAction,
    valid: { claim: "C-ZZ-004", statement: "ZZ corrected statement." },
    bad: { claim: "../x", statement: "ZZ" },
    action: "expert_claim_edit",
    check: async () => {
      expect(await status("C-ZZ-004")).toBe("owner_checked");
      expect(await revisions("C-ZZ-004")).toBe(2);
    },
    untouched: async () => expect(await revisions("C-ZZ-004")).toBe(1),
  },
  {
    name: "mergeClaimAction",
    call: mergeClaimAction,
    valid: { claim: "C-ZZ-012", cluster: "K-ZZ3", role: "contradicts" },
    bad: { claim: "../x", cluster: "K-ZZ3" },
    action: "expert_claim_merge",
    prep: confirmedCluster("K-ZZ3"),
    check: async () => expect(String(await clusterOf("C-ZZ-012"))).toBe("K-ZZ3"),
    untouched: async () => expect(await clusterOf("C-ZZ-012")).toBeNull(),
  },
  {
    name: "bulkConfirmExpertAction",
    call: bulkConfirmExpertAction,
    valid: { expert: "X-ZZ1" },
    bad: { expert: "../x" },
    action: "expert_claims_bulk_confirm",
    check: async () => expect(await status("C-ZZ-001")).toBe("owner_checked"),
    untouched: async () => expect(await status("C-ZZ-001")).toBe("extracted"),
  },
  {
    name: "confirmClusterAction",
    call: confirmClusterAction,
    valid: { cluster: "K-ZZ2" },
    bad: { cluster: "../x" },
    action: "expert_cluster_confirm",
    check: async () =>
      expect((await currentClusterState(w.main, "K-ZZ2"))?.state).toBe("confirmed"),
    untouched: async () =>
      expect((await currentClusterState(w.main, "K-ZZ2"))?.state).toBe("proposed"),
  },
  {
    name: "mergeClusterAction",
    call: mergeClusterAction,
    valid: { cluster: "K-ZZ1", into: "K-ZZ2" },
    bad: { cluster: "../x", into: "K-ZZ2" },
    action: "expert_cluster_merge",
    prep: confirmedCluster("K-ZZ2"),
    check: async () => expect((await currentClusterState(w.main, "K-ZZ1"))?.state).toBe("merged"),
    untouched: async () =>
      expect((await currentClusterState(w.main, "K-ZZ1"))?.state).not.toBe("merged"),
  },
];

describe.each(cases().map((c) => c.name))("%s", (name) => {
  const get = () => cases().find((c) => c.name === name)!;

  it("a Viewer is refused (403): no write, no audit row", async () => {
    const c = get();
    await c.prep?.();
    const before = (await audits()).length;
    as(w.viewer, "viewer");
    await expect(c.call(form(c.valid))).rejects.toThrow(/403/);
    expect((await audits()).length).toBe(before);
    await c.untouched();
  });

  it("an Owner succeeds: the state changes and ONE audit row is written", async () => {
    const c = get();
    await c.prep?.();
    const before = (await audits()).length;
    as(w.owner, "owner");
    expect(await c.call(form(c.valid))).toEqual({ ok: true });
    expect((await audits()).slice(before).map((x) => x.action)).toEqual([c.action]);
    await c.check();
  });

  it("an invalid id is `invalid` with no audit row", async () => {
    const c = get();
    await c.prep?.();
    const before = (await audits()).length;
    as(w.owner, "owner");
    expect(await c.call(form(c.bad))).toEqual({ error: "invalid" });
    expect((await audits()).length).toBe(before);
    await c.untouched();
  });
});

describe("Editor and masking", () => {
  it("an Editor can confirm a claim (one audit row)", async () => {
    as(w.editor, "editor");
    expect(await confirmClaimAction(form({ claim: "C-ZZ-001" }))).toEqual({ ok: true });
    expect((await audits()).map((a) => a.action)).toEqual(["expert_claim_confirm"]);
    expect(await status("C-ZZ-001")).toBe("owner_checked");
  });

  it("a masked Editor cannot edit a claim: { error: masked }, no write, no audit (D-633)", async () => {
    as(w.editor, "editor");
    const r = await editClaimAction(form({ claim: "C-ZZ-004", statement: "ZZ edit." }));
    expect(r).toEqual({ error: "masked" });
    expect(await audits()).toEqual([]);
    expect(await revisions("C-ZZ-004")).toBe(1);
    expect(await status("C-ZZ-004")).toBe("extracted");
  });
});
