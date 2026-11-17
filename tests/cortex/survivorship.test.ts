// @vitest-environment node
// M20 A5 (CXA-012, CXA-013, D-1115, D-1132; AT-70 / AT-75 data-limits clause): the survivorship haircut by known answer,
// and the caveats a market's report must carry. US: the DAT-130/131 caveat on every report until its own snapshots
// satisfy ARN-082; IN: measured on the bhavcopy archive; AU: nothing, the report is unchanged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "@/lib/config/keys";
import {
  ASSUMED_DELISTING_LOSS_PCT,
  STATIC_INDUSTRY,
  assumedLossPct,
  haircut,
  industryLabel,
  reportCaveats,
  withAndWithout,
} from "@/lib/cortex/survivorship";
import { dataLimitsOf } from "@/lib/market/seed/dataLimits.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

describe("haircut: delisted share per year x mean loss on a delisting", () => {
  it("3 % delisted per year x 50 % loss = 1.5 points a year (the known answer)", () => {
    const h = haircut({ delistedSharePerYear: 3, meanLossPct: 50 });
    expect(h.ppPerYear).toEqual({ num: 3n, den: 2n });
    expect(h.ppPerYearText).toBe("1.5");
  });
  it("the assumed loss is 50 % when not given", () => {
    expect(ASSUMED_DELISTING_LOSS_PCT).toBe(50);
    expect(haircut({ delistedSharePerYear: 3 }).ppPerYearText).toBe("1.5");
    expect(haircut({ delistedSharePerYear: 3 }).meanLossPct).toBe("50");
  });
  it("other inputs: 2.5 % x 40 % = 1 point; 0 % = 0; 100 % x 100 % = 100 points", () => {
    expect(haircut({ delistedSharePerYear: "2.5", meanLossPct: 40 }).ppPerYearText).toBe("1");
    expect(haircut({ delistedSharePerYear: 0 }).ppPerYearText).toBe("0");
    expect(haircut({ delistedSharePerYear: 100, meanLossPct: 100 }).ppPerYearText).toBe("100");
    expect(haircut({ delistedSharePerYear: "1.1", meanLossPct: 50 }).ppPerYearText).toBe("0.55");
  });
  it("refuses a negative, a non-numeric or an over-100 share", () => {
    expect(() => haircut({ delistedSharePerYear: -1 })).toThrow(RangeError);
    expect(() => haircut({ delistedSharePerYear: "x" })).toThrow(RangeError);
    expect(() => haircut({ delistedSharePerYear: 101 })).toThrow(RangeError);
  });
  it("a yearly return is reported with and without the haircut", () => {
    const h = haircut({ delistedSharePerYear: 3 });
    expect(withAndWithout("12", h)).toEqual({ without: "12", with: "10.5" });
    expect(withAndWithout("1", h)).toEqual({ without: "1", with: "-0.5" });
    expect(withAndWithout("-2.5", h)).toEqual({ without: "-2.5", with: "-4" });
  });
});

describe("reportCaveats (CXA-012)", () => {
  it("the US survivorship caveat is on every US report, with matched controls unmatched", () => {
    const c = reportCaveats(staticProfile("US"));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      id: "survivorship_us",
      matchedControls: "unmatched",
      haircut: null,
    });
    expect(c[0]!.ref).toContain("DAT-130/131");
    expect(c[0]!.text).toMatch(/delisted codes are missing/);
  });
  it("it carries the haircut when the delisted share is known", () => {
    const c = reportCaveats(staticProfile("US"), { delistedSharePerYear: 3 });
    expect(c[0]!.haircut!.ppPerYearText).toBe("1.5");
  });
  it("it lapses once the market's own snapshots satisfy ARN-082", () => {
    expect(reportCaveats(staticProfile("US"), { ownSnapshotsSatisfyArn082: true })).toEqual([]);
    expect(reportCaveats(staticProfile("US"), { ownSnapshotsSatisfyArn082: false })).toHaveLength(
      1,
    );
  });
  it("IN: measured on the bhavcopy archive, not lapsing with snapshots", () => {
    const c = reportCaveats(staticProfile("IN"), { ownSnapshotsSatisfyArn082: true });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: "measured_on_bhavcopy_archive", matchedControls: "matched" });
    expect(c[0]!.text).toMatch(/bhavcopy archive/);
  });
  it("an unknown market states nothing", () => {
    expect(reportCaveats({ code: "ZZ" })).toEqual([]);
  });
});

