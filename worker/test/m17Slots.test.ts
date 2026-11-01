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
      time: "10:32",
      until: "15:32",
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
    const l = sydneyLocal(utc("2026-11-02", "10:32", 11));
    const ids = (f: RouteFacts) => decideRoutes(l, f, new Map(), 0, AU_SLOTS).map((a) => a.slot.id);
    expect(ids(FACTS)).toEqual([]); // absent list = not released
    expect(
      ids({ ...FACTS, slotsEnabled: { kind: "list", ids: new Set(["alert-flush"]) } }),
    ).toEqual([]);
    expect(
      ids({ ...FACTS, slotsEnabled: { kind: "list", ids: new Set(["intraday-scan"]) } }),
    ).toEqual(["intraday-scan"]);
    const both = {
      ...FACTS,
      slotsEnabled: { kind: "list", ids: new Set(["quote-poll", "intraday-scan"]) },
    } as RouteFacts;
    expect(ids(both)).toEqual(["intraday-scan"]); // 10:32: the scan alone
    const l30 = sydneyLocal(utc("2026-11-02", "10:30", 11));
    expect(decideRoutes(l30, both, new Map(), 0, AU_SLOTS).map((a) => a.slot.id)).toEqual([
      "quote-poll",
    ]); // 10:30: the poll alone (V2-I1)
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
    "intraday-scan fires 10:32 to 15:32 every 30 minutes on %s (offset %i), 11 times, never at a quote-poll minute (V2-I1)",
    (d, off) => {
      const t = due("intraday-scan", d, off);
      expect(t).toEqual([
        "10:32",
        "11:02",
        "11:32",
        "12:02",
        "12:32",
        "13:02",
        "13:32",
        "14:02",
        "14:32",
        "15:02",
        "15:32",
      ]);
      const poll = new Set(due("quote-poll", d, off));
      expect(t.filter((x) => poll.has(x))).toEqual([]);
    },
  );

  it("neither fires at the weekend", () => {
    expect(due("quote-poll", SAT[0], SAT[1])).toEqual([]);
    expect(due("intraday-scan", SAT[0], SAT[1])).toEqual([]);
  });
});
