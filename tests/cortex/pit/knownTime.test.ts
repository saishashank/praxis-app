// @vitest-environment node
// CTX-010 known-time rules, one per InputKind (M15 C1a; docs/M15_design.md 3a, 6; D-263, D-290, D-291).
import { describe, expect, it } from "vitest";
import { decisionCutoffUtc } from "@/lib/agents/decisionView";
import { asicPublishedAt } from "@/lib/data/backfill/rules.mjs";
import {
  ALWAYS_KNOWN,
  dayStartUtc,
  instantMs,
  isKnownBy,
  KNOWN_TIME,
  knownTimeOf,
  MACRO_DEFAULT,
  MACRO_SERIES,
  macroRuleFor,
  makeSessionClock,
  NEVER_KNOWN,
  sessionsAfterUtc,
} from "@/lib/cortex/pit/knownTime";
import { INPUT_KINDS } from "@/lib/cortex/pit/types";
import { CUTOFF_HHMM, SESSIONS } from "./zzWorld";

const clock = makeSessionClock(SESSIONS, CUTOFF_HHMM);
const cutoff = (d: string) => decisionCutoffUtc(d, CUTOFF_HHMM);

describe("session clock", () => {
  it("cut-off, next and previous session over a list with a holiday gap", () => {
    expect(clock.cutoffUtc("2026-03-06")).toBe("2026-03-06T07:10:00.000Z"); // AEDT: 18:10 = 07:10Z
    expect(clock.nextSession("2026-03-06")).toBe("2026-03-10"); // the 9th is a holiday
    expect(clock.nextSession("2026-03-07")).toBe("2026-03-10"); // a non-session date too
    expect(clock.nextSession("2026-03-18")).toBeNull();
    expect(clock.previousSession("2026-03-10")).toBe("2026-03-06");
    expect(clock.previousSession("2026-03-02")).toBeNull();
    expect(clock.previousSession("2026-03-01")).toBeNull();
  });

  it("refuses an unsorted or non-date session list", () => {
    expect(() => makeSessionClock(["2026-03-02", "2026-03-02"], CUTOFF_HHMM)).toThrow(RangeError);
    expect(() => makeSessionClock(["2026-03-03", "2026-03-02"], CUTOFF_HHMM)).toThrow(RangeError);
    expect(() => makeSessionClock(["20260302"], CUTOFF_HHMM)).toThrow(RangeError);
  });

  it("sessionsAfterUtc walks n sessions and is NEVER_KNOWN past the end", () => {
    expect(sessionsAfterUtc(clock, "2026-03-06", 1)).toBe("2026-03-10T00:00:00.000Z");
    expect(sessionsAfterUtc(clock, "2026-03-06", 2)).toBe("2026-03-11T00:00:00.000Z");
    expect(sessionsAfterUtc(clock, "2026-03-06", 0)).toBe(dayStartUtc("2026-03-06"));
    expect(sessionsAfterUtc(clock, "2026-03-17", 2)).toBe(NEVER_KNOWN);
    expect(() => sessionsAfterUtc(clock, "2026-03-06", -1)).toThrow(RangeError);
  });

  it("instantMs refuses text that is not an instant", () => {
    expect(() => instantMs("not a time")).toThrow(RangeError);
    expect(instantMs("2026-03-06T07:10:00.000Z")).toBe(Date.UTC(2026, 2, 6, 7, 10));
  });
});

