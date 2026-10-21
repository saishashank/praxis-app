// @vitest-environment node
// Challenger evidence: the VAL-110 wrapper (M6 T9; ARN-087, ARN-085, KB-040 s13; D-090, D-110 #17,
// #47): sufficiency pre-check, access-before-read, (ii) required, pass / fail / insufficient.
import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  advanceProposed,
  classifyEvidence,
  evidenceSufficiency,
  runChallengerEvidence,
  type EvidenceRows,
  type EvidenceRun,
  type EvidenceSize,
} from "@/lib/learning/challengerEvidence";
import { loadChallenger, transitionChallenger } from "@/lib/learning/challengerLifecycle";
import type { Val110Result } from "@/lib/stats/val110";
import { cleanupTempDbs } from "../db/helpers";
import { dailyReturns, makeRows, weeklyMatrix } from "../fixtures/stats/t13";
import { BASE, D0, FAST, LEARNING, ownerChallenger, rows, world } from "./challengerFixtures";

afterEach(cleanupTempDbs);

const S = 504;
const BLOCK = 5;
const N = 400;
const WINDOW_END = "2028-12-29";

const keysOf = (n: number, p = "row") => Array.from({ length: n }, (_, i) => `${p}:${i}`);
const SIZE: EvidenceSize = {
  challengerKeys: keysOf(N),
  incumbentKeys: keysOf(N),
  sessionCount: S,
  block: BLOCK,
  windowEndD: WINDOW_END,
};

type Over = Partial<EvidenceRows> & { edge?: number; stressCost?: number };

/** Evidence with a planted edge for the challenger (rows and excess) and none for the incumbent. */
function evidence(over: Over = {}): EvidenceRows {
  const own = makeRows({
    n: N,
    S,
    edge: over.edge ?? 0.03,
    stressCost: over.stressCost,
    seed: "ch:c",
  });
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
    ...over,
  };
}

async function inReplay(
  db: Client,
  over: Parameters<typeof ownerChallenger>[3] = {},
): Promise<string> {
  const r = await ownerChallenger(db, 0, D0, over);
  if (r.status !== "created") throw new Error(JSON.stringify(r));
  await transitionChallenger(
    db,
    { id: r.id, to: "replay", d: D0, actor: "A6", reason: "r" },
    LEARNING,
  );
  return r.id;
}

function run(
  id: string,
  split: EvidenceRun["split"],
  data: EvidenceRows | (() => Promise<EvidenceRows>),
  over: Partial<EvidenceRun> = {},
) {
  const calls = { n: 0, accessAtCall: [] as number[] };
  const r: { run: EvidenceRun; calls: typeof calls; db?: Client } = {
    calls,
    run: {
      challengerId: id,
      runId: "run-1",
      d: "2026-10-10",
      variant: "primary",
      split,
      stats: FAST,
      learning: LEARNING,
      activeLineages: 6,
      size: SIZE,
      loadRows: async () => {
        calls.n += 1;
        return typeof data === "function" ? data() : data;
      },
      ...over,
    },
  };
  return r;
}

const accessRows = (db: Client, kind = "validation_access") =>
  rows(db, "SELECT id, rule_version, variant, run_id, d FROM trial_ledger WHERE kind = ?", [kind]);

