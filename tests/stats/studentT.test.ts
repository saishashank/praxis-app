// @vitest-environment node
// Student's t known answers (closed forms for df 1 and 2; tables for df 5 and 30; the normal limit).
import { describe, expect, it } from "vitest";
import { normalCdf } from "@/lib/stats/normal";
import { incompleteBeta, logGamma, studentTCdf, studentTTwoSided } from "@/lib/stats/studentT";

describe("studentT", () => {
  it("logGamma matches factorials and Γ(1/2) = √π", () => {
    expect(logGamma(1)).toBeCloseTo(0, 9);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 9);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 9);
    expect(() => logGamma(0)).toThrow(RangeError);
  });

  it("incompleteBeta: edges, symmetry and I_x(1, 1) = x", () => {
    expect(incompleteBeta(0, 2, 3)).toBe(0);
    expect(incompleteBeta(1, 2, 3)).toBe(1);
    expect(incompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 12);
    expect(incompleteBeta(0.4, 2.5, 3.5) + incompleteBeta(0.6, 3.5, 2.5)).toBeCloseTo(1, 12);
    expect(() => incompleteBeta(0.5, 0, 1)).toThrow(RangeError);
    expect(() => incompleteBeta(1.5, 1, 1)).toThrow(RangeError);
  });

  it("CDF: Cauchy (df 1), df 2 closed form, tables, normal limit", () => {
    for (const t of [-3, -1, 0, 0.5, 2]) {
      expect(studentTCdf(t, 1)).toBeCloseTo(0.5 + Math.atan(t) / Math.PI, 10);
      expect(studentTCdf(t, 2)).toBeCloseTo(0.5 + t / (2 * Math.sqrt(t * t + 2)), 10);
    }
    expect(studentTCdf(2.015, 5)).toBeCloseTo(0.95, 3);
    expect(studentTCdf(2.042, 30)).toBeCloseTo(0.975, 3);
    expect(studentTCdf(1.5, 1e6)).toBeCloseTo(normalCdf(1.5), 5);
    expect(studentTCdf(Infinity, 3)).toBe(1);
    expect(studentTCdf(-Infinity, 3)).toBe(0);
    expect(studentTCdf(Number.NaN, 3)).toBeNaN();
    expect(() => studentTCdf(1, 0)).toThrow(RangeError);
  });

  it("two-sided p", () => {
    expect(studentTTwoSided(2.015, 5)).toBeCloseTo(0.1, 3);
    expect(studentTTwoSided(-2.015, 5)).toBeCloseTo(0.1, 3);
    expect(studentTTwoSided(0, 4)).toBeCloseTo(1, 12);
    expect(studentTTwoSided(Infinity, 4)).toBe(0);
    expect(studentTTwoSided(Number.NaN, 4)).toBeNaN();
    expect(() => studentTTwoSided(1, -1)).toThrow(RangeError);
  });
});
