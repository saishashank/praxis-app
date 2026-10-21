// @vitest-environment node
// Promotion, force-apply, rollback, kill freeze, retire and the holdout roll (M6 T10; ARN-065,
// ARN-082, KB-043, KB-050; D-121 draft) against a real migrated database. HIGH RISK: this decides
// which rule version trades money, so the tests run the real group restart (runTerminalChecks).
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadVersionSet } from "@/lib/agents/versionRuns";
import { buildExecutionRegistry, planInitialStart, resolveCohortParams } from "@/lib/arena/cohort";
import {
  loadExecutions,
  loadLiveCohorts,
  runTerminalChecks,
  seedExecutions,
  startCohorts,
  type RestartConfig,
} from "@/lib/arena/cohortWriter";
import { sessionsBetween } from "@/lib/data/calendar";
import { loadMigrations, migrateUp } from "@/lib/db/migrate-core.mjs";
import { transitionChallenger, loadChallenger } from "@/lib/learning/challengerLifecycle";
import { currentKbVersionId } from "@/lib/learning/kbVersion";
import {
  PromotionError,
  budgetTotalFor,
  cancelChange,
  loadPromotion,
  pendingChanges,
  promotionsAwaitingRoll,
  recordKillFreeze,
  requestForceApply,
  requestPromotion,
  requestRollback,
  retireRuleVersion,
  rollAfterPromotion,
} from "@/lib/learning/promotion";
import { seedRuleVersions } from "@/lib/learning/ruleVersions";
import { rollLineageSplit, trialLedgerRow } from "@/lib/stats/splits";
import { cleanupTempDbs, MIGRATIONS, tempDbUrl, track } from "../db/helpers";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { addLineage, BASE, LEARNING, MARKET, ownerChallenger, rows } from "./challengerFixtures";

afterEach(cleanupTempDbs);

const MASTER = 20_261_011n;
const registry = buildExecutionRegistry();
const DATES = sessionsBetween("2026-10-05", "2027-03-31", []);
const D0 = DATES[0]!;
const OWNER = "u-owner";
const AUDIT = "audit:2026-10-06:0001";
const NOW = "2026-10-06T01:00:00.000Z";

async function freshDb(): Promise<Client> {
  const db = track(createClient({ url: tempDbUrl(), intMode: "bigint" }));
  await migrateUp(db, await loadMigrations(MIGRATIONS("main")));
  return db;
}

/** Migrated DB with the v1 rule versions, the F1 lineage, the 25 executions and their first cohorts. */
async function world(): Promise<Client> {
  const db = await freshDb();
  await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
  await addLineage(db, "F1");
  await seedExecutions(db, registry);
  await startCohorts(
    db,
    planInitialStart({
      registry,
      startD: D0,
      paramsFor: () => resolveCohortParams(),
      masterSeed: MASTER,
      controlsPerFamily: 2,
    }),
  );
  return db;
}

/** As closeBooks builds it: the executions are read from the database at the start of every run. */
async function restartConfig(
  db: Client,
  over: Partial<RestartConfig> = {},
): Promise<RestartConfig> {
  const map = new Map((await loadExecutions(db)).map((e) => [e.id, e]));
  return {
    executionFor: (id) => {
      const e = map.get(id);
      if (e === undefined) throw new Error(`no execution ${id}`);
      return e;
    },
    paramsFor: () => resolveCohortParams(),
    masterSeed: MASTER,
    ...over,
  };
}

async function nav(db: Client, cohortId: string, d: string, liq: bigint): Promise<void> {
  await db.execute({
    sql: `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro,
            positions_micro, div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro,
            fin_accrued_micro, nav_micro, liq_nav_micro, open_positions, invariants_ok)
          VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, 0, 1)`,
    args: [cohortId, d, liq, liq, liq],
  });
}

/** The live E01 target-resolves at close `d` (index into DATES) so the TW-F1 group restarts. */
async function restartGroup(
  db: Client,
  at: number,
  over: Partial<RestartConfig> = {},
  executionId = "E01",
  group = "TW-F1",
) {
  const live = (await loadLiveCohorts(db, group)).find((c) => c.executionId === executionId)!;
  await nav(db, live.id, DATES[at]!, 1_230_000_000n);
  return runTerminalChecks(db, [live.id], {
    d: DATES[at]!,
    calendar: [],
    signalsThroughD: DATES[at - 1]!,
    restart: await restartConfig(db, over),
  });
}

/** An Owner challenger moved to `state` through the real transitions (counter and ready marked). */
async function challengerIn(
  db: Client,
  i: number,
  state: "review" | "approved",
  approver = OWNER,
): Promise<string> {
  const made = await ownerChallenger(db, i, D0);
  if (made.status !== "created") throw new Error(`not created: ${JSON.stringify(made)}`);
  const id = made.id;
  const go = (to: "replay" | "shakedown" | "review" | "approved", actor = OWNER) =>
    transitionChallenger(
      db,
      { id, to, d: D0, actor, reason: `test ${to}` },
      { shakedownSessions: LEARNING.shakedownSessions },
    );
  await go("replay");
  await go("shakedown");
  await db.execute({
    sql: "UPDATE challenger SET shakedown_ok_sessions = ? WHERE id = ?",
    args: [LEARNING.shakedownSessions, id],
  });
  await go("review");
  await db.execute({ sql: "UPDATE challenger SET ready = 1 WHERE id = ?", args: [id] });
  if (state === "approved") await go("approved", approver);
  return id;
}

