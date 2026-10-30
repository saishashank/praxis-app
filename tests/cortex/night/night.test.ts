// @vitest-environment node
// runNight on a synthetic ZZ world (M15 C3c; CTX-013/014, CTX-023, CTX-054, D-280, D-281; AT-50
// determinism; TST-109 on the feature step; D-279 purity).
import { describe, expect, it, vi } from "vitest";
import type { Family } from "@/lib/agents/families/types";
import { cutWorld } from "@/lib/cortex/pit/asOfView";
import {
  FAMILY_STATUS_LABEL,
  L0_CODE_LABEL,
  L0_NIGHT_LABEL,
  NOT_ENOUGH_HISTORY_LABEL,
} from "@/lib/cortex/gates";
import { featuresAt, nightOutputJson, runNight, type NightOutput } from "@/lib/cortex/night";
import type { CortexMap } from "@/lib/cortex/score/types";
import {
  BOOKS,
  HASH,
  NIGHT_ANGLES,
  SESSIONS,
  book,
  nightInputs,
  nightView,
  nightWorld,
  ruleFor,
} from "./zzNight";

const T = SESSIONS.length - 1;

describe("runNight: a full night on the ZZ world", () => {
  const out = runNight(nightInputs());

  it("ran, with the scored set's hash and one feature row per universe code", () => {
    expect(out.status).toBe("ran");
    expect(out.reason).toBeNull();
    expect(out.activeSetHash).toBe(HASH);
    expect([...out.features.keys()]).toEqual(["ZZA", "ZZB", "ZZC", "ZZD"]);
    for (const row of out.features.values()) {
      expect([...row.keys()]).toEqual(["A-D1-01", "A-D1-02", "A-D2-01"]);
      for (const v of row.values()) expect(typeof v).toBe("number");
    }
  });

  it("the allowed F1 book takes one live decision, ranked and sized, with a limit below the cap", () => {
    const live = out.decisions.filter((d) => d.bookId === "E01");
    expect(live).toHaveLength(1);
    const d = live[0]!;
    expect(d.arm).toBe("live");
    expect(d.rank).toBe(1);
    expect(d.p).not.toBeNull();
    expect(d.qty > 0n).toBe(true);
    expect(d.stopMicro < d.refMicro).toBe(true);
    expect(d.limitMicro > d.refMicro).toBe(true);
    // every one of the twelve gates evaluated, in order, all passing
    expect(d.trace.map((x) => x.gateId)).toEqual([
      "G01_l0_veto",
      "G02_eligibility",
      "G03_family_status",
      "G04_economic",
      "G05_cost",
      "G06_stop_cap",
      "G07_gap_cap",
      "G08_event_state",
      "G09_regime",
      "G10_disagreement",
      "G11_portfolio",
      "G12_settled_cash",
    ]);
    expect(d.trace.every((x) => x.pass)).toBe(true);
    expect(d.card.costPerOrderPpm).toBeGreaterThan(0);
    expect(d.card.breakEven.map((b) => b.c)).toEqual([0.025, 0.05, 0.075]);
    expect(d.card.independentSources).toEqual(["bar_au"]);
    expect(d.card.regime).toBe("NEUTRAL");
    // the other passers of the book are queued below the slot, not blocked
    expect(out.queued.filter((q) => q.bookId === "E01").length).toBeGreaterThan(0);
  });

  it("the allowed book also runs a shadow arm with the portfolio limits off (CTX-023)", () => {
    const sh = out.shadow.filter((d) => d.bookId === "E01");
    expect(sh).toHaveLength(1);
    const g11 = sh[0]!.trace.find((x) => x.gateId === "G11_portfolio");
    expect(g11).toEqual({ gateId: "G11_portfolio", pass: true, value: "shadow:limits_off" });
    expect(sh[0]!.code).toBe(out.decisions[0]!.code);
  });

  it("shadow families get shadow decisions only, with G03 not applied, and an abstain at G03", () => {
    for (const bookId of ["E04"]) {
      expect(out.decisions.filter((d) => d.bookId === bookId)).toHaveLength(0);
      const sh = out.shadow.filter((d) => d.bookId === bookId);
      expect(sh).toHaveLength(1);
      expect(sh[0]!.trace.find((x) => x.gateId === "G03_family_status")).toEqual({
        gateId: "G03_family_status",
        pass: true,
        value: "shadow",
      });
      const a = out.abstains.find((x) => x.bookId === bookId);
      expect(a?.gateId).toBe("G03_family_status");
      expect(a?.label).toBe(FAMILY_STATUS_LABEL);
      // the live arm of a shadow family is blocked at G03 for every code
      const blockedLive = out.blocked.filter((b) => b.bookId === bookId && b.arm === "live");
      expect(blockedLive.length).toBe(4);
      expect(new Set(blockedLive.map((b) => b.firstFail))).toEqual(new Set(["G03_family_status"]));
    }
    expect(out.abstains.find((x) => x.bookId === "E01")).toBeUndefined();
  });

  it("D-332: an F5 book (U2/U3 universe) sees no U1 candidate at all — no rows, abstain 'no candidates'", () => {
    expect(out.decisions.filter((d) => d.bookId === "E05")).toEqual([]);
    expect(out.shadow.filter((d) => d.bookId === "E05")).toEqual([]);
    expect(out.blocked.filter((d) => d.bookId === "E05")).toEqual([]);
    expect(out.abstains.find((a) => a.bookId === "E05")).toEqual({
      bookId: "E05",
      gateId: "G01_l0_veto",
      label: L0_NIGHT_LABEL,
      detail: { reason: "no_candidates" },
    });
  });

  it("D-332: a U2 code failing ARN-011 is blocked at G01 with the reasons", () => {
    const world = nightWorld({
      tiers: new Map([
        ["ZZA", [{ d: SESSIONS[0]!, tier: "U1" as const }]],
        ["ZZB", [{ d: SESSIONS[0]!, tier: "U2" as const }]],
        ["ZZC", [{ d: SESSIONS[0]!, tier: "U1" as const }]],
        ["ZZD", [{ d: SESSIONS[0]!, tier: "U1" as const }]],
      ]),
    });
    const o = runNight(
      nightInputs(
        T,
        {
          rules: new Map([["F1", ruleFor("F1", { tiers: ["U1", "U2"] })]]),
          arn011Failed: new Map([["ZZB", ["gain_5s_without_price_sensitive_item"]]]),
        },
        nightView(world),
      ),
    );
    const zzb = o.blocked.find((b) => b.bookId === "E01" && b.arm === "live" && b.code === "ZZB");
    expect(zzb?.firstFail).toBe("G01_l0_veto");
    expect(zzb?.trace[0]).toEqual({
      gateId: "G01_l0_veto",
      pass: false,
      label: L0_CODE_LABEL,
      value: "arn011:gain_5s_without_price_sensitive_item",
    });
  });

  it("D-333: the decision carries the family's v1 exit plan (F1: trail, time stop, max hold)", () => {
    const d = out.decisions[0]!;
    expect(d.plan.trails.map((r) => r.id)).toEqual(["trail"]);
    expect(d.plan.cs.map((r) => r.id)).toEqual(["time_stop", "max_hold"]);
    expect(d.stopSpec).toEqual(d.plan.initialStops[0]!.spec);
    expect(d.card.similar).toEqual({ p: d.p, lo: null, hi: null, n: 100 });
  });

  it("D-334: a rule without a band edge fails G04 'band_missing'; D-339: pHidden hides p on the card", () => {
    const o = runNight(
      nightInputs(T, {
        rules: new Map([
          ["F1", ruleFor("F1", { top3MinS: undefined })],
          ["F4", ruleFor("F4", { pHidden: true })],
        ]),
        status: { F1: "allowed", F4: "allowed" },
      }),
    );
    const e01 = o.blocked.filter((b) => b.bookId === "E01" && b.arm === "live");
    expect(e01.length).toBe(4);
    for (const b of e01) {
      expect(b.firstFail).toBe("G04_economic");
      expect(b.trace[b.trace.length - 1]).toMatchObject({
        label: NOT_ENOUGH_HISTORY_LABEL,
        value: "band_missing",
      });
    }
    const f4 = o.decisions.find((d) => d.bookId === "E04")!;
    expect(f4.p).not.toBeNull();
    expect(f4.card.similar).toBeNull();
  });

  it("the sector tilt shadow log covers the taken decision's industry", () => {
    const taken = out.decisions[0]!;
    const tilt = out.sectorTilt.filter((s) => s.bookId === "E01");
    expect(tilt.length).toBeGreaterThan(0);
    const sector =
      taken.code === "ZZC" ? "Energy" : taken.code === "ZZD" ? "Financials" : "Materials";
    const row = tilt.find((s) => s.sector === sector);
    expect(row).toBeDefined();
    // book share of NAV after the entry minus the sector's share of the universe (ZZA, ZZB Materials)
    const universeShare = sector === "Materials" ? 0.5 : 0.25;
    const bookShare = Number(taken.orderValueMicro) / 12_500;
    expect(row!.tiltPp).toBeCloseTo(100 * (bookShare / 1_000_000 - universeShare), 6);
  });
});

