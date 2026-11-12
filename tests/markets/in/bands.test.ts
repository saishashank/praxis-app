// @vitest-environment node
// M20 A5 (DAT-243 f/g, ARN-117, CTX-044, D-1109 F; AT-69 band clause): India's daily price bands. The limits are the
// previous close x (1 +/- band) on the tick grid (upper down, lower up); a close at a limit is band-locked; the fill
// model refuses every fill on a locked session and cancels the order `band_locked`; a code on the ASM/GSM list takes
// no new entry (promotion trigger 3), exits unaffected; the next day off the list it may. Hand-computed, micro-rupees.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import { COST_PROFILES } from "@/lib/arena/costs";
import { fillOrder, type Bar, type FillOrderEnv } from "@/lib/arena/fills";
import {
  bandLimits,
  bandLocked,
  bandLockedForSession,
  limitsOfRow,
  loadPriceBand,
  loadSurveillance,
  type PriceBandRow,
} from "@/lib/cortex/states/bands";
import { stepPromotion, type SurveillanceEntry } from "@/lib/cortex/states/promotion";
import type { TickBand } from "@/lib/money/tick";
import { allowMarket, cleanupTempDbs, freshDb } from "../../db/helpers";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { path, SESSIONS, statesWorld } from "../../cortex/states/zzStates";

const R = 1_000_000n; // one rupee in micro
/** D-1104: Rs 0.01 below Rs 250, Rs 0.05 from Rs 250 (the table A4 seeds; the test states its own). */
const TABLE: readonly TickBand[] = [
  { fromMicro: 0n, tickMicro: 10_000n },
  { fromMicro: 250n * R, tickMicro: 50_000n },
];
const FLAT_5P: readonly TickBand[] = [{ fromMicro: 0n, tickMicro: 50_000n }];

describe("bandLimits: previous close x (1 +/- band) on the tick grid", () => {
  it("Rs 100.00 with a 20 % band: 120.00 and 80.00 exactly", () => {
    expect(bandLimits(100n * R, 20, TABLE)).toEqual({ lowerMicro: 80n * R, upperMicro: 120n * R });
  });

  it("the upper limit rounds DOWN, the lower UP (flat Rs 0.05 grid): 101.13 at 5 % is 96.10 / 106.15", () => {
    // 101.13 x 1.05 = 106.1865 -> 106.15 ; 101.13 x 0.95 = 96.0735 -> 96.10
    expect(bandLimits(101_130_000n, 5, FLAT_5P)).toEqual({
      lowerMicro: 96_100_000n,
      upperMicro: 106_150_000n,
    });
  });

  it("the upper limit rounds on the grid of the band it falls in: 240.37 at 5 % is 252.35 (Rs 0.05 tick), lower 228.36 (Rs 0.01)", () => {
    // 240.37 x 1.05 = 252.3885 (>= 250, tick 0.05) -> 252.35 ; 240.37 x 0.95 = 228.3515 (< 250, tick 0.01) -> 228.36
    expect(bandLimits(240_370_000n, 5, TABLE)).toEqual({
      lowerMicro: 228_360_000n,
      upperMicro: 252_350_000n,
    });
  });

  it("a lower limit that rounds up onto a coarser band is re-rounded on that band's grid", () => {
    // 263.153 x 0.95 = 249.99535: tick 0.01 rounds up to 250.00, which is in the 0.05 band: 250.00 is on its grid
    expect(bandLimits(263_153_000n, 5, TABLE).lowerMicro).toBe(250n * R);
  });

  it("a 100 % band floors the lower limit at one tick of the lowest band", () => {
    expect(bandLimits(100n * R, 100, TABLE).lowerMicro).toBe(10_000n);
  });

  it("every limit is a whole number of ticks of its own band", () => {
    for (const prev of [
      9_999_000n,
      49_990_000n,
      99_990_000n,
      249_990_000n,
      250_010_000n,
      777_770_000n,
    ]) {
      for (const pct of [2, 5, 10, 20]) {
        const { lowerMicro, upperMicro } = bandLimits(prev, pct, TABLE);
        for (const v of [lowerMicro, upperMicro]) {
          const tick = v >= 250n * R ? 50_000n : 10_000n;
          expect(v % tick).toBe(0n);
        }
        expect(lowerMicro).toBeLessThan(prev);
        expect(upperMicro).toBeGreaterThan(prev);
      }
    }
  });

  it("refuses a band outside 1..100 and a non-positive close", () => {
    expect(() => bandLimits(100n * R, 0, TABLE)).toThrow(RangeError);
    expect(() => bandLimits(100n * R, 101, TABLE)).toThrow(RangeError);
    expect(() => bandLimits(0n, 5, TABLE)).toThrow(RangeError);
  });
});