describe("KNOWN_TIME has one rule per InputKind", () => {
  it("covers every kind and nothing else", () => {
    expect(Object.keys(KNOWN_TIME).sort()).toEqual([...INPUT_KINDS].sort());
  });

  it("bar_au / index_au: a D bar is known at the cut-off of D (D-263 interim)", () => {
    expect(knownTimeOf("bar_au", { d: "2026-03-05" }, clock)).toBe(cutoff("2026-03-05"));
    expect(knownTimeOf("index_au", { d: "2026-03-05" }, clock)).toBe(cutoff("2026-03-05"));
    expect(() => knownTimeOf("bar_au", {}, clock)).toThrow(RangeError);
  });

  it("index_us: dated D, known D+1 09:00 Melbourne all year (AT-56 fixture 3 rule)", () => {
    // 2026-03-05 is AEDT (UTC+11): 09:00 on the 6th = 22:00Z on the 5th.
    expect(knownTimeOf("index_us", { d: "2026-03-05" }, clock)).toBe("2026-03-05T22:00:00.000Z");
    // Under AEST (UTC+10) the same rule gives 23:00Z the day before.
    expect(knownTimeOf("index_us", { d: "2026-06-05" }, clock)).toBe("2026-06-05T23:00:00.000Z");
    // Thursday's US bar is usable at Friday's cut-off, not Thursday's.
    const thu = knownTimeOf("index_us", { d: "2026-03-05" }, clock);
    expect(instantMs(thu) <= instantMs(cutoff("2026-03-05"))).toBe(false);
    expect(instantMs(thu) <= instantMs(cutoff("2026-03-06"))).toBe(true);
  });

  it("asic_short: the existing asicPublishedAt function, no second implementation (D-278)", () => {
    expect(knownTimeOf("asic_short", { asOf: "2026-03-02" }, clock)).toBe(
      asicPublishedAt("2026-03-02"),
    );
  });

  it("macro: stamped publication wins; cash-rate decision day 14:30; daily +1 session; monthly lag", () => {
    expect(
      knownTimeOf(
        "macro",
        { d: "2026-03-03", series: "DGS10", publishedAt: "2026-03-04T10:00:00Z" },
        clock,
      ),
    ).toBe("2026-03-04T10:00:00.000Z");
    expect(knownTimeOf("macro", { d: "2026-03-03", series: "RBA_CASH_RATE" }, clock)).toBe(
      "2026-03-03T03:30:00.000Z",
    );
    expect(knownTimeOf("macro", { d: "2026-03-06", series: "DGS10" }, clock)).toBe(
      "2026-03-10T00:00:00.000Z",
    );
    expect(knownTimeOf("macro", { d: "2026-03-06", series: "UNLISTED" }, clock)).toBe(
      "2026-03-10T00:00:00.000Z",
    );
    expect(knownTimeOf("macro", { d: "2026-03-01", series: "CPIAUCSL" }, clock)).toBe(NEVER_KNOWN);
    expect(macroRuleFor(undefined)).toBe(MACRO_DEFAULT);
    expect(MACRO_SERIES.FEDFUNDS).toEqual({ kind: "sessions", lag: 25 });
    expect(MACRO_SERIES.CPIAUCSL).toEqual({ kind: "sessions", lag: 35 });
  });

  it("announcement: platform time when stamped; an untimed (date-only) row is +1 session (OI-46)", () => {
    expect(knownTimeOf("announcement", { publishedAt: "2026-03-04T23:30:00+00:00" }, clock)).toBe(
      "2026-03-04T23:30:00.000Z",
    );
    expect(knownTimeOf("announcement", { publishedAt: "2026-03-06" }, clock)).toBe(
      "2026-03-10T00:00:00.000Z",
    );
    expect(() => knownTimeOf("announcement", { publishedAt: null }, clock)).toThrow(RangeError);
  });

  it("corp_action: known_at when confirmed; a vendor row is known the session before its ex-date", () => {
    expect(
      knownTimeOf("corp_action", { knownAt: "2026-03-10T05:00:00Z", exDate: "2026-03-11" }, clock),
    ).toBe("2026-03-10T05:00:00.000Z");
    expect(knownTimeOf("corp_action", { knownAt: null, exDate: "2026-03-11" }, clock)).toBe(
      "2026-03-10T00:00:00.000Z",
    );
    expect(knownTimeOf("corp_action", { exDate: "2026-03-10" }, clock)).toBe(
      "2026-03-06T00:00:00.000Z",
    );
    expect(knownTimeOf("corp_action", { exDate: "2026-03-02" }, clock)).toBe(ALWAYS_KNOWN);
  });

  it("index_change: known_at when stamped, else the announced (or effective) date's start", () => {
    expect(knownTimeOf("index_change", { d: "2026-03-04" }, clock)).toBe(
      "2026-03-04T00:00:00.000Z",
    );
    expect(
      knownTimeOf("index_change", { knownAt: "2026-03-04T06:00:00Z", d: "2026-03-04" }, clock),
    ).toBe("2026-03-04T06:00:00.000Z");
  });

  it("calendar: always known; sector_map: from its as_of date", () => {
    expect(knownTimeOf("calendar", {}, clock)).toBe(ALWAYS_KNOWN);
    expect(knownTimeOf("sector_map", { asOf: "2026-03-03" }, clock)).toBe(
      "2026-03-03T00:00:00.000Z",
    );
  });

  it("isKnownBy compares instants, not text", () => {
    const row = { publishedAt: "2026-03-05T07:09:59+00:00" }; // one second before the cut-off, odd form
    expect(isKnownBy("announcement", row, clock, cutoff("2026-03-05"))).toBe(true);
    expect(
      isKnownBy(
        "announcement",
        { publishedAt: "2026-03-05T07:10:01Z" },
        clock,
        cutoff("2026-03-05"),
      ),
    ).toBe(false);
  });
});
