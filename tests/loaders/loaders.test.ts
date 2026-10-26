// @vitest-environment node
// Page loaders, part 1 (M7 T7; docs/M7_design.md 2.7; D-128, D-129, D-135 draft): shape, empty and
// stale states, deterministic order, a bounded query count, and masking. The masking tests fail if a
// stock code, a company name, a signal or card id, a link, a price of a single trade or an exact trade
// date reaches an Editor or a Viewer, and check that the Owner still sees the real values.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { cardRef, loadCardPage, resolveCardRef } from "@/lib/ui/loaders/cards";
import { loadHome } from "@/lib/ui/loaders/home";
import { loadIdeas } from "@/lib/ui/loaders/ideas";
import { loadRisk } from "@/lib/ui/loaders/risk";
import { loadLeaderboard, loadStrategies, loadStrategyDetail } from "@/lib/ui/loaders/strategies";
import {
  CARD_DN,
  CARD_UP,
  counting,
  deps,
  EDITOR,
  emptyDbs,
  LATE,
  leaks,
  NOW,
  OWNER,
  seedPopulated,
  VIEWER,
  type Both,
} from "./seed";

afterAll(cleanupTempDbs);

let db: Both;
beforeAll(async () => {
  db = await emptyDbs();
  await seedPopulated(db);
});

// ---- empty and stale ---------------------------------------------------------------------------

describe("empty state (data-only mode)", () => {
  it("every loader answers empty with empty lists, for every role", async () => {
    const e = await emptyDbs();
    for (const u of [OWNER, EDITOR, VIEWER, null]) {
      const d = deps(e, u);
      const home = await loadHome(d);
      expect(home.state).toBe("empty");
      expect(home.data.picks.items).toEqual([]);
      expect(home.data.ideas.items).toEqual([]);
      expect(home.data.summary.tiles).toEqual([]);
      expect((await loadIdeas(d)).data.groups).toEqual([]);
      const s = await loadStrategies(d);
      expect(s.state).toBe("empty");
      expect(s.data.tiles).toEqual([]);
      expect((await loadStrategyDetail(d, "E01")).data.found).toBe(false);
      const lb = await loadLeaderboard(d);
      expect(lb.state).toBe("empty");
      expect(lb.data.strategies).toEqual([]);
      const r = await loadRisk(d);
      expect(r.state).toBe("empty");
      expect(r.data.strategies).toEqual([]);
      const c = await loadCardPage(d, "card:none");
      expect(c.data.found).toBe(false);
      expect(c.text).not.toBe("");
    }
  });
});

describe("stale state", () => {
  it("is stale when the newest data is older than the allowance, and says so", async () => {
    const home = await loadHome(deps(db, OWNER, LATE));
    expect(home.state).toBe("stale");
    expect(home.asOf).toBe("2026-10-19");
    expect(home.text).toContain("2026-10-19");
    expect((await loadStrategies(deps(db, OWNER, LATE))).state).toBe("stale");
    expect((await loadHome(deps(db, OWNER, NOW))).state).toBe("ok");
  });
});

// ---- shape, ordering, query count -------------------------------------------------------------------