describe("runNight: map missing (D-281)", () => {
  const out = runNight(nightInputs(T, { maps: new Map<Family, CortexMap>() }));

  it("D-335: abstains every book; every row of both arms is a G04 map_missing blocked row", () => {
    expect(out.status).toBe("abstain_all");
    expect(out.reason).toBe("map_missing");
    expect(out.decisions).toEqual([]);
    expect(out.queued).toEqual([]);
    expect(out.shadow).toEqual([]);
    expect(out.abstains.map((a) => a.bookId)).toEqual(["E01", "E04", "E05"]);
    expect(out.abstains.find((a) => a.bookId === "E04")?.gateId).toBe("G03_family_status");
    for (const a of out.abstains.filter((x) => x.bookId === "E01")) {
      expect(a.gateId).toBe("G04_economic");
      expect(a.label).toBe(NOT_ENOUGH_HISTORY_LABEL);
      expect(a.detail).toMatchObject({ value: "map_missing" });
    }
    const shadowRows = out.blocked.filter((b) => b.arm === "shadow" && b.bookId !== "E05");
    expect(shadowRows.length).toBe(8);
    for (const b of shadowRows) {
      expect(b.firstFail).toBe("G04_economic");
      expect(b.trace[b.trace.length - 1]).toMatchObject({ value: "map_missing" });
    }
  });
});

