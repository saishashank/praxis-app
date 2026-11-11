// @vitest-environment node
// Candidate measures from the daily loop's mover causes (Owner O-81; design C.13 step 9): a recurring
// cause maps to the registry angle that measures it (opened as a probe) or, without one, to an
// escalation "a new measure is needed"; covered causes, open probes and recent closes are left alone.
// Pure; synthetic ZZ data only.
import { describe, expect, it } from "vitest";
import { angleById } from "@/lib/cortex/angles/registry";
import type { AngleDef, AngleStatus } from "@/lib/cortex/angles/types";
import { cleanWords } from "@/lib/cortex/learn/learnWords";
import {
  CAUSE_ANGLES,
  CAUSE_MIN_NIGHTS,
  escalateWords,
  measureName,
  probeActions,
  probeCloseWords,
  probeEligible,
  probeOpenWords,
  probeStates,
  recurringCauses,
  sessionsSince,
} from "@/lib/cortex/learn/probes";
import { weekdays } from "./zzLearn";

const NIGHTS = weekdays("2026-10-13", "2026-11-09");
const D = "2026-11-09";
const candidate = (): AngleStatus => "candidate";

const nights = (causes: Record<string, number>) =>
  NIGHTS.map((d, i) => ({
    d,
    movers: Object.entries(causes).flatMap(([cause, every]) =>
      i % every === 0
        ? [
            { code: `ZZ${i}`, cause },
            { code: `ZZY${i}`, cause },
          ]
        : [],
    ),
  }));

describe("recurringCauses", () => {
  it("keeps the causes a measure could capture, on at least eight of the nights", () => {
    const t = recurringCauses(
      nights({
        volume_no_news: 1,
        sector_move: 2,
        stock_specific: 4,
        news_before_open: 1,
        market_move: 1,
      }),
    );
    expect(t.map((x) => x.cause)).toEqual(["volume_no_news", "sector_move"]);
    expect(t[0]).toEqual({
      cause: "volume_no_news",
      nights: NIGHTS.length,
      movers: 2 * NIGHTS.length,
    });
    expect(CAUSE_MIN_NIGHTS).toBe(8);
    expect(recurringCauses(nights({ stock_specific: 2 })).map((x) => x.cause)).toEqual([
      "stock_specific",
    ]);
  });
});

describe("probeEligible", () => {
  it("a computable live score angle outside the base, not retired", () => {
    const v = angleById("A-D2-07");
    expect(probeEligible(v, [], candidate)).toBe(true);
    expect(probeEligible(v, ["A-D2-07"], candidate)).toBe(false);
    expect(probeEligible(v, [], () => "retired")).toBe(false);
    expect(probeEligible(angleById("A-D5-03"), [], candidate)).toBe(false); // needs data
    expect(probeEligible(angleById("A-D1-11"), [], candidate)).toBe(false); // exclusive
    expect(probeEligible(undefined, [], candidate)).toBe(false);
    const gate = { ...(v as AngleDef), kind: "gate" } as AngleDef;
    expect(probeEligible(gate, [], candidate)).toBe(false);
  });
});

describe("probeStates", () => {
  it("folds opens and closes per family and angle", () => {
    const s = probeStates([
      {
        d: "2026-01-05",
        kind: "probe_open",
        family: "F1",
        angleId: "A-D2-07",
        evidence: { cause: "volume_no_news", cellId: "c1" },
      },
      { d: "2026-01-05", kind: "probe_open", family: "F4", angleId: "A-D2-07", evidence: null },
      { d: "2026-01-06", kind: "escalate", family: null, angleId: null, evidence: {} },
      { d: "2026-03-05", kind: "probe_close", family: "F4", angleId: "A-D2-07", evidence: {} },
    ]);
    expect(s.open).toEqual([
      {
        family: "F1",
        angleId: "A-D2-07",
        openedD: "2026-01-05",
        cause: "volume_no_news",
        cellId: "c1",
      },
    ]);
    expect(s.closed).toEqual([{ family: "F4", angleId: "A-D2-07", closedD: "2026-03-05" }]);
  });
});