describe("the assumed loss reads survivorship_loss_assumed_pct (CXA-012, D-1740)", () => {
  const def = CONFIG_KEYS.survivorship_loss_assumed_pct as {
    default: number;
    range: [number, number];
  };
  it("the key's default is 50 and is the constant, so every current value is unchanged", () => {
    expect(def.default).toBe(50);
    expect(ASSUMED_DELISTING_LOSS_PCT).toBe(def.default);
    expect(assumedLossPct()).toBe("50");
    expect(haircut({ delistedSharePerYear: 3 }).ppPerYearText).toBe("1.5");
  });
  it("the bounds are the key's own, 30 and 80, both inclusive", () => {
    expect(def.range).toEqual([30, 80]);
    expect(assumedLossPct(30)).toBe("30");
    expect(assumedLossPct(80)).toBe("80");
    expect(haircut({ delistedSharePerYear: 4, assumedLossPct: 30 }).ppPerYearText).toBe("1.2");
    expect(haircut({ delistedSharePerYear: 4, assumedLossPct: 80 }).ppPerYearText).toBe("3.2");
  });
  it("29 and 81 are refused", () => {
    expect(() => assumedLossPct(29)).toThrow(RangeError);
    expect(() => assumedLossPct(81)).toThrow(RangeError);
    expect(() => haircut({ delistedSharePerYear: 3, assumedLossPct: 29 })).toThrow(RangeError);
    expect(() => haircut({ delistedSharePerYear: 3, assumedLossPct: 81 })).toThrow(RangeError);
    expect(() => assumedLossPct("x")).toThrow(RangeError);
  });
  it("a measured loss (meanLossPct) is not bounded: only the assumed one is", () => {
    expect(haircut({ delistedSharePerYear: 2, meanLossPct: 10 }).ppPerYearText).toBe("0.2");
    expect(() => haircut({ delistedSharePerYear: 2, meanLossPct: 10, assumedLossPct: 50 })).toThrow(
      RangeError,
    );
  });
});

