// M7 T16: pure helpers of the News page (UXN-158 wording, UXN-160 snooze choices).
import { describe, expect, it } from "vitest";
import { materialityLabel, polarityLabel, snoozeUntil, whenText } from "@/app/(app)/news/text";

describe("polarity wording (UXN-158)", () => {
  it("always says rule-based when a tag exists", () => {
    expect(polarityLabel(1)).toBe("Good for our trades · rule-based");
    expect(polarityLabel(-1)).toBe("Bad for our trades · rule-based");
    expect(polarityLabel(0)).toBe("Neutral for our trades · rule-based");
    expect(polarityLabel(null)).toBe("Not assessed yet");
  });
  it("describes materiality in words and tolerates out-of-range values", () => {
    expect(materialityLabel(3)).toBe("Importance: very important");
    expect(materialityLabel(0)).toBe("Importance: not important");
    expect(materialityLabel(9)).toBe("Importance: very important");
    expect(materialityLabel(null)).toBe("Importance not assessed yet");
  });
});

describe("whenText", () => {
  it("keeps an ISO week, formats a timestamp in Melbourne time, and tolerates junk", () => {
    expect(whenText("2026-W43")).toBe("Week 2026-W43");
    expect(whenText("2026-10-19T02:00:00.000Z")).toMatch(/19 Oct 2026/);
    expect(whenText("2026-10-19T02:00:00.000Z")).toMatch(/1:00/);
    expect(whenText("nonsense")).toBe("n/a");
  });
});

describe("snoozeUntil (UXN-160)", () => {
  const now = new Date("2026-10-20T03:00:00.000Z"); // 14:00 Melbourne (UTC+11)
  it("1 hour and 4 hours", () => {
    expect(snoozeUntil("1h", now)).toBe("2026-10-20T04:00:00.000Z");
    expect(snoozeUntil("4h", now)).toBe("2026-10-20T07:00:00.000Z");
  });
  it("until tomorrow is 07:00 Melbourne on the next calendar day", () => {
    expect(snoozeUntil("tomorrow", now)).toBe("2026-10-20T20:00:00.000Z");
    // 04:00 on 21 Oct in Melbourne: tomorrow is the 22nd, never the 07:00 of the same day.
    expect(snoozeUntil("tomorrow", new Date("2026-10-20T17:00:00.000Z"))).toBe(
      "2026-10-21T20:00:00.000Z",
    );
  });
  it("is DST-safe and always inside the 7-day limit", () => {
    // Melbourne leaves daylight saving on 2027-04-04 (UTC+10 afterwards).
    const t = new Date("2027-04-03T12:00:00.000Z");
    expect(snoozeUntil("tomorrow", t)).toBe("2027-04-03T21:00:00.000Z");
    const u = Date.parse(snoozeUntil("tomorrow", t)) - t.getTime();
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(7 * 86_400_000);
  });
});