describe("probeActions", () => {
  const causes = recurringCauses(nights({ volume_no_news: 1, sector_move: 1, stock_specific: 1 }));
  const base = (bases: Record<string, string[]>) => new Map(Object.entries(bases));

  it("opens the mapped angle per family, says covered when the base has it, escalates what nothing measures", () => {
    const a = probeActions({
      d: D,
      calendar: [],
      causes,
      bases: base({ F1: ["A-D1-11"], F4: ["A-D1-10", "A-D1-11"] }),
      status: candidate,
      open: [],
      closed: [],
      lastEscalated: new Map(),
    });
    // equal tallies: causes in name order
    expect(
      a.map(
        (x) =>
          `${x.kind}:${"family" in x ? x.family : "-"}:${"angleId" in x ? x.angleId : x.cause}`,
      ),
    ).toEqual([
      "open:F1:A-D1-10",
      "covered:F4:A-D1-10",
      "escalate:-:stock_specific",
      "open:F1:A-D2-07",
      "open:F4:A-D2-07",
    ]);
    expect(CAUSE_ANGLES.stock_specific).toEqual([]);
  });

  it("no second open, no reopen within a year of a close, escalation at most once a quarter", () => {
    const a = probeActions({
      d: D,
      calendar: [],
      causes,
      bases: base({ F1: ["A-D1-11"] }),
      status: candidate,
      open: [{ family: "F1", angleId: "A-D2-07", openedD: "2026-09-01", cause: null, cellId: "" }],
      closed: [{ family: "F1", angleId: "A-D1-10", closedD: "2026-06-01" }],
      lastEscalated: new Map([["stock_specific", "2026-10-01"]]),
    });
    expect(a).toEqual([]);
    const later = probeActions({
      d: "2027-07-01",
      calendar: [],
      causes,
      bases: base({ F1: ["A-D1-11"] }),
      status: candidate,
      open: [],
      closed: [{ family: "F1", angleId: "A-D1-10", closedD: "2026-06-01" }],
      lastEscalated: new Map([["stock_specific", "2026-10-01"]]),
    });
    expect(later.map((x) => x.kind)).toEqual(["open", "escalate", "open"]);
  });

  it("with no family base, every recurring cause can only be escalated", () => {
    const a = probeActions({
      d: D,
      calendar: [],
      causes,
      bases: new Map(),
      status: candidate,
      open: [],
      closed: [],
      lastEscalated: new Map(),
    });
    expect(a.every((x) => x.kind === "escalate")).toBe(true);
    expect(a).toHaveLength(3);
  });
});

describe("words and names", () => {
  it("plain names, no ids or dates in any line", () => {
    expect(measureName("A-D2-07")).toBe("heavy trading without news");
    expect(measureName("A-D1-01")).toMatch(/^[a-z0-9]/);
    expect(measureName("A-D1-01")).not.toContain("(");
    expect(measureName("A-D9-99")).toBe("an unnamed measure");
    const syn = { ...(angleById("A-D1-01") as AngleDef), id: "A-D1-55", title: "ZZ Wave (test)" };
    expect(measureName("A-D1-55", [syn])).toBe("zZ Wave");
    const t = recurringCauses(nights({ volume_no_news: 1 }))[0]!;
    const lines = [
      probeOpenWords("F1", "A-D2-07", t),
      escalateWords({ cause: "stock_specific", nights: 9, movers: 30 }),
      escalateWords({ cause: "other", nights: 9, movers: 30 }),
      ...(["futile", "expired", "promoted", "base_has_it"] as const).map((r) =>
        probeCloseWords("F1", "A-D2-07", r),
      ),
    ];
    for (const l of lines) expect(cleanWords(l), l).toBe(true);
    expect(lines[1]).toContain("A new measure is needed for moves that neither news");
  });

  it("sessionsSince", () => {
    expect(sessionsSince("2026-11-09", "2026-11-09", [])).toBe(0);
    expect(sessionsSince("2026-11-09", "2026-11-02", [])).toBe(0);
    expect(sessionsSince("2026-11-02", "2026-11-09", [])).toBe(5);
  });
});
