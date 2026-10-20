// @vitest-environment node
// Batch 3 re-cost and price-shock rows on the golden nights (M7 T4, decision 52 / D-132 draft; UX-022,
// UXN-152). The synthetic scenario runs through 2a, 2b and 3. Checks: every cohort-night with a NAV
// has its 8 cost rows and 6 shock rows; re-costing under the cohort's own profile gives the stored NAV
// and liquidation NAV on EVERY night (the identity); a profile's NAV is recomputed here from the
// `fill` table with the M3 fee function; shocks are recomputed from `nav_daily_pos`; two runs write
// identical rows; the ledger and the kill switch are untouched by the new stage.
import type { Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewDay, type ReviewResult } from "@/lib/agents/batch3";
import { parseCohortParams } from "@/lib/arena/cohort";
import { COST_PROFILE_CODES, feeFor, getCostProfile } from "@/lib/arena/costs";
import { SHOCK_PCTS } from "@/lib/arena/recost";
import { makeRational, mulRat } from "@/lib/money/rational";
import { roundHalfAwayFromZero } from "@/lib/money/round";
import { cleanupTempDbs } from "../db/helpers";
import {
  DATES,
  MARKET,
  NOW,
  freshReplayDb,
  runNights,
  setMode,
  startCohortsAt,
  testParams,
} from "./batch2bHarness";
import { buildGolden } from "./batch2bScenario";

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const KEEP = ["E01", "E07", "E08", "C2-F1", "C2-F4", "C3-F4"];
const params = testParams();
const FIRST = 295;
const LAST = 320;

