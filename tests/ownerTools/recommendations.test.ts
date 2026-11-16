// @vitest-environment node
// M21 B1 (UXN-314, UXN-315, UXN-317; D-1216 to D-1219; F): the Owner's recommendations on a real (temporary) database with
// hand-computed figures. The synthetic world has two Balanced picks (ZZUP in Technology, ZZOTH with no sector), both with a
// buy-up-to price of 10.05 and a stop of 9.20; the AU cost profile is P5 (5.00 up to 1,000.00 an order).
//   capital 10,000, Balanced caps 10 % / 1 %: size cap 1,000.00; risk budget 100.00 -> by risk 1,182.35; size 1,000.00
//   shares = floor(1,000.00 / 10.05) = 99 (value 994.95); risk = 99 x 0.85 = 84.15 + 5.00 + 5.00 = 94.15 = 0.94 % of 10,000
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { envOf, fullWorld, D, type World } from "../loaders/world";
import { loadRecommendations, RECOMMENDATIONS_NOTICE } from "@/lib/ownerTools/recommendations";

afterAll(cleanupTempDbs);

let w: World;
beforeAll(async () => {
  w = await fullWorld();
}, 60_000);

const none = { capitalWhole: 0, links: [] as { name: string; url_template: string }[] };

describe("loadRecommendations", () => {
  it("sizes each Balanced pick for a capital of 10,000 on the hand-computed figures", async () => {
    const m = await loadRecommendations(envOf(w, "owner"), { ...none, capitalWhole: 10_000 });
    expect(m.d).toBe(D);
    expect(m.groups.map((g) => [g.profile, g.tier])).toEqual([["balanced", "Balanced"]]);
    const picks = m.groups[0]!.picks;
    expect(picks.map((p) => p.code)).toEqual(["ZZUP", "ZZOTH"]);
    for (const p of picks) {
      expect(p.limitMicro).toBe("10050000");
      expect(p.stopMicro).toBe("9200000");
      expect(p.parcel).toEqual({
        kind: "ok",
        shares: 99n,
        valueMicro: 994_950_000n,
        riskMicro: 94_150_000n,
        riskBp: 94n,
      });
      expect(p.chance).toBe("Not enough history yet");
    }
  });

  it("names the largest sector of the sized parcels (a missing sector is its own group; ties go by name)", async () => {
    const m = await loadRecommendations(envOf(w, "owner"), { ...none, capitalWhole: 10_000 });
    expect(m.groups[0]!.concentration).toBe(
      "Largest sector: Not classified yet, 50 % of the amount",
    );
  });

  it("a capital of 0 sizes nothing: the 'enter an amount' state and no concentration line", async () => {
    const m = await loadRecommendations(envOf(w, "owner"), none);
    expect(m.capitalWhole).toBe(0);
    for (const p of m.groups[0]!.picks) expect(p.parcel).toEqual({ kind: "no_amount" });
    expect(m.groups[0]!.concentration).toBeNull();
  });

  it("a small capital is 'too small for a parcel' (capital 1,000: 99.00 is under the 500.00 floor)", async () => {
    const m = await loadRecommendations(envOf(w, "owner"), { ...none, capitalWhole: 1_000 });
    for (const p of m.groups[0]!.picks) expect(p.parcel).toEqual({ kind: "too_small" });
    expect(m.groups[0]!.concentration).toBeNull();
  });

  it("builds the broker links from the Owner's templates for each pick, and ships none of its own", async () => {
    const none2 = await loadRecommendations(envOf(w, "owner"), { ...none, capitalWhole: 10_000 });
    for (const p of none2.groups[0]!.picks) expect(p.links).toEqual([]);
    const m = await loadRecommendations(envOf(w, "owner"), {
      capitalWhole: 10_000,
      links: [
        { name: "Mine", url_template: "https://broker.example/trade?symbol={code}&ex={market}" },
      ],
    });
    expect(m.groups[0]!.picks[0]!.links).toEqual([
      { name: "Mine", href: "https://broker.example/trade?symbol=ZZUP&ex=AU" },
    ]);
  });

  it("a pick the night's check withdrew is not sized", async () => {
    await w.main.execute({
      sql: `INSERT INTO pick_check (market, d, profile, rank, night_d, valid, reason, checked_at)
            VALUES ('AU', ?, 'balanced', 2, '2026-10-20', 0, 'below_stop', '2026-10-20T00:00:00.000Z')`,
      args: [D],
    });
    const m = await loadRecommendations(envOf(w, "owner"), { ...none, capitalWhole: 10_000 });
    const picks = m.groups[0]!.picks;
    expect(picks[0]!.parcel.kind).toBe("ok");
    expect(picks[1]!.parcel).toEqual({ kind: "withdrawn" });
  });

  it("the fixed words are exactly those of the design", () => {
    expect(RECOMMENDATIONS_NOTICE).toBe(
      "Paper-tested ideas, not advice. Place and manage your own orders.",
    );
  });

  it("reads no row of an unrelated market and works on an empty database", async () => {
    const { emptyWorld } = await import("../loaders/world");
    const e = await emptyWorld();
    const m = await loadRecommendations(envOf(e, "owner"), { ...none, capitalWhole: 10_000 });
    expect(m).toMatchObject({ d: null, groups: [] });
  });
});
