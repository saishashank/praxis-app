// @vitest-environment node
// Should-fix batch A, money path: V1-S1 (a frozen cohort has an Owner-only, audited way back; it is
// never unfrozen silently) and V1-S15 (a held code with no bar is marked at the last close, flagged, and
// opens an incident after a bounded number of sessions). Synthetic ZZ data on a migrated libSQL file.
import type { Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeBooksDay,
  STALE_MARK_ALERT_SESSIONS,
  STALE_MARK_INCIDENT,
  type CloseBooksResult,
} from "@/lib/arena/closeBooks";
import { toBig } from "@/lib/arena/ledgerWriter";
import {
  clearCohortInvariants,
  frozenState,
  GAP_TOO_LONG_STEPS,
  MAX_CATCH_UP_SESSIONS,
} from "@/lib/arena/unfreeze";
import { INVARIANTS_CLEARED, parseClearInput } from "@/lib/arena/unfreezeCore";
import type { CurrentUser } from "@/lib/auth/session";
import { addUser, auditRows, KEY } from "../auth/helpers";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { MARKET, NOW, setMode, setupReplay, type FullSetup } from "./replayHarness";

afterEach(cleanupTempDbs);

const BASE = { startD: "2030-01-07", sessions: 70, seed: 3 };
const closeDay = (db: Client, d: string): Promise<CloseBooksResult> =>
  closeBooksDay(db, { market: MARKET, d, replay: true, now: NOW });
const one = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows[0]!;
const rowsOf = async (db: Client, sql: string, args: unknown[] = []) =>
  (await db.execute({ sql, args: args as never })).rows;
const E01 = (s: FullSetup) => s.cohortIds.find((id) => id.startsWith("E01@")) as string;
const E02 = (s: FullSetup) => s.cohortIds.find((id) => id.startsWith("E02@")) as string;

async function placeEntry(
  db: Client,
  id: string,
  cohortId: string,
  decidedD: string,
  code: string,
) {
  await db.execute({
    sql: `INSERT INTO arena_order (id, cohort_id, decided_d, code, side, kind, qty, ref_stop_micro, tier)
          VALUES (?, ?, ?, ?, 'buy', 'entry', 20, 400000, 'U1')`,
    args: [id, cohortId, decidedD, code],
  });
}

// ---- V1-S1 --------------------------------------------------------------------------------------------

