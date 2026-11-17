// @vitest-environment node
// Owner 2026-11-16: every page that shows a price uses the same delayed quote as the pick cards, display
// only (ARN-021). Covered: My portfolio live value, the quote fetch set, the Home headline, the Strategies
// tiles' bust distance, the Risk marks, the Picks History filter, the Market overview, and the between
// rounds note. A masked viewer gets percentages only; no books or exits module imports any of it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paramsJson, resolveCohortParams } from "@/lib/arena/cohort";
import { displayHeldCodes } from "@/lib/intraday/universe";
import { runPickPortfolio } from "@/lib/picks/portfolioStore";
import { ratioPpm } from "@/lib/ui/loaders/common";
import { loadHome } from "@/lib/ui/loaders/home";
import { loadOverview } from "@/lib/ui/loaders/market";
import { loadPickHistory } from "@/lib/ui/loaders/picks";
import { loadMyPortfolios } from "@/lib/ui/loaders/pickPortfolio";
import { loadRisk } from "@/lib/ui/loaders/risk";
import { loadStrategies } from "@/lib/ui/loaders/strategies";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld, SHA, type World } from "../loaders/world";
import { deps, emptyDbs, NOW, OWNER, seedPopulated, VIEWER } from "../loaders/seed";

afterAll(cleanupTempDbs);

// 2026-10-20 02:05 UTC is 13:05 in Melbourne, a later day than the close D (2026-10-19).
const QUOTE_AT = "2026-10-20T02:05:00.000Z";
const quote = (db: World["main"], code: string, last: number) =>
  db.execute({
    sql: "INSERT OR REPLACE INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at) VALUES ('AU', ?, ?, NULL, ?, ?)",
    args: [code, last, QUOTE_AT, QUOTE_AT],
  });
const noQuotes = (db: World["main"]) => db.execute("DELETE FROM quote_latest");

const PICK_COLS = `market, d, profile, rank, code, family, tier, rule_version, signal_id, label,
  reference_micro, buy_max_micro, valid_until_d, stop_micro, aim_micro, n_similar, bad_ppm,
  typical_ppm, good_ppm, time_frame_sessions, size_micro, risk_micro, factors_json, based_on_json,
  pick_sha, created_at`;

async function openPick(w: World, rank: number, code: string, entryMicro: number) {
  await w.main.execute({
    sql: `INSERT INTO pick (${PICK_COLS})
          VALUES ('AU', ?, 'balanced', ?, ?, 'F1', 'U1', 'F1.v1', 's1', 'UNVALIDATED', ?, ?,
            '2026-10-23', 1800000, 24000000, 50, -60000, 20000, 110000, 4, 1000000000, 100000000, '[]', '[]', ?, ?)`,
    args: [D, rank, code, entryMicro, entryMicro + 50_000, SHA, `${D}T07:00:00.000Z`],
  });
  await w.main.execute({
    sql: `INSERT INTO pick_outcome (market, d, profile, rank, kind, code, published_sha, state, updated_d)
          VALUES ('AU', ?, 'balanced', ?, 'pick', ?, ?, 'waiting', ?)`,
    args: [D, rank, code, SHA, D],
  });
  await w.main.execute({
    sql: `UPDATE pick_outcome SET state = 'bought', entry_d = ?, entry_micro = ?, updated_d = ?
          WHERE market = 'AU' AND d = ? AND profile = 'balanced' AND rank = ? AND kind = 'pick'`,
    args: [D, entryMicro, D, D, rank],
  });
}