describe("sufficiency pre-check (entry counts only, decision 47)", () => {
  const S2 = { minTrades: 100, minBlocks: 15 };
  it("needs min_trades own entries, min_trades in the union and min_blocks blocks", () => {
    const size = (own: number, inc: number, sessions = 100, block = 5): EvidenceSize => ({
      challengerKeys: keysOf(own),
      incumbentKeys: keysOf(inc, "inc"),
      sessionCount: sessions,
      block,
      windowEndD: WINDOW_END,
    });
    expect(evidenceSufficiency(size(100, 0), S2)).toMatchObject({
      sufficient: true,
      entries: 100,
      blocks: 20,
    });
    expect(evidenceSufficiency(size(99, 500), S2).sufficient).toBe(false); // own entries short
    expect(evidenceSufficiency(size(100, 0, 74, 5), S2).sufficient).toBe(false); // 14.8 blocks
    expect(evidenceSufficiency(size(100, 0, 75, 5), S2).sufficient).toBe(true); // 15 blocks
    // duplicate keys count once
    expect(
      evidenceSufficiency({ ...size(0, 0), challengerKeys: Array(200).fill("a") }, S2).entries,
    ).toBe(1);
  });
  it("projects the date at which both floors would be met at the measured rate; none without entries", () => {
    const r = evidenceSufficiency(
      { ...SIZE, challengerKeys: keysOf(50), incumbentKeys: [] },
      { minTrades: 100, minBlocks: 15 },
    );
    // rate 50/504; 100 entries need 1008 sessions: 504 more weekdays
    expect(r).toMatchObject({
      sufficient: false,
      entries: 50,
      reachableD: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(r.reachableD! > WINDOW_END).toBe(true);
    expect(
      evidenceSufficiency(
        { ...SIZE, challengerKeys: [], incumbentKeys: [] },
        { minTrades: 100, minBlocks: 15 },
      ).reachableD,
    ).toBeNull();
  });
});

describe("classification of a VAL-110 result (decision 17)", () => {
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
  it("pass: descriptive (iii) and n/a (v) are not failures", () => {
    expect(classifyEvidence(res({}))).toEqual({ outcome: "pass", failed: [] });
    expect(classifyEvidence(res({ iii: "pass", v: "pass" })).outcome).toBe("pass");
  });
  it.each([
    ["i", { i: "fail" }],
    ["ii", { ii: "fail" }],
    ["ii", { ii: "n/a" }], // a challenger needs (ii) to PASS
    ["iii", { iii: "blocks" }],
    ["iv", { iv: "fail" }],
    ["iv-b", { ivb: "fail" }],
    ["v", { v: "fail" }],
    ["vi", { vi: "fail" }],
  ] as const)("a failed %s rejects", (comp, c) => {
    expect(classifyEvidence(res(c as Partial<Val110Result["checks"]>))).toEqual({
      outcome: "fail",
      failed: [comp],
    });
  });
  it("several failures are all listed in component order", () => {
    expect(classifyEvidence(res({ vi: "fail", i: "fail", ivb: "fail" })).failed).toEqual([
      "i",
      "iv-b",
      "vi",
    ]);
  });
  it("(i) or (ii) insufficient is insufficient even beside a failure; (vi) insufficient only when nothing failed", () => {
    expect(classifyEvidence(res({ i: "insufficient", iv: "fail" })).outcome).toBe("insufficient");
    expect(classifyEvidence(res({ ii: "insufficient", vi: "fail" })).outcome).toBe("insufficient");
    expect(classifyEvidence(res({ vi: "insufficient" })).outcome).toBe("insufficient");
    expect(classifyEvidence(res({ vi: "insufficient", iv: "fail" })).outcome).toBe("fail");
  });
});

describe("runChallengerEvidence", () => {
  it("pass: the access row exists before the rows are read; (ii) is evaluated; challenger goes to shakedown", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const seenBefore: number[] = [];
    const r = run(id, split, async () => {
      seenBefore.push((await accessRows(db)).length);
      return evidence();
    });
    const out = await runChallengerEvidence(db, r.run);
    expect(out).toMatchObject({ outcome: "pass", charged: true, failed: [] });
    expect(seenBefore).toEqual([1]); // charged first, read second
    expect(await accessRows(db)).toEqual([
      {
        id: expect.stringMatching(
          /^trial:AU:F1:1:validation_access:F1\.v2:primary:run-1:2026-10-10$/,
        ),
        rule_version: "F1.v2",
        variant: "primary",
        run_id: "run-1",
        d: "2026-10-10",
      },
    ]);
    expect(await accessRows(db, "holdout_access")).toHaveLength(0); // the holdout is never touched
    const tests = (await rows(db, "SELECT test FROM validation_result ORDER BY id")).map(
      (x) => x.test,
    );
    for (const t of ["i", "ii", "iii", "iv", "iv-b", "v", "vi"]) expect(tests).toContain(t);
    expect(await loadChallenger(db, id)).toMatchObject({
      state: "shakedown",
      state_d: "2026-10-10",
    });
    const ev = (
      await rows(db, "SELECT reason, ref_json FROM challenger_event WHERE to_state = 'shakedown'")
    )[0]!;
    const ref = JSON.parse(String(ev.ref_json)) as {
      checks: { ii: string };
      validation_result_ids: string[];
      trial_id: string;
    };
    expect(ref.checks.ii).toBe("pass");
    expect(ref.validation_result_ids.length).toBe(tests.length);
    expect(ref.trial_id).toMatch(/validation_access/);
    // a repeat finds the challenger already decided: nothing read, nothing charged
    const again = run(id, split, evidence());
    expect(await runChallengerEvidence(db, again.run)).toMatchObject({
      outcome: "skipped",
      reason: "not_in_replay",
    });
    expect(again.calls.n).toBe(0);
    expect(await accessRows(db)).toHaveLength(1);
  });

  it("insufficient entries: nothing is charged, nothing is read, the reachable date is returned", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const r = run(id, split, evidence(), {
      size: { ...SIZE, challengerKeys: keysOf(60), incumbentKeys: [] },
    });
    const out = await runChallengerEvidence(db, r.run);
    expect(out).toMatchObject({
      outcome: "insufficient",
      charged: false,
      reachableD: expect.any(String),
    });
    expect(r.calls.n).toBe(0);
    expect(await rows(db, "SELECT id FROM trial_ledger WHERE kind <> 'challenger'")).toHaveLength(
      0,
    );
    expect(await rows(db, "SELECT id FROM validation_result")).toHaveLength(0);
    expect((await loadChallenger(db, id))!.state).toBe("replay");
    // too few blocks is the same
    const few = run(id, split, evidence(), { size: { ...SIZE, sessionCount: 70 } });
    expect(await runChallengerEvidence(db, few.run)).toMatchObject({
      outcome: "insufficient",
      charged: false,
    });
    expect(few.calls.n).toBe(0);
  });

  it("insufficient after the pre-check (no matched controls): the charge stands, the challenger stays, a later run is a new look", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const noControls = evidence();
    const bare = { ...noControls, rows: noControls.rows.map((x) => ({ ...x, excess: null })) };
    const out = await runChallengerEvidence(db, run(id, split, bare).run);
    expect(out).toMatchObject({ outcome: "insufficient", charged: true });
    expect((await loadChallenger(db, id))!.state).toBe("replay");
    expect(await accessRows(db)).toHaveLength(1);
    const later = await runChallengerEvidence(
      db,
      run(id, split, evidence(), { runId: "run-2", d: "2026-10-17" }).run,
    );
    expect(later).toMatchObject({ outcome: "pass", charged: true });
    expect(await accessRows(db)).toHaveLength(2);
  });

  it("(vi) without daily returns is insufficient, not a failure", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const out = await runChallengerEvidence(db, run(id, split, evidence({ dsr: null })).run);
    expect(out).toMatchObject({ outcome: "insufficient", charged: true });
    expect((await loadChallenger(db, id))!.state).toBe("replay");
  });

  const failing: [string, Over][] = [
    ["i", { edge: 0 }],
    ["iii", { safety: { effectiveN: 10, delta: 0.2, firstBlockD: null } }],
    ["iv", { stressCost: 0.05 }],
    ["iv-b", { costInfeasible: true }],
    ["v", { pboWeekly: weeklyMatrix(104, 6, 0) }],
    [
      "vi",
      {
        dsr: {
          daily: dailyReturns(500, -0.002, 0.01),
          variantDailySr: [],
          defaultSrVariance: 0.0001,
        },
      },
    ],
  ];
  it.each(failing)(
    "a failed %s rejects the challenger; the trial stays used and the slot is freed",
    async (comp, over) => {
      const { db, split } = await world();
      const id = await inReplay(db);
      let data = evidence(over);
      if (comp === "i") {
        // (i) fails on the rows while (ii) still compares excess: keep (ii) passing
        const good = evidence();
        data = { ...good, rows: evidence({ edge: 0 }).rows };
      }
      const out = await runChallengerEvidence(db, run(id, split, data).run);
      expect(out).toMatchObject({ outcome: "fail", charged: true, failed: [comp] });
      expect(await loadChallenger(db, id)).toMatchObject({ state: "rejected", ready: 0 });
      const ev = (
        await rows(db, "SELECT reason FROM challenger_event WHERE to_state = 'rejected'")
      )[0]!;
      expect(ev.reason).toBe(`VAL-110 failed: ${comp}`);
      expect(await rows(db, "SELECT kind FROM trial_ledger ORDER BY kind")).toEqual([
        { kind: "challenger" },
        { kind: "validation_access" },
      ]);
    },
  );

  it("(ii) must pass: a challenger no better than its incumbent is rejected", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const data = evidence();
    const same = { ...data, incumbentRows: data.challengerRows };
    const out = await runChallengerEvidence(db, run(id, split, same).run);
    expect(out).toMatchObject({ outcome: "fail", failed: ["ii"] });
    expect((await rows(db, "SELECT outcome FROM validation_result WHERE test = 'ii'"))[0]).toEqual({
      outcome: "challenger does not beat incumbent",
    });
  });

  it("(ii) counts rows present in one version only against 0 excess", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const data = evidence();
    // the incumbent takes none of the challenger's trades: every row is the challenger's alone
    const out = await runChallengerEvidence(db, run(id, split, { ...data, incumbentRows: [] }).run);
    expect(out).toMatchObject({ outcome: "pass" });
  });

  it("a crash between the charge and the result is repaired by the same run: one charge only", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    await expect(
      runChallengerEvidence(
        db,
        run(id, split, async () => {
          throw new Error("worker died");
        }).run,
      ),
    ).rejects.toThrow(/worker died/);
    expect(await accessRows(db)).toHaveLength(1);
    expect((await loadChallenger(db, id))!.state).toBe("replay");
    const out = await runChallengerEvidence(db, run(id, split, evidence()).run);
    expect(out).toMatchObject({ outcome: "pass", charged: false });
    expect(await accessRows(db)).toHaveLength(1);
  });

  it("results are deterministic: the same data gives the same stored statistics", async () => {
    const a = await world(),
      b = await world();
    const ida = await inReplay(a.db),
      idb = await inReplay(b.db);
    await runChallengerEvidence(a.db, run(ida, a.split, evidence()).run);
    await runChallengerEvidence(b.db, run(idb, b.split, evidence()).run);
    const q =
      "SELECT id, test, level, B, n, blocks, stat, p, mde, lower, upper, outcome FROM validation_result ORDER BY id";
    expect(await rows(a.db, q)).toEqual(await rows(b.db, q));
  });

  it("skips a deferred split and an exhausted lineage budget without reading or charging", async () => {
    const { db, split } = await world();
    const id = await inReplay(db);
    const deferred = run(
      id,
      { ...split, deferred_until_d: "2027-01-01", dev_end_d: null },
      evidence(),
    );
    expect(await runChallengerEvidence(db, deferred.run)).toMatchObject({
      outcome: "skipped",
      reason: "split_deferred",
    });
    expect(deferred.calls.n).toBe(0);
    const spent = run(id, split, evidence(), { budgetTotal: 1 }); // the challenger's own trial already used it
    expect(await runChallengerEvidence(db, spent.run)).toMatchObject({
      outcome: "skipped",
      reason: "budget_exhausted",
      charged: false,
    });
    expect(spent.calls.n).toBe(0);
    expect(await accessRows(db)).toHaveLength(0);
    // the default budget (20) is not exhausted
    expect((await runChallengerEvidence(db, run(id, split, evidence()).run)).outcome).toBe("pass");
  });

  it("only a challenger in replay is evaluated; an unknown id throws", async () => {
    const { db, split } = await world();
    const r = await ownerChallenger(db, 0);
    if (r.status !== "created") throw new Error("x");
    const proposed = run(r.id, split, evidence());
    expect(await runChallengerEvidence(db, proposed.run)).toMatchObject({
      outcome: "skipped",
      reason: "not_in_replay",
    });
    expect(proposed.calls.n).toBe(0);
    await expect(
      runChallengerEvidence(db, run("C-AU-F1-99", split, evidence()).run),
    ).rejects.toThrow(/unknown challenger/);
  });
});

describe("proposed -> replay", () => {
  it("moves on enough validation entries and charges nothing", async () => {
    const { db } = await world();
    const r = await ownerChallenger(db, 0);
    if (r.status !== "created") throw new Error("x");
    const args = { challengerId: r.id, d: "2026-10-10", stats: BASE.stats, learning: LEARNING };
    const few = await advanceProposed(db, {
      ...args,
      size: { ...SIZE, challengerKeys: keysOf(10), incumbentKeys: [] },
    });
    expect(few.moved).toBe(false);
    expect((await loadChallenger(db, r.id))!.state).toBe("proposed");
    const enough = await advanceProposed(db, { ...args, size: SIZE });
    expect(enough).toMatchObject({ moved: true, sufficiency: { sufficient: true } });
    expect((await loadChallenger(db, r.id))!.state).toBe("replay");
    expect((await advanceProposed(db, { ...args, size: SIZE })).moved).toBe(false); // repeat
    expect(await rows(db, "SELECT kind FROM trial_ledger")).toEqual([{ kind: "challenger" }]);
  });
});
