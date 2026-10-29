// Company loader, index strip and the Market loader additions of M7 T15 (UXN-270/271, decision 21 of
// docs/M7_design.md, D-136/D-139). Synthetic ZZ data only. Covers the unmasked company model (candles as
// integer micro prices, key numbers, markers, our activity), the masked model (derived numbers only, no
// code, name, price, candle, link or activity; real code = same 404 as unknown), the 52-week position and
// volume-against-usual arithmetic, the moving-average relation, and the new Market list fields.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCompany, loadIndexStrip } from "@/lib/ui/loaders/company";
import { loadMarket, loadOverview } from "@/lib/ui/loaders/market";
import { mq } from "./query";
import { findLeaks } from "@/lib/view/mask";
import { cleanupTempDbs } from "../db/helpers";
import { CODES, D, envOf, fullWorld, NAMES, type World } from "../loaders/world";

let w: World;
const run = (sql: string, args: Array<string | number | null> = []) =>
  w.main.execute({ sql, args });

/** `n` calendar days before 2026-10-16 as YYYY-MM-DD. */
const before = (n: number): string =>
  new Date(Date.parse("2026-10-16T00:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await fullWorld();
  // 210 older bars for ZZUP: the close rises one cent a day, volume 1,000 a day.
  for (let n = 1; n <= 210; n++) {
    const d = before(n);
    const c = 10 - n * 0.01;
    await run(
      `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
       VALUES ('AU','ZZUP', ?, ?, ?, ?, ?, 1000, 'test', ?, ?)`,
      [d, c, c + 0.05, c - 0.05, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    );
  }
  // D-193: ZZBIG trades A$2M a day at A$10 for 210 sessions: Large (ARN-010 U1). The other codes
  // trade a few thousand dollars a day, below every floor, so the size groups leave them out.
  await run(
    "INSERT INTO instrument (market, code, name, sector) VALUES ('AU','ZZBIG','Zed Big Ltd','Materials')",
  );
  await w.main.batch(
    Array.from({ length: 211 }, (_, n) => {
      const d = n === 0 ? D : before(n);
      const c = n === 0 ? 10.2 : 10;
      return {
        sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
              VALUES ('AU','ZZBIG', ?, ?, ?, ?, ?, 200000, 'test', ?, ?)`,
        args: [d, c, c, c, c, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
      };
    }),
    "write",
  );
  // and on every other date of the world, so its 60-session window is full
  await run(
    `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
     SELECT 'AU', 'ZZBIG', d, 10, 10, 10, 10, 200000, 'test', d || 'T06:00:00.000Z', d || 'T06:05:00.000Z'
     FROM (SELECT DISTINCT d FROM price_bar WHERE market = 'AU')
     WHERE d NOT IN (SELECT d FROM price_bar WHERE code = 'ZZBIG')`,
  );
  await run(
    `INSERT INTO universe_snapshot (market, d, code, status, tier) VALUES
       ('AU', ?, 'ZZUP', 'active', 'U1'), ('AU', ?, 'ZZDN', 'active', 'U2')`,
    [D, D],
  );
  for (const [d, c] of [
    ["2026-10-15", 7000],
    ["2026-10-16", 7035],
    [D, 7070],
  ] as const) {
    await run(
      `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
       VALUES ('AU','ZZX', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      [d, c * 1e6, c * 1e6, c * 1e6, c * 1e6, `${d}T06:00:00.000Z`, `${d}T06:05:00.000Z`],
    );
  }
});
afterAll(cleanupTempDbs);

describe("the company model for the Owner", () => {
  it("returns candles as integer micro prices and the derived numbers", async () => {
    const c = await loadCompany(envOf(w, "owner"), "ZZUP");
    expect(c).not.toBeNull();
    expect(c!.masked).toBe(false);
    expect(c!.name).toBe("Zed Upward Holdings");
    expect(c!.stock).toBe("ZZUP");
    expect(c!.slug).toBe("ZZUP");
    expect(c!.sector).toBe("Technology");
    expect(c!.sizeGroup).toBe("Large");
    expect(c!.d).toBe(D);
    expect(c!.closeMicro).toBe("10500000");
    expect(c!.changePpm).toBe(50_000); // 10.00 -> 10.50
    expect(c!.bars).toHaveLength(212);
    const last = c!.bars[c!.bars.length - 1]!;
    expect(last).toMatchObject({ time: D, c: 10_500_000, volume: 1200 });
    for (const b of c!.bars) {
      for (const v of [b.o, b.h, b.l, b.c]) expect(Number.isInteger(v)).toBe(true);
    }
    expect(c!.bars.map((b) => b.time)).toEqual([...c!.bars.map((b) => b.time)].sort());
  });

  it("works out volume against usual, the 52-week position and the moving averages", async () => {
    const c = (await loadCompany(envOf(w, "owner"), "ZZUP"))!;
    // 20 sessions before the last bar: 2026-10-16 (1,000) and 19 older bars of 1,000.
    expect(c.usualVolume).toBe(1000);
    expect(c.volumeVsUsualPpm).toBe(1_200_000);
    // The last bar (high 10.50) is the year's high; the oldest bar (low 7.85) is the low.
    expect(c.rangeHighMicro).toBe("10500000");
    expect(c.rangeLowMicro).toBe("7850000");
    expect(c.rangePositionPpm).toBe(1_000_000);
    expect(c.ma.short).toMatchObject({ days: 50, above: true });
    expect(c.ma.long).toMatchObject({ days: 200, above: true });
  });

  it("an upper-case or lower-case code finds the same company; junk keys are unknown", async () => {
    expect((await loadCompany(envOf(w, "owner"), "zzup"))?.stock).toBe("ZZUP");
    for (const bad of ["", "../x", "ZZUP;DROP", "ABCDEFGHIJ", "ZZNOPE"]) {
      expect(await loadCompany(envOf(w, "owner"), bad)).toBeNull();
    }
  });

  it("carries practice markers (pick, announcement) and our activity", async () => {
    const c = (await loadCompany(envOf(w, "owner"), "ZZUP"))!;
    expect(c.markers.some((m) => m.kind === "pick" && m.time === D)).toBe(true);
    expect(c.markers.some((m) => m.kind === "news" && m.time === D)).toBe(true);
    expect(c.activity).not.toBeNull();
    expect(c.activity!.ideas).toEqual([{ family: "F1", name: expect.any(String) }]);
    expect(c.announcements).toHaveLength(1);
    expect(c.announcements[0]!.url).toBe("https://news.example.test/doc.pdf");
  });

  it("a company without bars is an empty page, not a failure", async () => {
    await run(
      `INSERT INTO instrument (market, code, name) VALUES ('AU','ZZNEW','Zed New Listing')`,
    );
    const c = (await loadCompany(envOf(w, "owner"), "ZZNEW"))!;
    expect(c.state).toBe("empty");
    expect(c.bars).toEqual([]);
    expect(c.closeMicro).toBeNull();
    expect(c.changePpm).toBeNull();
    expect(c.rangePositionPpm).toBeNull();
    expect(c.ma).toEqual({ short: null, long: null });
  });

  it("marks stale data when the last bar is old", async () => {
    const later = new Date("2026-11-20T03:00:00.000Z");
    const c = (await loadCompany(envOf(w, "owner", later), "ZZUP"))!;
    expect(c.state).toBe("stale");
    expect(c.staleText).toContain(D);
  });
});

describe("the company model for a masked user (decision 21, DAT-124)", () => {
  it("is addressed by the opaque slug and carries derived numbers only", async () => {
    for (const who of ["editor", "viewer"] as const) {
      // Active set of the day: ZZDN = Stock A, ZZUP = Stock B.
      const c = (await loadCompany(envOf(w, who), "stock-b"))!;
      expect(c).not.toBeNull();
      expect(c.masked).toBe(true);
      expect(c.stock).toBe("Stock B");
      expect(c.slug).toBe("stock-b");
      expect(c.name).toBeNull();
      expect(c.sector).toBeNull();
      expect(c.sizeGroup).toBeNull();
      expect(c.closeMicro).toBeNull();
      expect(c.rangeLowMicro).toBeNull();
      expect(c.rangeHighMicro).toBeNull();
      expect(c.bars).toEqual([]);
      expect(c.markers).toEqual([]);
      expect(c.activity).toBeNull();
      expect(c.starred).toBe(false);
      expect(c.changePpm).toBe(50_000);
      expect(c.volumeVsUsualPpm).toBe(1_200_000);
      expect(c.rangePositionPpm).not.toBeNull();
      expect(c.ma.short).not.toBeNull();
      expect(findLeaks(c, CODES, NAMES)).toEqual([]);
      expect(JSON.stringify(c)).not.toMatch(/https?:/);
    }
  });

  it("announcement headlines are masked: no code, name, price, link or exact date", async () => {
    const c = (await loadCompany(envOf(w, "viewer"), "stock-b"))!;
    expect(c.announcements).toHaveLength(1);
    const a = c.announcements[0]!;
    expect(a.title).not.toMatch(/ZZUP|Zed Upward|12\.34/);
    expect(a.url).toBeNull();
    expect(a.published).toMatch(/^\d{4}-W\d{2}$/);
  });

  it("a real code, a stock outside the day's active set and junk are all the same 'not found'", async () => {
    for (const key of ["ZZUP", "zzup", "ZZOTH", "stock-c", "stock-zz", "stock-", "../x"]) {
      expect(await loadCompany(envOf(w, "editor"), key)).toBeNull();
    }
  });

  it("a Viewer with a live unmask grant sees the full model", async () => {
    const c = (await loadCompany(envOf(w, "granted"), "ZZUP"))!;
    expect(c.masked).toBe(false);
    expect(c.name).toBe("Zed Upward Holdings");
    expect(c.bars.length).toBeGreaterThan(0);
    expect(c.starred).toBe(false); // a Viewer has no list
  });
});

describe("the index strip", () => {
  it("returns the index with the most bars, its day change and closes oldest first", async () => {
    const s = await loadIndexStrip(envOf(w, "viewer"));
    expect(s).toEqual({
      code: "ZZX",
      d: D,
      changePpm: 4975, // 7035 -> 7070
      closes: [7_000_000_000, 7_035_000_000, 7_070_000_000],
    });
  });

  it("is null when no index is stored", async () => {
    const { emptyWorld } = await import("../loaders/world");
    const e = await emptyWorld();
    expect(await loadIndexStrip(envOf(e, "owner"))).toBeNull();
  });
});

describe("the Market list additions", () => {
  it("D-193, D-205: All by default, one size group on request, from the bars, without penny stocks", async () => {
    const m = await loadMarket(envOf(w, "owner"), mq());
    expect(m).toMatchObject({ size: "all", sized: true });
    expect(m.traded.rows.map((r) => r.stock)).toEqual(["ZZBIG"]);
    const big = m.up.rows.find((r) => r.stock === "ZZBIG")!;
    expect(big.sizeGroup).toBe("Large");
    expect(big.volumeVsUsualPpm).toBe(1_000_000); // as usual
    // the barely traded codes are in no group
    for (const size of ["large", "mid", "small"] as const) {
      const all = await loadMarket(envOf(w, "owner"), mq({ open: ["all"], size }));
      expect(all.all.rows.map((r) => r.stock).filter((c) => c !== "ZZBIG")).toEqual([]);
    }
    expect(
      (await loadMarket(envOf(w, "owner"), mq({ open: ["all"], size: "mid" }))).all.rows,
    ).toEqual([]);
  });

  it("gives a masked user the derived fields only, as Stock A and Stock B", async () => {
    const m = await loadMarket(envOf(w, "editor"), mq());
    expect(m.masked).toBe(true);
    const all = [...m.up.rows, ...m.down.rows, ...m.traded.rows];
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(r.stock).toMatch(/^Stock [A-Z]+$/);
      expect(r.sizeGroup).toBeNull();
      expect(r.close).toBeNull();
      expect(r.name).toBeNull();
    }
    expect(findLeaks(m, CODES, NAMES)).toEqual([]);
  });

  it("D-196: the overview carries a rules-based SWOT once a company has a year of history", async () => {
    const big = await loadOverview(envOf(w, "owner"), "ZZBIG");
    expect(big!.swot!.strengths).toContain("Heavily traded: easy to buy and sell (Large).");
    expect(big!.notice).toMatch(/fixed rules/);
    // ZZUP's 212 bars are enough; ZZOTH has only a few, so it says so instead
    expect((await loadOverview(envOf(w, "owner"), "ZZOTH"))!.swot).toBeNull();
  });

  it("the overview of the same company agrees with the company page", async () => {
    const o = await loadOverview(envOf(w, "owner"), "ZZUP");
    const c = (await loadCompany(envOf(w, "owner"), "ZZUP"))!;
    expect(o!.changePpm).toBe(c.changePpm);
    expect(o!.close!.micro).toBe(c.closeMicro);
  });
});