describe("AU caveats (CXA-012, CXA-013, D-1741)", () => {
  it("AU carries the survivorship caveat, with the assumed haircut when the share is known", () => {
    const c = reportCaveats(staticProfile("AU"), { delistedSharePerYear: 3 });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ id: "survivorship_au", matchedControls: "unmatched" });
    expect(c[0]!.text).toMatch(/assumed/);
    expect(c[0]!.haircut!.ppPerYearText).toBe("1.5");
    expect(c[0]!.haircut!.meanLossPct).toBe("50");
  });
  it("matched controls only from the first own universe snapshot", () => {
    const p = staticProfile("AU");
    const at = (reportStart: string | null, first: string | null) =>
      reportCaveats(p, {
        firstOwnUniverseSnapshot: first,
        ...(reportStart === null ? {} : { reportStart }),
      })[0]!.matchedControls;
    expect(at("2026-01-02", null)).toBe("unmatched");
    expect(at(null, "2026-05-01")).toBe("unmatched");
    expect(at("2026-04-30", "2026-05-01")).toBe("unmatched");
    expect(at("2026-05-01", "2026-05-01")).toBe("matched");
    expect(at("2026-06-01", "2026-05-01")).toBe("matched");
  });
  it("it lapses once the market's own snapshots satisfy ARN-082", () => {
    expect(reportCaveats(staticProfile("AU"), { ownSnapshotsSatisfyArn082: true })).toEqual([]);
  });
  it("the director trade-type split and fundamentals are BLOCKED-DATA, with the source check", () => {
    const l = dataLimitsOf("AU")!;
    expect(l.director_trades).toMatchObject({ status: "BLOCKED-DATA" });
    expect(l.fundamentals).toMatchObject({ status: "BLOCKED-DATA", variant: "F2-no-fundamentals" });
    expect(l.fundamentals!.source_check).toMatchObject({ rule: "DAT-101", result: "FAIL" });
    expect(l.fundamentals!.source_check!.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("IN and US have no BLOCKED-DATA director split (not blocked for them)", () => {
    expect(dataLimitsOf("IN")!.director_trades).toBeUndefined();
    expect(dataLimitsOf("US")!.director_trades).toBeUndefined();
  });
});

describe("industryLabel: static industry before the first instrument_class snapshot (D-1742)", () => {
  it("is 'static industry' before the first snapshot, and nothing from it on", () => {
    expect(STATIC_INDUSTRY).toBe("static industry");
    expect(industryLabel("2026-04-30", "2026-05-01")).toBe("static industry");
    expect(industryLabel("2026-05-01", "2026-05-01")).toBeNull();
    expect(industryLabel("2026-06-01", "2026-05-01")).toBeNull();
  });
  it("is 'static industry' on every date when the market has no snapshot yet", () => {
    expect(industryLabel("2026-06-01", null)).toBe("static industry");
  });
});

describe("the home market's figures are unchanged (D-1740)", () => {
  it("the haircut and the with/without figures equal the pre-R4 known answers", () => {
    const h = haircut({ delistedSharePerYear: "1.1" });
    expect(h.ppPerYearText).toBe("0.55");
    expect(withAndWithout("12", haircut({ delistedSharePerYear: 3 }))).toEqual({
      without: "12",
      with: "10.5",
    });
  });
  it("IN and US records keep their ids, text and matching", () => {
    expect(dataLimitsOf("US")!.survivorship).toMatchObject({
      id: "survivorship_us",
      until_own_snapshots: true,
      matched_controls: "unmatched",
    });
    expect(dataLimitsOf("IN")!.survivorship).toMatchObject({
      id: "measured_on_bhavcopy_archive",
      until_own_snapshots: false,
      matched_controls: "matched",
    });
  });
});

describe("docs/cortex/data-limits records the limits (CXA-012, CXA-013, D-1132)", () => {
  it("AU: survivorship assumed, matched from the first own snapshot, both BLOCKED-DATA, the source check", () => {
    const t = read("AU");
    for (const s of [
      "assumed",
      "1.5 points per year",
      "first own universe snapshot",
      "static industry",
      "BLOCKED-DATA",
      "DAT-101",
      "F2-no-fundamentals",
    ]) {
      expect(t).toContain(s);
    }
  });
  it("IN and US re-read and date their CXA-013 line", () => {
    expect(read("IN")).toMatch(/CXA-013 re-read 2026-11-17/);
    expect(read("US")).toMatch(/CXA-013 re-read 2026-11-17/);
  });
  const read = (n: string) =>
    readFileSync(path.resolve(__dirname, `../../docs/cortex/data-limits-${n}.md`), "utf8").replace(
      /\s+/g,
      " ",
    );
  it("US: no price history, the survivorship caveat and haircut, unmatched controls, F2 variant, Form 4 not blocked", () => {
    const t = read("US");
    for (const s of [
      "no daily bars",
      "1.5 points per year",
      "unmatched",
      "F2-no-fundamentals",
      "not** blocked",
      "DAT-130/131",
    ]) {
      expect(t).toContain(s);
    }
  });
  it("IN: no index or VIX series, bhavcopy archive, the haircut, XBRL BLOCKED-DATA, PIT not blocked", () => {
    const t = read("IN");
    for (const s of [
      "India VIX",
      "not pulled",
      "bhavcopy archive",
      "1.5 points per",
      "BLOCKED-DATA",
      "not** blocked",
    ]) {
      expect(t).toContain(s);
    }
  });
});
