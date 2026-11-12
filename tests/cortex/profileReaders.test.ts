// @vitest-environment node
// M19 B1 -> M20 A5 (CXA-002 e, f, g, i; D-1003, D-1108, D-1112; PRD-039): the profile-selected rule sets. AU keeps its
// readers; the IN and US values now resolve to the readers built at M20, chosen by the VALUE of the profile field; a
// value with no reader still throws `not built (M20)` (the stub class stays for any later market). The franking angle
// (A-D4-05) is skipped without dividend imputation and the angle count follows the profile (AU 100, IN and US 99).
import { describe, expect, it } from "vitest";
import { ANGLES, EXCLUSIVE_ANGLE_IDS } from "@/lib/cortex/angles/registry";
import {
  anglesForProfile,
  categoryMapReader,
  classificationReader,
  FRANKING_ANGLE_ID,
  haltReader,
  NotBuiltM20,
  profileReaders,
  sicTwoDigit,
} from "@/lib/cortex/profileReaders";
import { groupOf, gatePortfolio, type Exposure } from "@/lib/cortex/gates/portfolio";
import { makeRational } from "@/lib/money/rational";
import { CATEGORY_MAP as IN_MAP } from "@/lib/market/seed/in/categoryMap.mjs";
import { CATEGORY_MAP as US_MAP } from "@/lib/market/seed/us/categoryMap.mjs";
import { staticProfile } from "@/lib/market/staticProfile.mjs";
import type { MarketProfile } from "@/lib/market/profileCore.mjs";

/** A profile with one field replaced (a value that has no reader). */
function withField(code: string, field: string, value: unknown): MarketProfile {
  const p = staticProfile(code);
  const accessor: Record<string, string> = {
    classification_scheme: "classificationScheme",
    halt_model: "haltModel",
  };
  return {
    ...p,
    ...(accessor[field] === undefined ? {} : { [accessor[field]!]: value }),
    fields: { ...p.fields, [field]: { ...p.fields[field as keyof typeof p.fields]!, value } },
  } as MarketProfile;
}

describe("AU readers are unchanged", () => {
  it("AU names the GICS group, the CX16 halt rules and no category map (today's behaviour)", () => {
    const r = profileReaders(staticProfile("AU"));
    expect(r.classification.scheme).toBe("gics_group");
    expect(r.halt).toBe("cx16");
    expect(r.categoryMap).toBeNull();
  });
  it("the AU group is the instrument's industry column, as the night reads it today", () => {
    const r = classificationReader(staticProfile("AU"));
    expect(r.groupOf({ industry: "Materials" })).toBe("Materials");
    expect(r.groupOf({ industry: null })).toBeNull();
    expect(r.groupOf({ industry: "  " })).toBeNull();
  });
});

describe("IN and US resolve to the readers built at M20 (D-1108, D-1112)", () => {
  it("IN: NSE level-2, bands, the headline category map", () => {
    const r = profileReaders(staticProfile("IN"));
    expect(r.classification.scheme).toBe("nse_level2");
    expect(r.halt).toBe("in_bands");
    expect(r.categoryMap).toBe(IN_MAP);
  });
  it("US: SIC two-digit, LULD, the 8-K item map", () => {
    const r = profileReaders(staticProfile("US"));
    expect(r.classification.scheme).toBe("sic_2digit");
    expect(r.halt).toBe("us_luld");
    expect(r.categoryMap).toBe(US_MAP);
  });
  it("nse_level2 reads the industry string; sic_2digit the first two digits of the SIC code", () => {
    expect(
      classificationReader(staticProfile("IN")).groupOf({ industry: "Financial Services" }),
    ).toBe("Financial Services");
    const us = classificationReader(staticProfile("US"));
    expect(us.groupOf({ sic: "7372" })).toBe("73");
    expect(us.groupOf({ sic: 3674 })).toBe("36");
    expect(us.groupOf({ sic: "0100" })).toBe("01");
    expect(us.groupOf({ sic: 100 })).toBe("01");
    expect(us.groupOf({ sic: "" })).toBeNull();
    expect(us.groupOf({ sic: "abcd" })).toBeNull();
    expect(us.groupOf({ sic: "73721" })).toBeNull();
    expect(us.groupOf({ industry: "Software" })).toBeNull();
    expect(sicTwoDigit(null)).toBeNull();
  });
});

