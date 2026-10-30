// @vitest-environment node
// D3 Events and announcements (M15 C1c; angles_D3.md; CTX-011, CTX-051): every entry is a
// candidate (announcement archive), the registry never calls a candidate's compute, and the
// computes defined from the event facts give the hand-computed values on the long ZZ world.
import { describe, expect, it } from "vitest";
import { D3_ANGLES, eventsWithin, sessionIndexAtOrBefore } from "@/lib/cortex/angles/d3";
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
import { longWorld } from "./d3to8World";

const world = longWorld({ sessions: 300 });
const view = buildAsOfView(world);
const T = world.sessions.length - 1;
const byId = (id: string) => D3_ANGLES.find((a) => a.id === id)!;
const run = (id: string, t: number, grid: Record<string, number> = {}) => {
  const def = byId(id);
  return def.compute!(view, "ZZA", t, { ...defaultGrid(def), ...grid });
};
const TS = [0, 1, 150, T - 101, T - 40, T - 3, T - 2, T - 1, T];

describe("D3 passports", () => {
  it("has ten validated entries, all candidates behind the announcement archive (CTX-051)", () => {
    const defs = defineAngles(D3_ANGLES);
    expect(defs.length).toBe(ANGLES_PER_DOMAIN);
    expect(defs.map((a) => a.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `A-D3-${String(i + 1).padStart(2, "0")}`),
    );
    for (const a of defs) {
      expect(a.domain).toBe(3);
      expect(a.inputs).toContain("announcement");
      expect(a.needsData).toMatch(/announcement archive/);
      expect(canActivate(a)).toEqual({ ok: false, reason: "needs_data", missing: [] });
      expect(resolveStatus(a, "active")).toBe("candidate");
      expect(resolveStatus(a, "retired")).toBe("retired");
    }
    expect(byId("A-D3-10").kind).toBe("gate");
    expect(byId("A-D3-10").cluster).toBe("calendar");
    expect(defs.filter((a) => a.kind === "score").map((a) => a.cluster)).toEqual([
      "event",
      "event",
      "event",
      "liquidity",
      "event",
      "event",
      "event",
      "sentiment",
      "sentiment",
    ]);
    expect(D3_ANGLES.filter((a) => a.compute).map((a) => a.id)).toEqual([
      "A-D3-01",
      "A-D3-02",
      "A-D3-03",
      "A-D3-04",
      "A-D3-06",
      "A-D3-09",
    ]);
  });

  it("evaluates to undefined through the registry while candidate, whatever the view holds", () => {
    for (const a of D3_ANGLES) {
      expect(evaluateAngle(a, "candidate", view, "ZZA", T)).toBeUndefined();
      expect(evaluateAngle(a, resolveStatus(a, "active"), view, "ZZA", T)).toBeUndefined();
    }
  });
});

describe("event helpers", () => {
  it("finds the session index at or before a date and orders events newest first", () => {
    expect(sessionIndexAtOrBefore(world.sessions, T, world.sessions[T]!)).toBe(T);
    expect(sessionIndexAtOrBefore(world.sessions, T, "2019-12-31")).toBe(-1);
    expect(sessionIndexAtOrBefore(world.sessions, 5, world.sessions[9]!)).toBe(5);
    const rows = eventsWithin(view, "ZZA", T, 20);
    expect(rows.map((e) => [e.category, e.age])).toEqual([
      ["capital_raising", 0],
      ["other", 1],
      ["results", 2],
      ["director_trade", 9],
      ["substantial_holder", 14],
    ]);
    expect(eventsWithin(view, "ZZA", T - 1, 20).map((e) => e.age)).toEqual([0, 1, 8, 13]);
    expect(eventsWithin(view, "ZZB", T, 20)).toEqual([]);
  });
});

describe("D3 computes on the long ZZ world (forward-measured passports)", () => {
  it("A-D3-01 polarity of the latest event: -1 tonight (raising), 0 the night before (other), +1 two nights before", () => {
    expect(run("A-D3-01", T)).toBe(-1);
    expect(run("A-D3-01", T - 1)).toBe(0);
    expect(run("A-D3-01", T - 2)).toBe(1);
    expect(run("A-D3-01", T - 101)).toBeUndefined(); // no event inside 20 sessions
    expect(run("A-D3-01", 0)).toBeUndefined();
  });

  it("A-D3-02 price-sensitive weight: 1 for the raising, w_lo for the other notice", () => {
    expect(run("A-D3-02", T)).toBe(1);
    expect(run("A-D3-02", T - 1)).toBe(0.25);
    expect(run("A-D3-02", T - 1, { w_lo: 0.5 })).toBe(0.5);
    expect(run("A-D3-02", 0)).toBeUndefined();
  });

  it("A-D3-03 clip(AR0 / theta): -0.75 tonight, undefined on the untimed-facts notice, +1 (clipped) on results", () => {
    expect(run("A-D3-03", T)).toBeCloseTo(-0.03 / 0.04, 12);
    expect(run("A-D3-03", T, { theta: 0.06 })).toBeCloseTo(-0.5, 12);
    expect(run("A-D3-03", T - 1)).toBeUndefined(); // E6 has no day-0 bar facts
    expect(run("A-D3-03", T - 2)).toBe(1); // 0.05 / 0.04 clipped
    expect(run("A-D3-03", T - 2, { theta: 0.06 })).toBeCloseTo(0.05 / 0.06, 12);
    expect(run("A-D3-03", 0)).toBeUndefined();
  });

  it("A-D3-04 sign(AR0) x min(VR0, cap) / cap: -2/3 tonight, +1 on results (VR 3.5 capped at 3)", () => {
    expect(run("A-D3-04", T)).toBeCloseTo(-2 / 3, 12);
    expect(run("A-D3-04", T - 2)).toBe(1);
    expect(run("A-D3-04", T - 2, { cap: 5 })).toBeCloseTo(0.7, 12);
    expect(run("A-D3-04", T - 1)).toBeUndefined();
  });

  it("A-D3-06 distinct events in the window: 5 tonight, 0 with no events, 2 inside a 10-session window", () => {
    expect(run("A-D3-06", T)).toBe(5);
    expect(run("A-D3-06", T, { window: 10 })).toBe(4);
    expect(run("A-D3-06", T, { window: 3 })).toBe(3);
    expect(run("A-D3-06", T - 101)).toBe(0);
  });

  it("A-D3-09 director and holder flow: sale -0.25 + holder +0.25 = 0 tonight; +0.25 before the sale; -0.5 with the old weight", () => {
    expect(run("A-D3-09", T)).toBe(0);
    expect(run("A-D3-09", T - 12)).toBe(0.25);
    expect(run("A-D3-09", T, { sale_weight: -0.5 })).toBe(-0.25);
    expect(run("A-D3-09", T - 16)).toBeUndefined(); // no notice inside 30 sessions
  });

  it("every compute passes TST-109 on the long world", () => {
    for (const def of D3_ANGLES.filter((a) => a.compute)) {
      assertTruncationInvariant(world, (v, c, t) => def.compute!(v, c, t, defaultGrid(def)), {
        ts: TS,
      });
      assertTruncationInvariant(world, (v, c, t) => evaluateAngle(def, "active", v, c, t), {
        ts: TS,
      });
    }
  });
});
