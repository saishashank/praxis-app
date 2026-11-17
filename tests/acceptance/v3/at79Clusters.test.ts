// @vitest-environment node
// AT-79 (M22 E4; KB-085, D-1436...D-1438): every one of 57 fixture clusters is reported either expressed (a schema-v2
// rule with an exit from the fixed menu and a pre-registration text) or parked with one of the six reasons; the target of
// 20 expressed is REPORTED (a shortfall comes with its reasons and never fails the check). Each expressed rule also
// evaluates end to end over a synthetic tier. All data synthetic ZZ (SEC-110).
import { describe, expect, it } from "vitest";
import {
  validateExpressedRule,
  validateExpressionExit,
  type ExpressedRule,
  type ExpressionExit,
} from "@/lib/agents/families/ruleSchema";
import { evaluateExpressed, type RuleDataSource } from "@/lib/experts/ruleEval";
import {
  checkExpressions,
  targetReport,
  TARGET_EXPRESSED,
} from "../../../scripts/experts/express-check.mjs";
import { PARK_REASONS, validateExpressions } from "../../../scripts/experts/validate.mjs";

const schema = { validateExpressedRule, validateExpressionExit };
const CLUSTERS = 57;
const id = (i: number): string => `K-ZZ${String(i).padStart(3, "0")}`;

type Entry = Record<string, unknown>;
// the three new node kinds, a v1 count_of and a plain condition, each used by a share of the expressed clusters
const RULES: unknown[] = [
  { rel_sector: { field: "rsi14", op: "<", value: -5 } },
  { persist: { n: 3, m: 5, when: { field: "close_above_sma5", op: "==", value: true } } },
  { ratio: { num: "volume_ratio", den: "rsi14", op: ">=", value: 0.1 } },
  {
    count_of: {
      n: 2,
      items: [
        { field: "rsi2", op: "<", value: 10 },
        { field: "rsi14", op: "<", value: 30 },
      ],
    },
  },
  { field: "rsi2", op: "<", value: 10 },
];
const EXITS: ExpressionExit[] = [
  { family: "F1", kind: "hold", sessions: 5 },
  { family: "F2", kind: "family", max_sessions: 20 },
];

/** `expressed` clusters expressed (rotating rules and exits), the rest parked with rotating reasons. */
function fixture(expressed: number): { clusters: Entry[]; expressions: Entry[] } {
  const clusters: Entry[] = [];
  const expressions: Entry[] = [];
  for (let i = 1; i <= CLUSTERS; i += 1) {
    clusters.push({ id: id(i), testability: "testable_eod", family_fit: null });
    if (i <= expressed) {
      expressions.push({
        cluster_id: id(i),
        outcome: "expressed",
        rule: { schema_version: 2, entry: RULES[i % RULES.length] },
        exit: EXITS[i % EXITS.length],
        preregistration: `ZZ pre-registration ${i}`,
        reason: `ZZ expressed ${i}`,
      });
    } else {
      expressions.push({
        cluster_id: id(i),
        outcome: "parked",
        park_reason: PARK_REASONS[(i - expressed) % PARK_REASONS.length],
        reason: `ZZ parked ${i}`,
      });
    }
  }
  return { clusters, expressions };
}

const data = (f: ReturnType<typeof fixture>) => ({
  "clusters.json": { clusters: f.clusters },
  "expressions.json": { expressions: f.expressions },
});

describe("AT-79: each of 57 clusters is expressed or parked with its reason", () => {
  it("every cluster lands in exactly one outcome, none is left unaddressed, every expression is valid", () => {
    const f = fixture(24);
    expect(validateExpressions({ expressions: f.expressions })).toEqual([]);
    const r = checkExpressions(data(f), schema);
    expect(r.errors).toEqual([]);
    expect(r.total).toBe(CLUSTERS);
    const parked = Object.values(r.parked).flat();
    expect(r.expressed.length + parked.length).toBe(CLUSTERS);
    expect(r.unaddressed).toEqual([]);
    expect(new Set([...r.expressed, ...parked]).size).toBe(CLUSTERS);
    // every parked cluster carries one of the six reasons of D-1438
    expect(Object.keys(r.parked).sort()).toEqual([...PARK_REASONS].sort());
    for (const reason of PARK_REASONS) expect(r.parked[reason]!.length, reason).toBeGreaterThan(0);
  });

  it("the target of 20 is met with 24 expressed", () => {
    const rep = targetReport(checkExpressions(data(fixture(24)), schema));
    expect(rep).toMatchObject({ target: TARGET_EXPRESSED, expressed: 24, met: true, shortfall: 0 });
  });

  it("a shortfall is reported with its reasons and does not fail the check", () => {
    const r = checkExpressions(data(fixture(12)), schema);
    expect(r.errors).toEqual([]); // not an error
    const rep = targetReport(r);
    expect(rep.met).toBe(false);
    expect(rep.shortfall).toBe(TARGET_EXPRESSED - 12);
    expect(Object.values(rep.reasons).reduce((a, b) => a + b, 0)).toBe(CLUSTERS - 12);
    expect(Object.keys(rep.reasons).every((k) => (PARK_REASONS as string[]).includes(k))).toBe(
      true,
    );
  });

  it("a cluster left without an expression is reported as not yet addressed, not as a pass", () => {
    const f = fixture(24);
    f.expressions.pop();
    const r = checkExpressions(data(f), schema);
    expect(r.unaddressed).toEqual([id(CLUSTERS)]);
    expect(targetReport(r).unaddressed).toBe(1);
  });
});

describe("AT-79: each expressed rule evaluates end to end", () => {
  it("every rule and exit of the fixture runs over a synthetic tier without error", () => {
    const sessions = Array.from(
      { length: 80 },
      (_, i) => `2030-01-${String(i + 1).padStart(3, "0")}`,
    );
    const index = new Map(sessions.map((d, i) => [d, i]));
    const bool = new Set(["close_above_sma5"]);
    const source: RuleDataSource = {
      codes: () => ["ZZA", "ZZB", "ZZC"],
      sector: (c) => (c === "ZZC" ? "s2" : "s1"),
      field: (c, field, d) => {
        const i = index.get(d)!;
        if (bool.has(field)) return (i + c.length + c.charCodeAt(2)) % 3 !== 0;
        return 5 + ((i * 7 + c.charCodeAt(2) * 3) % 50);
      },
      close: (c, d) => 100 + 0.1 * index.get(d)! + (c === "ZZA" ? 1 : 0),
      control: () => 0.001,
    };
    const f = fixture(24);
    let withRows = 0;
    for (const e of f.expressions.filter((x) => x.outcome === "expressed")) {
      const rows = evaluateExpressed(
        e.rule as ExpressedRule,
        e.exit as ExpressionExit,
        sessions,
        source,
      );
      expect(rows.every((r) => Number.isFinite(r.net) && r.exitD > r.entryD)).toBe(true);
      if (rows.length > 0) withRows += 1;
    }
    expect(withRows).toBeGreaterThan(10);
  });
});
