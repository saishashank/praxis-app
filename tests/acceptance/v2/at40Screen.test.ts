// @vitest-environment node
// AT-40 (a)-(d), screening part (M13-lite WP4): 40 synthetic ZZ clusters, 8 with a planted edge.
//  (a) only clusters with a person-checked supporting claim are screened (LLM-069);
//  (b) Benjamini-Hochberg runs ONCE over the run's clusters at expert_screen_fdr (0.10);
//  (c) planted clusters rank at the top, survivors are L1 at most;
//  (d) development rows only reach the statistic (access spy, ARN-082), nothing is written outside the expert
//      tables, the trial ledger is never touched, and a second run in the same week is a no-op.
import type { Client } from "@libsql/client";
import { afterAll, describe, expect, it } from "vitest";
import { clusterStatistic } from "@/lib/experts/screenStats";
import { screenClusters, type ScreeningSummary } from "@/lib/experts/screen";
import { currentClaimStatus } from "@/lib/experts/store";
import { EXPERT_TABLES } from "@/lib/experts/types";
import { benjaminiHochberg } from "@/lib/stats/multiplicity";
import { splitOf } from "@/lib/stats/splits";
import { cleanupTempDbs } from "../../db/helpers";
import { addCluster, fakeReplay, RUN_D, screenWorld, type Plan } from "../../experts/zzScreen";

afterAll(cleanupTempDbs);

const id = (n: number): string => `K-${String(n).padStart(3, "0")}`;
const PLANTED = Array.from({ length: 8 }, (_, i) => id(i + 1));
const NULLS = Array.from({ length: 30 }, (_, i) => id(i + 9));
const UNCHECKED = [id(39), id(40)]; // strong edge, but nobody has checked a claim

const plan: Plan = {
  ...Object.fromEntries(PLANTED.map((k, i) => [k, 0.02 + 0.001 * i])),
  ...Object.fromEntries(UNCHECKED.map((k) => [k, 0.03])),
};

