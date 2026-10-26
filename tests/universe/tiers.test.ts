// @vitest-environment node
// ARN-010 tiers from stored bars (D-189): U1 = top 300 by 60-session median traded value with price
// >= A$0.50 and ADV >= A$1M; U2 = ADV >= A$250k, price >= A$0.20, listed >= 12 months; U3 = ADV >=
// A$100k, price >= A$0.10; below that, status below_floor. And the pipeline's default hook writes them.
import { describe, expect, it } from "vitest";
import {
  assignTiers,
  medianMicro,
  TIER_RULES,
  type TierInput,
} from "@/lib/data/universe/tiers.mjs";
import { computeTiers, runBatch1 } from "@/lib/data/pipeline/batch1";
import { at1730, bar, pipelineDb, text } from "../pipeline/helpers";
import { cleanupTempDbs } from "../db/helpers";
import { afterEach } from "vitest";

afterEach(cleanupTempDbs);

const A$ = (n: number): bigint => BigInt(Math.round(n * 1e6));
const D = "2026-10-26";
const row = (
  code: string,
  price: number,
  adv: number,
  over: Partial<TierInput> = {},
): TierInput => ({
  code,
  priceMicro: A$(price),
  tradedMicro: Array.from({ length: 60 }, () => A$(adv)),
  listedSince: "2020-10-01",
  ...over,
});

describe("assignTiers", () => {
  it("uses the median traded value, not the mean", () => {
    expect(medianMicro([1n, 100n, 2n])).toBe(2n);
    expect(medianMicro([4n, 1n, 3n, 2n])).toBe(2n); // the lower middle: never an invented value
  });

  it("places each code by the ARN-010 table", () => {
    const t = assignTiers(
      [
        row("BIG", 5, 2_000_000),
        row("MID", 0.3, 300_000),
        row("NEW", 0.3, 300_000, { listedSince: "2026-03-01" }), // listed under 12 months
        row("SML", 0.12, 150_000),
        row("CHEAP", 0.05, 5_000_000), // price under every floor
        row("THIN", 1, 50_000), // ADV under every floor
        row("NONE", 1, 0, { tradedMicro: [] }), // no bars in the window
      ],
      D,
    );
    expect(Object.fromEntries([...t].map(([c, v]) => [c, `${v.tier}/${v.status}`]))).toEqual({
      BIG: "U1/active",
      MID: "U2/active",
      NEW: "U3/active",
      SML: "U3/active",
      CHEAP: "U3/below_floor",
      THIN: "U3/below_floor",
      NONE: "U3/below_floor",
    });
    expect(t.get("BIG")!.advMicro).toBe(A$(2_000_000));
    expect(t.get("NONE")!.advMicro).toBeNull();
  });

  it("U1 is the top 300 by ADV; the rest fall to U2; ties break by code", () => {
    const rows = Array.from({ length: 302 }, (_, i) =>
      row(`C${String(i).padStart(3, "0")}`, 2, 2_000_000 + (i < 2 ? 0 : i)),
    );
    const t = assignTiers(rows, D);
    const u1 = [...t].filter(([, v]) => v.tier === "U1").map(([c]) => c);
    expect(u1).toHaveLength(TIER_RULES.u1.top);
    // C000 and C001 share the lowest ADV: both fall outside the top 300, to U2
    expect(t.get("C000")!.tier).toBe("U2");
    expect(t.get("C001")!.tier).toBe("U2");
  });

  it("U1 needs a full 60-session window; U2 checks market cap only when it is known", () => {
    const t = assignTiers(
      [
        row("SHORT", 5, 2_000_000, {
          tradedMicro: Array.from({ length: 30 }, () => A$(2_000_000)),
        }),
        row("SMALLCAP", 0.5, 300_000, { mcapMicro: A$(10_000_000) }),
      ],
      D,
    );
    expect(t.get("SHORT")!.tier).toBe("U2");
    expect(t.get("SMALLCAP")!.tier).toBe("U3");
  });
});

describe("the pipeline's default tiers hook", () => {
  it("computes the tiers from the bars before the night and stores below-floor codes apart", async () => {
    const db = await pipelineDb({ codes: ["ZZA", "ZZB"] });
    // 60 sessions of history: ZZA trades A$2M a day at A$10, ZZB A$1,000 a day
    const days: string[] = [];
    for (
      let d = new Date("2026-07-01T00:00:00Z");
      days.length < 61;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    }
    for (const d of days.slice(0, 60)) {
      for (const [code, vol] of [
        ["ZZA", 200_000],
        ["ZZB", 100],
      ] as const) {
        await db.execute({
          sql: `INSERT INTO price_bar (market, code, d, o, h, l, c, volume, source, published_at, ingested_at)
                VALUES ('AU', ?, ?, 10, 10, 10, 10, ?, 'yahoo_eod', ?, ?)`,
          args: [code, d, vol, `${d}T07:00:00Z`, `${d}T07:00:00Z`],
        });
      }
    }
    const night = days[60]!;
    const tiers = await computeTiers(
      { db, market: "AU", calRows: [] },
      { read: 0, written: 0 },
      night,
      ["ZZA", "ZZB"],
    );
    expect(tiers.get("ZZA")).toEqual({ tier: "U1", status: "active", adv: 2_000_000 });
    expect(tiers.get("ZZB")).toEqual({ tier: "U3", status: "below_floor", adv: 1_000 });
    // and a night through the pipeline stores them
    await runBatch1(db, {
      nowMs: () => at1730(night),
      barsText: text([bar("ZZA", night), bar("ZZB", night)]),
      commitSha: "a".repeat(40),
    } as never);
    const snap = await db.execute({
      sql: "SELECT code, tier, status FROM universe_snapshot WHERE d = ? ORDER BY code",
      args: [night],
    });
    expect(snap.rows.map((r) => [r.code, r.tier, r.status])).toEqual([
      ["ZZA", "U1", "active"],
      ["ZZB", "U3", "below_floor"],
    ]);
  });
});
