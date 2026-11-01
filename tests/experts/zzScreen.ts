// Builders for the M13-lite screening tests (synthetic ZZ clusters; no network, no real experts, SEC-110).
// The replay is injected: a deterministic fake ledger per cluster whose rows exist in EVERY split, with a huge
// excess outside development, so any leak of validation or holdout rows into the statistic is visible.
import type { Client } from "@libsql/client";
import { FAMILY_PARAM_KEYS } from "@/lib/agents/families/ruleSchema";
import type { Family } from "@/lib/agents/schema";
import { CONFIG_KEYS } from "@/lib/config/keys";
import type { ReplayFn } from "@/lib/experts/devView";
import type { ScreenContext } from "@/lib/experts/screen";
import {
  appendClaimStatus,
  appendClusterState,
  insertClaim,
  mergeClaimIntoCluster,
} from "@/lib/experts/store";
import type { LedgerResult } from "@/lib/replay/ledger";
import { scopedPrng, uniform01 } from "@/lib/stats/rng";
import { splitOf, type LineageSplitRecord } from "@/lib/stats/splits";
import { weekdayCalendar } from "../fixtures/stats/t13";
import { BASE, MARKET, world } from "../learning/challengerFixtures";

export const NOW = "2030-03-05T08:00:00.000Z";
export const RUN_D = "2026-10-10";
/** Small enough for a test, large enough that a planted edge is unmistakable. */
export const TEST_PARAMS = {
  ...BASE,
  stats: { ...BASE.stats, minTrades: 20, minBlocks: 3, bootstrapReplicationsMin: 400 },
};

export const SESSIONS = weekdayCalendar(2000);

type Def = { default: unknown };
/** A valid full F1 parameter set; `i` varies the trailing stop inside its 2..4 bounds. */
export function f1Params(i: number): Record<string, unknown> {
  const p = Object.fromEntries(
    FAMILY_PARAM_KEYS.F1.map((k) => [
      k,
      (CONFIG_KEYS as unknown as Record<string, Def>)[k]!.default,
    ]),
  );
  return { ...p, f1_trail_atr: 2 + (i % 40) * 0.05 };
}
export const f1Fit = (i: number): { family: Family; params: Record<string, unknown> } => ({
  family: "F1",
  params: f1Params(i),
});

/** A valid fit of any family at the registry defaults (F6 included: its weights object passes fitCheck, D-590). */
export const defaultFit = (
  family: Family,
): { family: Family; params: Record<string, unknown> } => ({
  family,
  params: Object.fromEntries(
    FAMILY_PARAM_KEYS[family].map((k) => [
      k,
      (CONFIG_KEYS as unknown as Record<string, Def>)[k]!.default,
    ]),
  ),
});

export async function screenWorld(
  families: readonly Family[] = ["F1"],
): Promise<{ db: Client; split: LineageSplitRecord; ctx: ScreenContext }> {
  const w = await world(families);
  const ctx: ScreenContext = {
    db: w.db,
    market: MARKET,
    d: RUN_D,
    params: TEST_PARAMS,
    world: { sessions: SESSIONS } as unknown as ScreenContext["world"],
  };
  return { db: w.db, split: w.split, ctx };
}

export async function addCluster(
  db: Client,
  id: string,
  opts: {
    fit?: unknown;
    testability?: string;
    claimStatus?: "extracted" | "owner_checked" | "rejected" | "parked" | null;
    state?: "proposed" | "confirmed";
  } = {},
): Promise<string | null> {
  const fit = opts.fit === undefined ? f1Fit(Number(id.slice(-3))) : opts.fit;
  await db.execute({
    sql: `INSERT INTO cluster (id, name, category, statement, testability, external_grade, family_fit_json, created_at)
          VALUES (?, ?, 'trend_momentum', 'ZZ statement.', ?, 'none', ?, ?)`,
    args: [
      id,
      `ZZ cluster ${id}`,
      opts.testability ?? "testable_eod",
      fit === null ? null : JSON.stringify(fit),
      NOW,
    ],
  });
  // every cluster starts `proposed` (seq 1, the importer's row); by default a person then confirms it (D-594)
  await appendClusterState(db, { clusterId: id, state: "proposed", actor: "seed", at: NOW });
  if ((opts.state ?? "confirmed") === "confirmed")
    await appendClusterState(db, { clusterId: id, state: "confirmed", actor: "u1", at: NOW });
  const status = opts.claimStatus === undefined ? "owner_checked" : opts.claimStatus;
  if (status === null) return null;
  const claimId = `C-${id}`;
  await insertClaim(db, {
    id: claimId,
    type: "method",
    testability: "testable_eod",
    clusterId: null,
    statement: `ZZ claim for ${id}`,
    actor: "seed",
    at: NOW,
  });
  await mergeClaimIntoCluster(db, { claimId, clusterId: id });
  if (status !== "extracted") {
    await appendClaimStatus(db, {
      claimId,
      to:
        status === "owner_checked"
          ? "owner_checked"
          : status === "rejected"
            ? "rejected"
            : "parked",
      actor: "u1",
      at: NOW,
    });
  }
  return claimId;
}

function gauss(rng: ReturnType<typeof scopedPrng>): number {
  let s = 0;
  for (let i = 0; i < 12; i += 1) s += uniform01(rng);
  return s - 6;
}
const frac = (x: number): { num: bigint; den: bigint } => ({
  num: BigInt(Math.round(x * 1_000_000)),
  den: 1_000_000n,
});

export type Plan = Readonly<Record<string, number>>;
export type FakeReplay = { replay: ReplayFn; calls: string[] };

/**
 * A fake replay: label `<family>.expert:<cluster>` maps to a planted mean excess in `plan` (0 when absent).
 * Rows sit on every 4th session of the whole snapshot; outside the development split the excess is +0.5 (a
 * leak would make every cluster look like a winner). Clusters named in `noControls` get rows without a
 * matched control (`excess` null).
 */
export function fakeReplay(
  split: LineageSplitRecord,
  plan: Plan,
  opts: { readonly noControls?: readonly string[] } = {},
): FakeReplay {
  const calls: string[] = [];
  const replay: ReplayFn = (family, label) => {
    calls.push(label);
    const cluster = label.split(":")[1]!;
    const mean = plan[cluster] ?? 0;
    const controls = !(opts.noControls ?? []).includes(cluster);
    const rng = scopedPrng(`zzscreen:${cluster}`);
    const entries = SESSIONS.flatMap((d, i) => {
      if (i % 4 !== 0) return [];
      const dev = splitOf(split, d) === "development";
      const x = dev ? mean + 0.03 * gauss(rng) : 0.5;
      return [
        {
          family,
          variant: family,
          ruleVersion: label,
          code: "ZZA",
          net: frac(x + 0.001),
          excess: controls ? frac(x) : null,
          row: { entry_d: d },
        },
      ];
    });
    return { entries } as unknown as LedgerResult;
  };
  return { replay, calls };
}