const base = { market: MARKET, d: DATES[1]!, actor: OWNER, auditRef: AUDIT, now: NOW };
const executionVersions = async (db: Client, family = "F1") =>
  Object.fromEntries(
    (
      await rows(db, "SELECT id, rule_version FROM execution WHERE family = ? ORDER BY id", [
        family,
      ])
    ).map((r) => [String(r.id), String(r.rule_version)]),
  );
const cohortVersion = async (db: Client, id: string) =>
  String((await rows(db, "SELECT rule_version FROM cohort WHERE id = ?", [id]))[0]!.rule_version);
const lastStatus = async (db: Client, id: string) =>
  String(
    (
      await rows(
        db,
        "SELECT status FROM rule_version_status WHERE rule_version_id = ? ORDER BY seq DESC LIMIT 1",
        [id],
      )
    )[0]!.status,
  );
const count = async (db: Client, table: string, where = "1 = 1") =>
  Number((await rows(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);

async function dump(db: Client): Promise<string> {
  const parts: string[] = [];
  for (const sql of [
    "SELECT * FROM execution ORDER BY id",
    "SELECT * FROM cohort ORDER BY id",
    "SELECT * FROM cohort_event ORDER BY cohort_id, seq",
    "SELECT * FROM rule_version ORDER BY id",
    "SELECT * FROM rule_version_status ORDER BY rule_version_id, seq",
    "SELECT * FROM challenger ORDER BY id",
    "SELECT * FROM challenger_event ORDER BY challenger_id, seq",
    "SELECT * FROM promotion ORDER BY id",
    "SELECT * FROM change_ledger ORDER BY id",
    "SELECT * FROM lineage_split ORDER BY lineage_id, version",
    "SELECT * FROM lesson_window ORDER BY lineage_id, split_version",
  ]) {
    for (const r of (await db.execute(sql)).rows) {
      parts.push(JSON.stringify(Object.values(r).map(String)));
    }
  }
  return parts.join("\n");
}

describe("promotion path end to end (AT-23)", () => {
  it("an approved and ready challenger is promoted at the group restart; later cohorts use the new version, earlier ones are unchanged", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const ch = (await loadChallenger(db, id))!;
    const req = await requestPromotion(db, { ...base, challengerId: id });
    expect(req).toMatchObject({ status: "scheduled", created: true, groupId: "TW-F1" });
    const pid = (req as { promotionId: string }).promotionId;

    // requested but not applied: nothing trades the new version yet
    expect(await executionVersions(db)).toMatchObject({ E01: "v1", E02: "v1", "C2-F1": "v1" });
    expect(await loadPromotion(db, pid)).toMatchObject({
      status: "pending",
      kind: "promotion",
      from_version: "F1.v1",
      to_version: ch.rule_version_id,
      approved_by: OWNER,
    });
    // the approval record carries the Owner's audit reference
    const sched = await rows(
      db,
      "SELECT actor, audit_ref, effective_d FROM change_ledger WHERE target = ?",
      [`F1/schedule/${pid}`],
    );
    expect(sched).toEqual([{ actor: OWNER, audit_ref: AUDIT, effective_d: DATES[1] }]);

    const r = await restartGroup(db, 7);
    const restartD = DATES[9]!;
    expect(r.restarts[0]).toMatchObject({ group: "TW-F1", restartD });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({
      promotionId: pid,
      kind: "promotion",
      fromVersion: "F1.v1",
      toVersion: "F1.v2",
    });

    // executions of the family (E, C2, C3) now carry F1.v2; other families are untouched
    const v = await executionVersions(db);
    expect(Object.values(v).every((x) => x === "F1.v2")).toBe(true);
    expect(Object.keys(v)).toEqual(["C2-F1", "C3-F1", "E01", "E02"]);
    expect(await executionVersions(db, "F2")).toMatchObject({ E03: "v1", E04: "v1" });

    // earlier cohorts keep their version, every successor starts with the new one
    for (const e of ["E01", "E02", "C2-F1#01", "C3-F1#02"]) {
      expect(await cohortVersion(db, `${e}@${D0}`)).toBe("v1");
    }
    for (const e of ["E01", "E02", "C2-F1#01", "C2-F1#02", "C3-F1#01", "C3-F1#02"]) {
      expect(await cohortVersion(db, `${e}@${restartD}`)).toBe("F1.v2");
    }
    expect(await cohortVersion(db, `E03@${D0}`)).toBe("v1");

    // promotion applied, versions' status history, challenger promoted, ledger with the audit ref
    expect(await loadPromotion(db, pid)).toMatchObject({ status: "applied", applied_d: restartD });
    expect(await lastStatus(db, "F1.v2")).toBe("live");
    expect(await lastStatus(db, "F1.v1")).toBe("shadow");
    expect(await loadChallenger(db, id)).toMatchObject({ state: "promoted", ready: 1 });
    const ev = await rows(
      db,
      "SELECT from_state, to_state, d FROM challenger_event WHERE challenger_id = ? ORDER BY seq DESC LIMIT 1",
      [id],
    );
    expect(ev[0]).toEqual({ from_state: "approved", to_state: "promoted", d: restartD });
    const applied = await rows(
      db,
      "SELECT kind, actor, audit_ref, effective_d FROM change_ledger WHERE target = 'F1.v2'",
    );
    expect(applied).toEqual([
      { kind: "promotion", actor: OWNER, audit_ref: AUDIT, effective_d: restartD },
    ]);

    // batch 2b now sees F1.v2 as the live version and F1.v1 still evaluated for its shadow cohorts
    const set = await loadVersionSet(db, MARKET, await loadExecutions(db));
    expect(set!.live.get("F1")!.id).toBe("F1.v2");
    expect(set!.extra.map((x) => `${x.id}:${x.role}`)).toContain("F1.v1:shadow");
  });

  it("running the step again writes nothing; a second request returns the first", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const a = await requestPromotion(db, { ...base, challengerId: id });
    const b = await requestPromotion(db, { ...base, challengerId: id });
    expect(b).toMatchObject({ status: "scheduled", created: false });
    expect((b as { promotionId: string }).promotionId).toBe(
      (a as { promotionId: string }).promotionId,
    );
    expect(await count(db, "promotion")).toBe(1);
    expect(await count(db, "change_ledger")).toBe(1);
    await restartGroup(db, 7);
    const before = await dump(db);
    // the same request after it was applied still returns the first and writes nothing
    expect(await requestPromotion(db, { ...base, challengerId: id })).toMatchObject({
      status: "scheduled",
      created: false,
    });
    const again = await runTerminalChecks(db, [], {
      d: DATES[7]!,
      calendar: [],
      signalsThroughD: DATES[6]!,
      restart: await restartConfig(db),
    });
    expect(again.written).toBe(false);
    expect(await dump(db)).toBe(before);
  });

  it("replay parity: the same steps on two databases write the same bytes", async () => {
    const run = async () => {
      const db = await world();
      const id = await challengerIn(db, 1, "approved");
      await requestPromotion(db, { ...base, challengerId: id });
      await restartGroup(db, 7);
      await restartGroup(db, 7, {}, "E03", "TW-F2"); // another group restarts the same night
      return dump(db);
    };
    expect(await run()).toBe(await run());
  });

  it("a restart of another group leaves the pending change alone", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    await requestPromotion(db, { ...base, challengerId: id });
    const r = await restartGroup(db, 7, {}, "E03", "TW-F2");
    expect(r.changes).toEqual([]);
    expect((await pendingChanges(db, MARKET)).map((p) => p.family)).toEqual(["F1"]);
    expect(await executionVersions(db)).toMatchObject({ E01: "v1" });
  });
});

