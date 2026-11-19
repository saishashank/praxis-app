// @vitest-environment node
// Poll priority (M22 E2; DAT-230, D-1434): daily for L1+ or a positive call record, weekly for all-rejected after the
// minimum, never for retired or paused (and not for candidates); ties by last poll then id. Pure.
import { describe, expect, it } from "vitest";
import { cadenceOf, pollOrder, type PollFacts } from "@/lib/experts/poll/priority";

const f = (id: string, o: Partial<PollFacts> = {}): PollFacts => ({
  id,
  status: "tracked",
  screened: 0,
  rejected: 0,
  callsPositive: 0,
  callsSettled: 0,
  lastPolledAt: null,
  ...o,
});
const MIN = 10;

describe("cadenceOf", () => {
  it("an L1+ expert is daily and first", () => {
    expect(cadenceOf(f("a", { screened: 1 }), MIN)).toBe("daily-first");
    expect(cadenceOf(f("a", { screened: 1, rejected: 40 }), MIN)).toBe("daily-first");
  });
  it("a positive confirmed call record is daily and first; a weak one is not", () => {
    expect(cadenceOf(f("a", { callsSettled: 4, callsPositive: 3 }), MIN)).toBe("daily-first");
    expect(cadenceOf(f("a", { callsSettled: 4, callsPositive: 2 }), MIN)).toBe("daily");
    expect(cadenceOf(f("a", { callsSettled: 0, callsPositive: 0 }), MIN)).toBe("daily");
  });
  it("all tested claims rejected after the minimum is weekly; fewer than the minimum is still daily", () => {
    expect(cadenceOf(f("a", { rejected: 10 }), MIN)).toBe("weekly");
    expect(cadenceOf(f("a", { rejected: 9 }), MIN)).toBe("daily");
  });
  it("retired, paused and candidate experts are never read", () => {
    for (const status of ["retired", "paused", "candidate"] as const)
      expect(cadenceOf(f("a", { status, screened: 5 }), MIN)).toBe("never");
  });
});

describe("pollOrder", () => {
  it("puts the evidence first, then the rest, by oldest poll then id", () => {
    const order = pollOrder(
      [
        f("d", { lastPolledAt: "2030-03-01T00:00:00.000Z" }),
        f("c"),
        f("b", { screened: 2, lastPolledAt: "2030-03-02T00:00:00.000Z" }),
        f("a", { screened: 1, lastPolledAt: "2030-03-01T00:00:00.000Z" }),
        f("e", { status: "retired" }),
        f("p", { status: "paused", screened: 3 }),
      ],
      "2030-03-05",
      MIN,
    );
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("a weekly expert is read once a week: never polled or seven days ago, not before", () => {
    const w = (last: string | null) => f("w", { rejected: 12, lastPolledAt: last });
    expect(pollOrder([w(null)], "2030-03-10", MIN)).toEqual(["w"]);
    expect(pollOrder([w("2030-03-03T09:00:00.000Z")], "2030-03-10", MIN)).toEqual(["w"]);
    expect(pollOrder([w("2030-03-04T09:00:00.000Z")], "2030-03-10", MIN)).toEqual([]);
  });

  it("weekly experts come after the daily ones", () => {
    expect(pollOrder([f("w", { rejected: 12 }), f("z")], "2030-03-10", MIN)).toEqual(["z", "w"]);
  });
});