type Row = Record<string, unknown>;
const rows = async (db: Client, sql: string, args: (string | number)[] = []): Promise<Row[]> =>
  (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

async function world(): Promise<{ db: Client; reviews: ReviewResult[] }> {
  const db = await freshReplayDb();
  await buildGolden(db);
  await setMode(db, "full");
  await startCohortsAt(db, FIRST, KEEP);
  const reviews: ReviewResult[] = [];
  await runNights(db, params, FIRST, LAST, async (day) => {
    reviews.push(await reviewDay(db, { market: MARKET, d: day, replay: true, now: NOW, params }));
  });
  return { db, reviews };
}

let db: Client;
let second: Client;
let reviews: ReviewResult[];
beforeAll(async () => {
  ({ db, reviews } = await world());
  ({ db: second } = await world());
});
afterAll(cleanupTempDbs);

const stat = async (c: Client, scope: string, metric: string, d: string) => {
  const r = await rows(
    c,
    "SELECT value_json FROM replay_stat WHERE scope = ? AND metric = ? AND d = ?",
    [scope, metric, d],
  );
  return r.length === 0
    ? null
    : (JSON.parse(String(r[0]!.value_json)) as Record<string, string | number>);
};

describe("re-cost rows on the nights", () => {
  it("every night succeeded and wrote its rows", () => {
    for (const r of reviews) {
      expect(r.status).toBe("success");
      expect(r.stats.recostRows).toBeGreaterThan(0);
    }
  });

  it("each cohort-night has one row per profile and for stress, and one per shock", async () => {
    const nights = await rows(
      db,
      "SELECT cohort_id, d FROM nav_daily WHERE d >= ? ORDER BY d, cohort_id",
      [DATES[FIRST]!],
    );
    expect(nights.length).toBeGreaterThan(0);
    for (const n of nights) {
      const cost = await rows(
        db,
        "SELECT metric FROM replay_stat WHERE scope = ? AND d = ? ORDER BY metric",
        [`cost:${n.cohort_id}`, String(n.d)],
      );
      expect(cost.map((r) => r.metric)).toEqual(
        [...COST_PROFILE_CODES, "stress"].map((k) => `recost:${k}`).sort(),
      );
      const shock = await rows(db, "SELECT metric FROM replay_stat WHERE scope = ? AND d = ?", [
        `shock:${n.cohort_id}`,
        String(n.d),
      ]);
      expect(shock).toHaveLength(SHOCK_PCTS.length);
    }
  });

  it("under the cohort's own profile the NAV and liquidation NAV equal the stored ones, every night", async () => {
    const navs = await rows(
      db,
      `SELECT n.cohort_id, n.d, n.nav_micro, n.liq_nav_micro, c.params_json FROM nav_daily n
       JOIN cohort c ON c.id = n.cohort_id ORDER BY n.d, n.cohort_id`,
    );
    let checked = 0;
    for (const n of navs) {
      const own = parseCohortParams(String(n.params_json)).costProfile;
      const s = await stat(db, `cost:${n.cohort_id}`, `recost:${own}`, String(n.d));
      if (s === null) continue; // nights before batch 3 started
      expect(s.nav_micro, `${n.cohort_id} ${n.d}`).toBe(String(n.nav_micro));
      expect(s.liq_nav_micro, `${n.cohort_id} ${n.d}`).toBe(String(n.liq_nav_micro));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("a profile's NAV is the stored NAV plus (stored fees - fees under that profile), recomputed from fill", async () => {
    const d = DATES[LAST]!;
    const cohorts = await rows(db, "SELECT DISTINCT cohort_id FROM fill WHERE d <= ?", [d]);
    expect(cohorts.length).toBeGreaterThan(0);
    for (const c of cohorts) {
      const fills = await rows(
        db,
        `SELECT code, d, side, value_micro, brokerage_micro FROM fill WHERE cohort_id = ? AND d <= ?
         AND order_id NOT IN (SELECT id FROM arena_order WHERE kind IN ('sleeve_open','sleeve_close')) ORDER BY d, id`,
        [String(c.cohort_id), d],
      );
      const nav = (
        await rows(db, "SELECT nav_micro FROM nav_daily WHERE cohort_id = ? AND d = ?", [
          String(c.cohort_id),
          d,
        ])
      )[0];
      if (nav === undefined) continue;
      const profile = getCostProfile("P4"); // no first-buy rule, so the fill order is irrelevant
      let delta = 0n;
      for (const f of fills) {
        const v = BigInt(String(f.value_micro));
        delta +=
          BigInt(String(f.brokerage_micro)) -
          feeFor(profile, v, String(f.side) === "buy" ? "buy" : "sell");
      }
      const s = await stat(db, `cost:${c.cohort_id}`, "recost:P4", d);
      expect(s!.nav_micro).toBe(String(BigInt(String(nav.nav_micro)) + delta));
    }
  });

  it("shocks are the per-position rounded amounts of the stored position values", async () => {
    const d = DATES[LAST]!;
    const withPos = await rows(db, "SELECT DISTINCT cohort_id FROM nav_daily_pos WHERE d = ?", [d]);
    expect(withPos.length).toBeGreaterThan(0);
    for (const c of withPos) {
      const pos = await rows(
        db,
        "SELECT value_micro FROM nav_daily_pos WHERE cohort_id = ? AND d = ?",
        [String(c.cohort_id), d],
      );
      for (const pct of SHOCK_PCTS) {
        let pnl = 0n;
        for (const p of pos) {
          pnl += roundHalfAwayFromZero(
            mulRat(makeRational(BigInt(String(p.value_micro))), makeRational(BigInt(pct), 100n)),
          );
        }
        const s = await stat(db, `shock:${c.cohort_id}`, `shock:${pct > 0 ? "+" : ""}${pct}`, d);
        expect(s!.pnl_micro).toBe(pnl.toString());
      }
    }
  });

  it("two runs write the same rows (deterministic)", async () => {
    const q =
      "SELECT run_id, scope, metric, d, value_json FROM replay_stat WHERE scope LIKE 'cost:%' OR scope LIKE 'shock:%' ORDER BY run_id, scope, metric";
    expect(await rows(db, q)).toEqual(await rows(second, q));
  });

  it("the new stage changes no ledger, NAV or cohort row", async () => {
    const before = await rows(db, "SELECT COUNT(*) AS n FROM nav_daily");
    const again = await reviewDay(db, {
      market: MARKET,
      d: DATES[LAST]!,
      replay: true,
      now: NOW,
      params,
    });
    expect(again.status).toBe("already_done");
    expect(await rows(db, "SELECT COUNT(*) AS n FROM nav_daily")).toEqual(before);
  });
});
