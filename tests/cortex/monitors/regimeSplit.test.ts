// @vitest-environment node
// CXA-010 monitor 5 (M23 M2; D-1619, D-1700): the "one regime only" label at 90 %, either side, and the floor.
import { describe, expect, it } from "vitest";
import {
  MIN_SETUPS,
  ONE_REGIME_LABEL,
  regimeSplitMonitor,
  type RegimeCount,
} from "@/lib/cortex/monitors/regimeSplit";

const c = (family: string, regime: string, setups: number): RegimeCount => ({
  family,
  regime,
  setups,
});

describe("monitor 5: the label at 90 % of a family's setups", () => {
  it("90 of 100 is labelled, 89 of 100 is not, 91 is", () => {
    for (const [top, label] of [
      [89, false],
      [90, true],
      [91, true],
    ] as const) {
      const r = regimeSplitMonitor([c("F1", "CALM", top), c("F1", "SHOCK", 100 - top)]);
      const f = (r.value.families as Array<{ one_regime_only: boolean }>)[0]!;
      expect(f.one_regime_only).toBe(label);
    }
  });

  it("a family under the floor is never labelled, and the floor itself can be", () => {
    expect(MIN_SETUPS).toBe(30);
    const small = regimeSplitMonitor([c("F2", "CALM", 29)]);
    expect((small.value.families as Array<{ one_regime_only: boolean }>)[0]!.one_regime_only).toBe(
      false,
    );
    const at = regimeSplitMonitor([c("F2", "CALM", 30)]);
    expect((at.value.families as Array<{ one_regime_only: boolean }>)[0]!.one_regime_only).toBe(
      true,
    );
  });

  it("is a label only: no alarm, no Owner item, families in order with their shares", () => {
    const r = regimeSplitMonitor([c("F3", "CALM", 50), c("F1", "SHOCK", 40), c("F1", "CALM", 60)]);
    expect(r.alarm).toBe(false);
    expect(r.ownerItems).toEqual([]);
    expect(r.value.label).toBe(ONE_REGIME_LABEL);
    const fam = r.value.families as Array<{
      family: string;
      top_regime: string;
      top_share: number;
    }>;
    expect(fam.map((f) => f.family)).toEqual(["F1", "F3"]);
    expect(fam[0]).toMatchObject({ top_regime: "CALM", top_share: 0.6 });
  });

  it("no setups at all gives an empty list", () => {
    expect(regimeSplitMonitor([]).value.families).toEqual([]);
  });
});
