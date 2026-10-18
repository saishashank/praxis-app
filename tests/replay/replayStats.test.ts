// @vitest-environment node
// The replay statistics end to end (M4 T14; design 4.7, 4.11; ARN-049, ARN-053, ARN-071, ARN-102):
// signal ledger + rolling-start cohorts of the three synthetic years -> `replay_stat` / `replay_run`
// rows with a determinism digest. Two builds give identical rows; effective N in the rows is the M3
// one; the rows insert into the migration 0008 tables; sleeve figures exist at 10x and at 5x.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { agentParamsSha } from "@/lib/agents/params";
import { effectiveNByExecution, type EffectiveNCohort } from "@/lib/arena/cohort";
import { replayCohorts, type CohortReplayResult } from "@/lib/replay/cohortReplay";
import { replayLedger, type LedgerResult } from "@/lib/replay/ledger";
import {
  buildReplayStats,
  leaveOneClassOut,
  replayDigest,
  replayRunRow,
  type ReplayStatRow,
  type ScorecardInput,
} from "@/lib/replay/scorecards";
import { cleanupTempDbs, freshDb } from "../db/helpers";
import { buildDataset, freshReplayDb, terminalOverrides } from "../arena/replayHarness";
import { buildCohortWorld, seriesFromHarness } from "../fixtures/replay/cohortWorld";

const base = defaultAgentParams();
const p = { ...base, replay: { ...base.replay, zeroEdgeTrials: 400 } };
const FAMILIES = ["F1", "F2", "F3", "F4", "F5", "F6"];
const SESSIONS = 780;

let dates: string[] = [];
let world: ReturnType<typeof buildCohortWorld>;
let ledger: LedgerResult;
let cohorts: CohortReplayResult;
let input: ScorecardInput;

beforeAll(async () => {
  const db = await freshReplayDb();
  const ds = await buildDataset(db, { startD: "2030-01-07", sessions: SESSIONS, seed: 11 });
  dates = ds.dates;
  world = buildCohortWorld(dates, await seriesFromHarness(db, dates, ds.spec), p);
  ledger = replayLedger(world, { params: p });
  cohorts = replayCohorts(world, {
    params: p,
    cohortParams: () => terminalOverrides(),
    controlsPerFamily: 2,
    step: 10,
  });
  input = {
    runId: "run-1",
    d: dates[SESSIONS - 1]!,
    params: p,
    market: "AU",
    families: FAMILIES,
    cohorts,
    ledger,
    src: world,
    timeoutSessions: 130,
    patterns: true,
  };
}, 120000);
afterAll(cleanupTempDbs);

let memo: ReturnType<typeof buildReplayStats> | null = null;
const built = (): ReturnType<typeof buildReplayStats> => (memo ??= buildReplayStats(input));

const rowOf = (rows: readonly ReplayStatRow[], scope: string, metric: string) => {
  const r = rows.find((x) => x.scope === scope && x.metric === metric);
  if (r === undefined) throw new Error(`no ${scope} / ${metric}`);
  return JSON.parse(r.value_json) as Record<string, unknown>;
};

