// @vitest-environment node
// D-919 (Owner 2026-11-10 usability pass): one date and time style in trading words, and company names
// in readable case. No raw ISO text ever reaches a page.
import { describe, expect, it } from "vitest";
import { displayName, formatDay, formatInstant } from "@/lib/view/format";

const NOW = new Date("2026-11-10T02:00:00.000Z");

describe("formatDay / formatInstant", () => {
  it("days read as 'Mon 9 Nov', with the year only when it differs", () => {
    expect(formatDay("2026-11-09", NOW)).toBe("Mon 9 Nov");
    expect(formatDay("2025-12-31", NOW)).toBe("Wed 31 Dec 2025");
    expect(formatDay("2026-11-09T09:30:34.000Z", NOW)).toBe("Mon 9 Nov");
    expect(formatDay("nonsense", NOW)).toBe("n/a");
    expect(formatDay(null, NOW)).toBe("n/a");
  });
  it("instants are Melbourne time, 24-hour, never the raw ISO text", () => {
    expect(formatInstant("2026-10-22T03:38:31.000Z", NOW)).toBe("Thu 22 Oct, 14:38"); // AEDT
    expect(formatInstant("2026-11-09T09:30:34.000Z", NOW)).toBe("Mon 9 Nov, 20:30");
    expect(formatInstant("2026-07-01T00:00:00.000Z", NOW)).toBe("Wed 1 Jul, 10:00"); // AEST
    expect(formatInstant("bad", NOW)).toBe("n/a");
  });
});

describe("displayName", () => {
  it.each([
    ["SERVICE STREAM LIMITED", "Service Stream Limited"],
    ["BHP GROUP LIMITED", "BHP Group Limited"],
    ["G8 EDUCATION LIMITED", "G8 Education Limited"],
    ["SCX.AI HOLDINGS LIMITED", "SCX.AI Holdings Limited"],
    ["ASTRAL RESOURCES NL", "Astral Resources NL"],
    ["MEDALLION METALS LIMITED.", "Medallion Metals Limited."],
    ["NEXGEN ENERGY (CANADA) LTD", "Nexgen Energy (Canada) Ltd"],
    ["RESOURCES & ENERGY GROUP LIMITED", "Resources & Energy Group Limited"],
    [
      "THE HYDRATION PHARMACEUTICALS COMPANY LIMITED",
      "The Hydration Pharmaceuticals Company Limited",
    ],
    ["Zed Upward Holdings", "Zed Upward Holdings"],
  ])("%s -> %s", (raw, want) => expect(displayName(raw)).toBe(want));
});
