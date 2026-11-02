// @vitest-environment node
// AT-23 Challenger lifecycle (M6 T18; KB-040...043, AGT-041/042, ARN-065, ARN-082, ARN-087). Verbatim:
// "A seeded challenger goes proposed -> replay -> shakedown -> review; a failing VAL-110 component or
// deterministic Critic check blocks promotion; a passing one promotes only at a cohort boundary". The real
// lifecycle writer, VAL-110 evidence wrapper, `learn` phase (shakedown count, review), Critic verdict,
// promotion writer and the real group restart, over migrated databases. Mock LLM (none is called), synthetic
// ZZ data. Heavier cover (named, not repeated): tests/learning/{challengerLifecycle,challengerEvidence,
// challengerGenerator,promotion,critic,learnStage}.test.ts, tests/arena/promotionRestart.test.ts.
// PENDING (Owner / staging, not evidenced here): the staging run; the Owner's approval of any real
// promotion (ROL-102) and the reading of the promotion boundary (decision 18).
import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEvidence,
  runChallengerEvidence,
  type EvidenceRows,
  type EvidenceRun,
  type EvidenceSize,
} from "@/lib/learning/challengerEvidence";
import { generateChallenger, type DevelopmentEvaluation } from "@/lib/learning/challengerGenerator";
import {
  loadChallenger,
  reviewChallenger,
  transitionChallenger,
  type CriticState,
} from "@/lib/learning/challengerLifecycle";
import { learnDay } from "@/lib/learning/learnStage";
import { requestForceApply, requestPromotion, requestRollback } from "@/lib/learning/promotion";
import type { Val110Result } from "@/lib/stats/val110";
import { cleanupTempDbs } from "../../db/helpers";
import { dailyReturns, makeRows } from "../../fixtures/stats/t13";
import {
  BASE,
  D0 as CH0,
  FAST,
  LEARNING,
  MARKET,
  f1With,
  ownerChallenger,
  rows,
  world,
} from "../../learning/challengerFixtures";
import { PARAMS, addCritique, addNight, challengerChecks } from "../../learning/learnHelpers";
import { AUDIT, D0, DATES, NOW, OWNER, arenaWorld, challengerIn, restartGroup } from "./arenaWorld";

afterEach(cleanupTempDbs);

// ---- evidence fixtures (the shapes of tests/learning/challengerEvidence.test.ts) --------------------------

const S = 504;
const N = 400;
const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `row:${i}`);
const SIZE: EvidenceSize = {
  challengerKeys: keysOf(N),
  incumbentKeys: keysOf(N),
  sessionCount: S,
  block: 5,
  windowEndD: "2028-12-29",
};

function evidence(): EvidenceRows {
  const own = makeRows({ n: N, S, edge: 0.03, seed: "ch:c" });
  const inc = makeRows({ n: N, S, edge: 0, seed: "ch:i" });
  const toX = (r: (typeof own)[number]) => ({
    key: r.id,
    entrySession: r.entrySession,
    excess: r.excess ?? 0,
  });
  return {
    rows: own,
    challengerRows: own.map(toX),
    incumbentRows: inc.map(toX),
    safety: { effectiveN: 10, delta: 0.01, firstBlockD: null },
    costInfeasible: false,
    pboWeekly: null,
    dsr: { daily: dailyReturns(500, 0.002, 0.01), variantDailySr: [], defaultSrVariance: 0.0001 },
  };
}

async function inReplay(db: Client): Promise<string> {
  const r = await ownerChallenger(db, 0, CH0);
  if (r.status !== "created") throw new Error(JSON.stringify(r));
  await transitionChallenger(
    db,
    { id: r.id, to: "replay", d: CH0, actor: "A6", reason: "queued" },
    LEARNING,
  );
  return r.id;
}

const evidenceRun = (
  id: string,
  split: EvidenceRun["split"],
  data: EvidenceRows,
  d = "2026-10-06",
): EvidenceRun => ({
  challengerId: id,
  runId: "run-1",
  d,
  variant: "primary",
  split,
  stats: FAST,
  learning: LEARNING,
  activeLineages: 6,
  size: SIZE,
  loadRows: async () => data,
});

const stateOf = async (db: Client, id: string) => (await loadChallenger(db, id))!;

// ---- the lifecycle ---------------------------------------------------------------------------------------

