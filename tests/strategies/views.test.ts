// @vitest-environment node
// M7 T12 loaders (strategyViews.ts): sorting that keeps a strategy's two versions together, the
// attention order, drawdown, the stored replay figures (CIF, effective N, ranking, zero-edge, sleeve),
// trade markers with Decision Card links, version history, and masking per role (DAT-124).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { CARD_UP, deps, EDITOR, emptyDbs, leaks, OWNER, VIEWER, type Both } from "../loaders/seed";
import { strategiesWorld } from "./world";
import { loadStrategies, type StrategyTile } from "@/lib/ui/loaders/strategies";
import {
  attentionOrder,
  attentionReasons,
  drawdownPpm,
  labelRank,
  loadLeaderEvidence,
  loadStrategyExtras,
  loadTileExtras,
  parseRegime,
  sortTiles,
} from "@/lib/ui/loaders/strategyViews";

let w: Both;
beforeAll(async () => {
  w = await strategiesWorld();
});
afterAll(cleanupTempDbs);

const tile = (over: Partial<StrategyTile>): StrategyTile => ({
  execution: "E01",
  family: "F1",
  variant: "U",
  name: "A",
  oneLiner: "",
  moneyType: "Plain shares",
  hasCohort: true,
  round: 1,
  startD: "2026-10-01",
  sessions: 3,
  live: true,
  seed: null,
  nav: null,
  returnPpm: 0,
  positionPpm: 0,
  bust: null,
  target: null,
  stage: "seed",
  bustDistancePpm: null,
  label: null,
  regime: null,
  control: "enabled",
  needsAttention: false,
  attention: [],
  spark: [],
  ...over,
});

describe("sortTiles (UXN-046a)", () => {
  const tiles = [
    tile({ execution: "E01", family: "F1", variant: "U", name: "Zed", returnPpm: 10 }),
    tile({ execution: "E02", family: "F1", variant: "L", name: "Zed", returnPpm: 900 }),
    tile({ execution: "E03", family: "F2", variant: "U", name: "Alpha", returnPpm: 500 }),
    tile({ execution: "E04", family: "F2", variant: "L", name: "Alpha", returnPpm: 400 }),
  ];
  it("keeps the two versions together and orders strategies by the better one", () => {
    expect(sortTiles(tiles, "best").map((t) => t.execution)).toEqual(["E02", "E01", "E03", "E04"]);
  });
  it("sorts A to Z by name with the plain version first", () => {
    expect(sortTiles(tiles, "az").map((t) => t.execution)).toEqual(["E03", "E04", "E01", "E02"]);
  });
  it("puts a missing figure last", () => {
    const t = [
      tile({
        execution: "E01",
        family: "F1",
        returnPpm: null,
        positionPpm: null,
        bustDistancePpm: null,
      }),
      tile({ execution: "E03", family: "F2", returnPpm: 5, positionPpm: 5, bustDistancePpm: 5 }),
    ];
    for (const s of ["best", "closest", "risk"] as const) {
      expect(sortTiles(t, s).map((x) => x.execution)).toEqual(["E03", "E01"]);
    }
  });
  it("is stable and does not change its input", () => {
    const copy = [...tiles];
    expect(sortTiles(tiles, "risk")).toEqual(sortTiles(tiles, "risk"));
    expect(tiles).toEqual(copy);
  });
});

describe("attention order (UXN-046)", () => {
  it("ranks a loss-limit hit before a near-limit warning, then by distance", () => {
    const near = ["Within 15% of the bust level"];
    const a = tile({
      execution: "E01",
      needsAttention: true,
      attention: near,
      bustDistancePpm: 100_000,
    });
    const b = tile({
      execution: "E02",
      needsAttention: true,
      attention: near,
      bustDistancePpm: 50_000,
    });
    const c = tile({ execution: "E03", needsAttention: true, attention: ["Busted"] });
    const d = tile({
      execution: "E04",
      needsAttention: true,
      attention: ["Paused"],
      bustDistancePpm: 1,
    });
    const fine = tile({ execution: "E05" });
    expect(attentionOrder([a, b, c, d, fine]).map((t) => t.execution)).toEqual([
      "E03",
      "E02",
      "E01",
      "E04",
    ]);
  });
  it("words the reasons in plain language", () => {
    expect(attentionReasons(["Within 15% of the bust level", "Busted"]).map((r) => r.text)).toEqual(
      ["Hit its loss limit today and restarts", "Within 15% of its loss limit"],
    );
  });
});