describe("refusals: promotion needs the Owner's approval, readiness and a live incumbent", () => {
  it("refuses without audit reference or actor (throws), and for a challenger that is not approved", async () => {
    const db = await world();
    const review = await challengerIn(db, 1, "review");
    await expect(
      requestPromotion(db, { ...base, challengerId: review, auditRef: " " }),
    ).rejects.toThrow(PromotionError);
    await expect(
      requestPromotion(db, { ...base, challengerId: review, actor: "" }),
    ).rejects.toThrow(/Owner as actor/);
    expect(await requestPromotion(db, { ...base, challengerId: review })).toMatchObject({
      status: "refused",
      reason: "not_approved",
    });
    expect(await requestPromotion(db, { ...base, challengerId: "C-AU-F1-99" })).toMatchObject({
      status: "refused",
      reason: "unknown_challenger",
    });
    expect(await count(db, "promotion")).toBe(0);
    expect(await count(db, "change_ledger")).toBe(0);
  });

  it("refuses an approved challenger that is not ready, and an approval by a system actor", async () => {
    const db = await world();
    const notReady = await challengerIn(db, 1, "review");
    await db.execute({
      sql: "UPDATE challenger SET state = 'approved', ready = 0 WHERE id = ?",
      args: [notReady],
    });
    expect(await requestPromotion(db, { ...base, challengerId: notReady })).toMatchObject({
      status: "refused",
      reason: "not_ready",
    });
    const sys = await challengerIn(db, 2, "approved", "A6");
    expect(await requestPromotion(db, { ...base, challengerId: sys })).toMatchObject({
      status: "refused",
      reason: "approval_not_owner",
    });
    expect(await count(db, "promotion")).toBe(0);
  });

  it("a stale incumbent (the live version moved) and a second pending change are refused", async () => {
    const db = await world();
    const a = await challengerIn(db, 1, "approved");
    const b = await challengerIn(db, 2, "approved");
    expect(await requestPromotion(db, { ...base, challengerId: a })).toMatchObject({
      status: "scheduled",
    });
    expect(await requestPromotion(db, { ...base, challengerId: b })).toMatchObject({
      status: "refused",
      reason: "pending_exists",
    });
    await restartGroup(db, 7); // a is promoted: F1.v2 is live, b was tested against F1.v1
    expect(await requestPromotion(db, { ...base, challengerId: b })).toMatchObject({
      status: "refused",
      reason: "stale_incumbent",
    });
  });

  it("without an approval record in the change ledger a pending row never applies", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const ch = (await loadChallenger(db, id))!;
    await db.execute({
      sql: `INSERT INTO promotion (id, market, family, kind, from_version, to_version, challenger_id,
              approved_at, approved_by, status, group_id)
            VALUES ('PR:raw', 'AU', 'F1', 'promotion', 'F1.v1', ?, ?, ?, ?, 'pending', 'TW-F1')`,
      args: [ch.rule_version_id, id, NOW, OWNER],
    });
    const r = await restartGroup(db, 7);
    expect(r.changes).toEqual([]);
    expect(await loadPromotion(db, "PR:raw")).toMatchObject({ status: "pending" });
    expect(await executionVersions(db)).toMatchObject({ E01: "v1" });
    expect(await cohortVersion(db, `E01@${DATES[9]}`)).toBe("v1");
    expect(await loadChallenger(db, id)).toMatchObject({ state: "approved" });
  });

  it("a pending promotion whose challenger was rejected is cancelled at the restart, not applied", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    await transitionChallenger(
      db,
      { id, to: "rejected", d: DATES[2]!, actor: OWNER, reason: "changed mind" },
      { shakedownSessions: LEARNING.shakedownSessions },
    );
    const r = await restartGroup(db, 7);
    expect(r.changes).toEqual([]);
    const pid = (req as { promotionId: string }).promotionId;
    expect(await loadPromotion(db, pid)).toMatchObject({ status: "cancelled" });
    expect(await executionVersions(db)).toMatchObject({ E01: "v1" });
  });
});