describe("1. My portfolio: live value from the quotes", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
    await openPick(w, 9, "ZZUP", 10_000_000);
    await runPickPortfolio(w.main, { market: "AU", d: D });
  });
  const balanced = async (who: "owner" | "viewer") =>
    (await loadMyPortfolios(envOf(w, who))).portfolios.find((p) => p.profile === "balanced")!;

  it("without a newer quote the end-of-day figures stand", async () => {
    const b = await balanced("owner");
    expect(b.holdings.length).toBeGreaterThan(0);
    expect(b.liveLabel).toBeNull();
    expect(b.closeValue).toBeNull();
    expect(b.value?.micro).toBe("1011500000");
  });

  it("a newer quote gives cash plus shares at the quote, with the close kept beside it", async () => {
    await quote(w.main, "ZZUP", 11_000_000);
    try {
      const b = await balanced("owner");
      expect(b.holdings[0]!.now?.micro).toBe("11000000");
      // 749.00 cash + 25 shares x 11.00, the same price the holding shows
      expect(b.value?.micro).toBe("1024000000");
      expect(b.gain?.micro).toBe("24000000");
      expect(b.sinceStartPpm).toBe(24_000);
      expect(b.liveLabel).toBe("Delayed, 13:05");
      expect(b.closeValue?.micro).toBe("1011500000");
      expect(b.closeSinceStartPpm).toBe(11_500);
      // a masked viewer sees percentages only
      const m = await balanced("viewer");
      expect(m.value).toBeNull();
      expect(m.gain).toBeNull();
      expect(m.closeValue).toBeNull();
      expect(m.sinceStartPpm).toBe(24_000);
      expect(JSON.stringify(m)).not.toMatch(/1024000000|1011500000|11000000/);
    } finally {
      await noQuotes(w.main);
    }
  });
});

describe("2. the quote fetch set", () => {
  it("adds the stocks the portfolios hold, then the users' watchlists, deduped, held first", async () => {
    const w = await fullWorld();
    await w.main.execute(
      `INSERT INTO pick_portfolio_hold (market, profile, code, pos, strategy, pub_d, entry_d, entry_micro, qty, cost_micro)
       VALUES ('AU','balanced','ZZUP',1,'F1','${D}','${D}',10000000,25,250000000)`,
    );
    await w.auth.execute(
      `INSERT INTO user_watchlist (user_id, market, code, added_at) VALUES
         (${w.ids.owner}, 'AU', 'ZZUP', '2026-10-01T00:00:00.000Z'),
         (${w.ids.owner}, 'AU', 'ZZDN', '2026-10-01T00:00:00.000Z'),
         (${w.ids.viewer}, 'AU', 'ZZDN', '2026-10-01T00:00:00.000Z')`,
    );
    expect(await displayHeldCodes(w.main, "AU", w.auth)).toEqual({
      held: ["ZZUP"],
      watchlist: ["ZZDN"],
    });
    const src = readFileSync(path.resolve(__dirname, "../../src/lib/alerts/pick/poll.ts"), "utf8");
    // armed codes first, then the book's held codes, then the display codes; the per-run cap slices them all
    expect(src.indexOf("heldCodes(db, market)")).toBeLessThan(
      src.indexOf("displayHeldCodes(db, market, deps.auth)"),
    );
    expect(src).toMatch(/const planned = codes\.slice\(0, allowed\)/);
  });
});

