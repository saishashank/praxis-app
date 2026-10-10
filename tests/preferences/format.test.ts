// UX-110, PLT-023: time format preference; the zone stays Melbourne.
import { describe, expect, it } from "vitest";
import { formatMelbourne, formatTime } from "@/lib/health/format";

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
