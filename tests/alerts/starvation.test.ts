// @vitest-environment node
// OPS-109 c (M18 A3, D-971, AT-83): the pure quote-starvation check. A held code whose newest
// `quote_latest.fetched_at` is older than 30 minutes inside the poll window on a trading day is
// starved; a weekend or a time outside the window never is. Synthetic ZZ codes only.
import { describe, expect, it } from "vitest";
import { STARVATION_MINUTES, starved } from "@/lib/alerts/pick/starvation";

const D = "2026-11-04"; // Wed, AEDT (UTC+11)
const at = (hm: string) => new Date(`${D}T${hm}:00.000+11:00`);
const window = { start: at("10:00"), end: at("16:00") };
const opts = { minutes: STARVATION_MINUTES, window };
const fetched = (...rows: [string, string][]) =>
  new Map(rows.map(([c, hm]) => [c, at(hm).toISOString()]));

describe("starved (table)", () => {
  it("the limit is 30 minutes", () => {
    expect(STARVATION_MINUTES).toBe(30);
  });

  it.each([
    ["fresh (5 min)", "12:05", "12:00", []],
    ["29 minutes", "12:29", "12:00", []],
    ["exactly 30 minutes is not yet starved", "12:30", "12:00", []],
    ["31 minutes", "12:31", "12:00", ["ZZ01"]],
    ["hours old", "15:00", "10:05", ["ZZ01"]],
  ] as const)("%s", (_name, now, fetchedHm, expected) => {
    expect(starved(["ZZ01"], fetched(["ZZ01", fetchedHm]), at(now), opts)).toEqual(expected);
  });

  it("a code with no quote at all is measured from the start of the window", () => {
    expect(starved(["ZZ01"], new Map(), at("10:20"), opts)).toEqual([]);
    expect(starved(["ZZ01"], new Map(), at("10:30"), opts)).toEqual([]);
    expect(starved(["ZZ01"], new Map(), at("10:31"), opts)).toEqual(["ZZ01"]);
  });

  it("yesterday's quote does not start the clock before today's window opens", () => {
    const old = new Map([["ZZ01", new Date(`2026-11-03T15:55:00.000+11:00`).toISOString()]]);
    expect(starved(["ZZ01"], old, at("10:20"), opts)).toEqual([]);
    expect(starved(["ZZ01"], old, at("10:31"), opts)).toEqual(["ZZ01"]);
  });

  it("weekend or other non-trading day (no window): never", () => {
    expect(starved(["ZZ01"], new Map(), at("12:00"), { ...opts, window: null })).toEqual([]);
  });

  it.each([["09:00"], ["09:59"], ["16:01"], ["20:00"]])("outside hours (%s): never", (now) => {
    expect(starved(["ZZ01"], new Map(), at(now), opts)).toEqual([]);
  });

  it("window edges are inside: 10:31 and 16:00 can be starved", () => {
    expect(starved(["ZZ01"], fetched(["ZZ01", "10:00"]), at("16:00"), opts)).toEqual(["ZZ01"]);
  });

  it("several codes: only the stale ones, sorted; an unparsable time counts as no quote", () => {
    const f = new Map<string, string>([
      ["ZZ03", "garbage"],
      ["ZZ02", at("12:20").toISOString()],
      ["ZZ01", at("11:00").toISOString()],
    ]);
    expect(starved(["ZZ03", "ZZ02", "ZZ01"], f, at("12:40"), opts)).toEqual(["ZZ01", "ZZ03"]);
  });

  it("no held codes: nothing", () => {
    expect(starved([], new Map(), at("12:40"), opts)).toEqual([]);
  });
});
