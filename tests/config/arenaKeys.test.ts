// @vitest-environment node
// Arena cost/slippage config keys (spec ch.15 l.12, l.24; ARN-013; D-069 decisions 4 and 12).
import { describe, expect, it } from "vitest";
import { parseConfigInput } from "@/lib/config/admin";
import { CONFIG_KEYS, CONFIG_META } from "@/lib/config/keys";

const get = async () => undefined;
const check = (key: keyof typeof CONFIG_KEYS, v: unknown) => CONFIG_KEYS[key].validate(v, get);

describe("cost_profile_default", () => {
  it("defaults to P5, Owner-editable, enum P0 to P5b (ch.15 l.24)", async () => {
    expect(CONFIG_KEYS.cost_profile_default).toMatchObject({
      default: "P5",
      editable: "O",
      ref: "ARN-031",
    });
    for (const code of ["P0", "P1", "P2", "P3", "P4", "P5", "P5b"]) {
      expect(await check("cost_profile_default", code)).toBeNull();
    }
    for (const bad of ["P6", "p5", "", 5, null]) {
      expect(await check("cost_profile_default", bad)).toMatch(/must be one of/);
    }
    expect(CONFIG_META.cost_profile_default.input).toBe("text");
  });
  it("text input passes through unchanged", () => {
    expect(parseConfigInput("text", " P5b ")).toEqual({ value: "P5b" });
    expect(parseConfigInput("text", "")).toHaveProperty("error");
  });
});

describe("stall_floor_bps", () => {
  it("is fixed at 10 bps (decision 4) and refuses every edit", async () => {
    expect(CONFIG_KEYS.stall_floor_bps).toMatchObject({ default: 10, editable: "fixed" });
    expect(await check("stall_floor_bps", 10)).toMatch(/fixed/);
    expect(await check("stall_floor_bps", 11)).toMatch(/fixed/);
  });
});

describe("untradeable_adv_pct", () => {
  it("defaults to 0.5 (% of ADV), Owner-editable, bounds 0.1 to 5 inclusive", async () => {
    expect(CONFIG_KEYS.untradeable_adv_pct).toMatchObject({
      default: 0.5,
      editable: "O",
      unit: "% of ADV",
    });
    expect(CONFIG_KEYS.untradeable_adv_pct.ref).toContain("ARN-013");
    for (const ok of [0.1, 0.5, 1, 5]) expect(await check("untradeable_adv_pct", ok)).toBeNull();
    for (const bad of [0.09, 5.01, 0, -1, "0.5", Number.NaN, null]) {
      expect(await check("untradeable_adv_pct", bad)).toMatch(/number from 0.1 to 5/);
    }
  });
});
