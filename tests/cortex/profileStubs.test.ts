// @vitest-environment node
// M19 B1 (CXA-002 e, f, g, i; D-1003; PRD-039): the profile-selected rule sets. AU has its reader; the IN and US
// values name readers built at M20, and each throws `not built (M20)` with the reason, so a night can never run
// IN or US on the AU rules by accident. The franking angle (A-D4-05) is skipped without dividend imputation and
// the angle count follows the profile (AU 100, IN and US 99).
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
} from "@/lib/cortex/profileReaders";
import { staticProfile } from "@/lib/market/staticProfile.mjs";

describe("AU readers", () => {
  it("AU names the GICS group, the CX16 halt rules and no category map (today's behaviour)", () => {
    expect(profileReaders(staticProfile("AU"))).toEqual({
      classification: "gics_group",
      halt: "cx16",
      categoryMap: null,
    });
  });
});

describe("IN and US readers are stubs that say why (M20)", () => {
  it.each([
    ["IN", "classification scheme nse_level2", "halt model in_bands"],
    ["US", "classification scheme sic_2digit", "halt model us_luld"],
  ])("%s throws not built (M20) for each rule set", (code, group, halt) => {
    const p = staticProfile(code);
    expect(() => classificationReader(p)).toThrow(`not built (M20): ${group}`);
    expect(() => haltReader(p)).toThrow(`not built (M20): ${halt}`);
    expect(() => categoryMapReader(p)).toThrow("not built (M20): category map");
    expect(() => profileReaders(p)).toThrow(NotBuiltM20);
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