describe("weekly cap (ARN-065, decision 19): promotion waits, force-apply and rollback do not count", () => {
  it("max_promotions_per_week = 0 holds a promotion at the restart; the next restart with room applies it", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    const pid = (req as { promotionId: string }).promotionId;
    const held = await restartGroup(db, 7, { maxPromotionsPerWeek: 0 });
    expect(held.changes).toEqual([]);
    expect(await loadPromotion(db, pid)).toMatchObject({ status: "pending" });
    expect(await executionVersions(db)).toMatchObject({ E01: "v1" });
    expect(await cohortVersion(db, `E01@${DATES[9]}`)).toBe("v1");
    expect(await loadChallenger(db, id)).toMatchObject({ state: "approved" });

    const next = await restartGroup(db, 16, { maxPromotionsPerWeek: 1 });
    expect(next.changes).toHaveLength(1);
    expect(await cohortVersion(db, `E01@${DATES[18]}`)).toBe("F1.v2");
  });

  it("three applied promotions in the Melbourne week fill the cap of 3; a force-apply still applies", async () => {
    const db = await world();
    // three applied promotion rows of the week (other families) stand in for earlier applications
    for (const [i, fam] of ["F2", "F3", "F4"].entries()) {
      await db.execute({
        sql: `INSERT INTO promotion (id, market, family, kind, from_version, to_version, challenger_id,
                approved_at, approved_by, group_id)
              VALUES (?, 'AU', ?, 'promotion', ?, ?, 'C-x', ?, ?, ?)`,
        args: [`PR:x${i}`, fam, `${fam}.v1`, `${fam}.v2`, NOW, OWNER, `TW-${fam}`],
      });
      await db.execute({
        sql: "UPDATE promotion SET status = 'applied', applied_d = ? WHERE id = ?",
        args: [DATES[8]!, `PR:x${i}`],
      });
    }
    const a = await challengerIn(db, 1, "approved");
    const f = await challengerIn(db, 2, "review");
    await requestPromotion(db, { ...base, challengerId: a });
    const held = await restartGroup(db, 7);
    expect(held.changes).toEqual([]); // cap of 3 reached by the other families this week
    // cancel the held promotion and force-apply the other challenger instead
    await cancelChange(db, {
      promotionId: (await pendingChanges(db, MARKET))[0]!.id,
      d: DATES[10]!,
      actor: OWNER,
      auditRef: "audit:cancel",
      now: NOW,
      reason: "cap",
    });
    expect(await requestForceApply(db, { ...base, challengerId: f })).toMatchObject({
      status: "scheduled",
    });
    const forced = await restartGroup(db, 16);
    expect(forced.changes).toHaveLength(1);
    expect(forced.changes[0]).toMatchObject({ kind: "force_apply" });
  });
});