describe("3, 4, 5: Home headline, Strategies tiles and the Risk page use the live NAV", () => {
  it("Home since-start, the tiles' bust distance and the Risk marks agree with the quote", async () => {
    const db = await emptyDbs();
    await seedPopulated(db);
    const eod = (await loadHome(deps(db, OWNER))).data;
    const eodStrat = await loadStrategies(deps(db, OWNER));
    await quote(db.main, "ZZUP", 12_600_000);
    // E01: 630.0 + 10 x (12.60 - 12.34) = 632.6; seed 600, bust 300
    const home = (await loadHome(deps(db, OWNER))).data;
    const tiles = home.summary!.tiles;
    const seeds = tiles.reduce((s, t) => s + t.seed.micro, 0);
    const values = tiles.reduce((s, t) => s + t.value.micro, 0);
    expect(home.headline[0]!.sinceStartPpm).toBe(ratioPpm(values - seeds, seeds));
    expect(home.headline[0]!.sinceStartPpm).not.toBe(eod.headline[0]!.sinceStartPpm);

    const strat = await loadStrategies(deps(db, OWNER));
    const e01 = strat.data.tiles.find((t) => t.execution === "E01")!;
    const old = eodStrat.data.tiles.find((t) => t.execution === "E01")!;
    expect(e01.nav?.micro).toBe(632_600_000);
    expect(e01.bustDistancePpm).toBe(ratioPpm(632_600_000 - 300_000_000, 632_600_000));
    expect(e01.bustDistancePpm).not.toBe(old.bustDistancePpm);
    expect(e01.positionPpm).not.toBe(old.positionPpm);

    const risk = (await loadRisk(deps(db, OWNER))).data;
    const r01 = risk.strategies.find((s) => s.execution === "E01")!;
    expect(r01.liveLabel).toBe("Delayed, 13:05");
    expect(r01.nav.micro).toBe(632_600_000);
    const pos = r01.positions.find((p) => p.stock === "ZZUP")!;
    expect(pos.live).toBe(true);
    expect(pos.value?.micro).toBe(126_000_000);
    expect(pos.weightPpm).toBe(ratioPpm(126_000_000, 632_600_000));
    const masked = (await loadRisk(deps(db, VIEWER))).data;
    const mpos = masked.strategies.find((s) => s.execution === "E01")!.positions[0]!;
    expect(mpos.value).toBeNull();
    expect(mpos.weightPpm).toBe(ratioPpm(126_000_000, 632_600_000));
    expect(JSON.stringify(masked)).not.toMatch(/126000000|12600000/);
    await noQuotes(db.main);
    const back = (await loadRisk(deps(db, OWNER))).data.strategies.find(
      (s) => s.execution === "E01",
    )!;
    expect(back.liveLabel).toBeNull();
    expect(back.nav.micro).toBe(630_000_000);
  });
});

describe("6. Picks History filter agrees with the row", () => {
  it("an open trade in profit at the close but below its buy price on the quote is a loss", async () => {
    const w = await fullWorld();
    await openPick(w, 7, "ZZOTH", 2_000_000);
    const open = async (filter: "profit" | "loss") =>
      (await loadPickHistory(envOf(w, "owner"), { profile: "balanced", filter, cursor: null })).rows
        .filter((r) => r.stock.includes("ZZOTH"))
        .map((r) => r.status);
    // last close 2.20 against a buy at 2.00: in profit
    expect(await open("profit")).toEqual(["open"]);
    expect(await open("loss")).toEqual([]);
    await quote(w.main, "ZZOTH", 1_900_000);
    const row = (
      await loadPickHistory(envOf(w, "owner"), {
        profile: "balanced",
        filter: "open",
        cursor: null,
      })
    ).rows.find((r) => r.stock.includes("ZZOTH"))!;
    expect(row.now?.micro).toBe("1900000"); // what the row shows
    expect(await open("profit")).toEqual([]);
    expect(await open("loss")).toEqual(["open"]);
  });
});

describe("7. Market overview sheet has the delayed quote", () => {
  it("live price and change on the close; a masked viewer gets the change only", async () => {
    const w = await fullWorld();
    expect((await loadOverview(envOf(w, "owner"), "ZZUP"))!.live).toBeNull();
    await quote(w.main, "ZZUP", 11_025_000); // close 10.50
    const o = (await loadOverview(envOf(w, "owner"), "ZZUP"))!;
    expect(o.live).toEqual({
      priceMicro: "11025000",
      currency: "AUD",
      changePpm: 50_000,
      at: "13:05",
    });
    let sawMasked = 0;
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      const m = await loadOverview(envOf(w, "viewer"), `stock-${letter}`);
      if (m === null || m.live === null) continue;
      sawMasked += 1;
      expect(m.live.priceMicro).toBeNull();
      expect(JSON.stringify(m)).not.toMatch(/11025000|ZZUP/);
    }
    expect(sawMasked).toBeGreaterThan(0);
  });
});

