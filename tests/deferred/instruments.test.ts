// @vitest-environment node
// M21 R1 (ARN-124 a-c, D-1229): three deferred instrument classes with their reasons, and the refusal.
import { describe, expect, it } from "vitest";
import { DEFERRED_CLASSES, DeferredInstrument, refuseDeferred } from "@/lib/deferred/instruments";

describe("deferred instrument classes", () => {
  it("lists exactly options and futures, crypto and foreign exchange", () => {
    expect(DEFERRED_CLASSES.map((c) => [c.arn, c.kind, c.status])).toEqual([
      ["ARN-124a", "options_futures", "BLOCKED-DATA"],
      ["ARN-124b", "crypto", "OUTSIDE-EQUITY-CORTEX"],
      ["ARN-124c", "fx", "OUTSIDE-EQUITY-CORTEX"],
    ]);
  });

  it("every record carries a reason; the data-blocked one names the sources it checked", () => {
    for (const c of DEFERRED_CLASSES) expect(c.reason.length).toBeGreaterThan(40);
    const opt = DEFERRED_CLASSES[0]!;
    expect(opt.sourcesChecked).toEqual(["ASX derivatives data", "NSE F&O archive", "OPRA"]);
    expect(opt.reason).toMatch(/\[VERIFY\]/);
    expect(DEFERRED_CLASSES[2]!.reason).toMatch(/seed conversion rate/);
  });

  it.each(DEFERRED_CLASSES.map((c) => c.kind))(
    "refuseDeferred(%s) throws DeferredInstrument with the reason",
    (kind) => {
      const c = DEFERRED_CLASSES.find((x) => x.kind === kind)!;
      try {
        refuseDeferred(kind);
        expect.unreachable("must throw");
      } catch (e) {
        expect(e).toBeInstanceOf(DeferredInstrument);
        expect((e as DeferredInstrument).kind).toBe(kind);
        expect((e as DeferredInstrument).status).toBe(c.status);
        expect((e as Error).message).toContain(c.reason);
      }
    },
  );

  it("an unknown kind is a programming error, not a deferred class", () => {
    expect(() => refuseDeferred("bonds")).toThrow(RangeError);
  });
});
