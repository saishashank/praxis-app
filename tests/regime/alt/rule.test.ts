// @vitest-environment node
// M22 E5 (DAT-248, D-1440): the pure alt rule. One step more cautious on stress, never less cautious, never SHOCK, unknown stays.
import { describe, expect, it } from "vitest";
import { ALT_STRESS_PPM, altState, cautionOf, moreCautious, stressed } from "@/lib/regime/alt/rule";

const P = (ppm: number) => ({
  predictions: [{ source: "x", eventKey: "e", d: "2030-01-01", probPpm: ppm }],
});
const NONE = { predictions: [] };

describe("the alt rule", () => {
  it("equals the base without stress or without any input", () => {
    for (const b of ["RISK-ON", "NEUTRAL", "RISK-OFF", "SHOCK", "unknown"]) {
      expect(altState(b, NONE)).toBe(b);
      expect(altState(b, P(ALT_STRESS_PPM - 1))).toBe(b);
    }
  });

  it("steps one state more cautious on stress, to RISK-OFF at most", () => {
    expect(altState("RISK-ON", P(ALT_STRESS_PPM))).toBe("NEUTRAL");
    expect(altState("NEUTRAL", P(1_000_000))).toBe("RISK-OFF");
    expect(altState("RISK-OFF", P(1_000_000))).toBe("RISK-OFF");
    expect(altState("SHOCK", P(1_000_000))).toBe("SHOCK");
    expect(altState("unknown", P(1_000_000))).toBe("unknown");
  });

  it("is never less cautious than the base and only the base reaches SHOCK", () => {
    for (const b of ["RISK-ON", "NEUTRAL", "RISK-OFF", "SHOCK"]) {
      for (const ppm of [0, 599_999, 600_000, 1_000_000]) {
        const a = altState(b, P(ppm));
        expect(cautionOf(a)).toBeGreaterThanOrEqual(cautionOf(b));
        if (b !== "SHOCK") expect(a).not.toBe("SHOCK");
      }
    }
  });

  it("stress and the differing-session test", () => {
    expect(stressed(P(ALT_STRESS_PPM))).toBe(true);
    expect(stressed(NONE)).toBe(false);
    expect(moreCautious("RISK-ON", "NEUTRAL")).toBe(true);
    expect(moreCautious("NEUTRAL", "NEUTRAL")).toBe(false);
    expect(moreCautious("unknown", "RISK-OFF")).toBe(false);
  });
});