describe("a value with no reader still throws not built (M20)", () => {
  it.each([
    ["classification_scheme", "naics_sector", "classification scheme naics_sector"],
    ["halt_model", "jp_circuit", "halt model jp_circuit"],
  ])("%s %s", (field, value, message) => {
    const p = withField("US", field, value);
    const run = field === "halt_model" ? () => haltReader(p) : () => classificationReader(p);
    expect(run).toThrow(`not built (M20): ${message}`);
    expect(() => profileReaders(p)).toThrow(NotBuiltM20);
  });
  it("an unknown category map kind throws", () => {
    const p = withField("IN", "category_map", { kind: "keyword_rules" });
    expect(() => categoryMapReader(p)).toThrow("not built (M20): category map");
    expect(() => categoryMapReader(withField("IN", "category_map", null))).toThrow(NotBuiltM20);
  });
  it("prototype names are not readers", () => {
    expect(() =>
      classificationReader(withField("US", "classification_scheme", "constructor")),
    ).toThrow(NotBuiltM20);
    expect(() => categoryMapReader(withField("IN", "category_map", { kind: "__proto__" }))).toThrow(
      NotBuiltM20,
    );
  });
});

describe("the NAV cap groups by the market's classification (D-1112, CTX-026)", () => {
  const caps = {
    maxBooksSameCode: 3,
    maxCodeNavShare: makeRational(1n, 4n),
    maxIndustryNavShare: makeRational(3n, 10n),
  };
  const NAV = 1_000_000_000n;
  const us = classificationReader(staticProfile("US"));
  const au = classificationReader(staticProfile("AU"));

  it("groupOf is the reader's group", () => {
    expect(groupOf(us, { sic: "7372" })).toBe("73");
    expect(groupOf(au, { industry: "Energy" })).toBe("Energy");
  });

  it("two US codes with different SIC codes in the same two-digit group share one industry cap", () => {
    const held: Exposure[] = [
      {
        bookId: "b1",
        code: "AAA",
        industry: groupOf(us, { sic: "7370" }),
        exposureMicro: 250_000_000n,
      },
    ];
    // BBB (sic 7372) is in group 73: 250 + 100 = 350 of 1000 = 35 % > 30 %
    const r = gatePortfolio({
      bookId: "b2",
      code: "BBB",
      industry: groupOf(us, { sic: "7372" }),
      orderValueMicro: 100_000_000n,
      exposures: held,
      arenaNavMicro: NAV,
      caps,
    });
    expect(r.pass).toBe(false);
    expect(r.pass ? "" : r.value).toMatch(/^industry_(drift|share)/);
  });

  it("a code in another group is not counted against it", () => {
    const held: Exposure[] = [
      {
        bookId: "b1",
        code: "AAA",
        industry: groupOf(us, { sic: "7370" }),
        exposureMicro: 250_000_000n,
      },
    ];
    const r = gatePortfolio({
      bookId: "b2",
      code: "CCC",
      industry: groupOf(us, { sic: "3674" }),
      orderValueMicro: 100_000_000n,
      exposures: held,
      arenaNavMicro: NAV,
      caps,
    });
    expect(r.pass).toBe(true);
  });
});

describe("the franking angle and the angle count (CXA-002 i)", () => {
  const exclusive = EXCLUSIVE_ANGLE_IDS.length;
  it("AU runs every angle: 100 spec angles plus the exclusive rule-version angles", () => {
    const p = staticProfile("AU");
    expect(p.angleCount).toBe(100);
    expect(anglesForProfile(ANGLES, p)).toBe(ANGLES);
    expect(ANGLES).toHaveLength(p.angleCount + exclusive);
  });
  it.each(["IN", "US"])("%s skips A-D4-05 and counts 99", (code) => {
    const p = staticProfile(code);
    expect(p.dividendImputation).toBe(false);
    expect(p.angleCount).toBe(99);
    const run = anglesForProfile(ANGLES, p);
    expect(run.some((a) => a.id === FRANKING_ANGLE_ID)).toBe(false);
    expect(run).toHaveLength(p.angleCount + exclusive);
    expect(run).toHaveLength(ANGLES.length - 1);
  });
});
