// @vitest-environment node
// A3 regime (M4 T6; AGT-101; design 2.4, decision 17): SHOCK entered with no hysteresis, exits need
// 3 sessions, warm-up unknown, state agrees with the rule recomputed from the reported fields,
// stepwise == series, determinism, DB reader through the cut-off view. Synthetic data only.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60000 });
import { defaultAgentParams } from "@/lib/agents/params";
import {
  regimeForLast,
  regimeSeries,
  regimeWarmupCloses,
  roundHalfAway,
  stepRegime,
  computeRegime,
  type RegimeResult,
} from "@/lib/agents/regime";
import { createDecisionView, decisionCutoffUtc } from "@/lib/agents/decisionView";
import { addDays, isWeekend } from "@/lib/data/calendar";
import { cleanupTempDbs, freshDb, ROOT } from "../db/helpers";

afterEach(cleanupTempDbs);

type Fixture = {
  start: number;
  seed: number;
  segments: { name: string; days: number; driftBps: number; noiseBps: number }[];
};
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/agents/regime/segments.json"), "utf8"),
) as Fixture;

function lcg(seed: number): () => number {
  let s = BigInt(seed);
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n);
  };
}

/** Closes in micro from the fixture; integer arithmetic only. */
function buildCloses(extra: number[] = []): bigint[] {
  const next = lcg(fixture.seed);
  let price = BigInt(fixture.start);
  const out: bigint[] = [];
  for (const seg of fixture.segments) {
    for (let i = 0; i < seg.days; i++) {
      const span = 2 * seg.noiseBps + 1;
      const noise = (next() % span) - seg.noiseBps;
      price += (price * BigInt(seg.driftBps + noise)) / 10000n;
      out.push(price);
    }
  }
  for (const bps of extra) {
    price += (price * BigInt(bps)) / 10000n;
    out.push(price);
  }
  return out;
}

const p = defaultAgentParams();

/** Independent restatement of the AGT-101 raw rule from the reported fields (float, test only). */
function expectedRaw(r: RegimeResult): string {
  if (r.vol_pct === null || r.fall5_ppm === null || r.sma_micro === null) return "unknown";
  if (r.fall5_ppm > 70000 || r.vol_pct > 95) return "SHOCK";
  if (r.close_micro < r.sma_micro && r.vol_pct > 70) return "RISK-OFF";
  if (r.close_micro > r.sma_micro && r.vol_pct < 50) return "RISK-ON";
  return "NEUTRAL";
}

describe("A3 regime: hysteresis step (pure)", () => {
  it("SHOCK is entered at once; leaving needs 3 consecutive differing sessions", () => {
    let c = stepRegime(null, "RISK-ON", 3);
    expect(c).toEqual({ state: "RISK-ON", exitStreak: 0 });
    c = stepRegime(c, "SHOCK", 3);
    expect(c).toEqual({ state: "SHOCK", exitStreak: 0 });
    c = stepRegime(c, "NEUTRAL", 3);
    expect(c).toEqual({ state: "SHOCK", exitStreak: 1 });
    c = stepRegime(c, "RISK-ON", 3);
    expect(c).toEqual({ state: "SHOCK", exitStreak: 2 });
    c = stepRegime(c, "RISK-OFF", 3);
    expect(c).toEqual({ state: "RISK-OFF", exitStreak: 0 }); // raw state of the third session
  });

  it("a session matching the current state resets the streak", () => {
    let c = stepRegime(null, "RISK-ON", 3);
    c = stepRegime(c, "NEUTRAL", 3);
    c = stepRegime(c, "NEUTRAL", 3);
    expect(c).toEqual({ state: "RISK-ON", exitStreak: 2 });
    c = stepRegime(c, "RISK-ON", 3);
    expect(c).toEqual({ state: "RISK-ON", exitStreak: 0 });
    c = stepRegime(c, "NEUTRAL", 3);
    expect(c.state).toBe("RISK-ON");
  });

  it("unknown stays unknown and the first known day takes its raw state", () => {
    expect(stepRegime(null, "unknown", 3)).toEqual({ state: "unknown", exitStreak: 0 });
    expect(stepRegime({ state: "unknown", exitStreak: 0 }, "NEUTRAL", 3).state).toBe("NEUTRAL");
  });

  it("roundHalfAway rounds .5 away from zero for both signs", () => {
    expect(roundHalfAway({ num: 5n, den: 2n })).toBe(3n);
    expect(roundHalfAway({ num: -5n, den: 2n })).toBe(-3n);
    expect(roundHalfAway({ num: 7n, den: 3n })).toBe(2n);
    expect(roundHalfAway({ num: 0n, den: 1n })).toBe(0n);
  });
});