describe("runNight: L0 night integrity (CTX-010, D-289)", () => {
  it("a late benchmark bar is an abstain-all with reason late_bar and one abstain per cash-holding book", () => {
    const world = nightWorld();
    const axjo = (world.index!.AXJO ?? []).slice(0, -1); // no ^AXJO bar on the last session
    const view = nightView(nightWorld({ index: { AXJO: axjo } }));
    const out = runNight(nightInputs(T, {}, view));
    expect(out.status).toBe("abstain_all");
    expect(out.reason).toBe("late_bar");
    expect(out.decisions).toEqual([]);
    expect(out.shadow).toEqual([]);
    expect(out.features.size).toBe(0);
    expect(out.abstains).toEqual(
      ["E01", "E04", "E05"].map((bookId) => ({
        bookId,
        gateId: "G01_l0_veto",
        label: L0_NIGHT_LABEL,
        detail: { reason: "late_bar" },
      })),
    );
  });

  it("D-336: the wall-clock budget comes from the caller; the stale share is the core's own figure", () => {
    const quota = runNight(nightInputs(T, { degrade: { elapsedMinutes: 21 } }));
    expect(quota.status).toBe("abstain_all");
    expect(quota.reason).toBe("quota");
    expect(runNight(nightInputs(T, { degrade: { elapsedMinutes: 20 } })).status).toBe("ran");
    // one of four universe codes without a D bar → stale share 25 % > 10 %
    const world = nightWorld();
    const bars = new Map(world.bars);
    bars.set("ZZD", world.bars.get("ZZD")!.slice(0, -1));
    const stale = runNight(nightInputs(T, {}, nightView(nightWorld({ bars }))));
    expect(stale.status).toBe("abstain_all");
    expect(stale.reason).toBe("universe_incomplete");
  });

  it("a book with no cash gets no abstain record (CTX-014: per cash-holding book)", () => {
    const books = [book("E01", "F1", { settledCashMicro: 100_000_000n, navMicro: 100_000_000n })];
    const out = runNight(nightInputs(T, { books, status: { F1: "shadow" } }));
    expect(out.decisions).toEqual([]);
    expect(out.abstains).toEqual([]);
  });
});

