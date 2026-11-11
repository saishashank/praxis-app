// @vitest-environment node
// D-950 database step and page loader of "My portfolio" on the shared synthetic world
// (tests/loaders/world.ts): the balanced pick ZZUP (Follow the trend) bought at 10.00 on D, last close
// 10.50. Added here: a conservative pick of the same stock (too small for its risk cap, so it stays in
// cash) and a candidate-measure pick (never in the portfolio). A re-run writes the same rows; a
// masked viewer sees letters and percentages only; the review gets one line per valued profile.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { findLeaks } from "@/lib/view/mask";
import { runPickPortfolio } from "@/lib/picks/portfolioStore";
import { loadMyPortfolios } from "@/lib/ui/loaders/pickPortfolio";
import { readMyPortfolios, type Ctx } from "@/lib/review/sections";
import { CODES, D, envOf, fullWorld, NAMES, SHA, type World } from "../loaders/world";

afterAll(cleanupTempDbs);

let w: World;
const addPick = async (profile: string, rank: number, code: string, ruleVersion: string) => {
  await w.main.execute({
    sql: `INSERT INTO pick (market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
            reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
            typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
            pick_sha, created_at)
          VALUES ('AU', ?, ?, ?, ?, 'F1', 'U1', ?, 's1', 'UNVALIDATED', 10000000, 10050000,
            '2026-10-23', 9200000, 11000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    args: [D, profile, rank, code, ruleVersion, SHA, `${D}T07:00:00.000Z`],
  });
  await w.main.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, ?, ?, 'pick', ?, ?, 'waiting', ?)`,
    args: [D, profile, rank, code, SHA, D],
  });
  await w.main.execute({
    sql: `UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = 10000000, updated_d = ?
          WHERE market = 'AU' AND d = ? AND profile = ? AND rank = ? AND kind = 'pick'`,
    args: [D, D, D, profile, rank],
  });
};

beforeAll(async () => {
  w = await fullWorld();
  await addPick("conservative", 1, "ZZUP", "F1.v1");
  await addPick("balanced", 3, "ZZDN", "CAND.v1");
});

const all = async (table: string) =>
  (await w.main.execute(`SELECT * FROM ${table} ORDER BY 1, 2, 3`)).rows.map((r) => ({ ...r }));

describe("runPickPortfolio (D-950)", () => {
  it("rebuilds the three portfolios: balanced buys its Follow the trend pick, conservative stays in cash", async () => {
    const r = await runPickPortfolio(w.main, { market: "AU", d: D });
    expect(r.balanced).toEqual({ trades: 1, open: 1, days: 1, splits: 1, skipped: 0 });
    expect(r.conservative).toMatchObject({ trades: 0, open: 0, days: 1, skipped: 1 });
    expect(r.aggressive).toEqual({ trades: 0, open: 0, days: 0, splits: 0, skipped: 0 });
    const trades = await all("pick_portfolio_trade");
    expect(trades).toEqual([
      expect.objectContaining({
        profile: "balanced",
        side: "buy",
        code: "ZZUP",
        strategy: "F1",
        qty: 25, // A$250: the risk cap (2 % of A$1,000 over an 8 % stop) and the quarter slot
        price_micro: 10_000_000,
        fee_micro: 1_000_000, // P6, the default cost profile
        reason: "pick",
      }),
    ]);
    expect(String(trades[0]!.words)).toContain("Follow the trend");
    const day = (
      await w.main.execute("SELECT * FROM pick_portfolio_day WHERE profile = 'balanced'")
    ).rows[0]!;
    expect(Number(day.value_micro)).toBe(1_011_500_000); // 749 cash + 25 x 10.50
    expect(Number(day.fall_ppm)).toBe(0);
    const hold = await all("pick_portfolio_hold");
    expect(hold).toEqual([expect.objectContaining({ profile: "balanced", code: "ZZUP", qty: 25 })]);
    const split = (await all("pick_portfolio_split")).find((s) => s.profile === "balanced")!;
    expect(JSON.parse(String(split.shares_json))).toEqual([
      { strategy: "F1", target_ppm: 400_000 },
    ]);
  });

  it("a re-run writes the same rows", async () => {
    const before = await Promise.all(
      [
        "pick_portfolio_trade",
        "pick_portfolio_day",
        "pick_portfolio_hold",
        "pick_portfolio_split",
      ].map(all),
    );
    await runPickPortfolio(w.main, { market: "AU", d: D });
    const after = await Promise.all(
      [
        "pick_portfolio_trade",
        "pick_portfolio_day",
        "pick_portfolio_hold",
        "pick_portfolio_split",
      ].map(all),
    );
    expect(after).toEqual(before);
  });

  it("the card: three portfolios side by side; masked shows letters and percentages only", async () => {
    const v = await loadMyPortfolios(envOf(w, "owner"));
    expect(v.portfolios.map((p) => p.profile)).toEqual(["conservative", "balanced", "aggressive"]);
    expect(v.seed?.micro).toBe("1000000000");
    expect(v.stockMaxPct).toBe(30);
    const bal = v.portfolios[1]!;
    expect(bal).toMatchObject({ started: true, asOfD: D, holdingsMax: 4, closed: 0, wins: 0 });
    expect(bal.gain?.micro).toBe("11500000");
    expect(bal.sinceStartPpm).toBe(11_500);
    expect(bal.worstFallPpm).toBe(0);
    expect(bal.split).toBe("Follow the trend 40%, cash 60%");
    expect(bal.splitWhy).toBe("First split, from the strategies' records so far.");
    expect(bal.holdings).toEqual([
      expect.objectContaining({
        stock: "ZZUP",
        strategy: "Follow the trend",
        entryD: D,
        changePpm: 50_000,
      }),
    ]);
    expect(bal.trades).toEqual([expect.objectContaining({ d: D, stock: "ZZUP" })]);
    expect(v.portfolios[0]).toMatchObject({
      started: true,
      holdings: [],
      split: "Follow the trend 40%, cash 60%",
    });
    expect(v.portfolios[2]).toMatchObject({ started: false, holdingsMax: 3 });
    const m = await loadMyPortfolios(envOf(w, "viewer"));
    expect(m.seed).toBeNull();
    const mb = m.portfolios[1]!;
    expect(mb).toMatchObject({ value: null, gain: null, cash: null, asOfD: null });
    expect(mb.holdings[0]!.entry).toBeNull();
    expect(mb.holdings[0]!.changePpm).toBe(50_000);
    expect(mb.trades[0]!.d).toBeNull();
    expect(findLeaks(m, CODES, NAMES)).toEqual([]);
  });

  it("the Evening Review: one plain line per valued profile, bounded to the date", async () => {
    const ctx = { db: w.main, market: "AU", d: D } as unknown as Ctx;
    const r = await readMyPortfolios(ctx);
    expect(r?.lines).toEqual([
      "Conservative: A$1,000.00, A$0.00 (0.0%) since the start; no fall from a peak yet; all in cash; split Follow the trend 40%, cash 60%.",
      "Balanced: A$1,011.50, +A$11.50 (+1.1%) since the start; no fall from a peak yet; 1 holding; split Follow the trend 40%, cash 60%; today 1 buy.",
    ]);
    expect(await readMyPortfolios({ ...ctx, d: "2026-10-20" } as Ctx)).toBeNull();
  });
});