describe("8. between rounds, not 'No rounds yet'", () => {
  const params = paramsJson(resolveCohortParams());
  async function world(successor: boolean) {
    const db = await emptyDbs();
    const m = db.main;
    await m.execute(
      "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E01','AU','E','F1','U','v1','P5')",
    );
    const cohort = (id: string, start: string, seed: number) =>
      m.execute({
        sql: `INSERT INTO cohort (id, execution_id, control_idx, start_d, seed_micro, rule_version, params_json,
                cost_profile_version, rng_seed) VALUES (?, 'E01', NULL, ?, ?, 'v1', ?, 1, 1)`,
        args: [id, start, seed, params],
      });
    await cohort("E01@2026-10-12", "2026-10-12", 600_000_000);
    await m.execute(
      "UPDATE cohort SET terminal_kind = 'timeout', terminal_d = '2026-11-13', ttd_sessions = 25, ttd_days = 32, outcome_micro = 650000000 WHERE id = 'E01@2026-10-12'",
    );
    await m.execute(
      `INSERT INTO nav_daily (cohort_id, d, cash_settled_micro, recv_micro, pay_micro, positions_micro,
         div_recv_micro, sleeve_margin_micro, sleeve_unreal_micro, fin_accrued_micro, nav_micro,
         liq_nav_micro, open_positions, invariants_ok) VALUES ('E01@2026-10-12','2026-11-13',650000000,0,0,0,0,0,0,0,650000000,650000000,0,1)`,
    );
    if (successor) await cohort("E01@2026-11-17", "2026-11-17", 5_000_000_000);
    return db;
  }
  const NOTE =
    "Round 2 starts Tue 17 Nov with A$5,000 a strategy. Orders are placed after that day's close; the first buys are at the open on Wed 18 Nov.";
  const at = new Date("2026-11-16T03:00:00.000Z");

  it.each([true, false])(
    "a round ended (successor row: %s): Strategies and Home say when round 2 starts",
    async (successor) => {
      const db = await world(successor);
      const s = await loadStrategies(deps(db, OWNER, at));
      expect(s.data.pendingRound).toBe(NOTE);
      if (successor) expect(s.text).toBe(NOTE);
      expect(JSON.stringify(s)).not.toMatch(/No rounds yet/);
      const h = (await loadHome(deps(db, OWNER, at))).data;
      expect(h.summary!.tiles).toEqual([]);
      expect(h.summary!.note).toBe(NOTE);
    },
  );

  it("the true first-ever state keeps 'No rounds yet'", async () => {
    const db = await emptyDbs();
    await db.main.execute(
      "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES ('E01','AU','E','F1','U','v1','P5')",
    );
    const s = await loadStrategies(deps(db, OWNER, NOW));
    expect(s.data.pendingRound).toBeNull();
    expect(s.text).toMatch(/No rounds yet/);
    expect((await loadHome(deps(db, OWNER, NOW))).data.summary!.note ?? null).toBeNull();
  });
});

describe("ARN-021: no books or exits module reads the display code", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const n of readdirSync(dir)) {
      const f = path.join(dir, n);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (/\.(ts|tsx)$/.test(n)) out.push(f);
    }
    return out;
  };
  it("arena, agents, picks, replay, learning, stats and money never import the quote readers or the new loaders", () => {
    const BAD =
      /from\s+["'](?:@\/lib\/data\/quotes\/latest|@\/lib\/ui\/loaders\/(?:roundNote|pickNow|liveDay|pickPortfolio)|@\/lib\/intraday\/universe)["']/;
    const bad: string[] = [];
    for (const d of ["arena", "agents", "picks", "replay", "learning", "stats", "money"])
      for (const f of walk(path.join(ROOT, "src/lib", d)))
        if (BAD.test(readFileSync(f, "utf8"))) bad.push(path.relative(ROOT, f));
    expect(bad).toEqual([]);
  });
});
