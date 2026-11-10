// @vitest-environment node
// D-913 database step and page loader of the "Follow the picks" portfolio on the shared synthetic
// world (tests/loaders/world.ts): the balanced pick ZZUP bought at 10.00 on D, last close 10.50.
// A re-run writes the same rows; a masked viewer sees letters and percentages only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDbs } from "../db/helpers";
import { findLeaks } from "@/lib/view/mask";
import { runPickPortfolio } from "@/lib/picks/portfolioStore";
import { loadPickPortfolio } from "@/lib/ui/loaders/pickPortfolio";
import { CODES, D, envOf, fullWorld, NAMES, type World } from "../loaders/world";

afterAll(cleanupTempDbs);

let w: World;
beforeAll(async () => {
  w = await fullWorld();
});

const rows = async () =>
  (await w.main.execute("SELECT * FROM pick_portfolio_trade ORDER BY pub_d, rank")).rows.map(
    (r) => ({ ...r }),
  );

describe("runPickPortfolio (D-913)", () => {
  it("buys the tracked pick with a fifth of the money and values it at the close", async () => {
    const r = await runPickPortfolio(w.main, { market: "AU", d: D });
    expect(r).toEqual({ trades: 1, open: 1, days: 1, skipped: 0 }); // valued from the first publication (D)
    const [t] = await rows();
    expect(t).toMatchObject({ code: "ZZUP", entry_d: D, entry_micro: 10_000_000, qty: 100 });
    expect(t!.exit_d).toBeNull();
    const day = (await w.main.execute("SELECT * FROM pick_portfolio_day WHERE d = ?", [D]))
      .rows[0]!;
    expect(Number(day.holdings_micro)).toBe(1_050_000_000); // 100 x 10.50
    expect(Number(day.holdings)).toBe(1);
  });

  it("a re-run writes the same rows", async () => {
    const before = await rows();
    await runPickPortfolio(w.main, { market: "AU", d: D });
    expect(await rows()).toEqual(before);
  });

  it("the Picks page card: value, cash, holding and its change; masked shows percentages only", async () => {
    const v = await loadPickPortfolio(envOf(w, "owner"));
    expect(v).toMatchObject({ started: true, slots: 5, asOfD: D, closed: 0, wins: 0 });
    expect(v.seed?.micro).toBe("5000000000");
    expect(v.holdings).toEqual([
      expect.objectContaining({ stock: "ZZUP", entryD: D, changePpm: 50_000 }),
    ]);
    expect(v.sinceStartPpm! > 0).toBe(true);
    const m = await loadPickPortfolio(envOf(w, "viewer"));
    expect(m.started).toBe(true);
    expect(m.value).toBeNull();
    expect(m.holdings[0]!.entry).toBeNull();
    expect(m.holdings[0]!.changePpm).toBe(50_000);
    expect(findLeaks(m, CODES, NAMES)).toEqual([]);
  });
});
