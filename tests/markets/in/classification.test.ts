// @vitest-environment node
// M20 IN1 (DAT-243 d, D-1112): the monthly NSE industry file. Quoted names with commas parse; a blank or "-" industry
// is skipped, never guessed.
import { describe, expect, it } from "vitest";
import { parseClassification } from "@/lib/data/sources/in/classification.mjs";
import { classificationFile } from "./dayFixture";

describe("parseClassification", () => {
  it("reads industry groups and skips an unclassified code", () => {
    expect(parseClassification(classificationFile())).toEqual([
      { code: "ALFA", industry: "Financial Services", name: "Alfa Industries, Ltd." },
      { code: "BETA", industry: "Information Technology", name: "Beta Ltd." },
    ]);
  });
});