describe("V1-S1: Owner recovery of a frozen cohort", () => {
  let s: FullSetup;
  let auth: Client;
  let owner: CurrentUser;
  let editor: CurrentUser;
  let c1: string;
  let c2: string;
  const ctx = () => ({
    mainDb: s.db,
    authDb: auth,
    env: { PII_HASH_KEY: KEY } as Record<string, string | undefined>,
    meta: { ip: null, userAgent: null },
    now: () => new Date("2030-01-20T00:00:00Z"),
  });
  const clear = (over: Record<string, unknown> = {}, user: CurrentUser = owner) =>
    clearCohortInvariants(ctx(), user, {
      cohortId: c1,
      cause: "bad vendor bar corrected, ledger row reversed",
      confirm: true,
      ...over,
    });

  /** Unbalance c1's ledger (the failure the existing freeze test uses) and close the session that sees it. */
  async function freeze(withOrder: boolean): Promise<void> {
    await closeDay(s.db, s.ds.dates[0]);
    await closeDay(s.db, s.ds.dates[1]);
    await closeDay(s.db, s.ds.dates[2]);
    await closeDay(s.db, s.ds.dates[3]);
    await s.db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
            VALUES (?, ?, 'tamper', 'cash_settled', 1000000, 'div_pay')`,
      args: [c1, s.ds.dates[3]],
    });
    if (withOrder) await placeEntry(s.db, "O9", c1, s.ds.dates[3], "ZZA");
    const bad = await closeDay(s.db, s.ds.dates[4]);
    expect(bad.failed).toEqual([c1]);
  }
  /** Fix the cause: the operator repairs the bad row in the database (test-only trigger drop). */
  const fixCause = async (): Promise<void> => {
    await s.db.execute("DROP TRIGGER IF EXISTS cash_ledger_no_delete");
    await s.db.execute({
      sql: "DELETE FROM cash_ledger WHERE cohort_id = ? AND txn_id = 'tamper'",
      args: [c1],
    });
  };
  const events = () =>
    rowsOf(s.db, "SELECT * FROM cohort_event WHERE cohort_id = ? AND kind = 'data_event'", [c1]);

  beforeEach(async () => {
    s = await setupReplay({ ...BASE, keep: ["E01", "E02"] });
    c1 = E01(s);
    c2 = E02(s);
    await setMode(s.db, "full");
    auth = await freshDb("auth");
    const ownerId = await addUser(auth, { email: "owner@example.test", role: "owner" });
    const editorId = await addUser(auth, { email: "editor@example.test", role: "editor" });
    owner = { id: ownerId, email: "owner@example.test", name: null, role: "owner" } as CurrentUser;
    editor = {
      id: editorId,
      email: "editor@example.test",
      name: null,
      role: "editor",
    } as CurrentUser;
  });

  it("without the Owner action the cohort stays frozen night after night (never auto-unfrozen)", async () => {
    await freeze(false);
    await fixCause(); // even with the cause fixed
    for (const i of [5, 6, 7]) {
      const r = await closeDay(s.db, s.ds.dates[i]);
      expect(r.frozen).toEqual([c1]);
      expect(r.closed).toEqual([c2]);
      expect(r.status).toBe("degraded");
    }
    expect(await events()).toEqual([]);
  });

  it("the Owner clears it before the next close: audited, one cohort_event, the cohort closes again", async () => {
    await freeze(true); // an order is pending, but no session has been missed yet (gap 0)
    await fixCause();
    const before = await frozenState(s.db, c1);
    expect(before).toMatchObject({ throughD: s.ds.dates[4], badDays: 1, gapSessions: 0 });
    const out = await clear();
    expect(out.status).toBe(200);
    const ev = await events();
    expect(ev).toHaveLength(1);
    const detail = JSON.parse(String(ev[0]!.detail_json)) as Record<string, unknown>;
    expect(detail).toMatchObject({
      type: INVARIANTS_CLEARED,
      through_d: s.ds.dates[4],
      gap_sessions: 0,
      by: `u${owner.id}`,
    });
    expect(String(detail.audit)).toMatch(/^audit:\d+$/);
    const audit = (await auditRows(auth)).filter((a) => a.action === "arena.cohort_unfreeze");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ cohortId: c1, throughD: s.ds.dates[4] });
    // the permanent record is untouched, and the next close runs the cohort
    expect(
      toBig(
        (
          await one(
            s.db,
            "SELECT COUNT(*) AS n FROM nav_daily WHERE cohort_id = ? AND invariants_ok = 0",
            [c1],
          )
        ).n,
      ),
    ).toBe(1n);
    const next = await closeDay(s.db, s.ds.dates[5]);
    expect(next.frozen).toEqual([]);
    expect([...next.closed].sort()).toEqual([c1, c2].sort());
    expect(next.status).toBe("success");
    const day = await one(
      s.db,
      "SELECT invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
      [c1, s.ds.dates[5]],
    );
    expect(toBig(day.invariants_ok)).toBe(1n);
    // a clear is not a licence: the next fatal verdict freezes it again
    expect((await frozenState(s.db, c1)).throughD).toBeNull();
    await s.db.execute({
      sql: `INSERT INTO cash_ledger (cohort_id, d, txn_id, account, delta_micro, kind)
            VALUES (?, ?, 'tamper2', 'cash_settled', 5, 'div_pay')`,
      args: [c1, s.ds.dates[5]],
    });
    const again = await closeDay(s.db, s.ds.dates[6]);
    expect(again.failed).toEqual([c1]);
    expect((await closeDay(s.db, s.ds.dates[7])).frozen).toEqual([c1]);
  });

  const navDays = async (cohort: string) =>
    (
      await rowsOf(s.db, "SELECT d, invariants_ok FROM nav_daily WHERE cohort_id = ? ORDER BY d", [
        cohort,
      ])
    ).map((r) => [String(r.d), toBig(r.invariants_ok)] as const);

  it("the sessions it sat out are replayed for that cohort only, oldest first, before the event is written", async () => {
    await freeze(false);
    await closeDay(s.db, s.ds.dates[5]);
    await closeDay(s.db, s.ds.dates[6]);
    const c2Before = await navDays(c2);
    await fixCause();
    const out = await clear();
    expect(out.status).toBe(200);
    expect(out.body.gapSessions).toBe(2);
    const detail = JSON.parse(String((await events())[0]!.detail_json)) as Record<string, unknown>;
    expect(detail).toMatchObject({
      gap_sessions: 2,
      catch_up_days: [s.ds.dates[5], s.ds.dates[6]],
    });
    const days = (await navDays(c1)).map(([d]) => d);
    expect(days).toEqual(expect.arrayContaining([s.ds.dates[5], s.ds.dates[6]]));
    expect(
      (await navDays(c1)).filter(([d]) => d > s.ds.dates[4]).every(([, ok]) => ok === 1n),
    ).toBe(true);
    expect(await navDays(c2)).toEqual(c2Before); // the other cohort is untouched
    const next = await closeDay(s.db, s.ds.dates[7]);
    expect(next.frozen).toEqual([]);
    expect(next.closed).toContain(c1);
    expect(next.status).toBe("success");
  });

  it("a cohort with a pending order catches up too (its order fills on the first skipped session)", async () => {
    await freeze(true);
    await closeDay(s.db, s.ds.dates[5]);
    await fixCause();
    const out = await clear();
    expect(out.status).toBe(200);
    const o9 = await one(s.db, "SELECT status, fill_d FROM arena_order WHERE id = 'O9'");
    expect(["filled", "cancelled"]).toContain(String(o9.status));
    expect((await navDays(c1)).some(([d, ok]) => d === s.ds.dates[5] && ok === 1n)).toBe(true);
    expect((await closeDay(s.db, s.ds.dates[6])).closed).toContain(c1);
  });

  it("if a replayed session fails the ledger check again nothing is cleared and the cohort stays frozen", async () => {
    await freeze(false);
    await closeDay(s.db, s.ds.dates[5]);
    // the cause is NOT fixed
    const out = await clear();
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({ error: "catch_up_invariants_failed" });
    expect(await events()).toEqual([]);
    const audit = await auditRows(auth);
    expect(audit.map((a) => a.action)).toEqual([
      "arena.cohort_unfreeze",
      "arena.cohort_unfreeze_failed",
    ]);
    expect((await closeDay(s.db, s.ds.dates[6])).frozen).toEqual([c1]);
  });

  it("more skipped sessions than MAX_CATCH_UP_SESSIONS are refused with the exact steps, and no audit row", async () => {
    await freeze(false);
    for (let i = 5; i <= 5 + MAX_CATCH_UP_SESSIONS; i++) await closeDay(s.db, s.ds.dates[i]);
    await fixCause();
    const out = await clear();
    expect(out.status).toBe(409);
    expect(out.body).toMatchObject({
      error: "gap_too_long",
      gapSessions: MAX_CATCH_UP_SESSIONS + 1,
      steps: GAP_TOO_LONG_STEPS,
    });
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
  });

  it("refuses: a non-Owner, a missing confirmation, bad input, an unknown cohort, a cohort that is not frozen", async () => {
    await freeze(false);
    expect((await clear({}, editor)).status).toBe(403);
    expect((await clear({ confirm: false })).body).toEqual({ error: "confirmation_required" });
    expect((await clear({ cause: "   " })).body).toEqual({ error: "invalid" });
    expect((await clear({ cohortId: 5 })).body).toEqual({ error: "invalid" });
    expect((await clear({ cohortId: "NOPE@x" })).status).toBe(404);
    expect((await clear({ cohortId: c2 })).body).toEqual({ error: "not_frozen" });
    expect(await events()).toEqual([]);
    expect(await auditRows(auth)).toEqual([]);
    // and once cleared, a second clear has nothing to do
    await fixCause();
    expect((await clear()).status).toBe(200);
    expect((await clear()).body).toEqual({ error: "not_frozen" });
    expect(await events()).toHaveLength(1);
  });

  it("parseClearInput is a pure check", () => {
    expect(parseClearInput({ cohortId: "E01@x", cause: " fixed ", confirm: true })).toEqual({
      ok: true,
      value: { cohortId: "E01@x", cause: "fixed" },
    });
    expect(parseClearInput({ cohortId: "E01@x", cause: "x".repeat(301), confirm: true }).ok).toBe(
      false,
    );
    expect(parseClearInput({ cohortId: "a b", cause: "x", confirm: true }).ok).toBe(false);
  });
});

// ---- V1-S15 --------------------------------------------------------------------------------------------

describe("V1-S15: a held code with no bar is marked at the last close, flagged, then alerted", () => {
  it("flags the stale mark, never invents a price, and opens one incident after the bounded run", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"] });
    const c = E01(s);
    await placeEntry(s.db, "OE", c, s.ds.dates[1], "ZZA");
    for (let i = 0; i <= 4; i++)
      expect((await closeDay(s.db, s.ds.dates[i])).status).toBe("success");
    const held = await one(
      s.db,
      "SELECT close_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZA'",
      [c, s.ds.dates[4]],
    );
    // the vendor leaves a gap for the held code on the next three sessions (a test-only trigger drop)
    await s.db.execute("DROP TRIGGER price_bar_prune_only");
    for (const i of [5, 6, 7]) {
      await s.db.execute({
        sql: "DELETE FROM price_bar WHERE market = ? AND code = 'ZZA' AND d = ?",
        args: [MARKET, s.ds.dates[i]],
      });
    }
    const incidents = () =>
      rowsOf(s.db, "SELECT kind, severity, detail_json FROM incident WHERE kind = ?", [
        STALE_MARK_INCIDENT,
      ]);
    for (const i of [5, 6, 7]) {
      const r = await closeDay(s.db, s.ds.dates[i]);
      expect(r.status).toBe("success"); // non-fatal: the run and the day stay ok
      const pos = await one(
        s.db,
        "SELECT close_micro, haircut FROM nav_daily_pos WHERE cohort_id = ? AND d = ? AND code = 'ZZA'",
        [c, s.ds.dates[i]],
      );
      expect(toBig(pos.close_micro)).toBe(toBig(held.close_micro)); // the last close, no invented price
      expect(toBig(pos.haircut)).toBe(0n); // a data gap is not a halt (ARN-026)
      const day = await one(
        s.db,
        "SELECT invariants_ok FROM nav_daily WHERE cohort_id = ? AND d = ?",
        [c, s.ds.dates[i]],
      );
      expect(toBig(day.invariants_ok)).toBe(1n);
      const logs = await rowsOf(
        s.db,
        "SELECT message FROM app_log WHERE level = 'warn' AND message LIKE ?",
        [`%${s.ds.dates[i]}%marked at the last close%`],
      );
      expect(logs.map((l) => String(l.message))).toEqual([
        expect.stringContaining(
          `ZZA marked at the last close: no bar on ${s.ds.dates[i]} (${i - 4} session(s) in a row)`,
        ),
      ]);
      // bounded: no incident before the limit, exactly one at it
      expect((await incidents()).length).toBe(i - 4 >= STALE_MARK_ALERT_SESSIONS ? 1 : 0);
    }
    const [inc] = await incidents();
    expect(inc).toMatchObject({ severity: "S2" });
    expect(JSON.parse(String(inc!.detail_json))).toMatchObject({ cohortId: c, codes: ["ZZA"] });
  });

  it("a normal session writes no stale flag and no incident", async () => {
    const s = await setupReplay({ ...BASE, keep: ["E01"] });
    await placeEntry(s.db, "OE", E01(s), s.ds.dates[1], "ZZA");
    for (let i = 0; i <= 8; i++) await closeDay(s.db, s.ds.dates[i]);
    expect(
      await rowsOf(s.db, "SELECT 1 FROM app_log WHERE message LIKE '%marked at the last close%'"),
    ).toEqual([]);
    expect(await rowsOf(s.db, "SELECT 1 FROM incident")).toEqual([]);
  });
});
