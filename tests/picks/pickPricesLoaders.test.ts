// @vitest-environment node
// Owner 2026-11-16: the loaders behind the pick cards give the entry price, the current price with its
// change from entry and the company name; a masked viewer gets percentages only, never a name or price.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPicks } from "@/lib/ui/loaders/picks";
import { loadPickNow } from "@/lib/ui/loaders/pickNow";
import { loadMyPortfolios } from "@/lib/ui/loaders/pickPortfolio";
import { loadHome } from "@/lib/ui/loaders/home";
import { cleanupTempDbs } from "../db/helpers";
import { D, envOf, fullWorld, type World } from "../loaders/world";
import { deps, emptyDbs, OWNER, seedPopulated, VIEWER } from "../loaders/seed";

afterAll(cleanupTempDbs);

const m = (micro: string) => ({ micro, currency: "AUD" as const, simulated: true as const });

describe("loaders", () => {
  let w: World;
  beforeAll(async () => {
    w = await fullWorld();
  });

  it("loadPicks: entry, now from the last close and the change from entry; masked has no price", async () => {
    const owner = await loadPicks(envOf(w, "owner"), { profile: "balanced" });
    const p = owner.picks[0]!;
    expect(p.entry).toEqual(m("10000000")); // the pick-night close (the world pick is closed, not open)
    expect(p.entryBought).toBe(false);
    expect(p.lastCloseD).toBe(D);
    expect(p.now?.money?.micro).toBe("10500000");
    expect(p.now?.changePpm).toBe(50_000);
    expect(p.now?.label).toBe("End of day, Mon 19 Oct");
    const masked = await loadPicks(envOf(w, "viewer"), { profile: "balanced" });
    const q = masked.picks[0]!;
    expect(q).toMatchObject({ entry: null, lastCloseD: null, company: null });
    expect(q.now).toEqual({ money: null, changePpm: 50_000, label: null });
    expect(JSON.stringify(masked)).not.toMatch(/Zed|ZZ|10500000/);
  });

  it("loadPicks: a newer delayed quote wins over the close; no price gives no now", async () => {
    await w.main.execute({
      sql: "INSERT INTO quote_latest (market, code, last_micro, prev_close_micro, quote_at, fetched_at) VALUES ('AU','ZZOTH',2420000,2200000,'2026-10-20T02:05:00.000Z','2026-10-20T02:06:00.000Z')",
      args: [],
    });
    const owner = await loadPicks(envOf(w, "owner"), { profile: "balanced" });
    const oth = owner.picks.find((x) => x.stock === "ZZOTH")!;
    expect(oth.now?.money?.micro).toBe("2420000");
    expect(oth.now?.label).toMatch(/^Delayed, \d\d:\d\d$/);
    expect((await loadPickNow(w.main, "AU", ["ZZNONE"])).size).toBe(0);
  });

  it("loadHome: company, entry, now and percentages; masked has none of the names or prices", async () => {
    const pop = await emptyDbs();
    await seedPopulated(pop);
    const owner = await loadHome(deps(pop, OWNER));
    const up = owner.data.picks.items.find((x) => x.stock === "ZZUP")!;
    expect(up.company).toBe("Zed Upward Holdings");
    expect(up.entryMicro).toBe(12_340_000);
    expect(up.entryBought).toBe(false);
    expect(up.nowMicro).toBe(12_340_000);
    expect(up.nowChangePpm).toBe(0);
    expect(up.nowLabel).toMatch(/^End of day, /);
    expect(up.stopPpm).toBe(-108_590);
    const viewer = await loadHome(deps(pop, VIEWER));
    expect(viewer.data.picks.items.length).toBeGreaterThan(0);
    for (const it of viewer.data.picks.items) {
      expect(it).toMatchObject({
        company: null,
        entryMicro: null,
        nowMicro: null,
        nowLabel: null,
        lastCloseD: null,
        referenceMicro: null,
      });
      expect(it.stopPpm).not.toBeNull();
    }
    expect(JSON.stringify(viewer.data.picks)).not.toMatch(/Zed|ZZUP|12340000/);
  });

  it("loadMyPortfolios: every holding and trade carries a company field, null when masked", async () => {
    const o = await loadMyPortfolios(envOf(w, "owner"));
    for (const x of o.portfolios.flatMap((p) => [...p.holdings, ...p.trades]))
      expect(x).toHaveProperty("company");
    const v = await loadMyPortfolios(envOf(w, "viewer"));
    for (const x of v.portfolios.flatMap((p) => [...p.holdings, ...p.trades]))
      expect(x.company).toBeNull();
  });
});