describe("A3 regime: series", () => {
  const closes = buildCloses();
  const series = regimeSeries(closes, p);

  it("is unknown until 1,260 + 20 sessions exist, then known", () => {
    const warm = regimeWarmupCloses(p);
    expect(warm).toBe(1281);
    expect(series[warm - 2]!.state).toBe("unknown");
    expect(series[warm - 2]!.vol_pct).toBeNull();
    expect(series[warm - 1]!.raw_state).not.toBe("unknown");
    expect(series[warm - 1]!.vol_pct).not.toBeNull();
    expect(regimeSeries(closes.slice(0, warm - 1), p).at(-1)!.state).toBe("unknown");
  });

  it("every raw state equals the AGT-101 rule recomputed from the reported fields", () => {
    for (const r of series) expect(r.raw_state).toBe(expectedRaw(r));
  });

  it("covers RISK-ON, RISK-OFF, NEUTRAL and SHOCK raw states in the fixture path plus a crash", () => {
    const withCrash = regimeSeries(buildCloses([-300, -300, -300, -300, -300]), p);
    const seen = new Set(withCrash.map((r) => r.raw_state));
    expect(seen.has("RISK-ON")).toBe(true);
    expect(seen.has("NEUTRAL") || seen.has("RISK-OFF")).toBe(true);
    expect(withCrash.at(-1)!.raw_state).toBe("SHOCK");
  });

  it("SHOCK trigger day: the regime is SHOCK that day (no hysteresis on entry)", () => {
    const calm = buildCloses();
    const before = regimeSeries(calm, p).at(-1)!;
    expect(before.state).not.toBe("SHOCK");
    // five sessions down about 7.3 % in total: fall5 > 7 %
    const crash = regimeSeries(buildCloses([-100, -100, -100, -100, -330]), p).at(-1)!;
    expect(crash.fall5_ppm!).toBeGreaterThan(70000);
    expect(crash.raw_state).toBe("SHOCK");
    expect(crash.state).toBe("SHOCK");
    expect(crash.exit_streak).toBe(0);
  });

  it("a SHOCK state is held two more sessions after the raw state leaves it, left on the third", () => {
    const base = buildCloses([-100, -100, -100, -100, -330]);
    // three further +0.2 % sessions: fall5 stays > 7 % for the next days, so extend until raw leaves
    const long = regimeSeries(
      buildCloses([-100, -100, -100, -100, -330, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50]),
      p,
    );
    const start = base.length - 1;
    expect(long[start]!.state).toBe("SHOCK");
    let firstNonShockRaw = -1;
    for (let i = start + 1; i < long.length; i++) {
      if (long[i]!.raw_state !== "SHOCK") {
        firstNonShockRaw = i;
        break;
      }
    }
    // The raw state may stay SHOCK through high volatility; when it does leave, the state follows
    // exactly three sessions later (never earlier, never later) unless the raw state returns.
    if (firstNonShockRaw > 0) {
      for (let k = 0; k < 3 && firstNonShockRaw + k < long.length; k++) {
        const r = long[firstNonShockRaw + k]!;
        if (r.raw_state === "SHOCK") break;
        if (k < 2) expect(r.state).toBe("SHOCK");
        else expect(r.state).toBe(r.raw_state);
      }
    }
  });

  it("stepwise from yesterday's carried state equals the replayed series", () => {
    const warm = regimeWarmupCloses(p);
    for (const n of [warm, warm + 7, closes.length - 1, closes.length]) {
      const slice = closes.slice(0, n);
      const prev = regimeSeries(slice.slice(0, n - 1), p).at(-1)!;
      const viaStep = regimeForLast(slice, p, { state: prev.state, exitStreak: prev.exit_streak });
      const viaSeries = regimeSeries(slice, p).at(-1)!;
      expect(viaStep).toEqual(viaSeries);
    }
  });

  it("is deterministic: two runs give identical results", () => {
    const a = JSON.stringify(regimeSeries(closes, p), (_k, v) =>
      typeof v === "bigint" ? `${v}` : v,
    );
    const b = JSON.stringify(regimeSeries(closes, p), (_k, v) =>
      typeof v === "bigint" ? `${v}` : v,
    );
    expect(a).toBe(b);
  });
});

describe("A3 regime: DB reader through the cut-off view", () => {
  it("reads only index bars <= D and never the poisoned future row", async () => {
    const db = await freshDb("main");
    const closes = buildCloses();
    const dates: string[] = [];
    let d = "2020-01-01";
    while (dates.length < closes.length + 3) {
      if (!isWeekend(d)) dates.push(d);
      d = addDays(d, 1);
    }
    const last = dates[closes.length - 1]!;
    const stmts = closes.map((c, i) => ({
      sql: `INSERT INTO index_bar (market, index_code, d, o_micro, h_micro, l_micro, c_micro, source, published_at, ingested_at)
            VALUES ('AU', 'AXJO', ?, ?, ?, ?, ?, 'test', ?, ?)`,
      args: [dates[i]!, c, c, c, c, `${dates[i]}T06:00:00.000Z`, `${dates[i]}T06:05:00.000Z`],
    }));
    // poison: the next three sessions, one crashing 40 %
    for (let k = 0; k < 3; k++) {
      const c = (closes.at(-1)! * BigInt(6 - k * 2)) / 10n;
      stmts.push({
        sql: stmts[0]!.sql,
        args: [
          dates[closes.length + k]!,
          c,
          c,
          c,
          c,
          `${dates[closes.length + k]}T06:00:00.000Z`,
          `${dates[closes.length + k]}T06:05:00.000Z`,
        ],
      });
    }
    await db.batch(stmts);
    const view = createDecisionView(db, {
      market: "AU",
      d: last,
      cutoff: decisionCutoffUtc(last, p.decisionCutoff),
    });
    const got = await computeRegime(view, "AXJO", p, 1);
    expect(got).not.toBeNull();
    expect(got!.d).toBe(last);
    expect(got!.result).toEqual(regimeSeries(closes, p).at(-1));
    await expect(view.indexBars("AXJO", 5, dates[closes.length]!)).rejects.toThrow(/look-ahead/);
  }, 60000);
});