describe("force-apply and rollback (decision 19, 22)", () => {
  it("force-apply of a challenger in review copies its parameters into a force version: UNVALIDATED, no roll, no cap count", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "review");
    const ch = (await loadChallenger(db, id))!;
    const req = await requestForceApply(db, { ...base, challengerId: id });
    expect(req).toMatchObject({ status: "scheduled", toVersion: "F1.v3" });
    const forced = await rows(
      db,
      "SELECT origin, parent, params_sha FROM rule_version WHERE id = 'F1.v3'",
    );
    const src = await rows(db, "SELECT params_sha FROM rule_version WHERE id = ?", [
      ch.rule_version_id,
    ]);
    expect(forced).toEqual([{ origin: "force", parent: "F1.v1", params_sha: src[0]!.params_sha }]);

    const r = await restartGroup(db, 7);
    expect(r.changes[0]).toMatchObject({ kind: "force_apply", toVersion: "F1.v3" });
    expect(await executionVersions(db)).toMatchObject({ E01: "F1.v3", "C3-F1": "F1.v3" });
    expect(await cohortVersion(db, `E02@${DATES[9]}`)).toBe("F1.v3");
    expect(await lastStatus(db, "F1.v3")).toBe("live");
    expect(await loadChallenger(db, id)).toMatchObject({ state: "review" }); // left as it was
    const led = JSON.parse(
      String(
        (await rows(db, "SELECT after_json FROM change_ledger WHERE target = 'F1.v3'"))[0]!
          .after_json,
      ),
    );
    expect(led).toMatchObject({ label: "UNVALIDATED", qualifier: "forced by Owner" });
    // a force-apply does not count against the weekly cap and does not roll the split
    expect(await count(db, "promotion", "kind = 'promotion' AND status = 'applied'")).toBe(0);
    const pid = (req as { promotionId: string }).promotionId;
    expect(
      await rollAfterPromotion(db, {
        promotionId: pid,
        calendar: weekdayCalendar(3000),
        primaryRows: [],
        stats: BASE.stats,
        now: NOW,
      }),
    ).toEqual({ status: "not_a_promotion" });
    expect(await count(db, "lineage_split")).toBe(1);
  });

  it("an Owner version in an early state can be force-applied; a rejected challenger cannot", async () => {
    const db = await world();
    const early = await ownerChallenger(db, 1, D0);
    const eid = (early as { id: string }).id;
    expect(await requestForceApply(db, { ...base, challengerId: eid })).toMatchObject({
      status: "scheduled",
    });
    const db2 = await world();
    const rej = await challengerIn(db2, 1, "review");
    await transitionChallenger(
      db2,
      { id: rej, to: "rejected", d: D0, actor: OWNER, reason: "no" },
      { shakedownSessions: LEARNING.shakedownSessions },
    );
    expect(await requestForceApply(db2, { ...base, challengerId: rej })).toMatchObject({
      status: "refused",
      reason: "challenger_state",
    });
  });

  it("rollback to an earlier live version: a new version with the earlier parameters, applied at the restart, history intact", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    await requestPromotion(db, { ...base, challengerId: id });
    await restartGroup(db, 7); // F1.v2 live from DATES[9]
    const v1 = await rows(
      db,
      "SELECT params_json, params_sha FROM rule_version WHERE id = 'F1.v1'",
    );
    const v2sha = String(
      (await rows(db, "SELECT params_sha FROM rule_version WHERE id = 'F1.v2'"))[0]!.params_sha,
    );
    expect(v2sha).not.toBe(String(v1[0]!.params_sha));

    const req = await requestRollback(db, {
      ...base,
      d: DATES[10]!,
      family: "F1",
      toVersion: "F1.v1",
    });
    expect(req).toMatchObject({ status: "scheduled", toVersion: "F1.v3" });
    const rb = await rows(
      db,
      "SELECT origin, parent, params_json FROM rule_version WHERE id = 'F1.v3'",
    );
    expect(rb).toEqual([{ origin: "rollback", parent: "F1.v2", params_json: v1[0]!.params_json }]);
    // the rollback is not live yet
    expect(await executionVersions(db)).toMatchObject({ E01: "F1.v2" });

    const r = await restartGroup(db, 16);
    expect(r.changes[0]).toMatchObject({
      kind: "rollback",
      fromVersion: "F1.v2",
      toVersion: "F1.v3",
    });
    expect(await executionVersions(db)).toMatchObject({ E01: "F1.v3", E02: "F1.v3" });
    expect(await cohortVersion(db, `E01@${DATES[18]}`)).toBe("F1.v3");
    expect(await cohortVersion(db, `E01@${DATES[9]}`)).toBe("F1.v2"); // the ending cohort keeps its version
    expect(await lastStatus(db, "F1.v3")).toBe("live");
    expect(await lastStatus(db, "F1.v2")).toBe("shadow");
    // history is never rewritten: v1 and v2 rows and their statuses are as they were
    expect(await count(db, "rule_version", "family = 'F1'")).toBe(3);
    // the cap counts the promotion only, not the rollback
    expect(await count(db, "promotion", "kind = 'promotion' AND status = 'applied'")).toBe(1);
    // a rolled-back-to version must have been live, and an earlier one
    expect(await requestRollback(db, { ...base, family: "F1", toVersion: "F1.v3" })).toMatchObject({
      status: "refused",
      reason: "same_version",
    });
  });

  it("rollback refuses a version that was never live", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const ch = (await loadChallenger(db, id))!;
    // F1.v2 is a challenger version, never live: not a rollback target (and not earlier than live? it is later)
    expect(
      await requestRollback(db, { ...base, family: "F1", toVersion: ch.rule_version_id }),
    ).toMatchObject({ status: "refused" });
    expect(await requestRollback(db, { ...base, family: "F1", toVersion: "F2.v1" })).toMatchObject({
      status: "refused",
      reason: "wrong_market",
    });
  });
});

