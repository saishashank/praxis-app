// @vitest-environment node
// M19 B1 (CXA-002 a, b, d, h; D-1003, D-1030): the Cortex and agents constants that used to be AU literals are
// the profile's values, to the byte, and the engines take a market's own table or code as an argument.
import { describe, expect, it } from "vitest";
import { INDEX_CODE } from "@/lib/agents/candidates";
import { AU_TIME_ZONE } from "@/lib/agents/decisionView";
import { isLate2a, LATE_2A_AFTER } from "@/lib/agents/batch2b";
import {
  ADV_FLOOR_PER_PARCEL_MICRO,
  HALF_SPREAD_PPM_BY_TIER,
  halfSpreadPpm,
  PARCEL_FLOOR_MICRO,
} from "@/lib/cortex/economics/cost";
import { buildAsOfView } from "@/lib/cortex/pit/asOfView";
import { INDEX_US_KNOWN_LOCAL, knownTimeOf, makeSessionClock } from "@/lib/cortex/pit/knownTime";
import { INDEX_CODES_PIT } from "@/lib/cortex/pit/types";
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";
import { benchmarkIndexOf, costProfilesOf, homeProfile } from "@/lib/market/staticProfile.mjs";
import { CUTOFF_HHMM, indexFor, SESSIONS, zzWorld } from "./pit/zzWorld";

describe("AU constants equal today's values (the snapshot numbers, written out)", () => {
  it("parcel floor, ADV floor (= parcel floor x 100) and half-spread floors", () => {
    expect(PARCEL_FLOOR_MICRO).toBe(500_000_000n);
    expect(ADV_FLOOR_PER_PARCEL_MICRO).toBe(50_000_000_000n);
    expect(ADV_FLOOR_PER_PARCEL_MICRO).toBe(PARCEL_FLOOR_MICRO * 100n);
    expect(HALF_SPREAD_PPM_BY_TIER).toEqual({ U1: 500n, U2: 2_500n, U3: 7_500n });
  });
  it("benchmark and global indices, known-time rule, zones, late-2a time", () => {
    expect(INDEX_CODE).toBe("AXJO");
    expect(INDEX_CODES_PIT).toEqual(["AXJO", "GSPC", "VIX"]);
    expect(INDEX_CODES_PIT).toEqual(homeProfile().indexCodes);
    expect(INDEX_US_KNOWN_LOCAL).toBe("09:00");
    expect(AU_TIME_ZONE).toBe("Australia/Melbourne");
    expect(AU_TIME_ZONE).toBe(OWNER_TZ);
    expect(LATE_2A_AFTER).toBe("18:40");
  });
});

describe("the engines take a market's own value", () => {
  it("halfSpreadPpm uses the floors passed (default: the home market's)", () => {
    const price = 20_000_000n; // a price whose half tick is far below any floor
    const floors = { U1: 1_000n, U2: 2_000n, U3: 3_000n };
    expect(halfSpreadPpm("U1", price)).toBe(500);
    expect(halfSpreadPpm("U1", price, HALF_SPREAD_PPM_BY_TIER)).toBe(500);
    expect(halfSpreadPpm("U2", price, floors)).toBe(2_000);
    expect(halfSpreadPpm("U3", price, floors)).toBe(3_000);
  });
  it("isLate2a takes the market's late time (default: the home market's)", () => {
    const at = "2026-03-10T07:41:00.000Z"; // 18:41 Melbourne (AEDT, UTC+11)
    expect(isLate2a(at, "2026-03-10", OWNER_TZ)).toBe(true);
    expect(isLate2a(at, "2026-03-10", OWNER_TZ, "18:50")).toBe(false);
  });
  it("the view reads the market's own benchmark index, not a fixed code", () => {
    const t = SESSIONS.length - 1;
    expect(benchmarkIndexOf("IN")).toBe("NSEI");
    const inView = buildAsOfView(
      zzWorld({
        market: "IN",
        index: { NSEI: indexFor(22_000n), GSPC: indexFor(5_000n), VIX: indexFor(15n) },
      }),
    );
    expect(inView.index("NSEI", t, 1)[0]!.d).toBe(SESSIONS[t]);
    expect(inView.index("GSPC", t, 1)).toHaveLength(1);
    expect(inView.regime(t)).toBeDefined();
    const auView = buildAsOfView(zzWorld());
    expect(auView.index(benchmarkIndexOf("AU"), t, 1)[0]!.d).toBe(SESSIONS[t]);
  });
  it("a global index bar is known D+1 09:00 Melbourne; the benchmark at the cut-off", () => {
    const clock = makeSessionClock(SESSIONS, CUTOFF_HHMM);
    // D 2026-03-05 -> 2026-03-06 09:00 AEDT (UTC+11) = 2026-03-05T22:00Z
    expect(knownTimeOf("index_us", { d: "2026-03-05" }, clock)).toBe("2026-03-05T22:00:00.000Z");
    expect(knownTimeOf("index_au", { d: "2026-03-05" }, clock)).toBe(clock.cutoffUtc("2026-03-05"));
  });
});

describe("cost profiles resolve through the seed registry", () => {
  it("AU, IN and US resolve; a market without a table is not built (M20)", () => {
    expect(Object.keys(costProfilesOf("AU"))).toEqual([
      "P0",
      "P1",
      "P2",
      "P3",
      "P4",
      "P5",
      "P5b",
      "P6",
    ]);
    expect(Object.keys(costProfilesOf("IN"))).toEqual(["IN-P1"]);
    expect(Object.keys(costProfilesOf("US"))).toEqual(["US-P1"]);
    expect(() => costProfilesOf("ZZ")).toThrow("not built (M20)");
  });
});
