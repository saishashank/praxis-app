// @vitest-environment node
// D4 Fundamentals and quality (M15 C1c; angles_D4.md; CTX-011, DAT-170): the fundamentals entries
// are candidates (no point-in-time snapshot history); the dividend yield, the momentum-only variant
// and the 252-session volatility are computed from vendor actions and adjusted closes and checked
// against closed-form values; the guidance proxy is a candidate with a forward compute.
import { describe, expect, it } from "vitest";
import { D4_ANGLES, daysBefore, dpsOf } from "@/lib/cortex/angles/d4";
import {
  ANGLES_PER_DOMAIN,
  canActivate,
  defaultGrid,
  defineAngles,
  evaluateAngle,
  resolveStatus,
} from "@/lib/cortex/angles/registry";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { assertTruncationInvariant } from "@/lib/cortex/pit/truncation";
import { closeCents, longWorld } from "./d3to8World";

const world = longWorld({ sessions: 400 });
const view = buildAsOfView(world);
const T = world.sessions.length - 1;
const byId = (id: string) => D4_ANGLES.find((a) => a.id === id)!;
const run = (id: string, code: string, t: number, grid: Record<string, number> = {}) => {
  const def = byId(id);
  return def.compute!(view, code, t, { ...defaultGrid(def), ...grid });
};
const TS = [0, 126, 127, 252, 253, T - 100, T - 99, T - 1, T];

describe("D4 passports", () => {
  it("has ten validated entries; fundamentals and guidance are candidates, three are computable", () => {
    const defs = defineAngles(D4_ANGLES);
    expect(defs.length).toBe(ANGLES_PER_DOMAIN);
    expect(defs.map((a) => a.needsData !== undefined)).toEqual([
      true, // 01 EY
      true, // 02 ROE
      true, // 03 balance sheet (gate)
      true, // 04 guidance (announcement archive)
      false, // 05 dividend yield
      true, // 06 PEG
      false, // 07 momentum-only variant
      false, // 08 low volatility
      true, // 09 screens
      true, // 10 accruals
    ]);
    expect(byId("A-D4-04").needsData).toMatch(/announcement archive/);
    expect(byId("A-D4-03").kind).toBe("gate");
    expect(byId("A-D4-03").cluster).toBe("risk");
    expect(byId("A-D4-08").cluster).toBe("low_volatility");
    expect(byId("A-D4-07").cluster).toBe("momentum");
    for (const a of defs) {
      expect(a.domain).toBe(4);
      expect(a.orientation).toBe(1);
      if (a.needsData) {
        expect(canActivate(a).ok).toBe(false);
        expect(resolveStatus(a, "active")).toBe("candidate");
        expect(evaluateAngle(a, resolveStatus(a, "active"), view, "ZZA", T)).toBeUndefined();
      } else {
        expect(canActivate(a)).toEqual({ ok: true });
        expect(resolveStatus(a, "active")).toBe("active");
        expect(a.compute).toBeDefined();
      }
    }
  });

  it("helpers: calendar-day subtraction and the dividend payload", () => {
    expect(daysBefore("2021-03-01", 365)).toBe("2020-03-01"); // 2020 is a leap year
    expect(daysBefore("2022-03-01", 365)).toBe("2021-03-01");
    expect(daysBefore("2020-03-01", 1)).toBe("2020-02-29");
    expect(dpsOf({ dps: "0.10" })).toBe(0.1);
    expect(dpsOf({ dps: 0.25 })).toBe(0.25);
    expect(dpsOf({ dps: "x" })).toBeNull();
    expect(dpsOf({})).toBeNull();
    expect(dpsOf({ dps: "-1" })).toBeNull();
  });
});

describe("D4 computes", () => {
  it("A-D4-04 guidance proxy: exp-weighted up minus down over 120 sessions; undefined without events", () => {
    const up = Math.exp(-99 / 60);
    const down = Math.exp(-39 / 60);
    expect(run("A-D4-04", "ZZA", T)).toBeCloseTo((up - down) / Math.max(1, up + down), 12);
    expect(run("A-D4-04", "ZZA", T - 50)).toBeCloseTo(Math.exp(-49 / 60) / 1, 12); // only the up event
    expect(run("A-D4-04", "ZZA", T - 101)).toBe(0); // no guidance event = a known 0 (D-329)
    expect(run("A-D4-04", "ZZB", T)).toBe(0);
  });

  it("A-D4-05 trailing cash yield: both dividends inside 365 days over tonight's close; the ex-date session counts; warm-up undefined", () => {
    const close = closeCents("ZZA", T) / 100;
    expect(run("A-D4-05", "ZZA", T)).toBeCloseTo(0.4 / close, 12);
    // The night before the second ex-date only the first dividend is in the window.
    expect(run("A-D4-05", "ZZA", T - 1)).toBeCloseTo(0.3 / (closeCents("ZZA", T - 1) / 100), 12);
    // Before the first ex-date (and after warm-up) there is no dividend: yield 0.
    expect(run("A-D4-05", "ZZA", T - 100)).toBe(0);
    expect(run("A-D4-05", "ZZB", T)).toBe(0);
    expect(run("A-D4-05", "ZZA", 250)).toBeUndefined();
    expect(run("A-D4-05", "ZZA", 251)).toBeCloseTo(0, 12);
  });

  it("A-D4-07 momentum-only variant: the 126-session adjusted-close return", () => {
    const r = closeCents("ZZB", T) / closeCents("ZZB", T - 126) - 1;
    expect(run("A-D4-07", "ZZB", T)).toBeCloseTo(r, 12);
    expect(run("A-D4-07", "ZZA", T)).toBe(0); // period-3 closes: zero over 126 sessions
    expect(run("A-D4-07", "ZZC", T)).toBeLessThan(0);
    expect(run("A-D4-07", "ZZB", T, { lookback: 21 })).toBeCloseTo(
      closeCents("ZZB", T) / closeCents("ZZB", T - 21) - 1,
      12,
    );
    expect(run("A-D4-07", "ZZB", 125)).toBeUndefined();
    expect(run("A-D4-07", "ZZB", 126)).toBeCloseTo(
      closeCents("ZZB", 126) / closeCents("ZZB", 0) - 1,
      12,
    );
  });

  it("A-D4-08 low-volatility tilt: minus the sample sd of 252 log returns (closed form on the period-3 closes)", () => {
    const rets: number[] = [];
    for (let i = T - 251; i <= T; i += 1)
      rets.push(Math.log(closeCents("ZZA", i) / closeCents("ZZA", i - 1)));
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1));
    expect(run("A-D4-08", "ZZA", T)).toBeCloseTo(-sd, 14);
    expect(run("A-D4-08", "ZZA", T)).toBeLessThan(0);
    expect(run("A-D4-08", "ZZC", T)).toBeGreaterThan(run("A-D4-08", "ZZA", T) as number); // linear fall is calmer
    expect(run("A-D4-08", "ZZA", 251)).toBeUndefined();
    expect(run("A-D4-08", "ZZA", 252)).toBeDefined();
  });

  it("every compute passes TST-109 on the long world", () => {
    for (const def of D4_ANGLES.filter((a) => a.compute)) {
      assertTruncationInvariant(world, (v, c, t) => evaluateAngle(def, "active", v, c, t), {
        ts: TS,
      });
    }
  });
});
