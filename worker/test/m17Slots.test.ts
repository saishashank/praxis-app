// M17 WP5 (D-387, D-397, PLT-077, TST-103 pattern): the two quote slots are available but listed-only,
// fire at the right Sydney-local minutes across both DST changes, never on weekends, and post the
// route's own purpose. Nothing touches a network.
import { describe, expect, it } from "vitest";
import { decideRoutes, purposeOf, routeSlotsDue, type RouteFacts } from "../src/routes";
import { sydneyLocal } from "../src/localtime";
import { AU_SLOTS } from "../src/schedule";

const hm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const utc = (date: string, time: string, offset: number): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h - offset, mi);
};
const FACTS: RouteFacts = {
  dispatchEnabled: true,
  marketMode: "full",
  tradingDay: true,
  flushDue: false,
};
// Weekdays around both clock changes (2026-10-04 AEDT starts, 2027-04-04 AEST starts).
const DAYS: [string, 10 | 11][] = [
  ["2026-10-02", 10],
  ["2026-10-05", 11],
  ["2026-11-02", 11],
  ["2027-04-02", 11],
  ["2027-04-05", 10],
];
const SAT: [string, 10 | 11] = ["2026-11-07", 11];

const due = (id: string, date: string, off: 10 | 11): string[] => {
  const out: string[] = [];
  for (let m = 0; m < 1440; m++) {
    const l = sydneyLocal(utc(date, hm(m), off));
    if (l.date !== date) continue;
    if (routeSlotsDue(l, AU_SLOTS).some((s) => s.id === id)) out.push(hm(l.minute));
  }
  return out;
};

describe("the shipped quote slots", () => {
  it("have the full Slot fields and are listed-only", () => {
    const poll = AU_SLOTS.find((s) => s.id === "quote-poll")!;
    const scan = AU_SLOTS.find((s) => s.id === "intraday-scan")!;
    expect(poll).toMatchObject({
      time: "10:00",
      until: "16:00",
      everyMin: 5,
      runner: "route",
      route: "/api/internal/pick-alerts",
      workflow: null,
      tradingDaysOnly: true,
      marketBound: true,
      priority: 5,
      catchUpMin: 0,
      enabled: true,
      requiresListing: true,
    });
    expect(scan).toMatchObject({
      time: "10:30",
      until: "15:30",
      everyMin: 30,
      runner: "route",
      route: "/api/internal/intraday-scan",
      workflow: null,
      tradingDaysOnly: true,
      marketBound: true,
      priority: 6,
      catchUpMin: 0,
      enabled: true,
      requiresListing: true,
    });
    expect(purposeOf(poll.route!)).toBe("pick-alerts");
    expect(purposeOf(scan.route!)).toBe("intraday-scan");
  });

  it("post nothing without a list, nothing when unlisted, and only the listed slot when listed", () => {
    const l = sydneyLocal(utc("2026-11-02", "10:30", 11));
    const ids = (f: RouteFacts) => decideRoutes(l, f, new Map(), 0, AU_SLOTS).map((a) => a.slot.id);
    expect(ids(FACTS)).toEqual([]); // absent list = not released
    expect(
      ids({ ...FACTS, slotsEnabled: { kind: "list", ids: new Set(["alert-flush"]) } }),
    ).toEqual([]);
    expect(
      ids({ ...FACTS, slotsEnabled: { kind: "list", ids: new Set(["intraday-scan"]) } }),
    ).toEqual(["intraday-scan"]);
    expect(
      ids({
        ...FACTS,
        slotsEnabled: { kind: "list", ids: new Set(["quote-poll", "intraday-scan"]) },
      }),
    ).toEqual(["quote-poll", "intraday-scan"]); // priority 5 before 6
    expect(
      ids({
        ...FACTS,
        dispatchEnabled: false,
        slotsEnabled: { kind: "list", ids: new Set(["quote-poll"]) },
      }),
    ).toEqual([]);
    expect(
      ids({
        ...FACTS,
        marketMode: "off",
        slotsEnabled: { kind: "list", ids: new Set(["quote-poll"]) },
      }),
    ).toEqual([]);
  });

  it.each(DAYS)(
    "quote-poll fires 10:00 to 16:00 every 5 minutes on %s (offset %i), 73 times",
    (d, off) => {
      const t = due("quote-poll", d, off);
      expect(t).toHaveLength(73);
      expect([t[0], t[t.length - 1]]).toEqual(["10:00", "16:00"]);
      expect(t.every((x) => Number(x.slice(3)) % 5 === 0)).toBe(true);
    },
  );

  it.each(DAYS)(
    "intraday-scan fires 10:30 to 15:30 every 30 minutes on %s (offset %i), 11 times",
    (d, off) => {
      const t = due("intraday-scan", d, off);
      expect(t).toEqual([
        "10:30",
        "11:00",
        "11:30",
        "12:00",
        "12:30",
        "13:00",
        "13:30",
        "14:00",
        "14:30",
        "15:00",
        "15:30",
      ]);
    },
  );

  it("neither fires at the weekend", () => {
    expect(due("quote-poll", SAT[0], SAT[1])).toEqual([]);
    expect(due("intraday-scan", SAT[0], SAT[1])).toEqual([]);
  });
});
