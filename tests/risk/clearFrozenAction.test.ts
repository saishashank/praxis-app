// @vitest-environment node
// TST-122 for clearCohortInvariantsAction (V1-S1; HIGH RISK, money path). The Owner lets a cohort that a
// fatal ledger verdict froze carry on. Covered: the guard runs FIRST and a refusal changes nothing, the
// explicit confirmation and input checks, the audit event BEFORE the change, the success path (skipped
// sessions replayed for that cohort, one cohort_event, revalidation), `gap_too_long` with its exact steps,
// and a replayed session that fails again (nothing cleared). Engine detail: tests/arena/cohortRecovery.test.ts.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeBooksDay } from "@/lib/arena/closeBooks";
import { MAX_CATCH_UP_SESSIONS } from "@/lib/arena/unfreeze";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { MARKET, NOW, setMode, setupReplay, type FullSetup } from "../arena/replayHarness";
import { cleanupTempDbs, freshDb } from "../db/helpers";

const requireUser = vi.hoisted(() => vi.fn());
const revalidatePath = vi.hoisted(() => vi.fn());
const mem = vi.hoisted(() => ({ main: null as unknown, auth: null as unknown }));
vi.mock("@/lib/auth/guard", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "9.9.9.9", "user-agent": "agent" }),
}));
vi.mock("@/lib/db/client", () => ({ mainDb: () => mem.main, authDb: () => mem.auth }));

import { clearCohortInvariantsAction } from "@/app/(app)/strategies/risk/actions";

afterEach(() => {
  cleanupTempDbs();
  vi.unstubAllEnvs();
});

let s: FullSetup;
let auth: Client;
let cohort: string;
let ownerId: number;

const form = (o: Record<string, string | undefined>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) fd.set(k, v);
  return fd;
};
const close = (i: number) =>
  closeBooksDay(s.db, { market: MARKET, d: s.ds.dates[i], replay: true, now: NOW });
const events = async () =>
  (
    await s.db.execute({
      sql: "SELECT detail_json FROM cohort_event WHERE cohort_id = ? AND kind = 'data_event'",
      args: [cohort],
    })
  ).rows;
const fix = async () => {
  await s.db.execute("DROP TRIGGER IF EXISTS cash_ledger_no_delete");
  await s.db.execute({ sql: "DELETE FROM cash_ledger WHERE txn_id = 'tamper'", args: [] });
};
const OK = () => ({ cohortId: cohort, cause: "bad bar corrected", confirm: "true" });

beforeEach(async () => {
  vi.stubEnv("PII_HASH_KEY", KEY);
  requireUser.mockReset();
  revalidatePath.mockReset();
  s = await setupReplay({ startD: "2030-01-07", sessions: 70, seed: 3, keep: ["E01"] });
  await setMode(s.db, "full");
  cohort = s.cohortIds[0]!;
  auth = await freshDb("auth");
  mem.main = s.db;
  mem.auth = auth;
  ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
  requireUser.mockResolvedValue({ id: ownerId, email: "o", name: null, role: "owner" });
  for (let i = 0; i <= 3; i++) await close(i);
  await s.db.execute({
    sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
          VALUES (?, ?, 'tamper', 'cash_settled', 1000000, 'div_pay')`,
    args: [cohort, s.ds.dates[3]],
  });
  expect((await close(4)).failed).toEqual([cohort]);
});

describe("guard first", () => {
  it("asks for the admin (Owner) action before anything else, on the page path", async () => {
    await clearCohortInvariantsAction(form(OK()));
    expect(requireUser).toHaveBeenCalledWith("admin", "/strategies/risk");
  });

  it("a non-Owner is refused by the guard: nothing is written", async () => {
    requireUser.mockRejectedValue(new Error("NEXT_HTTP_ERROR_FALLBACK;403"));
    await expect(clearCohortInvariantsAction(form(OK()))).rejects.toThrow(/403/);
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("the service refuses an editor even if a caller skipped the guard", async () => {
    const editor = await addUser(auth, { email: "e@example.test", role: "editor" });
    requireUser.mockResolvedValue({ id: editor, email: "e", name: null, role: "editor" });
    expect(await clearCohortInvariantsAction(form(OK()))).toEqual({ error: "forbidden" });
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });
});

describe("the Owner resumes a frozen cohort", () => {
  it("needs the confirmation and a cause", async () => {
    expect(await clearCohortInvariantsAction(form({ ...OK(), confirm: "false" }))).toEqual({
      error: "confirmation_required",
    });
    expect(await clearCohortInvariantsAction(form({ ...OK(), cause: " " }))).toEqual({
      error: "invalid",
    });
    expect(await clearCohortInvariantsAction(form({ ...OK(), cohortId: undefined }))).toEqual({
      error: "invalid",
    });
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("success: audited, skipped sessions replayed, one event, pages revalidated", async () => {
    await close(5);
    await fix();
    expect(await clearCohortInvariantsAction(form(OK()))).toEqual({ ok: true });
    expect((await auditRows(auth)).map((a) => a.action)).toEqual(["arena.cohort_unfreeze"]);
    const ev = await events();
    expect(ev).toHaveLength(1);
    expect(JSON.parse(String(ev[0]!.detail_json))).toMatchObject({
      type: "invariants_cleared",
      gap_sessions: 1,
      catch_up_days: [s.ds.dates[5]],
    });
    expect(revalidatePath).toHaveBeenCalledWith("/strategies/risk");
    expect((await close(6)).closed).toContain(cohort);
    // a second request has nothing to clear
    expect(await clearCohortInvariantsAction(form(OK()))).toEqual({ error: "not_frozen" });
  });

  it("an unknown cohort is not_found", async () => {
    expect(await clearCohortInvariantsAction(form({ ...OK(), cohortId: "NOPE@x" }))).toEqual({
      error: "not_found",
    });
  });

  it("a gap above the limit is refused with the steps and writes no audit row", async () => {
    for (let i = 5; i <= 5 + MAX_CATCH_UP_SESSIONS; i++) await close(i);
    await fix();
    expect(await clearCohortInvariantsAction(form(OK()))).toEqual({ error: "gap_too_long" });
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("a replayed session that fails again clears nothing and leaves the audit + failed rows", async () => {
    await close(5);
    expect(await clearCohortInvariantsAction(form(OK()))).toEqual({
      error: "catch_up_invariants_failed",
    });
    expect(await events()).toEqual([]);
    expect((await auditRows(auth)).map((a) => a.action)).toEqual([
      "arena.cohort_unfreeze",
      "arena.cohort_unfreeze_failed",
    ]);
  });
});