describe("kill-switch freeze (KB-043, ARN-093)", () => {
  async function kill(db: Client, scope = "family", key = "F1"): Promise<void> {
    await db.execute({
      sql: `INSERT INTO arena_control (scope, scope_key, state, set_at, set_by, reason)
            VALUES (?, ?, 'killed', ?, 'killswitch', 'test')`,
      args: [scope, key, NOW],
    });
  }

  it("a killed family gets no promotion: refused at request, held at the restart, cancelled by the freeze record", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    const pid = (req as { promotionId: string }).promotionId;
    await kill(db);
    // held at the restart even before the freeze is recorded
    const held = await restartGroup(db, 7);
    expect(held.changes).toEqual([]);
    expect(await loadPromotion(db, pid)).toMatchObject({ status: "pending" });
    expect(await executionVersions(db)).toMatchObject({ E01: "v1" });

    const kb = await currentKbVersionId(db);
    const freeze = await recordKillFreeze(db, {
      market: MARKET,
      family: "F1",
      d: DATES[8]!,
      now: NOW,
    });
    expect(freeze).toMatchObject({ status: "recorded", cancelled: [pid] });
    expect(await loadPromotion(db, pid)).toMatchObject({ status: "cancelled" });
    expect(await currentKbVersionId(db)).toBe(kb); // a freeze changes no prompt
    expect(
      await rows(
        db,
        "SELECT kind, target, actor, audit_ref FROM change_ledger WHERE kind = 'kill_freeze'",
      ),
    ).toEqual([{ kind: "kill_freeze", target: "F1/freeze", actor: "system", audit_ref: null }]);
    expect(
      await recordKillFreeze(db, { market: MARKET, family: "F1", d: DATES[8]!, now: NOW }),
    ).toMatchObject({
      status: "unchanged",
    });
    expect(await count(db, "change_ledger", "kind = 'kill_freeze'")).toBe(1);

    // a new promotion request of the killed family is refused
    expect(await requestPromotion(db, { ...base, challengerId: id })).toMatchObject({
      status: "refused",
      reason: "family_frozen",
    });
    // another family is not frozen
    expect(
      await recordKillFreeze(db, { market: MARKET, family: "F2", d: DATES[8]!, now: NOW }),
    ).toEqual({
      status: "not_killed",
    });
  });

  it("a market-scope kill freezes every family", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    await kill(db, "market", MARKET);
    expect(await requestPromotion(db, { ...base, challengerId: id })).toMatchObject({
      reason: "family_frozen",
    });
  });

  it("force-apply and rollback of a killed family need the second confirmation, then apply at the restart", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "review");
    await kill(db);
    expect(await requestForceApply(db, { ...base, challengerId: id })).toMatchObject({
      status: "refused",
      reason: "confirmation_required",
    });
    const ok = await requestForceApply(db, { ...base, challengerId: id, confirmKilled: true });
    expect(ok).toMatchObject({ status: "scheduled" });
    const r = await restartGroup(db, 7);
    expect(r.changes[0]).toMatchObject({ kind: "force_apply" });
    // a pending force-apply row without the recorded confirmation stays held in a killed family
    const db2 = await world();
    const id2 = await challengerIn(db2, 1, "review");
    const req = await requestForceApply(db2, { ...base, challengerId: id2 });
    await kill(db2);
    const held = await restartGroup(db2, 7);
    expect(held.changes).toEqual([]);
    expect(await loadPromotion(db2, (req as { promotionId: string }).promotionId)).toMatchObject({
      status: "pending",
    });
  });
});

describe("retire (ARN-092)", () => {
  it("retires a challenger version and its challenger; never the live version; needs a basis", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "review");
    const ch = (await loadChallenger(db, id))!;
    await expect(
      retireRuleVersion(db, {
        market: MARKET,
        versionId: ch.rule_version_id,
        d: DATES[2]!,
        now: NOW,
        actor: "A6",
        reason: "FAILED at forward look",
      }),
    ).rejects.toThrow(/audit reference or an evidence reference/);
    expect(
      await retireRuleVersion(db, {
        market: MARKET,
        versionId: "F1.v1",
        d: DATES[2]!,
        now: NOW,
        actor: OWNER,
        reason: "x",
        auditRef: AUDIT,
      }),
    ).toMatchObject({ status: "refused", reason: "live_version" });
    const done = await retireRuleVersion(db, {
      market: MARKET,
      versionId: ch.rule_version_id,
      d: DATES[2]!,
      now: NOW,
      actor: "A6",
      reason: "FAILED at forward look",
      evidenceRef: "look:F1:1",
    });
    expect(done).toMatchObject({ status: "retired", challengerRetired: true });
    expect(await lastStatus(db, ch.rule_version_id)).toBe("retired");
    expect(await loadChallenger(db, id)).toMatchObject({ state: "retired", ready: 0 });
    expect(
      await retireRuleVersion(db, {
        market: MARKET,
        versionId: ch.rule_version_id,
        d: DATES[2]!,
        now: NOW,
        actor: "A6",
        reason: "again",
        evidenceRef: "look:F1:1",
      }),
    ).toEqual({ status: "unchanged" });
    expect(await count(db, "change_ledger", "kind = 'retire'")).toBe(1);
  });

  it("a retired target makes a pending change stale; a version held by an unfinished cohort is not retired", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const ch = (await loadChallenger(db, id))!;
    const req = await requestPromotion(db, { ...base, challengerId: id });
    // retiring the approved challenger's version cancels the pending promotion
    const done = await retireRuleVersion(db, {
      market: MARKET,
      versionId: ch.rule_version_id,
      d: DATES[2]!,
      now: NOW,
      actor: OWNER,
      reason: "Owner withdrew it",
      auditRef: "audit:retire",
    });
    expect(done).toMatchObject({ status: "retired" });
    expect(await loadPromotion(db, (req as { promotionId: string }).promotionId)).toMatchObject({
      status: "cancelled",
    });
    const r = await restartGroup(db, 7);
    expect(r.changes).toEqual([]);

    // after a promotion the old live version is shadow but still held by the unfinished shadow cohorts
    const db2 = await world();
    const id2 = await challengerIn(db2, 1, "approved");
    await requestPromotion(db2, { ...base, challengerId: id2 });
    await restartGroup(db2, 7);
    expect(
      await retireRuleVersion(db2, {
        market: MARKET,
        versionId: "F1.v1",
        d: DATES[10]!,
        now: NOW,
        actor: OWNER,
        reason: "dominated",
        auditRef: "audit:r",
      }),
    ).toMatchObject({ status: "refused", reason: "held_by_cohort" });
  });
});