describe("buildReplayStats", () => {
  it("is deterministic: two builds give identical rows and the same digest", () => {
    const a = buildReplayStats(input);
    const b = buildReplayStats(input);
    expect(a.rows).toEqual(b.rows);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    // the digest covers the cohorts too: change one outcome and it moves
    const moved = {
      ...cohorts,
      cohorts: cohorts.cohorts.map((c, i) =>
        i === 0 ? { ...c, outcomeMicro: c.outcomeMicro + 1n } : c,
      ),
    };
    expect(replayDigest({ cohorts: moved, stats: a.rows })).not.toBe(a.digest);
  });

  it("writes cif, effective_n and nav_minus_seed rows per execution, base and reality", () => {
    const { rows } = built();
    for (const scope of ["E01", "E07", "E08", "E08~reality", "C2-F4", "C3-F4"]) {
      expect(
        rows.some((r) => r.scope === scope && r.metric === "cif"),
        scope,
      ).toBe(true);
      expect(
        rows.some((r) => r.scope === scope && r.metric === "effective_n"),
        scope,
      ).toBe(true);
    }
    const cif = rowOf(rows, "E07", "cif") as {
      proportions: { horizon: number }[];
      aalenJohansen: unknown[];
      bootstrap: unknown[] | null;
    };
    expect(cif.proportions.map((x) => x.horizon)).toEqual([63, 126, 252]);
    expect(cif.aalenJohansen.length).toBe(3);
    expect(cif.bootstrap).not.toBeNull(); // E executions carry bootstrap intervals
    expect(rowOf(rows, "C2-F4", "cif").bootstrap).toBeNull(); // pooled controls: point estimates only
  });

  it("effective N in the rows equals the M3 effectiveN of the same cohorts", () => {
    const { rows } = built();
    const asEffective = (c: CohortReplayResult["cohorts"][number]): EffectiveNCohort => ({
      id: c.id,
      executionId: c.executionId,
      startD: c.startD,
      terminalD: c.censored ? null : c.endD,
      terminalKind: c.terminalKind,
    });
    const m3 = effectiveNByExecution(
      cohorts.cohorts.filter((c) => c.group === "base").map(asEffective),
    );
    for (const [id, want] of m3) {
      expect((rowOf(rows, id, "effective_n") as { n: number }).n, id).toBe(want.n);
    }
  });

  it("headline figures subtract the matched C2 value; progress hides cells below effective N 3", () => {
    const { rows } = built();
    const h = rowOf(rows, "E07", "headline") as {
      comparator: string;
      effectiveN: number;
      navMinusC2Micro: number | null;
    };
    expect(h.comparator).toBe("C2-F4");
    expect(h.effectiveN).toBeGreaterThanOrEqual(3);
    const progress = rows.filter((r) => r.metric === "progress");
    expect(progress.length).toBeGreaterThan(0);
    for (const r of progress) {
      for (const cell of JSON.parse(r.value_json) as {
        effectiveN: number;
        pTarget: number | null;
      }[]) {
        expect(cell.pTarget === null).toBe(cell.effectiveN < p.stats.progressMinNeff);
      }
    }
  });

  it("sleeve figures at 10x and at the reality-adjusted 5x, labelled hypothetical leverage (ARN-049)", () => {
    const { rows } = built();
    const s = rowOf(rows, "sleeve:F4", "sleeve_leverage") as {
      label: string;
      levered: { leverage: number; sleeveTrades: number };
      reality: { leverage: number };
      unlevered: { executionId: string };
    };
    expect(s.label).toBe("hypothetical leverage");
    expect(s.levered.leverage).toBe(10);
    expect(s.reality.leverage).toBe(5);
    expect(s.unlevered.executionId).toBe("E07");
    expect(s.levered.sleeveTrades).toBeGreaterThan(0);
  });

  it("zero-edge benchmark per measured family and the PRD-020 table, with trials and seed stated", () => {
    const { rows } = built();
    const z = rowOf(rows, "AU:F4:F4.v1", "zero_edge") as {
      trials: number;
      seed: number;
      scope: string;
    };
    expect(z.trials).toBe(400);
    expect(z.seed).toBe(p.replay.zeroEdgeSeed);
    expect(z.scope).toBe("zeroedge:F4:F4.v1");
    expect(rows.some((r) => r.scope === "PRD-020" && r.metric === "zero_edge")).toBe(true);
    // families without development rows are said to be skipped, not invented
    expect(rowOf(rows, "all", "family_flow")).toHaveLength(1);
  });

  it("scorecards say how little history there is when it is little", () => {
    const { rows } = built();
    const card = rowOf(rows, "AU:F4|F4.v1|F4", "scorecard") as {
      insufficient: boolean;
      message: string;
    };
    expect(card.insufficient).toBe(true);
    expect(card.message).toBe(`Not enough history yet (n = ${ledger.entries.length})`);
  });
});

describe("ARN-076 on the real ledger", () => {
  it("re-runs the F6 ledger with each evidence class disabled and is deterministic", () => {
    const run = (off: string | null) =>
      replayLedger(world, {
        params: p,
        controls: false,
        familyOptions: { families: ["F6"], f6DisabledClasses: off === null ? [] : [off] },
      });
    const a = leaveOneClassOut(run, dates, p, "AU:F6");
    expect(a.classes.map((c) => c.class)).toEqual(["a", "b", "c", "d"]);
    expect(a.all.disabled).toBeNull();
    expect(leaveOneClassOut(run, dates, p, "AU:F6")).toEqual(a);
  });
});

describe("rows against migration 0008", () => {
  it("replay_run and replay_stat rows satisfy the table checks", async () => {
    const out = built();
    const db = await freshDb("main");
    const run = replayRunRow({
      id: "run-1",
      kind: "full",
      market: "AU",
      snapshotSha: "a".repeat(64),
      commitSha: "b".repeat(40),
      paramsSha: agentParamsSha(p),
      seed: 20261011n,
      nodeVersion: process.version,
      minutes: 0.25,
      files: ["replay-2031-01/cohorts.json"],
      digest: out.digest,
    });
    await db.execute({
      sql: `INSERT INTO replay_run (id, kind, market, snapshot_sha, commit_sha, params_sha, seed, node_version, files_json, minutes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        run.id,
        run.kind,
        run.market,
        run.snapshot_sha,
        run.commit_sha,
        run.params_sha,
        run.seed,
        run.node_version,
        run.files_json,
        run.minutes,
      ],
    });
    for (let i = 0; i < out.rows.length; i += 50) {
      await db.batch(
        out.rows.slice(i, i + 50).map((r) => ({
          sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)",
          args: [r.run_id, r.scope, r.metric, r.d, r.value_json],
        })),
        "write",
      );
    }
    const n = await db.execute("SELECT COUNT(*) AS n FROM replay_stat WHERE run_id = 'run-1'");
    expect(Number(n.rows[0]!.n)).toBe(out.rows.length);
    const stored = await db.execute("SELECT files_json FROM replay_run WHERE id = 'run-1'");
    expect(JSON.parse(String(stored.rows[0]!.files_json)).digest).toBe(out.digest);
    await expect(
      db.execute({
        sql: "INSERT INTO replay_stat (run_id, scope, metric, d, value_json) VALUES (?, ?, ?, ?, ?)",
        args: ["run-1", out.rows[0]!.scope, out.rows[0]!.metric, out.rows[0]!.d, "{}"],
      }),
    ).rejects.toThrow();
  });
});
