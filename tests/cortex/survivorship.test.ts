// @vitest-environment node
// M20 A5 (CXA-012, CXA-013, D-1115, D-1132; AT-70 / AT-75 data-limits clause): the survivorship haircut by known answer,
// and the caveats a market's report must carry. US: the DAT-130/131 caveat on every report until its own snapshots
// satisfy ARN-082; IN: measured on the bhavcopy archive; AU: nothing, the report is unchanged.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSUMED_DELISTING_LOSS_PCT,
  haircut,
  reportCaveats,
  withAndWithout,
} from "@/lib/cortex/survivorship";
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
  it("AU: no caveat, the report is unchanged", () => {
    expect(reportCaveats(staticProfile("AU"))).toEqual([]);
    expect(reportCaveats(staticProfile("AU"), { delistedSharePerYear: 3 })).toEqual([]);
  });
});

describe("docs/cortex/data-limits records the limits (CXA-012, CXA-013, D-1132)", () => {
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