describe("rollLineageSplit (ARN-082, pure)", () => {
  const calendar = weekdayCalendar(3000);
  const stats = BASE.stats;
  const purge = 140; // F1: 120 + purge_extra

  it("holdout starts one purge after the anchor, validation ends one purge before it, development is everything earlier", () => {
    const anchorD = calendar[2800]!;
    const s = rollLineageSplit({
      market: MARKET,
      family: "F1",
      previous: { version: 1 },
      calendar,
      maxHoldingUpper: 120,
      primaryRows: [],
      params: stats,
      anchorD,
      measuredOnRun: "promotion:PR:t",
    });
    expect(s).toMatchObject({ lineage_id: "AU:F1", version: 2, reason: "roll", purge });
    const idx = (d: string) => calendar.indexOf(d);
    // anchor + 1 session, then one purge of sessions
    expect(idx(s.validation_end_d!)).toBe(2800); // = holdout start - 1 - purge
    expect(s.holdout_start_d).toBe(calendar[2801 + purge]);
    expect(idx(s.validation_start_d!)).toBe(2800 - s.validation_len + 1);
    expect(idx(s.dev_end_d!)).toBe(idx(s.validation_start_d!) - 1 - purge);
    expect(s.holdout_len).toBeGreaterThanOrEqual(stats.splitHoldoutMinSessions);
    expect(s.validation_len).toBeGreaterThanOrEqual(stats.splitValidationMinSessions);
    expect(s.deferred_until_d).toBeNull();
    expect(s.measured_on_run).toBe("promotion:PR:t");
    // the holdout ends beyond the data: its dates are weekday estimates after the data end
    expect(s.holdout_end_d! > s.data_end_d).toBe(true);
  });

  it("is deterministic and re-measures the block from realised holds before the validation window", () => {
    const a = calendar[2800]!;
    const mk = (hold: number) =>
      rollLineageSplit({
        market: MARKET,
        family: "F1",
        previous: { version: 3 },
        calendar,
        maxHoldingUpper: 120,
        primaryRows: Array.from({ length: 50 }, (_, i) => ({
          entryD: calendar[100 + i]!,
          exitD: calendar[100 + i + hold]!,
        })),
        params: stats,
        anchorD: a,
        measuredOnRun: "m",
      });
    expect(mk(60)).toEqual(mk(60));
    expect(mk(60).version).toBe(4);
    expect(mk(60).block_sessions).toBeGreaterThan(mk(1).block_sessions - 1);
    expect(mk(60).block_sessions).toBeGreaterThanOrEqual(stats.bootstrapBlockMinSessions);
  });

  it("an anchor on the last day puts the holdout wholly in the future; a short history defers", () => {
    const s = rollLineageSplit({
      market: MARKET,
      family: "F1",
      previous: { version: 1 },
      calendar,
      maxHoldingUpper: 120,
      primaryRows: [],
      params: stats,
      anchorD: calendar[calendar.length - 1]!,
      measuredOnRun: "m",
    });
    expect(s.validation_end_d).toBe(calendar[calendar.length - 1]);
    const short = rollLineageSplit({
      market: MARKET,
      family: "F1",
      previous: { version: 1 },
      calendar: calendar.slice(0, 400),
      maxHoldingUpper: 120,
      primaryRows: [],
      params: stats,
      anchorD: calendar[399]!,
      measuredOnRun: "m",
    });
    expect(short.deferred_until_d).not.toBeNull();
    expect(short.dev_end_d).toBeNull();
  });
});