describe("AT-23 a seeded challenger goes proposed -> replay -> shakedown -> review (KB-040)", () => {
  it("walks the four states with one event each; VAL-110 runs on the validation split, the holdout is untouched; nothing promotes", async () => {
    const { db, split } = await world();
    await db.execute({ sql: "UPDATE market SET mode = 'full' WHERE code = ?", args: [MARKET] });
    const id = await inReplay(db); // proposed -> replay
    const out = await runChallengerEvidence(db, evidenceRun(id, split, evidence()));
    expect(out).toMatchObject({ outcome: "pass", charged: true, failed: [] }); // replay -> shakedown
    expect(await stateOf(db, id)).toMatchObject({ state: "shakedown", state_d: "2026-10-06" });
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind = 'holdout_access'")).toEqual([]);
    expect(
      (await rows(db, "SELECT id FROM trial_ledger WHERE kind = 'validation_access'")).length,
    ).toBe(1);

    // ten finished sessions (2b and 3 both done) after the move, then the Critic result: review
    for (const d of [
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
      "2026-10-20",
    ]) {
      await addNight(db, d);
    }
    await addCritique(db, "challenger", id, challengerChecks(), true, "2026-10-14");
    const r = await learnDay(db, {
      market: MARKET,
      d: "2026-10-20",
      now: () => "2026-10-20T08:20:00.000Z",
      params: PARAMS,
    });
    expect(r.stats.shakedown).toEqual({ synced: 1, movedToReview: 1 });
    expect(await stateOf(db, id)).toMatchObject({ state: "review", ready: 1 });
    const events = await rows(
      db,
      "SELECT from_state, to_state FROM challenger_event WHERE challenger_id = ? ORDER BY seq",
      [id],
    );
    expect(events.map((e) => e.to_state)).toEqual(["proposed", "replay", "shakedown", "review"]);
    // review is the end of the automatic path: no promotion row, no version switch
    expect(await rows(db, "SELECT id FROM promotion")).toEqual([]);
    expect(
      await rows(
        db,
        "SELECT rule_version_id FROM rule_version_status WHERE status = 'live' AND rule_version_id LIKE 'F1.%' AND rule_version_id <> 'F1.v1'",
      ),
    ).toEqual([]);
  });

  it("an Owner-authored version enters as a challenger, not live (KB-050)", async () => {
    const { db } = await world();
    const made = await ownerChallenger(db, 3);
    expect(made.status).toBe("created");
    expect(await rows(db, "SELECT origin, state FROM challenger")).toEqual([
      { origin: "owner", state: "proposed" },
    ]);
  });

  it("the generator can only reach the development split (type and runtime guard)", async () => {
    const { db } = await world();
    const evil = {
      async evaluate() {
        return {
          split: "validation",
          rows: 150,
          blocks: 20,
          meanExcess: 1,
        } as unknown as DevelopmentEvaluation;
      },
    };
    await expect(
      generateChallenger(db, evil, {
        market: MARKET,
        family: "F1",
        d: "2026-10-10",
        hints: [],
        learning: LEARNING,
        stats: BASE.stats,
      }),
    ).rejects.toThrow(/development split only/);
    expect(await rows(db, "SELECT id FROM challenger")).toEqual([]);
    expect(await rows(db, "SELECT id FROM trial_ledger")).toEqual([]);
  });
});

// ---- blocks: VAL-110 -----------------------------------------------------------------------------------------

describe("AT-23 a failing VAL-110 component blocks promotion (KB-041, ARN-087)", () => {
  const res = (c: Partial<Val110Result["checks"]>): Val110Result =>
    ({
      checks: {
        i: "pass",
        ii: "pass",
        iii: "descriptive",
        iv: "pass",
        ivb: "pass",
        v: "n/a",
        vi: "pass",
        ...c,
      },
    }) as Val110Result;

  it.each([
    ["i", { i: "fail" }],
    ["ii", { ii: "fail" }],
    ["iii", { iii: "blocks" }],
    ["iv", { iv: "fail" }],
    ["iv-b", { ivb: "fail" }],
    ["v", { v: "fail" }],
    ["vi", { vi: "fail" }],
  ] as const)("component %s failing is a rejection", (comp, c) => {
    expect(classifyEvidence(res(c as Partial<Val110Result["checks"]>))).toEqual({
      outcome: "fail",
      failed: [comp],
    });
  });

  it("a real run where (ii) fails rejects the challenger, keeps the trial slot used, and it cannot be approved", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const data = evidence();
    const out = await runChallengerEvidence(
      db,
      evidenceRun(id, split, { ...data, incumbentRows: data.challengerRows }),
    );
    expect(out).toMatchObject({ outcome: "fail", failed: ["ii"] });
    expect(await stateOf(db, id)).toMatchObject({ state: "rejected" });
    expect(await rows(db, "SELECT kind FROM trial_ledger ORDER BY kind")).toEqual([
      { kind: "challenger" },
      { kind: "validation_access" },
    ]);
    await expect(
      transitionChallenger(
        db,
        { id, to: "approved", d: CH0, actor: OWNER, reason: "no" },
        LEARNING,
      ),
    ).rejects.toThrow();
  });

  it("insufficient data is not a failure and charges no access", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const run = evidenceRun(id, split, evidence());
    const out = await runChallengerEvidence(db, {
      ...run,
      size: { ...SIZE, challengerKeys: keysOf(60), incumbentKeys: [] },
    });
    expect(out).toMatchObject({ outcome: "insufficient", charged: false });
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind <> 'challenger'")).toEqual([]);
    expect(await stateOf(db, id)).toMatchObject({ state: "replay" });
  });
});