describe("small helpers", () => {
  it("orders the labels as UX-020 (s13) says", () => {
    expect(["FAILED", "UNVALIDATED", "CONSISTENT-FORWARD", null].map(labelRank)).toEqual([
      5, 2, 0, 6,
    ]);
  });
  it("accepts only the four market moods", () => {
    expect(parseRegime("RISK-ON")).toBe("RISK-ON");
    expect(parseRegime("calm")).toBeNull();
    expect(parseRegime(null)).toBeNull();
  });
  it("measures the drop from the highest value in integer ppm", () => {
    expect(drawdownPpm([100, 120, 90, 120, 60])).toEqual([0, 0, -250_000, 0, -500_000]);
    expect(drawdownPpm([])).toEqual([]);
    expect(drawdownPpm([0, 0])).toEqual([0, 0]);
  });
});

describe("tile extras", () => {
  it("reads open positions, sleeve state and the worst warning sign", async () => {
    const x = await loadTileExtras(deps(w, OWNER), ["E01", "E02"]);
    expect(x.E01).toEqual({ openPositions: 1, sleeve: null, breaker: "red" });
    expect(x.E02!.openPositions).toBe(0);
    expect(await loadTileExtras(deps(w, OWNER), [])).toEqual({});
  });
});

describe("strategy extras", () => {
  it("gives the Owner codes, dates, prices and a Decision Card link on the trade", async () => {
    const d = await loadStrategyExtras(deps(w, OWNER), "E01", [
      "2026-10-15",
      "2026-10-16",
      "2026-10-19",
    ]);
    const up = d.trades.find((t) => t.entryDate === "2026-10-16")!;
    expect(up).toMatchObject({
      stock: "ZZUP",
      qty: 3,
      open: true,
      cardHref: `/cards/${encodeURIComponent(CARD_UP)}`,
    });
    expect(up.entryPrice).toEqual({ micro: 12_000_000, currency: "AUD", simulated: true });
    const closed = d.trades.find((t) => t.stock === "ZZDN")!;
    expect(closed).toMatchObject({ returnPpm: 100_000, exitType: "IS", cardHref: null });
    expect(closed.pnl?.micro).toBe(5_000_000); // (11 - 10) x 5 shares
    expect(d.trades.map((t) => t.key)).toEqual(["t1", "t2", "t3"]);
  });

  it.each([
    ["editor", EDITOR],
    ["viewer", VIEWER],
  ])(
    "shows %s letters, weeks, no prices, no exact dates and an opaque card link",
    async (_n, u) => {
      const d = await loadStrategyExtras(deps(w, u), "E01", ["2026-10-15"]);
      expect(d.trades.length).toBe(3);
      for (const t of d.trades) {
        expect(t.stock).toMatch(/^Stock [A-Z]+$|^Another stock$/);
        expect(t.entryDate).toBeNull();
        expect(t.exitDate).toBeNull();
        expect(t.entryPrice).toBeNull();
        expect(t.exitPrice).toBeNull();
        expect(t.pnl).toBeNull();
        expect(t.entryDay).toMatch(/^\d{4}-W\d{2}$/);
      }
      const linked = d.trades.find((t) => t.cardHref !== null)!;
      expect(linked.cardHref).toMatch(/^\/cards\/ck%3A[0-9a-f]{16}$/);
      expect(leaks(d)).toEqual([]);
    },
  );

  it("reads market mood by date, the matched control and the zero-edge benchmark", async () => {
    const d = await loadStrategyExtras(deps(w, OWNER), "E01", ["2026-10-15", "2026-10-19"]);
    expect(d.regimes).toEqual([null, "NEUTRAL"]);
    expect(d.controls).toEqual([
      {
        id: "C2",
        label: "Matched control C2",
        points: [
          { d: "2026-10-15", nav: 600_000_000 },
          { d: "2026-10-16", nav: 605_000_000 },
          { d: "2026-10-19", nav: 615_000_000 },
        ],
      },
    ]);
    expect(d.zeroEdge).toMatchObject({
      target: 0.03,
      trials: 2000,
      meanNavMinusSeedMicro: -15_000_000,
    });
  });

  it("maps CIF horizons of 63 / 126 / 252 sessions to 3 / 6 / 12 months with intervals", async () => {
    const d = await loadStrategyExtras(deps(w, OWNER), "E01", []);
    expect(d.evidence?.cif.map((r) => r.month)).toEqual([3, 6, 12]);
    expect(d.evidence?.cif[2]!.target).toEqual({ p: 0.12, lo: 0.02, hi: 0.5 });
    expect(d.evidence).toMatchObject({
      effectiveN: 5,
      minusC2Micro: 10_000_000,
      comparator: "C2-F1",
    });
    expect(d.evidence?.navMinusSeed).toEqual({
      n: 5,
      meanMicro: 20_000_000,
      lowerMicro: -30_000_000,
      upperMicro: 60_000_000,
    });
  });

  it("lists versions with the test result and offers a revert only to an earlier live version", async () => {
    const d = await loadStrategyExtras(deps(w, OWNER), "E01", []);
    expect(d.versions.map((v) => [v.id, v.live, v.revertable, v.validation])).toEqual([
      ["F1.v2", true, false, "passed"],
      ["F1.v1", false, true, null],
    ]);
    expect(d.pendingChallengers).toEqual([{ id: "C-1", state: "proposed" }]);
    expect(d.family).toBe("F1");
  });

  it("reads the sleeve at 10 times and at 5 times, labelled hypothetical, for the L version only", async () => {
    const l = await loadStrategyExtras(deps(w, OWNER), "E02", []);
    expect(l.sleeve?.hypotheticalLabel).toBe("hypothetical leverage");
    expect(l.sleeve?.levered).toMatchObject({
      leverage: 10,
      sleeveTrades: 12,
      closeouts: 1,
      locks: 2,
    });
    expect(l.sleeve?.levered?.netPl?.micro).toBe(-25_000_000);
    expect(l.sleeve?.reality).toMatchObject({ leverage: 5 });
    expect((await loadStrategyExtras(deps(w, OWNER), "E01", [])).sleeve).toBeNull();
  });

  it("answers an unknown strategy with nothing", async () => {
    const d = await loadStrategyExtras(deps(w, OWNER), "E99", []);
    expect(d.trades).toEqual([]);
    expect(d.family).toBeNull();
  });
});