describe("bandLocked: a close at or beyond a limit", () => {
  const limits = bandLimits(100n * R, 20, TABLE); // 80.00 .. 120.00
  it("at the upper limit and at the lower limit the session is locked", () => {
    expect(bandLocked({ closeMicro: 120n * R }, limits)).toBe(true);
    expect(bandLocked({ closeMicro: 80n * R }, limits)).toBe(true);
  });
  it("one tick inside either limit it is not", () => {
    expect(bandLocked({ closeMicro: 120n * R - 10_000n }, limits)).toBe(false);
    expect(bandLocked({ closeMicro: 80n * R + 10_000n }, limits)).toBe(false);
    expect(bandLocked({ closeMicro: 100n * R }, limits)).toBe(false);
  });
});

const row = (over: Partial<PriceBandRow> = {}): PriceBandRow => ({
  market: "IN",
  code: "ZZ1",
  d: "2030-01-02",
  bandPct: 20,
  lowerMicro: null,
  upperMicro: null,
  source: "t",
  ...over,
});

describe("limitsOfRow and bandLockedForSession", () => {
  it("computes from the percent, or takes the file's own limits when it carries both", () => {
    expect(limitsOfRow(row(), 100n * R, TABLE)).toEqual({
      lowerMicro: 80n * R,
      upperMicro: 120n * R,
    });
    expect(
      limitsOfRow(row({ lowerMicro: 81n * R, upperMicro: 119n * R }), 100n * R, TABLE),
    ).toEqual({
      lowerMicro: 81n * R,
      upperMicro: 119n * R,
    });
  });
  it("no row, no band (F&O, null percent) or no previous close = no limits, never locked", () => {
    expect(limitsOfRow(null, 100n * R, TABLE)).toBeNull();
    expect(limitsOfRow(row({ bandPct: null }), 100n * R, TABLE)).toBeNull();
    expect(limitsOfRow(row(), null, TABLE)).toBeNull();
    expect(bandLockedForSession(null, 100n * R, { closeMicro: 200n * R }, TABLE)).toBe(false);
    expect(bandLockedForSession(row({ bandPct: null }), 100n * R, { closeMicro: 1n }, TABLE)).toBe(
      false,
    );
  });
  it("a close at the upper limit of a 20 % band is locked, inside it is not", () => {
    expect(bandLockedForSession(row(), 100n * R, { closeMicro: 120n * R }, TABLE)).toBe(true);
    expect(bandLockedForSession(row(), 100n * R, { closeMicro: 119n * R }, TABLE)).toBe(false);
  });
});

describe("the fill model refuses every fill on a band-locked session (D-1109)", () => {
  const bar: Bar = {
    openMicro: 118n * R,
    highMicro: 120n * R,
    lowMicro: 118n * R,
    closeMicro: 120n * R,
  };
  const env = (over: Partial<FillOrderEnv> = {}): FillOrderEnv => ({
    bar,
    advMicro: 5_000_000_000_000n,
    profile: COST_PROFILES.P5,
    gate: { allowed: true, reason: "ok" } as FillOrderEnv["gate"],
    ...over,
  });
  const entry = { kind: "entry" as const, qty: 10n, stopDistanceMicro: 5n * R };
  const locked = bandLockedForSession(row(), 100n * R, bar, TABLE);

  it("the session in this fixture is locked at the upper limit", () => {
    expect(locked).toBe(true);
  });

  it("an entry is cancelled with reason band_locked", () => {
    const o = fillOrder(entry, env({ bandLocked: locked }));
    expect(o).toEqual({ status: "cancelled", reason: "band_locked", detail: "band_locked" });
  });

  it("a close-signal exit and an intraday-stop exit are cancelled band_locked as well", () => {
    expect(fillOrder({ kind: "exit_cs", qty: 10n }, env({ bandLocked: true }))).toEqual({
      status: "cancelled",
      reason: "band_locked",
      detail: "band_locked",
    });
    expect(
      fillOrder({ kind: "exit_is", qty: 10n, levelMicro: 119n * R }, env({ bandLocked: true })),
    ).toEqual({ status: "cancelled", reason: "band_locked", detail: "band_locked" });
  });

  it("not locked (or the flag absent, the AU shape): the order fills as before", () => {
    const a = fillOrder(entry, env());
    const b = fillOrder(entry, env({ bandLocked: false }));
    expect(a.status).toBe("filled");
    expect(b).toEqual(a);
  });

  it("order of refusals: the gate and a halt come first (an entry is gate, then halted, then band_locked; an exit halted first)", () => {
    expect(
      fillOrder(
        entry,
        env({ bandLocked: true, gate: { allowed: false, reason: "u1_gate_failed" } as never }),
      ),
    ).toMatchObject({ reason: "gate" });
    expect(fillOrder(entry, env({ bandLocked: true, halted: true }))).toMatchObject({
      reason: "halted",
    });
    expect(
      fillOrder({ kind: "exit_cs", qty: 1n }, env({ bandLocked: true, halted: true })),
    ).toEqual({
      status: "unfilled",
      reason: "halted",
    });
  });
});

