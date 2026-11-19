// @vitest-environment node
// M22 L4 (D-1493): the steelman leaves the reflections' reservation. `hasRoom` takes `reflectionReserve`; with it the largest
// reservation the stage may make shrinks, without it nothing changes.
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentParams } from "@/lib/agents/params";
import { DbStore } from "@/lib/llm/store";
import { hasRoom } from "@/lib/steelman/write";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

describe("steelman room and the reflection reservation", () => {
  it("the largest reservation that fits shrinks by the reserve, and is unchanged by a zero reserve", async () => {
    const db = await freshDb("main");
    const base = {
      params: defaultAgentParams().llm,
      store: new DbStore(db),
      market: "AU",
      d: "2026-03-04",
    };
    const largest = async (reflectionReserve?: number): Promise<number> => {
      let lo = 0;
      let hi = 1_000_000;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (await hasRoom({ ...base, reflectionReserve }, mid)) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const none = await largest();
    expect(none).toBeGreaterThan(0);
    expect(await largest(0)).toBe(none);
    const reserve = Math.min(1000, none);
    expect(await largest(reserve)).toBeLessThan(none);
  });
});
