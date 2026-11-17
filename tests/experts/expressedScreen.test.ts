// @vitest-environment node
// Expressed clusters in the weekly screening (M22 E4; KB-085, D-1436, D-1437, D-1438): an expressed cluster enters the
// SAME single Benjamini-Hochberg pass as a counted hypothesis, is charged once, reads development rows only (the holdout
// is never looked at: the data source is refused a non-development date and no trial is spent), and is never a
// challenger candidate. Synthetic ZZ data over a real migrated database with an injected replay and rule data.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import type { ExpressedRule, ExpressionExit } from "@/lib/agents/families/ruleSchema";
import type { RuleDataSource } from "@/lib/experts/ruleEval";
import { readRunSurvivors, screenClusters, type ScreenContext } from "@/lib/experts/screen";
import { currentClaimStatus } from "@/lib/experts/store";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";
import { splitOf, type LineageSplitRecord } from "@/lib/stats/splits";
import { cleanupTempDbs } from "../db/helpers";
import { addCluster, fakeReplay, NOW, SESSIONS, screenWorld } from "./zzScreen";

afterAll(cleanupTempDbs);

const CODES = ["ZZA", "ZZB", "ZZC", "ZZD"] as const;
const SHA = "a".repeat(64);
const RULE: ExpressedRule = {
  schema_version: 2,
  entry: { field: "rsi2", op: "<", value: 10 },
} as ExpressedRule;
const EXIT: ExpressionExit = { family: "F1", kind: "hold", sessions: 5 };

function gauss(rng: ReturnType<typeof scopedPrng>): number {
  let s = 0;
  for (let i = 0; i < 12; i += 1) s += uniform01(rng);
  return s - 6;
}

type Source = RuleDataSource & { readonly asked: Set<string> };

/**
 * Four codes, one signal every 8th session (staggered), a planted mean return `edge` over the 5 sessions after each
 * signal, and a LEAK outside development: a huge return, so any read of a validation or holdout session shows.
 */
function makeSource(split: LineageSplitRecord, seed: string, edge: number, leak: number): Source {
  const index = new Map(SESSIONS.map((d, i) => [d, i]));
  const isDev = (d: string): boolean => splitOf(split, d) === "development";
  const signal = (c: number, i: number): boolean => (i + c) % 8 === 0;
  const closes = CODES.map((_, c) => {
    const rng = scopedPrng(`zzx:${seed}:${c}`);
    const out: number[] = [];
    let p = 100;
    for (let i = 0; i < SESSIONS.length; i += 1) {
      let r = 0.004 * gauss(rng);
      for (let k = 1; k <= 5; k += 1) if (i - k >= 0 && signal(c, i - k)) r += edge / 5;
      if (!isDev(SESSIONS[i]!)) r += leak;
      p *= 1 + r;
      out.push(p);
    }
    return out;
  });
  const asked = new Set<string>();
  const code = (x: string): number => CODES.indexOf(x as (typeof CODES)[number]);
  return {
    asked,
    codes: () => CODES,
    sector: () => "s1",
    field: (x, field, d) => {
      asked.add(d);
      const i = index.get(d)!;
      if (field === "rsi2") return signal(code(x), i) ? 5 : 50;
      // rsi14 is low on sessions 6 (mod 8) after a signal: the planted bump covers days 1 to 5 only, so a 2-session
      // hold from there (days 7 and 0) carries no edge: the null hypothesis
      if (field === "rsi14") return (i + code(x)) % 8 === 6 ? 5 : 50;
      return null;
    },
    close: (x, d) => {
      asked.add(d);
      return closes[code(x)]![index.get(d)!]!;
    },
    control: (_x, a, b) => {
      asked.add(a);
      asked.add(b);
      return 0;
    },
  };
}