describe("runNight: candidates in the regime table (CTX-017)", () => {
  it("F1 is blocked in RISK-OFF (G09 on every code), F4 passes SHOCK at half size", () => {
    const riskOff = runNight(
      nightInputs(
        T,
        { status: { F1: "allowed", F4: "allowed" } },
        nightView(nightWorld(), "RISK-OFF"),
      ),
    );
    const e01 = riskOff.blocked.filter((b) => b.bookId === "E01" && b.arm === "live");
    expect(e01.length).toBe(4);
    expect(new Set(e01.map((b) => b.firstFail))).toEqual(new Set(["G09_regime"]));
    expect(riskOff.abstains.find((a) => a.bookId === "E01")?.gateId).toBe("G09_regime");
    expect(riskOff.decisions.filter((d) => d.bookId === "E04")).toHaveLength(1);

    const shock = runNight(
      nightInputs(
        T,
        { status: { F1: "allowed", F4: "allowed" } },
        nightView(nightWorld(), "SHOCK"),
      ),
    );
    expect(shock.decisions.filter((d) => d.bookId === "E01")).toHaveLength(0);
    const f4 = shock.decisions.filter((d) => d.bookId === "E04");
    expect(f4).toHaveLength(1);
    expect(f4[0]!.halfSize).toBe(true);
    expect(f4[0]!.trace.find((x) => x.gateId === "G09_regime")?.value).toBe("SHOCK:half_size");
  });
});

describe("runNight: determinism (AT-50) and purity (D-279)", () => {
  it("two runs on the same inputs are byte-identical", () => {
    const a = nightOutputJson(runNight(nightInputs()));
    const b = nightOutputJson(runNight(nightInputs()));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1_000);
  });

  it("book order in the inputs does not change the bytes", () => {
    const a = nightOutputJson(runNight(nightInputs()));
    const b = nightOutputJson(runNight(nightInputs(T, { books: [...BOOKS].reverse() })));
    expect(a).toBe(b);
  });

  it("reads no clock and draws no random number of its own", () => {
    const now = vi.spyOn(Date, "now");
    const rnd = vi.spyOn(Math, "random");
    try {
      runNight(nightInputs());
      expect(now).not.toHaveBeenCalled();
      expect(rnd).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      rnd.mockRestore();
    }
  });

  it("nothing reads past t: the night at t on the full world equals the night on the world cut at t", () => {
    const world = nightWorld();
    const t = T - 5;
    const full: NightOutput = runNight(nightInputs(t, {}, nightView(world)));
    const cut: NightOutput = runNight(nightInputs(t, {}, nightView(cutWorld(world, t))));
    expect(nightOutputJson(cut)).toBe(nightOutputJson(full));
  });
});

describe("featuresAt: TST-109 on the feature step", () => {
  it("features at every t from the full view equal the ones from the view cut at t", () => {
    const world = nightWorld();
    const full = nightView(world);
    for (let t = 0; t < SESSIONS.length; t += 1) {
      const cut = nightView(cutWorld(world, t));
      const a = featuresAt(full, t, NIGHT_ANGLES);
      const b = featuresAt(cut, t, NIGHT_ANGLES);
      expect(nightOutputJson({ features: a } as unknown as NightOutput)).toBe(
        nightOutputJson({ features: b } as unknown as NightOutput),
      );
    }
  });

  it("rank-standardises numeric outputs into [-1, 1] with the angle's orientation, undefined kept", () => {
    const f = featuresAt(nightView(nightWorld()), 3, NIGHT_ANGLES); // before both warm-ups
    for (const row of f.values()) {
      expect(row.get("A-D1-01")).toBeUndefined();
      expect(row.get("A-D1-02")).toBeUndefined();
    }
    const g = featuresAt(nightView(nightWorld()), T, NIGHT_ANGLES);
    const vals = [...g.values()].map((r) => r.get("A-D1-01") as number).sort((x, y) => x - y);
    expect(vals[0]).toBe(-1);
    expect(vals[vals.length - 1]).toBe(1);
  });
});