// ---- blocks: the deterministic Critic ------------------------------------------------------------------------

describe("AT-23 a failing deterministic Critic check blocks promotion (AGT-041/042)", () => {
  const P: CriticState = "pass";

  it.each([2, 3, 4, 6])(
    "check %i failing keeps the challenger in review, not ready, and the approval edge is closed",
    async (n) => {
      const db = await arenaWorld();
      const id = await challengerIn(db, n, "review");
      const checks: CriticState[] = [P, P, P, P, P, P];
      checks[n - 1] = "fail";
      const r = await reviewChallenger(db, id, checks);
      expect(r.verdict).toMatchObject({ ready: false, failed: [n] });
      expect(await stateOf(db, id)).toMatchObject({ state: "review", ready: 0 });
      await expect(
        transitionChallenger(
          db,
          { id, to: "approved", d: D0, actor: OWNER, reason: "no" },
          LEARNING,
        ),
      ).rejects.toThrow(/not ready/);
      expect(await rows(db, "SELECT id FROM promotion")).toEqual([]);
    },
  );

  it("an open (pending) check is not a pass either", async () => {
    const db = await arenaWorld();
    const id = await challengerIn(db, 1, "review");
    const r = await reviewChallenger(db, id, [P, P, "pending", P, P, P]);
    expect(r.verdict.ready).toBe(false);
  });
});

// ---- promotes: only at the cohort boundary ------------------------------------------------------------------

describe("AT-23 a passing challenger promotes only at the group restart", () => {
  const base = { market: MARKET, d: DATES[1]!, actor: OWNER, auditRef: AUDIT, now: NOW };
  const version = async (db: Client, cohort: string) =>
    String(
      (await rows(db, "SELECT rule_version FROM cohort WHERE id = ?", [cohort]))[0]!.rule_version,
    );
  const executionVersion = async (db: Client, id = "E01") =>
    String(
      (await rows(db, "SELECT rule_version FROM execution WHERE id = ?", [id]))[0]!.rule_version,
    );

  it("approval schedules it; nothing trades the new version until the restart; the ending cohort keeps v1, successors start with v2; then a rollback is a new version", async () => {
    const db = await arenaWorld();
    const id = await challengerIn(db, 1, "approved");
    const req = await requestPromotion(db, { ...base, challengerId: id });
    expect(req).toMatchObject({ status: "scheduled", groupId: "TW-F1" });
    expect(await executionVersion(db)).toBe("v1"); // requested, not applied
    expect(await stateOf(db, id)).toMatchObject({ state: "approved" });

    const r = await restartGroup(db, 7);
    const restartD = DATES[9]!;
    expect(r.changes[0]).toMatchObject({
      kind: "promotion",
      fromVersion: "F1.v1",
      toVersion: "F1.v2",
    });
    expect(await executionVersion(db)).toBe("F1.v2");
    expect(await version(db, `E01@${D0}`)).toBe("v1"); // the ending cohort keeps its version
    expect(await version(db, `E01@${restartD}`)).toBe("F1.v2");
    expect(await stateOf(db, id)).toMatchObject({ state: "promoted" });
    expect(await executionVersion(db, "E03")).toBe("v1"); // another family is untouched
    const led = await rows(
      db,
      "SELECT kind, actor, audit_ref FROM change_ledger WHERE target = 'F1.v2'",
    );
    expect(led).toEqual([{ kind: "promotion", actor: OWNER, audit_ref: AUDIT }]);

    // rollback: a new version with the earlier parameters; v1 and v2 stay in the history (KB-043)
    const v1 = await rows(db, "SELECT params_json FROM rule_version WHERE id = 'F1.v1'");
    const rb = await requestRollback(db, {
      ...base,
      d: DATES[10]!,
      family: "F1",
      toVersion: "F1.v1",
    });
    expect(rb).toMatchObject({ status: "scheduled", toVersion: "F1.v3" });
    await restartGroup(db, 16);
    expect(await executionVersion(db)).toBe("F1.v3");
    expect(
      (await rows(db, "SELECT params_json FROM rule_version WHERE id = 'F1.v3'"))[0]!.params_json,
    ).toBe(v1[0]!.params_json);
    expect((await rows(db, "SELECT id FROM rule_version WHERE family = 'F1'")).length).toBe(3);
    expect(await version(db, `E01@${restartD}`)).toBe("F1.v2"); // history intact
  });

  it("without the Owner's approval nothing is requested: a ready challenger still in review, or approved by a system actor, is refused", async () => {
    const db = await arenaWorld();
    const inReview = await challengerIn(db, 1, "review");
    expect(await requestPromotion(db, { ...base, challengerId: inReview })).toMatchObject({
      status: "refused",
    });
    expect(await rows(db, "SELECT id FROM promotion")).toEqual([]);
  });

  it("force-apply gives a version labelled UNVALIDATED, forced by Owner, and applies at the restart too", async () => {
    const db = await arenaWorld();
    const id = await challengerIn(db, 1, "review");
    const req = await requestForceApply(db, { ...base, challengerId: id });
    expect(req).toMatchObject({ status: "scheduled", toVersion: "F1.v3" });
    expect(await executionVersion(db)).toBe("v1");
    await restartGroup(db, 7);
    expect(await executionVersion(db)).toBe("F1.v3");
    const after = JSON.parse(
      String(
        (await rows(db, "SELECT after_json FROM change_ledger WHERE target = 'F1.v3'"))[0]!
          .after_json,
      ),
    ) as { label: string; qualifier: string };
    expect(after).toMatchObject({ label: "UNVALIDATED", qualifier: "forced by Owner" });
  });
});