describe("leaderboard evidence", () => {
  it("reads the stored ranking as one tied group and the labels", async () => {
    const e = await loadLeaderEvidence(deps(w, OWNER));
    expect(e.runId).toBe("arena-3:AU:2026-10-19");
    expect(e.groups).toEqual([{ rank: 1, tied: true, members: ["E01", "E02"] }]);
    expect(e.insufficient).toEqual([]);
    expect(e.labels.E01).toMatchObject({ label: "UNVALIDATED", possibleLuck: false });
    expect(e.zeroEdge.E01!.target).toBe(0.03);
    expect(Object.keys(e.rows).sort()).toEqual(["E01", "E02"]);
    expect(e.regimeRounds).toBeNull();
  });

  it("is the same for every role and holds no stock code", async () => {
    for (const u of [OWNER, EDITOR, VIEWER]) {
      const e = await loadLeaderEvidence(deps(w, u));
      expect(leaks(e)).toEqual([]);
      expect(e.groups).toEqual([{ rank: 1, tied: true, members: ["E01", "E02"] }]);
    }
  });

  it("has no ranking before the first run", async () => {
    const none = await emptyDbs();
    const e = await loadLeaderEvidence(deps(none, OWNER));
    expect(e).toMatchObject({ runId: null, groups: null, rows: {} });
  });

  it("counts rounds that started under a market mood", async () => {
    // No regime row exists for the start date 2026-10-12, so no round started under RISK-ON yet.
    const before = await loadLeaderEvidence(deps(w, OWNER), { regime: "RISK-ON" });
    expect(before.regimeRounds).toEqual({});
    await w.main.execute(
      "INSERT INTO regime_daily (market, d, version, close_micro, raw_state, state) VALUES ('AU','2026-10-12',1,1,'RISK-ON','RISK-ON')",
    );
    const on = await loadLeaderEvidence(deps(w, OWNER), { regime: "RISK-ON" });
    expect(on.regimeRounds!.E01).toMatchObject({ rounds: 1 });
  });
});

describe("the list still agrees with the badge count", () => {
  it("counts one strategy that needs attention", async () => {
    const s = await loadStrategies(deps(w, OWNER));
    expect(attentionOrder(s.data.tiles).map((t) => t.execution)).toEqual(["E02"]);
    expect(s.data.attentionCount).toBe(1);
  });
});
