// D-885: the stop in force and the indicative target of a trade (shown only, never an exit rule).
import { describe, expect, it } from "vitest";
import { stopTarget } from "@/lib/ui/loaders/strategyViews";

const M = 1_000_000;

describe("stopTarget (D-885)", () => {
  it("target is the buy price plus twice the distance to the first stop", () => {
    const r = stopTarget(false, 10 * M, 9 * M, null);
    expect(r.stop?.micro).toBe(9 * M);
    expect(r.target?.micro).toBe(12 * M);
  });

  it("the stop in force is the higher of the first stop and the latest recomputed one", () => {
    expect(stopTarget(false, 10 * M, 9 * M, 9.5 * M).stop?.micro).toBe(9.5 * M);
    // a lower recomputed level never loosens the stop; the target stays on the first stop
    const r = stopTarget(false, 10 * M, 9 * M, 8 * M);
    expect(r.stop?.micro).toBe(9 * M);
    expect(r.target?.micro).toBe(12 * M);
  });

  it("nothing for a masked viewer or an impossible stop", () => {
    expect(stopTarget(true, 10 * M, 9 * M, null)).toEqual({ stop: null, target: null });
    expect(stopTarget(false, 10 * M, 10 * M, null)).toEqual({ stop: null, target: null });
    expect(stopTarget(false, 10 * M, 0, null)).toEqual({ stop: null, target: null });
  });
});
