// UX-110, PLT-023: time format preference; the zone stays Melbourne.
import { describe, expect, it } from "vitest";
import { formatMarketTime, formatMelbourne, formatTime } from "@/lib/health/format";

const SUMMER = "2026-10-10T12:30:00.000Z"; // AEDT (UTC+11) -> 23:30
const PM = "2026-10-10T03:05:00.000Z"; // 14:05 AEDT

describe("formatTime", () => {
  it("24h is the default and matches the old output", () => {
    expect(formatTime(SUMMER)).toBe("2026-10-10 23:30 AEDT");
    expect(formatTime(SUMMER, { time_format: "24h" })).toBe("2026-10-10 23:30 AEDT");
    expect(formatTime(SUMMER, null)).toBe("2026-10-10 23:30 AEDT");
    expect(formatMelbourne(SUMMER)).toBe("2026-10-10 23:30 AEDT");
  });

  it("12h uses am/pm and still Melbourne time", () => {
    expect(formatTime(SUMMER, { time_format: "12h" })).toBe("2026-10-10 11:30 pm AEDT");
    expect(formatTime(PM, { time_format: "12h" })).toBe("2026-10-10 02:05 pm AEDT");
    expect(formatMelbourne(PM, "12h")).toBe("2026-10-10 02:05 pm AEDT");
  });

  it("accepts a Date and shows standard time in winter", () => {
    expect(formatTime(new Date("2026-07-01T00:00:00Z"), { time_format: "24h" })).toBe(
      "2026-07-01 10:00 AEST",
    );
  });

  it("handles empty and invalid input", () => {
    expect(formatTime(null)).toBe("Never");
    expect(formatTime("garbage")).toBe("Unknown");
  });
});

// UXN-313, D-1002: the dual "local · Melbourne" time shows only when the market zone differs from Melbourne.
describe("formatMarketTime", () => {
  it("an AU market (Sydney shares Melbourne's offset) is the single Melbourne form, unchanged", () => {
    for (const at of [
      SUMMER,
      PM,
      "2026-07-01T00:00:00Z",
      "2026-04-04T15:30:00Z",
      "2026-10-03T15:30:00Z",
    ]) {
      expect(formatMarketTime(at, "Australia/Sydney")).toBe(formatTime(at));
      expect(formatMarketTime(at, "Australia/Sydney", { time_format: "12h" })).toBe(
        formatTime(at, { time_format: "12h" }),
      );
    }
  });

  it("a market in another zone shows its own time and Melbourne's", () => {
    expect(formatMarketTime(SUMMER, "Asia/Kolkata")).toBe(
      "2026-10-10 18:00 GMT+5:30 · 23:30 Melbourne",
    );
    expect(formatMarketTime(SUMMER, "America/New_York")).toBe(
      "2026-10-10 08:30 EDT · 23:30 Melbourne",
    );
    expect(formatMarketTime(PM, "America/New_York", { time_format: "12h" })).toBe(
      "2026-10-09 11:05 pm EDT · 02:05 pm Melbourne",
    );
  });

  it("handles empty and invalid input", () => {
    expect(formatMarketTime(null, "Asia/Kolkata")).toBe("Never");
    expect(formatMarketTime("garbage", "Asia/Kolkata")).toBe("Unknown");
  });
});