describe("Home", () => {
  it("has the summary, day line, picks, ideas, watchlist, news and review (Owner)", async () => {
    const h = await loadHome(deps(db, OWNER));
    expect(h.state).toBe("ok");
    expect(h.masked).toBe(false);
    const d = h.data;
    // D-192: one tile per strategy, each its own money; nothing is added across strategies (the L
    // twin E04 runs nothing and is not shown, D-191)
    expect(d.summary.strategies).toBe(2);
    const [t, t2] = d.summary.tiles;
    expect(t).toMatchObject({ id: "E01", startD: "2026-10-12" });
    expect(t!.dayChange?.micro).toBe(20_000_000); // E01 +20 M
    expect(t2).toMatchObject({ id: "E02", startD: "2026-10-12" });
    expect(t2!.dayChange?.micro).toBe(-5_000_000); // E02 -5 M
    expect(t!.value.micro - t!.seed.micro).toBe(t!.sinceStart.micro);
    expect(t!.value).toMatchObject({ currency: "AUD", simulated: true });
    expect(d.day.regime).toBe("NEUTRAL");
    expect(d.day.quality).toEqual([{ tier: "U1", score: 1, gatePass: true }]);
    expect(d.picks.items).toHaveLength(1);
    expect(d.picks.items[0]).toMatchObject({ stock: "ZZUP", referenceMicro: 12_340_000, rank: 1 });
    expect(d.ideas.items.map((i) => i.stock)).toEqual(["ZZUP", "ZZDN", "ZZOTH"]);
    expect(d.watchlist).toEqual([{ stock: "ZZUP", close: 12.34, changePpm: 19_835 }]);
    expect(d.news.items[0]?.stock).toBe("ZZUP");
    expect(d.review).toEqual({ d: "2026-10-19", day: "2026-10-19", kind: "full" });
    expect(d.attentionCount).toBe(0);
  });

  it("is serialisable (no bigint, no Date)", async () => {
    expect(() => JSON.stringify(loadHome(deps(db, OWNER)))).not.toThrow();
    const h = await loadHome(deps(db, OWNER));
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});

describe("Strategies list", () => {
  it("lists the strategies with names, glyph limits and money marked simulated", async () => {
    const s = await loadStrategies(deps(db, OWNER));
    expect(s.data.tiles.map((t) => t.execution).sort()).toEqual(["E01", "E02"]);
    const e01 = s.data.tiles.find((t) => t.execution === "E01")!;
    expect(e01.name).toBe("Follow the trend");
    expect(e01.moneyType).toBe("Plain shares");
    expect(e01.round).toBe(1);
    expect(e01.sessions).toBe(3);
    expect(e01.nav).toEqual({ micro: 630_000_000, currency: "AUD", simulated: true });
    expect(e01.returnPpm).toBe(50_000);
    expect(e01.bust?.micro).toBe(300_000_000);
    expect(e01.target?.micro).toBe(1_200_000_000);
    expect(e01.spark).toEqual([600_000_000, 610_000_000, 630_000_000]);
    expect(e01.label).toBe("UNVALIDATED");
    const e02 = s.data.tiles.find((t) => t.execution === "E02")!;
    expect(e02.round).toBe(2);
    expect(e02.moneyType).toBe("Plain shares"); // D-191: the L twins are not listed
  });

  it("puts what needs attention first and orders deterministically", async () => {
    const s = await loadStrategies(deps(db, OWNER));
    // E02: paused family F2 and within 15 % of the bust level.
    expect(s.data.tiles[0]!.execution).toBe("E02");
    expect(s.data.tiles[0]!.needsAttention).toBe(true);
    expect(s.data.tiles[0]!.attention).toEqual(["Paused", "Within 15% of the bust level"]);
    expect(s.data.attentionCount).toBe(1);
    const again = await loadStrategies(deps(db, OWNER));
    expect(again).toEqual(s);
    const az = await loadStrategies(deps(db, OWNER), { sort: "az" });
    expect(az.data.tiles.map((t) => t.execution)).toEqual(["E02", "E01"]);
    expect((await loadStrategies(deps(db, OWNER), { sort: "nonsense" })).data.sort).toBe("best");
  });

  it("uses a fixed number of queries however many strategies there are", async () => {
    const a = counting(db);
    await loadStrategies(deps(a.db, OWNER));
    const two = a.count();
    expect(two).toBeLessThanOrEqual(14);
    const more = await emptyDbs();
    await seedPopulated(more);
    for (let i = 5; i <= 14; i += 1) {
      const id = `E${String(i).padStart(2, "0")}`;
      await more.main.execute({
        sql: "INSERT INTO execution (id, market, kind, family, variant, rule_version, cost_profile) VALUES (?, 'AU', 'E', 'F3', 'U', 'v1', 'P5')",
        args: [id],
      });
    }
    const b = counting(more);
    await loadStrategies(deps(b.db, OWNER));
    expect(b.count()).toBe(two);
  });
});

describe("Strategy detail", () => {
  it("has the NAV series, trades with prices (Owner), past rounds and the sleeve block", async () => {
    const x = await loadStrategyDetail(deps(db, OWNER), "E01");
    expect(x.data.found).toBe(true);
    expect(x.data.navSeries.map((p) => p.d)).toEqual(["2026-10-15", "2026-10-16", "2026-10-19"]);
    expect(x.data.trades.map((t) => t.stock).sort()).toEqual(["ZZDN", "ZZUP"]);
    const dn = x.data.trades.find((t) => t.stock === "ZZDN")!;
    expect(dn).toMatchObject({
      open: false,
      exitType: "IS",
      entryPriceMicro: 10_000_000,
      returnPpm: 100_000,
    });
    expect(x.data.trades.find((t) => t.stock === "ZZUP")?.open).toBe(true);
    expect(x.data.sleeve).toBeNull();
    const l = await loadStrategyDetail(deps(db, OWNER), "E02");
    expect(l.data.pastRounds.map((r) => [r.round, r.terminalKind])).toEqual([
      [2, null],
      [1, "bust"],
    ]);
    expect(l.data.pastRounds[1]!.outcome?.micro).toBe(290_000_000);
  });

  it("answers not found for an unknown or malformed id", async () => {
    expect((await loadStrategyDetail(deps(db, OWNER), "E99")).data.found).toBe(false);
    expect((await loadStrategyDetail(deps(db, OWNER), "E01'; DROP TABLE x;--")).data.found).toBe(
      false,
    );
    expect((await loadStrategyDetail(deps(db, OWNER), "C2-F1")).data.found).toBe(false);
  });
});

describe("Leaderboard", () => {
  it("ranks strategies, pools controls and reads re-cost rows for a chosen profile", async () => {
    const lb = await loadLeaderboard(deps(db, OWNER));
    expect(lb.data.strategies.map((r) => r.execution)).toEqual(["E02", "E01"]);
    const e02 = lb.data.strategies.find((r) => r.execution === "E02")!;
    expect(e02).toMatchObject({ rounds: 2, finished: 1, busted: 1, live: 1 });
    expect(e02.meanReturnPpm).toBe(-516_667); // 290 / 600 - 1
    expect(lb.data.controls.map((r) => r.execution)).toEqual(["C2:F1"]);
    expect(lb.data.strategies.every((r) => r.recostNav === null)).toBe(true);
    const p3 = await loadLeaderboard(deps(db, OWNER), { cost: "P3" });
    expect(p3.data.cost).toBe("P3");
    expect(p3.data.strategies.find((r) => r.execution === "E01")?.recostNav?.micro).toBe(
      628_000_000,
    );
    expect((await loadLeaderboard(deps(db, OWNER), { cost: "nope" })).data.cost).toBeNull();
  });
});

describe("Risk", () => {
  it("has positions with weights and stop distances, concentration, breakers, controls and shocks", async () => {
    const r = await loadRisk(deps(db, OWNER));
    expect(r.data.d).toBe("2026-10-19");
    const e01 = r.data.strategies.find((s) => s.execution === "E01")!;
    expect(e01.positions).toHaveLength(1);
    expect(e01.positions[0]).toMatchObject({ stock: "ZZUP", qty: 10, stopDistancePpm: 68_071 });
    expect(e01.positions[0]!.value?.micro).toBe(123_400_000);
    expect(r.data.concentration[0]?.stock).toBe("ZZUP");
    expect(r.data.breakers).toHaveLength(1);
    expect(r.data.breakers[0]).toMatchObject({ stock: "ZZUP", status: "red", execution: "E01" });
    expect(r.data.controls).toEqual([{ scope: "family", key: "F2", state: "paused" }]);
    expect(r.data.shocks).toEqual([
      { pct: -10, pnl: { micro: -12_340_000, currency: "AUD", simulated: true } },
    ]);
  });
});

describe("Ideas", () => {
  it("groups the session's signals by strategy with taken and not-taken counts", async () => {
    const i = await loadIdeas(deps(db, OWNER));
    expect(i.data.d).toBe("2026-10-19");
    expect(i.data.groups.map((g) => [g.family, g.strategy])).toEqual([
      ["F1", "Follow the trend"],
      ["F2", "Good company, good news"],
    ]);
    expect(i.data.groups[0]!.ideas.map((x) => x.stock)).toEqual(["ZZUP", "ZZDN"]);
    expect(i.data.tally).toEqual({ signals: 3, taken: 1, notTaken: 1 });
    expect(i.data.groups[0]!.ideas[0]!.cards[0]!.href).toBe(
      `/cards/${encodeURIComponent(CARD_UP)}`,
    );
    expect(i.data.groups[0]!.ideas[1]!.cards[0]!.reason).toContain("ZZOTH is held");
    expect((await loadIdeas(deps(db, OWNER), { d: "2026-01-01" })).state).toBe("empty");
  });
});

describe("Card page", () => {
  it("resolves the stored id and an opaque reference to the same card", async () => {
    const a = await loadCardPage(deps(db, OWNER), CARD_UP);
    expect(a.data.found).toBe(true);
    expect(a.data.view?.stock).toBe("ZZUP");
    expect(a.data.breakers).toMatchObject([{ id: "TB-NEG", status: "red" }]);
    expect(await resolveCardRef(db.main, cardRef(CARD_UP), NOW)).toBe(CARD_UP);
    const b = await loadCardPage(deps(db, EDITOR), cardRef(CARD_UP));
    expect(b.data.found).toBe(true);
    expect((await loadCardPage(deps(db, OWNER), "ck:0000000000000000")).data.found).toBe(false);
    expect((await loadCardPage(deps(db, OWNER), "x".repeat(400))).data.found).toBe(false);
  });
});

// ---- masking -----------------------------------------------------------------------------------

describe("masking: Editor and Viewer never see a code, a name, a link, a trade price or an id", () => {
  for (const [name, user] of [
    ["Editor", EDITOR],
    ["Viewer", VIEWER],
  ] as const) {
    it(`${name}: no loader result contains the seed's codes, names or ids`, async () => {
      const d = deps(db, user);
      const results = {
        home: await loadHome(d),
        ideas: await loadIdeas(d),
        strategies: await loadStrategies(d),
        detail: await loadStrategyDetail(d, "E01"),
        leaderboard: await loadLeaderboard(d),
        risk: await loadRisk(d),
        card: await loadCardPage(d, cardRef(CARD_UP)),
        cardRaw: await loadCardPage(d, CARD_DN),
      };
      for (const [k, v] of Object.entries(results)) {
        expect(v.masked, k).toBe(true);
        expect(leaks(v), k).toEqual([]);
      }
    });
  }

  it("uses letters, hides prices, amounts and company news, and blurs dates to weeks", async () => {
    const d = deps(db, EDITOR);
    const home = await loadHome(d);
    expect(home.data.picks.items[0]).toMatchObject({
      stock: "Stock C",
      referenceMicro: null,
      stopMicro: null,
      aimMicro: null,
    });
    expect(home.data.picks.items[0]!.validUntil).toBe("2026-W43");
    expect(home.data.news).toEqual({ hidden: true, items: [] });
    expect(home.data.review?.day).toBe("2026-W43");
    expect(home.data.watchlist).toEqual([{ stock: "Stock C", close: null, changePpm: 19_835 }]);
    expect(home.data.ideas.items.map((i) => i.stock)).toEqual(["Stock C", "Stock A", "Stock B"]);
    expect(home.data.ideas.items[0]!.href).toMatch(/^\/cards\/ck%3A[0-9a-f]{16}$/);

    const detail = await loadStrategyDetail(d, "E01");
    for (const t of detail.data.trades) {
      expect(t.stock).toMatch(/^Stock [A-Z]+$/);
      expect(t.entryPriceMicro).toBeNull();
      expect(t.exitPriceMicro).toBeNull();
      expect(t.entryDay).toMatch(/^2026-W\d\d$/);
    }
    expect(detail.data.trades.find((t) => !t.open)?.returnPpm).toBe(100_000);

    const risk = await loadRisk(d);
    const p = risk.data.strategies.find((s) => s.execution === "E01")!.positions[0]!;
    expect(p.stock).toMatch(/^Stock [A-Z]+$/);
    expect(p.value).toBeNull();
    expect(p.stopDistancePpm).toBe(68_071);
    expect(risk.data.breakers[0]!.stock).toMatch(/^Stock [A-Z]+$/);
    expect(risk.data.breakers[0]!.day).toBe("2026-W43");

    const card = await loadCardPage(d, cardRef(CARD_UP));
    expect(card.data.view?.masked).toBe(true);
    expect(card.data.view?.stock).toBe("Stock C");
  });

  it("the Owner and a user with a live unmask grant see the real values", async () => {
    const o = await loadHome(deps(db, OWNER));
    expect(o.masked).toBe(false);
    expect(JSON.stringify(o)).toContain("ZZUP");
    expect(JSON.stringify(await loadRisk(deps(db, OWNER)))).toContain("ZZUP");
    expect((await loadIdeas(deps(db, OWNER))).data.groups[0]!.ideas[0]!.cards[0]!.href).toContain(
      "card",
    );

    await db.auth.execute({
      sql: "INSERT INTO unmask_grant (user_id, granted_by, granted_at, expires_at) VALUES (2, 1, ?, ?)",
      args: ["2026-10-19T00:00:00.000Z", "2026-11-19T00:00:00.000Z"],
    });
    const g = await loadHome(deps(db, EDITOR));
    expect(g.masked).toBe(false);
    expect(g.data.picks.items[0]!.stock).toBe("ZZUP");
    // The grant has expired for a later clock: masked again.
    const later = await loadHome(deps(db, EDITOR, new Date("2026-12-01T00:00:00.000Z")));
    expect(later.masked).toBe(true);
  });

  it("masks when the grant lookup fails, and for an unknown user", async () => {
    const broken = {
      ...deps(db, EDITOR),
      authDb: { execute: () => Promise.reject(new Error("down")) },
    };
    expect((await loadHome(broken)).masked).toBe(true);
    expect((await loadHome(deps(db, null))).masked).toBe(true);
    expect(leaks(await loadHome(deps(db, null)))).toEqual([]);
  });
});
