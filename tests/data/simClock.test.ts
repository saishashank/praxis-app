// M18 OPS-107 / D-965: the simulated clock of the recorded-day app process.
import { describe, expect, it } from "vitest";
import { installSimClock, simNowFromEnv } from "@/lib/data/recorded/simClock.mjs";

describe("simNowFromEnv", () => {
  it("reads PRAXIS_SIM_NOW only in the recorded environment", () => {
    const iso = "2026-11-12T07:10:00Z";
    expect(simNowFromEnv({ PRAXIS_ENV: "recorded", PRAXIS_SIM_NOW: iso })).toBe(Date.parse(iso));
    for (const env of [
      { PRAXIS_SIM_NOW: iso },
      { PRAXIS_ENV: "production", PRAXIS_SIM_NOW: iso },
      { PRAXIS_ENV: "staging", PRAXIS_SIM_NOW: iso },
      { PRAXIS_ENV: "recorded" },
      { PRAXIS_ENV: "recorded", PRAXIS_SIM_NOW: "2026-11-12" },
      { PRAXIS_ENV: "recorded", PRAXIS_SIM_NOW: "garbage" },
    ]) {
      expect(simNowFromEnv(env)).toBeNull();
    }
  });
});

describe("installSimClock", () => {
  it("moves Date.now() and new Date() to the simulated instant, keeps time flowing, and undoes", async () => {
    const target = { Date } as { Date: DateConstructor };
    const simMs = Date.parse("2031-03-04T05:06:07Z");
    const undo = installSimClock(simMs, target);
    try {
      const a = target.Date.now();
      expect(Math.abs(a - simMs)).toBeLessThan(2000);
      expect(Math.abs(new target.Date().getTime() - simMs)).toBeLessThan(2000);
      await new Promise((r) => setTimeout(r, 30));
      expect(target.Date.now()).toBeGreaterThan(a + 20);
      // arguments are untouched; statics and instanceof still work; Date() returns a string
      expect(new target.Date("2020-01-02T03:04:05Z").toISOString()).toBe(
        "2020-01-02T03:04:05.000Z",
      );
      expect(target.Date.UTC(2020, 0, 1)).toBe(Date.UTC(2020, 0, 1));
      expect(target.Date.parse("2020-01-01T00:00:00Z")).toBe(Date.parse("2020-01-01T00:00:00Z"));
      expect(new target.Date() instanceof Date).toBe(true);
      expect(typeof (target.Date as unknown as () => string)()).toBe("string");
    } finally {
      undo();
    }
    expect(target.Date).toBe(Date);
    expect(Math.abs(Date.now() - Date.parse("2031-03-04T05:06:07Z"))).toBeGreaterThan(86_400_000);
  });
});