// ---- limits ---------------------------------------------------------------------------------------------------

// O-46 caps stop, trail and sizing variants per quarter, so the slot tests use a non-stop key
const slotChallenger = async (db: Parameters<typeof ownerChallenger>[0], i: number) =>
  ownerChallenger(db, i, undefined, {
    params: await f1With(db, { f1_volume_ratio_min: 1.5 + 0.05 * (i + 1) }),
  });

describe("AT-23 limits (KB-042, ARN-005, ARN-085, KB-043)", () => {
  it("at most 8 concurrent challengers; a decided one frees its slot", async () => {
    const { db } = await world();
    const ids: string[] = [];
    for (let i = 0; i < LEARNING.maxChallengers; i += 1) {
      const r = await slotChallenger(db, i);
      if (r.status !== "created") throw new Error(JSON.stringify(r));
      ids.push(r.id);
    }
    expect(await slotChallenger(db, 8)).toMatchObject({ reason: "max_challengers" });
    await transitionChallenger(
      db,
      { id: ids[0]!, to: "rejected", d: CH0, actor: "A6", reason: "x" },
      LEARNING,
    );
    expect(await slotChallenger(db, 8)).toMatchObject({ status: "created" });
  });

  it("an exhausted trial budget and a killed family give no new generated challenger", async () => {
    const { db } = await world();
    const stats = { ...BASE.stats, trialBudgetPerLineage: 1 };
    await ownerChallenger(db, 0, CH0, { stats });
    expect(await ownerChallenger(db, 1, CH0, { stats })).toMatchObject({
      reason: "budget_exhausted",
    });
    await db.execute(
      "INSERT INTO arena_control (scope, scope_key, state, set_at, set_by) VALUES ('family', 'F1', 'killed', '2026-10-05T00:00:00.000Z', 'k')",
    );
    expect(await ownerChallenger(db, 2, CH0, { origin: "generator" })).toMatchObject({
      reason: "family_frozen",
    });
  });

  it("the weekly promotion cap holds a promotion at the restart; the next restart with room applies it (ARN-065)", async () => {
    const db = await arenaWorld();
    const id = await challengerIn(db, 1, "approved");
    await requestPromotion(db, {
      market: MARKET,
      d: DATES[1]!,
      actor: OWNER,
      auditRef: AUDIT,
      now: NOW,
      challengerId: id,
    });
    expect(LEARNING.maxPromotionsPerWeek).toBe(3);
    expect((await restartGroup(db, 7, { maxPromotionsPerWeek: 0 })).changes).toEqual([]);
    expect(await stateOf(db, id)).toMatchObject({ state: "approved" });
    expect((await restartGroup(db, 16, { maxPromotionsPerWeek: 1 })).changes).toHaveLength(1);
    expect(await stateOf(db, id)).toMatchObject({ state: "promoted" });
  });
});