describe("roll after a promotion: split, lesson windows, trial budget (ARN-082, ARN-063, ARN-085)", () => {
  const calendar = weekdayCalendar(3000);

  /** A challenger promoted at the group restart of DATES[7] (applied DATES[9]). */
  async function promotedWorld(): Promise<{ db: Client; pid: string; id: string }> {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    await restartGroup(db, 7);
    return { db, pid: (req as { promotionId: string }).promotionId, id };
  }

  it("writes lineage_split v2 (roll), the lesson window, and the rolled budget with the Owner audit reference; once", async () => {
    const { db, pid } = await promotedWorld();
    expect(await promotionsAwaitingRoll(db, MARKET)).toEqual([pid]);
    const input = { promotionId: pid, calendar, primaryRows: [], stats: BASE.stats, now: NOW };
    const r = await rollAfterPromotion(db, input);
    expect(r).toMatchObject({
      status: "rolled",
      splitVersion: 2,
      lessonWindowFrozen: true,
      deferred: false,
    });
    const splits = await rows(
      db,
      "SELECT version, reason, measured_on_run, holdout_start_d, validation_end_d FROM lineage_split ORDER BY version",
    );
    expect(splits.map((s) => [Number(s.version), s.reason, s.measured_on_run])).toEqual([
      [1, "create", null],
      [2, "roll", `promotion:${pid}`],
    ]);
    // the new holdout starts after the promotion date (DATES[9]) plus a purge
    expect(String(splits[1]!.holdout_start_d) > DATES[9]!).toBe(true);
    const w = await rows(
      db,
      "SELECT split_version, frozen_run, l1_end_d, l2_start_d FROM lesson_window ORDER BY split_version",
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ split_version: 2n, frozen_run: `promotion:${pid}` });
    const led = (
      await rows(
        db,
        "SELECT audit_ref, actor, effective_d FROM change_ledger WHERE target = 'F1/split/2'",
      )
    )[0]!;
    expect(led).toEqual({ audit_ref: AUDIT, actor: "A6", effective_d: DATES[9] });
    expect(await budgetTotalFor(db, MARKET, "F1", 2, BASE.stats.trialBudgetPerLineage)).toBe(
      BASE.stats.trialBudgetPerLineage,
    );
    expect(await promotionsAwaitingRoll(db, MARKET)).toEqual([]);

    // idempotent: nothing more is written
    const before = await dump(db);
    expect(await rollAfterPromotion(db, input)).toEqual({ status: "unchanged", splitVersion: 2 });
    expect(await dump(db)).toBe(before);
  });

  it("the budget rolls by D-078 #26: m minus the overlap-weighted validation and holdout accesses of the old split", async () => {
    const db = await freshDb();
    await seedRuleVersions(db, { market: MARKET, d: "2026-10-01" });
    await addLineage(db, "F1");
    // a previous split whose validation window covers every session: overlap = 1
    await db.execute({
      sql: `INSERT INTO lineage_split (lineage_id, version, block_sessions, holdout_len, validation_len,
              purge, data_end_d, holdout_start_d, holdout_end_d, validation_start_d, validation_end_d,
              dev_end_d, deferred_until_d, reason, measured_on_run)
            VALUES ('AU:F1', 2, 20, 126, 126, 140, '2026-09-01', '2026-08-01', '2026-09-01',
                    '2015-01-05', '2030-12-31', '2014-12-31', NULL, 'roll', 'older')`,
      args: [],
    });
    for (const [kind, run] of [
      ["validation_access", "r1"],
      ["validation_access", "r2"],
      ["holdout_access", "r3"],
      ["challenger", "r4"], // a challenger trial is not an access: it does not roll over
    ] as const) {
      const t = trialLedgerRow({
        market: MARKET,
        lineage_id: "AU:F1",
        split_version: 2,
        kind,
        rule_version: "F1.v1",
        variant: null,
        run_id: run,
        d: "2026-09-01",
      });
      await db.execute({
        sql: `INSERT INTO trial_ledger (id, market, lineage_id, split_version, kind, rule_version, variant, run_id, d)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          t.id,
          t.market,
          t.lineage_id,
          t.split_version,
          t.kind,
          t.rule_version,
          t.variant,
          t.run_id,
          t.d,
        ],
      });
    }
    await seedExecutions(db, registry);
    await startCohorts(
      db,
      planInitialStart({
        registry,
        startD: D0,
        paramsFor: () => resolveCohortParams(),
        masterSeed: MASTER,
        controlsPerFamily: 2,
      }),
    );
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    await restartGroup(db, 7);
    const pid = (req as { promotionId: string }).promotionId;
    const r = await rollAfterPromotion(db, {
      promotionId: pid,
      calendar,
      primaryRows: [],
      stats: BASE.stats,
      now: NOW,
    });
    expect(r).toMatchObject({ status: "rolled", splitVersion: 3 });
    expect((r as { budgetTotal: number }).budgetTotal).toBe(BASE.stats.trialBudgetPerLineage - 3);
    expect(await budgetTotalFor(db, MARKET, "F1", 3, BASE.stats.trialBudgetPerLineage)).toBe(
      BASE.stats.trialBudgetPerLineage - 3,
    );
    // the old version's budget total is not recorded: it keeps the base
    expect(await budgetTotalFor(db, MARKET, "F1", 2, BASE.stats.trialBudgetPerLineage)).toBe(
      BASE.stats.trialBudgetPerLineage,
    );
  });

  it("does not roll before the promotion is applied, nor without a split", async () => {
    const db = await world();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    const pid = (req as { promotionId: string }).promotionId;
    const input = { promotionId: pid, calendar, primaryRows: [], stats: BASE.stats, now: NOW };
    expect(await rollAfterPromotion(db, input)).toEqual({ status: "not_applied" });
    expect(await rollAfterPromotion(db, { ...input, promotionId: "PR:none" })).toEqual({
      status: "not_applied",
    });
    expect(await count(db, "lineage_split")).toBe(1);
  });
});