/** A Client whose execute() and transaction().execute() are recorded; a write outside EXPERT_TABLES, or any trial_ledger statement, throws. */
function spyOn(db: Client, log: string[]): Client {
  const guard = (sql: string): void => {
    log.push(sql);
    if (/trial_ledger/i.test(sql)) throw new Error(`trial_ledger touched: ${sql.slice(0, 60)}`);
    const m = /^\s*(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql);
    if (m !== null && !(EXPERT_TABLES as readonly string[]).includes(m[1]!.toLowerCase())) {
      throw new Error(`write outside the expert tables: ${m[1]}`);
    }
  };
  const sqlOf = (s: unknown): string => (typeof s === "string" ? s : (s as { sql: string }).sql);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "execute") {
        return (s: unknown) => {
          guard(sqlOf(s));
          return (target.execute as (x: unknown) => unknown)(s);
        };
      }
      if (prop === "transaction") {
        return async (mode: "write") => {
          const tx = await target.transaction(mode);
          return new Proxy(tx, {
            get(t, p) {
              if (p === "execute") {
                return (s: unknown) => {
                  guard(sqlOf(s));
                  return (t.execute as (x: unknown) => unknown)(s);
                };
              }
              const v = (t as unknown as Record<string | symbol, unknown>)[p];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
          });
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

async function build(): Promise<{
  db: Client;
  run: () => Promise<ScreeningSummary>;
  seen: { development: number; other: number };
  log: string[];
  split: Awaited<ReturnType<typeof screenWorld>>["split"];
}> {
  const w = await screenWorld();
  for (const k of [...PLANTED, ...NULLS]) await addCluster(w.db, k);
  for (const k of UNCHECKED) await addCluster(w.db, k, { claimStatus: "extracted" });
  const fake = fakeReplay(w.split, plan);
  const seen = { development: 0, other: 0 };
  const log: string[] = [];
  const db = spyOn(w.db, log);
  const run = (): Promise<ScreeningSummary> =>
    screenClusters(
      { ...w.ctx, db },
      {
        replay: fake.replay,
        // the counting statistic: every row that reaches it is classified by the split
        statistic: (sample, seed, opts) => {
          for (const r of sample.rows) {
            if (splitOf(w.split, r.entryD) === "development") seen.development += 1;
            else seen.other += 1;
          }
          return clusterStatistic(sample, seed, opts);
        },
      },
    );
  return { db: w.db, run, seen, log, split: w.split };
}

let shared: Promise<Awaited<ReturnType<typeof build>> & { first: ScreeningSummary }> | null = null;
/** One screening of the 40 clusters shared by the clauses (the run is expensive and insert-once anyway). */
function setup(): NonNullable<typeof shared> {
  shared ??= build().then(async (t) => ({ ...t, first: await t.run() }));
  return shared;
}

describe("AT-40 screening (a)-(d)", () => {
  it("(a) screens only clusters with a checked supporting claim", async () => {
    const t = await setup();
    const s = t.first;
    expect(s.status).toBe("ran");
    expect(s.considered).toBe(38);
    expect(s.screened).toBe(38);
    const ids = (
      await t.db.execute("SELECT cluster_id FROM screening_result ORDER BY cluster_id")
    ).rows.map((r) => String(r.cluster_id));
    expect(ids).toEqual([...PLANTED, ...NULLS].sort());
    for (const k of UNCHECKED) expect(ids).not.toContain(k);
    // the unchecked claims stay extracted; checked ones moved owner_checked -> formalised -> screened
    expect(await currentClaimStatus(t.db, `C-${UNCHECKED[0]}`)).toBe("extracted");
    expect(await currentClaimStatus(t.db, `C-${PLANTED[0]}`)).toBe("screened");
    const chain = await t.db.execute({
      sql: "SELECT status, actor FROM claim_status WHERE claim_id = ? ORDER BY seq",
      args: [`C-${PLANTED[0]}`],
    });
    expect(chain.rows.map((r) => String(r.status))).toEqual([
      "extracted",
      "owner_checked",
      "formalised",
      "screened",
    ]);
    expect(String(chain.rows[3]!.actor)).toBe("system");
  });

  it("(b) BH runs once over the whole run at q = 0.10", async () => {
    const t = await setup();
    const s = t.first;
    const run = (await t.db.execute("SELECT * FROM screening_run")).rows;
    expect(run).toHaveLength(1);
    expect(Number(run[0]!.q)).toBe(0.1);
    expect(String(run[0]!.run_id)).toBe(`expscreen:AU:${RUN_D}`);
    const res = (await t.db.execute("SELECT * FROM screening_result ORDER BY cluster_id")).rows;
    const bh = benjaminiHochberg(
      res.map((r) => Number(r.p)),
      0.1,
      "prds",
    );
    res.forEach((r, i) => {
      expect(Number(r.adjusted_p)).toBeCloseTo(bh.adjusted[i]!, 12);
      expect(Number(r.bh_rejected)).toBe(bh.rejected[i]! ? 1 : 0);
    });
    expect(Number(run[0]!.survivors)).toBe(s.survivors);
  });

  it("(c) planted clusters survive and rank at the top; survivors are L1, the rest L0", async () => {
    const t = await setup();
    const s = t.first;
    const res = (
      await t.db.execute("SELECT * FROM screening_result ORDER BY COALESCE(rank, 999), cluster_id")
    ).rows;
    const survivors = res.filter((r) => Number(r.survived) === 1);
    expect(survivors.length).toBeGreaterThanOrEqual(8);
    for (const k of PLANTED) {
      const r = res.find((x) => String(x.cluster_id) === k)!;
      expect(Number(r.survived)).toBe(1);
      expect(Number(r.rank)).toBeLessThanOrEqual(8);
      expect(String(r.grade)).toBe("L1");
    }
    expect(
      survivors
        .slice(0, 8)
        .map((r) => String(r.cluster_id))
        .sort(),
    ).toEqual([...PLANTED]);
    expect(new Set(res.map((r) => String(r.grade)))).toEqual(new Set(["L1", "L0"]));
    expect(
      s.ranked
        .slice(0, 8)
        .map((x) => x.clusterId)
        .sort(),
    ).toEqual([...PLANTED]);
    expect(s.ranked.map((x) => x.rank)).toEqual(s.ranked.map((_, i) => i + 1));
    // few false survivors among 30 nulls, and none with an L2 grade (the column cannot hold one)
    expect(survivors.length - 8).toBeLessThanOrEqual(2);
  });

  it("(d) only development rows reach the statistic; no other table and no trial is touched", async () => {
    const t = await setup();
    expect(t.seen.development).toBeGreaterThan(0);
    expect(t.seen.other).toBe(0); // zero validation, holdout or purge rows
    expect(t.log.some((q) => /trial_ledger/i.test(q))).toBe(false);
    expect(Number((await t.db.execute("SELECT COUNT(*) AS n FROM trial_ledger")).rows[0]!.n)).toBe(
      0,
    );
    expect(Number((await t.db.execute("SELECT COUNT(*) AS n FROM challenger")).rows[0]!.n)).toBe(0);
    // a null cluster is not inflated by the +0.5 excess planted outside development
    const nullMean = (
      await t.db.execute({
        sql: "SELECT mean_excess_ppm FROM screening_result WHERE cluster_id = ?",
        args: [NULLS[0]!],
      })
    ).rows[0]!;
    expect(Math.abs(Number(nullMean.mean_excess_ppm))).toBeLessThan(20_000);
  });

  it("a second run in the same week is a no-op (insert-once per market and day)", async () => {
    const t = await setup();
    const first = t.first;
    const before = (await t.db.execute("SELECT COUNT(*) AS n FROM claim_status")).rows[0]!.n;
    const again = await t.run();
    expect(again.status).toBe("exists");
    expect(again.survivors).toBe(first.survivors);
    expect(again.ranked.map((x) => x.clusterId)).toEqual(first.ranked.map((x) => x.clusterId));
    expect((await t.db.execute("SELECT COUNT(*) AS n FROM screening_run")).rows[0]!.n).toBe(1);
    expect((await t.db.execute("SELECT COUNT(*) AS n FROM claim_status")).rows[0]!.n).toBe(before);
  });
});