describe("promotion trigger 3: an ASM/GSM code takes no new entry (CTX-044, D-1109)", () => {
  const D = SESSIONS.slice(0, 3);
  const view = buildAsOfView(
    statesWorld([
      { code: "ZZ1", tier: "U2", bars: { closesCents: path(1000, SESSIONS.length, []) } },
    ]),
  );
  const asm: ReadonlyMap<string, SurveillanceEntry> = new Map([
    [D[0]!, { list: "ASM", stage: 2 }],
    [D[1]!, { list: "GSM", stage: null }],
  ]);

  it("on the list on D: entries blocked, a surveillance state row, exits unaffected (the effect says entries only)", () => {
    const s = stepPromotion(view, "ZZ1", 0, null, undefined, { surveillance: asm });
    expect(s.next).toEqual({ state: "surveillance", list: "ASM", stage: 2 });
    expect(s.effects.entriesBlocked).toBe(true);
    expect(s.effects.zeroPositive).toBe(false);
    expect(s.reason).toBe("surveillance_list");
    expect(s.row).toMatchObject({
      kind: "promotion",
      state: "surveillance",
      code: "ZZ1",
      fromD: D[0],
    });
  });

  it("any stage counts, ASM or GSM; a list change is a new row, a repeat is not", () => {
    const first = stepPromotion(view, "ZZ1", 0, null, undefined, { surveillance: asm });
    const second = stepPromotion(view, "ZZ1", 1, first.next, undefined, { surveillance: asm });
    expect(second.next).toEqual({ state: "surveillance", list: "GSM", stage: null });
    expect(second.row).not.toBeNull();
    const same = stepPromotion(view, "ZZ1", 0, first.next, undefined, { surveillance: asm });
    expect(same.row).toBeNull();
  });

  it("a code off the list the next day may enter: the state ends with a none row", () => {
    const on = stepPromotion(view, "ZZ1", 1, null, undefined, { surveillance: asm });
    const off = stepPromotion(view, "ZZ1", 2, on.next, undefined, { surveillance: asm });
    expect(off.next).toEqual({ state: "none" });
    expect(off.effects.entriesBlocked).toBe(false);
    expect(off.row).toMatchObject({ state: "none", basis: { after: "surveillance" } });
  });

  it("no surveillance input (the AU path): the machine is the M15 one, never surveillance", () => {
    const s = stepPromotion(view, "ZZ1", 0, null);
    expect(s.next).toEqual({ state: "none" });
    expect(s.effects.entriesBlocked).toBe(false);
  });
});

describe("loadPriceBand reads the table row (A2 shape)", () => {
  let db: Client;
  beforeEach(async () => {
    db = await freshDb("main");
    await allowMarket(db, "IN");
  });
  afterEach(cleanupTempDbs);

  it("returns the row as typed values, null when absent", async () => {
    await db.execute(
      "INSERT INTO price_band (market, code, d, band_pct, lower_micro, upper_micro, source) VALUES ('IN', 'ZZ1', '2030-01-02', 20, 80000000, 120000000, 'nse_pr')",
    );
    await db.execute(
      "INSERT INTO price_band (market, code, d, band_pct, lower_micro, upper_micro, source) VALUES ('IN', 'ZZ2', '2030-01-02', NULL, NULL, NULL, 'nse_pr')",
    );
    expect(await loadPriceBand(db, "IN", "ZZ1", "2030-01-02")).toEqual({
      market: "IN",
      code: "ZZ1",
      d: "2030-01-02",
      bandPct: 20,
      lowerMicro: 80_000_000n,
      upperMicro: 120_000_000n,
      source: "nse_pr",
    });
    expect(await loadPriceBand(db, "IN", "ZZ2", "2030-01-02")).toMatchObject({
      bandPct: null,
      lowerMicro: null,
    });
    expect(await loadPriceBand(db, "IN", "ZZ9", "2030-01-02")).toBeNull();
  });

  it("loadSurveillance returns the code's list membership by date, GSM over ASM on a shared day", async () => {
    const ins = (d: string, list: string, stage: number | null) =>
      db.execute({
        sql: "INSERT INTO surveillance_list (market, code, d, list, stage, source) VALUES ('IN', 'ZZ1', ?, ?, ?, 'nse_asm')",
        args: [d, list, stage],
      });
    await ins("2030-01-02", "ASM", 1);
    await ins("2030-01-03", "ASM", 2);
    await ins("2030-01-03", "GSM", null);
    await ins("2030-02-01", "ASM", 1); // outside the window
    const m = await loadSurveillance(db, "IN", "ZZ1", "2030-01-01", "2030-01-31");
    expect([...m.entries()]).toEqual([
      ["2030-01-02", { list: "ASM", stage: 1 }],
      ["2030-01-03", { list: "GSM", stage: null }],
    ]);
    expect((await loadSurveillance(db, "IN", "ZZ9", "2030-01-01", "2030-01-31")).size).toBe(0);
  });
});
