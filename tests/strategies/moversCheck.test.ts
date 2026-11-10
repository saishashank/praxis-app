// D-886 movers check: what the six strategies did with the day's top rises and falls.
import { afterAll, describe, expect, it } from "vitest";
import { fallRow, loadMoversCheck, riseRow, type MoverContext } from "@/lib/ui/loaders/moversCheck";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld } from "../loaders/world";

afterAll(cleanupTempDbs);

const ctx = (over: Partial<MoverContext> = {}): MoverContext => ({
  d: "2026-11-03",
  holds: new Map(),
  ideas: new Map(),
  followed: new Map(),
  nameOf: (f) => ({ F1: "Follow the trend", F4: "Buy the dip" })[String(f) as "F1"] ?? String(f),
  ...over,
});
const row = (stock: string, changePpm: number) => ({ stock, name: `${stock} Ltd`, changePpm });

describe("riseRow (D-886)", () => {
  it("held during the rise names the strategies", () => {
    const r = riseRow(
      ctx({ holds: new Map([["AAA", [{ family: "F1", exitD: null, exitType: null }]]]) }),
      row("AAA", 90_000),
    );
    expect(r.verdict).toBe("held");
    expect(r.text).toBe("Held during the rise by Follow the trend.");
  });

  it("an idea the evening before that was not bought gives the plain reasons", () => {
    const r = riseRow(
      ctx({
        ideas: new Map([
          ["AAA", [{ family: "F4", taken: false, reason: "skipped_stop_distance" }]],
        ]),
      }),
      row("AAA", 90_000),
    );
    expect(r.verdict).toBe("idea_not_bought");
    expect(r.strategies).toEqual(["Buy the dip"]);
    expect(r.text).toMatch(/stop would have been too far below the entry price/);
  });

  it("outside the universe, or followed with no rule matched", () => {
    expect(riseRow(ctx(), row("AAA", 1)).verdict).toBe("not_followed");
    const small = riseRow(ctx({ followed: new Map([["AAA", "below_floor"]]) }), row("AAA", 1));
    expect(small.text).toMatch(/too small or too thinly traded/);
    const active = riseRow(ctx({ followed: new Map([["AAA", "active"]]) }), row("AAA", 1));
    expect(active.verdict).toBe("no_rule");
  });
});

describe("fallRow (D-886)", () => {
  it("sold that day by the stop, or still held with the stop in force", () => {
    const sold = fallRow(
      ctx({ holds: new Map([["BBB", [{ family: "F1", exitD: "2026-11-03", exitType: "IS" }]]]) }),
      row("BBB", -80_000),
    );
    expect(sold.verdict).toBe("sold_by_stop");
    expect(sold.text).toMatch(/sold that day by the stop loss/);
    const heldOn = fallRow(
      ctx({ holds: new Map([["BBB", [{ family: "F1", exitD: null, exitType: null }]]]) }),
      row("BBB", -80_000),
    );
    expect(heldOn.verdict).toBe("held_in_fall");
    const soldOther = fallRow(
      ctx({ holds: new Map([["BBB", [{ family: "F1", exitD: "2026-11-03", exitType: "CS" }]]]) }),
      row("BBB", -80_000),
    );
    expect(soldOther.text).toBe("Held by Follow the trend and sold that day.");
  });

  it("avoided, with the reason when it was an idea", () => {
    expect(fallRow(ctx(), row("BBB", -1)).text).toBe("Not held: no strategy held it.");
    const idea = fallRow(
      ctx({ ideas: new Map([["BBB", [{ family: "F4", taken: false, reason: "gate" }]]]) }),
      row("BBB", -1),
    );
    expect(idea.verdict).toBe("not_held");
    expect(idea.text).toMatch(/market conditions did not allow/);
  });
});

describe("loadMoversCheck (D-886)", () => {
  it("lists the liquid movers of the latest session and hides everything from a masked viewer", async () => {
    const w = await fullWorld();
    await w.main.execute(
      "INSERT INTO instrument (market, code, name, sector) VALUES ('AU','ZZLIQ','Zed Liquid Ltd','Technology'), ('AU','ZZDRP','Zed Drop Ltd','Materials')",
    );
    for (const [code, d, c] of [
      ["ZZLIQ", "2026-10-16", 20],
      ["ZZLIQ", D, 21],
      ["ZZDRP", "2026-10-16", 30],
      ["ZZDRP", D, 27],
    ] as const) {
      await w.main.execute({
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU', ?, ?, ?, ?, ?, ?, 100000, 'test', ?, ?)`,
        args: [code, d, c, c, c, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
      });
    }
    const m = await loadMoversCheck(envOf(w, "owner"));
    expect(m.hidden).toBe(false);
    expect(m.d).toBe(D);
    expect(m.prev).toBe("2026-10-16");
    expect(m.rises.map((r) => r.code)).toEqual(["ZZLIQ"]);
    expect(m.falls.map((r) => r.code)).toEqual(["ZZDRP"]);
    expect(m.falls[0]!.verdict).toBe("not_held");
    expect(m.summary).toEqual({ risesHeld: 0, fallsHeld: 0, fallsSold: 0 });

    const masked = await loadMoversCheck(envOf(w, "viewer"));
    expect(masked).toMatchObject({ hidden: true, rises: [], falls: [] });
  });
});
