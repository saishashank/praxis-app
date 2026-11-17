// @vitest-environment node
// The Owner's accept-the-risk action (M22 E1; KB-083, D-1430): the action called through the same harness as the
// claims-queue actions. Only the Owner can accept; an Editor and a Viewer are refused with no row and no audit
// row; the audit row is written before the licence row; robots disallowances cannot be accepted.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendLicence, latestLicence, type LicenceRow } from "@/lib/experts/licence/store";
import { auditRows, KEY } from "../../auth/helpers";
import { cleanupTempDbs } from "../../db/helpers";
import { zzWorld, type World } from "../uiWorld";

const requireUser = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { acceptRiskAction } from "@/app/(app)/reviews/experts/[id]/actions";
import { can, type Role } from "@/lib/auth/permissions";

afterAll(cleanupTempDbs);

let w: World;
beforeEach(async () => {
  requireUser.mockReset();
  process.env.PII_HASH_KEY = KEY;
  w = await zzWorld();
  mem.main = w.main;
  mem.auth = w.auth;
});

/** The "admin" guard as the real one: Owner passes, anyone else is a 403. */
const as = (id: number, role: string) =>
  requireUser.mockImplementation(async (need: string) => {
    if (!can(role as Role, need)) throw new Error("NEXT_HTTP_ERROR_FALLBACK;403");
    return { id, role, email: `${role}@example.test`, name: null };
  });
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const SRC = "https://zz1.example.test";
const ok = { expert: "X-ZZ1", source: SRC };
const seed = (o: Partial<LicenceRow> = {}) =>
  appendLicence(w.main, {
    expertId: "X-ZZ1",
    sourceKey: SRC,
    checkedAt: "2020-03-01T00:00:00.000Z",
    termsUrl: `${SRC}/terms`,
    robots: "allows",
    summarisation: "no",
    status: "no",
    actor: "job",
    note: null,
    ...o,
  });
const audits = async () =>
  (await auditRows(w.auth)).filter((a) => String(a.action).startsWith("expert_licence"));
const rowsOf = async () =>
  Number((await w.main.execute("SELECT COUNT(*) AS n FROM expert_source_licence")).rows[0]!.n);

describe("acceptRiskAction", () => {
  it("the Owner accepts a source whose terms forbid: one audit row, then one owner row", async () => {
    await seed();
    as(w.owner, "owner");
    expect(await acceptRiskAction(form(ok))).toEqual({ ok: true });
    const l = await latestLicence(w.main, { expertId: "X-ZZ1", sourceKey: SRC });
    expect(l).toMatchObject({
      status: "owner-accepted-risk",
      actor: "owner",
      summarisation: "no",
      robots: "allows",
    });
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "expert_licence_accept_risk", target_id: "X-ZZ1" });
    expect(String(a[0]!.detail_json)).toContain("owner-accepted-risk");
  });

  it("an unreachable source (status unchecked) can be accepted too", async () => {
    await seed({ robots: "unreachable", summarisation: "unknown", status: "unchecked" });
    as(w.owner, "owner");
    expect(await acceptRiskAction(form(ok))).toEqual({ ok: true });
  });

  it.each(["editor", "viewer"])(
    "%s cannot accept the risk: refused by the guard, nothing written",
    async (role) => {
      await seed();
      as(role === "editor" ? w.editor : w.viewer, role);
      await expect(acceptRiskAction(form(ok))).rejects.toThrow(/403/);
      expect(await audits()).toHaveLength(0);
      expect(await rowsOf()).toBe(1);
    },
  );

  it("an Editor is also refused by the service itself, even if the guard were bypassed", async () => {
    await seed();
    requireUser.mockImplementation(async () => ({
      id: w.editor,
      role: "editor",
      email: "e@example.test",
      name: null,
    }));
    expect(await acceptRiskAction(form(ok))).toEqual({ error: "forbidden" });
    expect(await audits()).toHaveLength(0);
    expect(await rowsOf()).toBe(1);
  });

  it("refuses with a word and no audit row: bad input, unknown source, not checked, robots, already allowed", async () => {
    as(w.owner, "owner");
    expect(await acceptRiskAction(form({ expert: "bad id!", source: SRC }))).toEqual({
      error: "invalid",
    });
    expect(await acceptRiskAction(form({ expert: "X-ZZ1" }))).toEqual({ error: "invalid" });
    expect(
      await acceptRiskAction(form({ expert: "X-ZZ1", source: "https://nope.example.test" })),
    ).toEqual({ error: "not_found" });
    expect(await acceptRiskAction(form({ expert: "X-NOPE", source: SRC }))).toEqual({
      error: "not_found",
    });
    expect(await acceptRiskAction(form(ok))).toEqual({ error: "not_checked" });
    await seed({ robots: "disallows", status: "no", summarisation: "unknown" });
    expect(await acceptRiskAction(form(ok))).toEqual({ error: "robots" });
    await seed({
      checkedAt: "2021-04-01T00:00:00.000Z",
      status: "enabled",
      summarisation: "unknown",
    });
    expect(await acceptRiskAction(form(ok))).toEqual({ error: "not_needed" });
    expect(await audits()).toHaveLength(0);
    expect(await rowsOf()).toBe(2);
  });

  it("a write that fails after the audit row leaves a _failed row", async () => {
    await seed();
    as(w.owner, "owner");
    await w.main.execute(
      "CREATE TRIGGER zz_block BEFORE INSERT ON expert_source_licence WHEN NEW.actor = 'owner' BEGIN SELECT RAISE(ABORT, 'zz'); END",
    );
    expect(await acceptRiskAction(form(ok))).toEqual({ error: "unavailable" });
    expect((await audits()).map((a) => a.action)).toEqual([
      "expert_licence_accept_risk",
      "expert_licence_accept_risk_failed",
    ]);
    expect(await rowsOf()).toBe(1);
  });
});
