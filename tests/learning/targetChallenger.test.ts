// @vitest-environment node
// FAM-010 target keys under the O-46 cap and the structural validator (M21 E1, D-1224).
import { afterEach, describe, expect, it } from "vitest";
import {
  VARIANT_QUARTER_CAP,
  changesStopOrSizing,
  isStopOrSizingKey,
} from "@/lib/learning/challengerLifecycle";
import { checkStructuralParams } from "@/lib/agents/families/ruleSchema";
import { cleanupTempDbs } from "../db/helpers";
import { D0, f1With, ownerChallenger, world } from "./challengerFixtures";

afterEach(cleanupTempDbs);

const withTarget = async (db: Parameters<typeof f1With>[0], extra: Record<string, number>) =>
  ownerChallenger(db, 0, D0, { params: await f1With(db, extra) });

describe("target keys", () => {
  it("count as stop, trail or sizing keys", () => {
    for (const k of ["f1_target_r", "f4_target_pct", "f6_target_r"])
      expect(isStopOrSizingKey(k)).toBe(true);
    expect(changesStopOrSizing({}, { f1_target_r: 2 })).toBe(true);
  });

  it("a target variant counts toward the cap of 3 per quarter; the fourth is refused", async () => {
    const { db } = await world();
    for (const r of [1.5, 2, 3]) {
      expect(await withTarget(db, { f1_target_r: r })).toMatchObject({ status: "created" });
    }
    expect(await withTarget(db, { f1_target_r: 4 })).toMatchObject({
      status: "refused",
      reason: "variant_quarter_cap",
    });
    expect(VARIANT_QUARTER_CAP).toBe(3);
  });

  it("a target and a stop variant share the same cap", async () => {
    const { db } = await world();
    expect(await ownerChallenger(db, 0)).toMatchObject({ status: "created" });
    expect(await ownerChallenger(db, 1)).toMatchObject({ status: "created" });
    expect(await withTarget(db, { f1_target_pct: 10 })).toMatchObject({ status: "created" });
    expect(await withTarget(db, { f1_target_pct: 20 })).toMatchObject({
      status: "refused",
      reason: "variant_quarter_cap",
    });
  });

  it("the validator refuses both keys, out-of-range values and a key of another family", async () => {
    const { db } = await world();
    const refused = (r: unknown) =>
      expect(r).toMatchObject({ status: "refused", reason: "invalid_params" });
    refused(await withTarget(db, { f1_target_r: 2, f1_target_pct: 10 }));
    refused(await withTarget(db, { f1_target_r: 0.9 }));
    refused(await withTarget(db, { f1_target_r: 5.1 }));
    refused(await withTarget(db, { f1_target_pct: 4.9 }));
    refused(await withTarget(db, { f1_target_pct: 51 }));
    refused(await withTarget(db, { f4_target_r: 2 }));
    refused(await withTarget(db, { f7_target_r: 2 }));
    // the bounds themselves are allowed
    expect(await withTarget(db, { f1_target_r: 1 })).toMatchObject({ status: "created" });
    expect(await withTarget(db, { f1_target_pct: 50 })).toMatchObject({ status: "created" });
  });

  it("checkStructuralParams reads the same keys", () => {
    expect(checkStructuralParams("F2", { f2_target_r: 2 })).toEqual([]);
    expect(checkStructuralParams("F2", { f2_target_r: 2, f2_target_pct: 10 })).toHaveLength(1);
    expect(checkStructuralParams("F2", { f2_target_pct: 80 })).toHaveLength(1);
  });
});