async function addExpression(
  db: Client,
  id: string,
  o: { rule?: unknown; exit?: unknown; version?: number } = {},
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO cluster_expression (cluster_id, version, outcome, rule_json, exit_json, park_reason,
            reason_text, prereg_sha, created_at) VALUES (?, ?, 'expressed', ?, ?, NULL, 'ZZ entry rule', ?, ?)`,
    args: [
      id,
      o.version ?? 1,
      JSON.stringify(o.rule ?? RULE),
      JSON.stringify(o.exit ?? EXIT),
      SHA,
      NOW,
    ],
  });
}

const rowsOf = async (db: Client, sql: string) =>
  (await db.execute(sql)).rows.map((r) => ({ ...r }));
const num = (v: unknown): number => Number(v);

/** The Benjamini-Hochberg adjusted p-values of `ps` over m = ps.length hypotheses (step-up, as the pass computes them). */
function bhAdjusted(ps: readonly number[]): number[] {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = new Array<number>(m);
  let running = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    running = Math.min(running, (order[k]!.p * m) / (k + 1));
    adj[order[k]!.i] = running;
  }
  return adj;
}

async function world() {
  const w = await screenWorld(["F1"]);
  return { ...w, ctxAt: (d: string): ScreenContext => ({ ...w.ctx, d }) };
}

describe("an expressed cluster is one counted hypothesis in the single BH pass", () => {
  it("is screened with the fitted clusters in ONE run; its adjusted p is over all of them, and it is charged once", async () => {
    const w = await world();
    await addCluster(w.db, "K-001"); // a fitted cluster
    await addCluster(w.db, "K-002", { fit: null });
    await addCluster(w.db, "K-003", { fit: null });
    await addCluster(w.db, "K-004", { fit: null });
    await addExpression(w.db, "K-002"); // rsi2 < 10, hold 5: the planted edge
    await addExpression(w.db, "K-003", {
      rule: { schema_version: 2, entry: { field: "rsi14", op: "<", value: 10 } },
      exit: { family: "F1", kind: "hold", sessions: 2 },
    }); // no edge
    await addExpression(w.db, "K-004", { exit: { family: "F1", kind: "hold", sessions: 3 } });
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, { "K-001": 0.03 }).replay,
      expressedSource: () => makeSource(w.split, "all", 0.02, 0.5),
    });
    expect(s.status).toBe("ran");
    expect(s).toMatchObject({ considered: 4, eligible: 4, screened: 4 });
    expect(await rowsOf(w.db, "SELECT run_id FROM screening_run")).toHaveLength(1);
    const res = await rowsOf(
      w.db,
      "SELECT cluster_id, family, params_sha, p, adjusted_p, survived FROM screening_result ORDER BY cluster_id",
    );
    expect(res.map((r) => r.cluster_id)).toEqual(["K-001", "K-002", "K-003", "K-004"]);
    // BH over m = 4: the stored adjusted p equals the step-up adjustment of the four p-values together
    const want = bhAdjusted(res.map((r) => num(r.p)));
    res.forEach((r, i) => expect(num(r.adjusted_p), String(r.cluster_id)).toBeCloseTo(want[i]!, 9));
    // the expressed row carries the family of its exit and a 64-hex expression hash
    expect(res[1]!.family).toBe("F1");
    expect(String(res[1]!.params_sha)).toMatch(/^[0-9a-f]{64}$/);
    // the planted edge is found, the null one is not; the claims of an expressed cluster move like any other
    expect(num(res[1]!.survived)).toBe(1);
    expect(num(res[2]!.survived)).toBe(0);
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("screened");
    // an expressed cluster is never a challenger candidate: only the fitted survivor is ranked
    expect(s.ranked.map((r) => r.clusterId)).toEqual(["K-001"]);
    expect((await readRunSurvivors(w.db, s.runId)).map((r) => r.clusterId)).toEqual(["K-001"]);
  });

  it("an expression already screened is not screened again (charged once); a new version is a new hypothesis", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002");
    const deps = {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    };
    expect((await screenClusters(w.ctxAt("2026-10-10"), deps)).screened).toBe(1);
    const again = await screenClusters(w.ctxAt("2026-10-17"), deps);
    expect(again).toMatchObject({ status: "ran", considered: 1, eligible: 1, screened: 0 });
    expect(again.skipped).toEqual([{ clusterId: "K-002", reason: "already_screened" }]);
    expect(
      await rowsOf(w.db, "SELECT 1 FROM screening_result WHERE cluster_id = 'K-002'"),
    ).toHaveLength(1);
    // the same rule with a different pre-registration is a different hypothesis (version 2 carries another hash)
    await w.db.execute({
      sql: `INSERT INTO cluster_expression (cluster_id, version, outcome, rule_json, exit_json, park_reason,
              reason_text, prereg_sha, created_at) VALUES ('K-002', 2, 'expressed', ?, ?, NULL, 'ZZ v2', ?, ?)`,
      args: [JSON.stringify(RULE), JSON.stringify(EXIT), "b".repeat(64), NOW],
    });
    expect((await screenClusters(w.ctxAt("2026-10-24"), deps)).screened).toBe(1);
  });

  it("a cluster with a family fit is screened as a fit, never also as an expression", async () => {
    const w = await world();
    await addCluster(w.db, "K-001"); // fitted
    await addExpression(w.db, "K-001"); // an expression row beside a fit is ignored
    const fake = fakeReplay(w.split, { "K-001": 0.02 });
    const s = await screenClusters(w.ctx, {
      replay: fake.replay,
      expressedSource: () => makeSource(w.split, "K-001", 0.02, 0),
    });
    expect(s).toMatchObject({ considered: 1, screened: 1 });
    expect(fake.calls).toEqual(["F1.expert:K-001"]);
    expect(await rowsOf(w.db, "SELECT 1 FROM screening_result")).toHaveLength(1);
  });
});

describe("development rows only; the holdout is never looked at", () => {
  it("the data source is only asked for development sessions", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002");
    const src = makeSource(w.split, "K-002", 0.02, 0.5);
    await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => src,
    });
    expect(src.asked.size).toBeGreaterThan(100);
    expect([...src.asked].filter((d) => splitOf(w.split, d) !== "development")).toEqual([]);
  });

  it(
    "the statistic does not move when every non-development session changes (a leak would show)",
    { timeout: 90_000 },
    async () => {
      const out: unknown[] = [];
      for (const leak of [0, 0.5, -0.4]) {
        const w = await world();
        await addCluster(w.db, "K-002", { fit: null });
        await addExpression(w.db, "K-002");
        await screenClusters(w.ctx, {
          replay: fakeReplay(w.split, {}).replay,
          expressedSource: () => makeSource(w.split, "K-002", 0.02, leak),
        });
        out.push(
          await rowsOf(
            w.db,
            "SELECT rows, blocks, mean_net_ppm, mean_excess_ppm, lower90_ppm, p FROM screening_result",
          ),
        );
      }
      expect((out[0] as unknown[]).length).toBe(1);
      expect(out[1]).toEqual(out[0]);
      expect(out[2]).toEqual(out[0]);
    },
  );

  it("no trial is charged and no holdout look is spent by the screening", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002");
    const before = await rowsOf(w.db, "SELECT COUNT(*) AS n FROM trial_ledger");
    await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    });
    expect(await rowsOf(w.db, "SELECT COUNT(*) AS n FROM trial_ledger")).toEqual(before);
    expect(
      await rowsOf(w.db, "SELECT 1 FROM trial_ledger WHERE kind LIKE '%holdout%'"),
    ).toHaveLength(0);
  });
});

describe("what keeps an expressed cluster out of the pass, with the reason", () => {
  it("an invalid expression is skipped as such and is not eligible", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002", {
      rule: { schema_version: 2, entry: { field: "rsi2", op: "<", param: "f1_trail_atr" } },
    });
    await addCluster(w.db, "K-003", { fit: null });
    await addExpression(w.db, "K-003", { exit: { family: "F1", kind: "hold", sessions: 0 } });
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    });
    expect(s).toMatchObject({ considered: 2, eligible: 0, screened: 0 });
    expect(s.skipped).toEqual(
      expect.arrayContaining([
        { clusterId: "K-002", reason: "invalid_expression" },
        { clusterId: "K-003", reason: "invalid_expression" },
      ]),
    );
    expect(await currentClaimStatus(w.db, "C-K-002")).toBe("owner_checked");
  });

  it("no rule data: skipped as no_rule_data and the fitted clusters still run", async () => {
    const w = await world();
    await addCluster(w.db, "K-001");
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002");
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, { "K-001": 0.02 }).replay,
    });
    expect(s).toMatchObject({ status: "ran", considered: 2, screened: 1 });
    expect(s.skipped).toEqual([{ clusterId: "K-002", reason: "no_rule_data" }]);
  });

  it("an unconfirmed cluster, or one without a checked claim, is not screened", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null, state: "proposed" });
    await addCluster(w.db, "K-003", { fit: null, claimStatus: "extracted" });
    await addCluster(w.db, "K-004", { fit: null, testability: "needs_new_data" });
    for (const id of ["K-002", "K-003", "K-004"]) await addExpression(w.db, id);
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    });
    expect(s.status).toBe("nothing_eligible");
  });

  it("a parked expression is not a candidate; the newest version decides", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002");
    await w.db.execute({
      sql: `INSERT INTO cluster_expression (cluster_id, version, outcome, rule_json, exit_json, park_reason,
              reason_text, prereg_sha, created_at) VALUES ('K-002', 2, 'parked', NULL, NULL, 'needs_intraday', 'ZZ', NULL, ?)`,
      args: [NOW],
    });
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    });
    expect(s.status).toBe("nothing_eligible");
  });

  it("too few development rows is insufficient, as for a fitted cluster, and gets no result row", async () => {
    const w = await world();
    await addCluster(w.db, "K-002", { fit: null });
    await addExpression(w.db, "K-002", {
      rule: { schema_version: 2, entry: { field: "rsi2", op: "<", value: -1 } }, // never true
    });
    const s = await screenClusters(w.ctx, {
      replay: fakeReplay(w.split, {}).replay,
      expressedSource: () => makeSource(w.split, "K-002", 0.02, 0),
    });
    expect(s.skipped).toEqual([{ clusterId: "K-002", reason: "insufficient_rows" }]);
    expect(await rowsOf(w.db, "SELECT 1 FROM screening_result")).toHaveLength(0);
  });
});
