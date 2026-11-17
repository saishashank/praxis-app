// @vitest-environment node
// The arithmetic and the fail-soft edges behind the current price on pick cards (pickNow.ts) and the
// bar check shared with the replay (usableBar): pure functions and stub databases, no network.
import { describe, expect, it } from "vitest";
import { loadPickNow, ppmOf } from "@/lib/ui/loaders/pickNow";
import { usableBar } from "@/lib/picks/shortlistLoad";
import type { DayBar } from "@/lib/picks/shortlist";

describe("ppmOf", () => {
  it("is exact integer ppm, rounded half away from zero, either side of the reference", () => {
    expect(ppmOf(10_500_000n, 10_000_000n)).toBe(50_000);
    expect(ppmOf("9500000", "10000000")).toBe(-50_000);
    expect(ppmOf(10_000_000, 10_000_000)).toBe(0);
    // 1 micro over 3 micro: 333333.33 rounds to 333333; 2 over 3 is 666666.67, rounds up
    expect(ppmOf(4n, 3n)).toBe(333_333);
    expect(ppmOf(5n, 3n)).toBe(666_667);
    // the mirror image rounds away from zero as well
    expect(ppmOf(2n, 3n)).toBe(-333_333);
    expect(ppmOf(1n, 3n)).toBe(-666_667);
    // exactly half a ppm (1 micro over 2_000_000): 0.5 rounds to 1, and -0.5 to -1
    expect(ppmOf(2_000_001n, 2_000_000n)).toBe(1);
    expect(ppmOf(1_999_999n, 2_000_000n)).toBe(-1);
  });

  it("no usable reference or an unreadable number is null, never a throw", () => {
    expect(ppmOf(10n, 0n)).toBeNull();
    expect(ppmOf(10n, -5n)).toBeNull();
    expect(ppmOf("abc", "10")).toBeNull();
    expect(ppmOf(10n, "x")).toBeNull();
    expect(ppmOf(1.5, 10n)).toBeNull(); // a fractional micro level is not an integer
  });
});

describe("loadPickNow with a failing database", () => {
  it("reads nothing and gives nothing, for a repeated code too", async () => {
    const down = {
      execute: async () => {
        throw new Error("db down");
      },
    };
    const r = await loadPickNow(down as never, "AU", ["ZZ01", "ZZ01"]);
    expect(r.size).toBe(0);
  });

  it("an empty code list reads nothing at all", async () => {
    let reads = 0;
    const db = {
      execute: async () => {
        reads += 1;
        return { rows: [] };
      },
    };
    expect((await loadPickNow(db as never, "AU", [])).size).toBe(0);
    expect(reads).toBe(0);
  });

  it("a long list is read in chunks of at most 200 codes", async () => {
    const sizes: number[] = [];
    const db = {
      execute: async (q: { args?: unknown[] }) => {
        sizes.push((q.args?.length ?? 1) - 1);
        return { rows: [] };
      },
    };
    const codes = Array.from({ length: 450 }, (_, i) => `ZZ${i}`);
    await loadPickNow(db as never, "AU", codes);
    expect(sizes.filter((n) => n > 0)).toEqual(expect.arrayContaining([200, 200, 50]));
    expect(Math.max(...sizes)).toBe(200);
  });
});

describe("usableBar", () => {
  const bar = (o: number, h: number, l: number, c: number): DayBar => ({
    d: "2026-11-12",
    openMicro: BigInt(o),
    highMicro: BigInt(h),
    lowMicro: BigInt(l),
    closeMicro: BigInt(c),
    volume: 1,
  });
  it("accepts a bar whose range holds its open and close", () => {
    expect(usableBar(bar(10, 12, 9, 11))).toBe(true);
    expect(usableBar(bar(10, 10, 10, 10))).toBe(true);
  });
  it("refuses a zero open, a zero low, a low above the open or close, a high below the open or close", () => {
    expect(usableBar(bar(0, 12, 9, 11))).toBe(false);
    expect(usableBar(bar(10, 12, 0, 11))).toBe(false);
    expect(usableBar(bar(10, 12, 11, 11))).toBe(false); // low above the open
    expect(usableBar(bar(10, 12, 10, 9))).toBe(false); // low above the close... close below low
    expect(usableBar(bar(10, 9, 9, 9))).toBe(false); // high below the open
    expect(usableBar(bar(10, 10, 9, 11))).toBe(false); // high below the close
  });
});
