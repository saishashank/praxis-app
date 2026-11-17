// @vitest-environment node
// Expressed-rule evaluator (M22 E4; KB-085, D-1436, D-1437): hand-checked entries over a small synthetic tier. Each
// case states the answer worked out by hand. Synthetic ZZ codes only.
import { describe, expect, it } from "vitest";
import type { ExpressedRule, ExpressionExit } from "@/lib/agents/families/ruleSchema";
import { evaluateExpressed, type FieldValue, type RuleDataSource } from "@/lib/experts/ruleEval";

const days = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `2030-02-${String(i + 1).padStart(2, "0")}`);

type Series = Record<string, readonly FieldValue[]>;
type World = {
  readonly fields: Record<string, Series>; // code -> field -> per session
  readonly closes: Record<string, readonly number[]>;
  readonly sectors: Record<string, string | null>;
  readonly control?: number | null;
};

function source(sessions: readonly string[], w: World): RuleDataSource {
  const idx = new Map(sessions.map((d, i) => [d, i]));
  return {
    codes: () => Object.keys(w.closes),
    field: (code, field, d) => w.fields[code]?.[field]?.[idx.get(d)!] ?? null,
    sector: (code) => w.sectors[code] ?? null,
    close: (code, d) => w.closes[code]?.[idx.get(d)!] ?? null,
    control: () => (w.control === undefined ? null : w.control),
  };
}
const rule = (entry: unknown): ExpressedRule => ({ schema_version: 2, entry }) as ExpressedRule;
const hold = (n: number): ExpressionExit => ({ family: "F1", kind: "hold", sessions: n });
const flat = (n: number, v = 100): number[] => Array.from({ length: n }, () => v);
const fill = (n: number, v: FieldValue): FieldValue[] => Array.from({ length: n }, () => v);
const at = (n: number, base: FieldValue, hits: Record<number, FieldValue>): FieldValue[] =>
  fill(n, base).map((v, i) => (i in hits ? hits[i]! : v));

const N = 12;
const S = days(N);

describe("entry, hold exit, net and excess", () => {
  it("enters at the close of the signal session and exits at the close n sessions later", () => {
    const closes = [100, 100, 100, 101, 102, 103, 104, 104, 104, 104, 104, 104];
    const w: World = {
      fields: { ZZA: { rsi2: at(N, 50, { 2: 5 }) } },
      closes: { ZZA: closes },
      sectors: { ZZA: null },
      control: 0.01,
    };
    const rows = evaluateExpressed(
      rule({ field: "rsi2", op: "<", value: 10 }),
      hold(3),
      S,
      source(S, w),
    );
    // entry idx 2 at 100, exit idx 5 at 103: net 3 %, minus the 1 % control = 2 % excess
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: "ZZA", entryD: S[2], exitD: S[5], session: 2 });
    expect(rows[0]!.net).toBeCloseTo(0.03, 12);
    expect(rows[0]!.excess).toBeCloseTo(0.02, 12);
  });

  it("holds one position per code: a signal inside the hold is ignored, the next after the exit is taken", () => {
    const w: World = {
      fields: { ZZA: { rsi2: at(N, 50, { 2: 5, 3: 5, 6: 5 }) } },
      closes: { ZZA: [100, 100, 100, 100, 100, 100, 100, 100, 100, 110, 110, 110] },
      sectors: { ZZA: null },
    };
    const rows = evaluateExpressed(
      rule({ field: "rsi2", op: "<", value: 10 }),
      hold(3),
      S,
      source(S, w),
    );
    // idx 2 -> exit 5 (idx 3 ignored); idx 6 -> exit 9 at 110: net 10 %; no control: excess null
    expect(rows.map((r) => [r.session, r.exitD])).toEqual([
      [2, S[5]],
      [6, S[9]],
    ]);
    expect(rows[1]!.net).toBeCloseTo(0.1, 12);
    expect(rows[1]!.excess).toBeNull();
  });

  it("drops a position that cannot close inside the handed sessions (never carried past the window)", () => {
    const w: World = {
      fields: { ZZA: { rsi2: at(N, 50, { 8: 5, 9: 5 }) } },
      closes: { ZZA: flat(N) },
      sectors: { ZZA: null },
    };
    const entry = rule({ field: "rsi2", op: "<", value: 10 });
    // idx 8 + 3 = 11 closes on the last session; idx 9 + 3 = 12 does not exist
    expect(evaluateExpressed(entry, hold(3), S, source(S, w)).map((r) => r.session)).toEqual([8]);
    expect(evaluateExpressed(entry, hold(4), S, source(S, w))).toEqual([]);
  });

  it("skips a code with no entry close and visits codes in sorted order", () => {
    const f = { rsi2: at(N, 50, { 1: 5 }) };
    const w: World = {
      fields: { ZZB: f, ZZA: f, ZZC: f },
      closes: { ZZB: flat(N), ZZA: flat(N), ZZC: flat(N).map((v, i) => (i === 1 ? 0 : v)) },
      sectors: {},
    };
    const rows = evaluateExpressed(
      rule({ field: "rsi2", op: "<", value: 10 }),
      hold(2),
      S,
      source(S, w),
    );
    expect(rows.map((r) => r.code)).toEqual(["ZZA", "ZZB"]);
  });
});

describe("the conditions of v1 that stay", () => {
  it("compares with each operator; a missing value is false", () => {
    const w: World = {
      fields: { ZZA: { rsi2: at(N, null, { 1: 10, 2: 20, 3: 30 }) } },
      closes: { ZZA: flat(N) },
      sectors: {},
    };
    const hit = (op: string, value: number): number[] =>
      evaluateExpressed(rule({ field: "rsi2", op, value }), hold(1), S, source(S, w)).map(
        (r) => r.session,
      );
    expect(hit("<", 20)).toEqual([1]);
    expect(hit("<=", 20)).toEqual([1]); // idx 1 enters and exits at idx 2; the next look is idx 3 (30 is not <= 20)
    expect(hit(">", 10)).toEqual([2]);
    expect(hit("==", 30)).toEqual([3]);
  });

  it("crosses_above and crosses_below need the previous session", () => {
    const w: World = {
      fields: { ZZA: { rsi2: at(N, null, { 0: 40, 1: 25, 2: 35, 3: 20, 4: 22 }) } },
      closes: { ZZA: flat(N) },
      sectors: {},
    };
    const hit = (op: string): number[] =>
      evaluateExpressed(rule({ field: "rsi2", op, value: 30 }), hold(1), S, source(S, w)).map(
        (r) => r.session,
      );
    expect(hit("crosses_above")).toEqual([2]); // 25 -> 35
    expect(hit("crosses_below")).toEqual([1, 3]); // 40 -> 25, then 35 -> 20 (idx 0 has no previous)
  });

  it("AND, OR and count_of", () => {
    const w: World = {
      fields: {
        ZZA: {
          rsi2: at(N, 50, { 2: 5, 5: 5 }),
          close_above_sma5: at(N, false, { 2: true, 8: true }),
        },
      },
      closes: { ZZA: flat(N) },
      sectors: {},
    };
    const a = { field: "rsi2", op: "<", value: 10 };
    const b = { field: "close_above_sma5", op: "==", value: true };
    const hit = (entry: unknown): number[] =>
      evaluateExpressed(rule(entry), hold(1), S, source(S, w)).map((r) => r.session);
    expect(hit({ logic: "AND", items: [a, b] })).toEqual([2]);
    expect(hit({ logic: "OR", items: [a, b] })).toEqual([2, 5, 8]);
    expect(hit({ count_of: { n: 2, items: [a, b] } })).toEqual([2]);
    expect(hit({ count_of: { n: 1, items: [a, b] } })).toEqual([2, 5, 8]);
  });
});

describe("rel_sector: the field against its sector median", () => {
  const W = (values: Record<string, number>, sectors: Record<string, string | null>): World => ({
    fields: Object.fromEntries(
      Object.entries(values).map(([c, v]) => [c, { rsi14: at(N, v, {}) }]),
    ),
    closes: Object.fromEntries(Object.keys(values).map((c) => [c, flat(N)])),
    sectors,
  });
  const entry = rule({ rel_sector: { field: "rsi14", op: "<", value: -5 } });
  const codesHit = (w: World): string[] => [
    ...new Set(evaluateExpressed(entry, hold(1), S, source(S, w)).map((r) => r.code)),
  ];

  it("odd sector: median 40, so ZZA (30) is 10 below and the others are not", () => {
    const w = W(
      { ZZA: 30, ZZB: 40, ZZC: 50, ZZD: 10 },
      { ZZA: "s1", ZZB: "s1", ZZC: "s1", ZZD: "s2" },
    );
    expect(codesHit(w)).toEqual(["ZZA"]); // ZZD is alone in its sector: 10 - 10 = 0
  });

  it("even sector: the median is the mean of the middle two (45), so 30 is 15 below and 40 only 5 below", () => {
    const w = W(
      { ZZA: 30, ZZB: 40, ZZC: 50, ZZD: 60 },
      { ZZA: "s1", ZZB: "s1", ZZC: "s1", ZZD: "s1" },
    );
    expect(codesHit(w)).toEqual(["ZZA"]); // ZZB: 40 - 45 = -5, not < -5
    const loose = rule({ rel_sector: { field: "rsi14", op: "<=", value: -5 } });
    expect(new Set(evaluateExpressed(loose, hold(1), S, source(S, w)).map((r) => r.code))).toEqual(
      new Set(["ZZA", "ZZB"]),
    );
  });

  it("an unclassified code never matches, and a missing peer value is left out of the median", () => {
    const w = W({ ZZA: 30, ZZB: 40, ZZC: 50 }, { ZZA: null, ZZB: "s1", ZZC: "s1" });
    expect(codesHit(w)).toEqual([]); // ZZA unclassified; ZZB is 5 below the 45 median of ZZB and ZZC only
    w.fields.ZZC = { rsi14: fill(N, null) };
    expect(codesHit(w)).toEqual([]); // the median of ZZB alone is 40: 0 below
  });
});

describe("persist: true on at least n of the last m sessions", () => {
  const w: World = {
    fields: {
      ZZA: { close_above_sma5: at(N, false, { 1: true, 2: true, 4: true }) as FieldValue[] },
    },
    closes: { ZZA: flat(N) },
    sectors: {},
  };
  const when = { field: "close_above_sma5", op: "==", value: true };
  const hit = (n: number, m: number): number[] =>
    evaluateExpressed(rule({ persist: { n, m, when } }), hold(1), S, source(S, w)).map(
      (r) => r.session,
    );

  it("2 of 3: true at idx 2 (idx 2, 1, 0 = T, T, F) and again at idx 4 (T, F, T)", () => {
    // idx 1: sessions 1, 0 and one before the start = T, F: one hit, false. idx 2 enters (exit 3); idx 4 enters (exit 5).
    expect(hit(2, 3)).toEqual([2, 4]);
  });
  it("3 of 3 never holds here, 1 of 1 is the plain condition, 1 of 5 holds from the first hit on", () => {
    expect(hit(3, 3)).toEqual([]);
    expect(hit(1, 1)).toEqual([1, 4]); // idx 1 -> exit 2, idx 2 is inside it, idx 4 -> exit 5
    expect(hit(1, 5)).toEqual([1, 3, 5, 7]); // a hit stays in the 5-session window until idx 8 (the last hit is idx 4)
  });
  it("a persist over a ratio", () => {
    const w2: World = {
      fields: { ZZA: { rsi2: at(N, 10, { 3: 20, 4: 20 }), rsi14: fill(N, 40) } },
      closes: { ZZA: flat(N) },
      sectors: {},
    };
    const r = rule({
      persist: { n: 2, m: 2, when: { ratio: { num: "rsi2", den: "rsi14", op: ">=", value: 0.5 } } },
    });
    // 20 / 40 = 0.5 on idx 3 and 4 only: both of the last 2 at idx 4
    expect(evaluateExpressed(r, hold(1), S, source(S, w2)).map((x) => x.session)).toEqual([4]);
  });
});

describe("ratio: two series divided, compared with a value", () => {
  it("3 / 20 is 0.15 (>= 0.1); a zero or a missing denominator is false", () => {
    const w: World = {
      fields: {
        ZZA: {
          volume_ratio: at(N, 3, {}),
          rsi14: at(N, 20, { 5: 0, 7: null }),
        },
      },
      closes: { ZZA: flat(N) },
      sectors: {},
    };
    const r = rule({ ratio: { num: "volume_ratio", den: "rsi14", op: ">=", value: 0.1 } });
    const hit = evaluateExpressed(r, hold(1), S, source(S, w)).map((x) => x.session);
    expect(hit).not.toContain(5);
    expect(hit).not.toContain(7);
    expect(hit).toEqual([0, 2, 4, 6, 8, 10].filter((i) => i < N - 1));
  });
});

describe("the family exit (D-1437)", () => {
  const n = 60;
  const sessions = days(31).concat(days(29).map((d) => d.replace("-02-", "-03-")));
  const entry = rule({ field: "rsi2", op: "<", value: 10 });
  const fields = (): Series => ({ rsi2: at(n, 50, { 0: 5 }) });

  it("F1 slow-gain: at 40 sessions held with a gain under 5 % the position closes on that session", () => {
    const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.05); // +2 % after 40 sessions
    const w: World = { fields: { ZZA: fields() }, closes: { ZZA: closes }, sectors: {} };
    const rows = evaluateExpressed(
      entry,
      { family: "F1", kind: "family", max_sessions: 100 },
      sessions,
      source(sessions, w),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exitD).toBe(sessions[40]);
    expect(rows[0]!.net).toBeCloseTo(closes[40]! / 100 - 1, 12);
  });

  it("max_sessions forces the close", () => {
    const w: World = { fields: { ZZA: fields() }, closes: { ZZA: flat(n) }, sectors: {} };
    const rows = evaluateExpressed(
      entry,
      { family: "F1", kind: "family", max_sessions: 10 },
      sessions,
      source(sessions, w),
    );
    expect(rows[0]).toMatchObject({ exitD: sessions[10], net: 0 });
  });

  it("a gain of 5 % or more by session 40 keeps the position; with no other exit and no cap in the window it is dropped", () => {
    const closes = Array.from({ length: n }, (_, i) => (i < 20 ? 100 : 106));
    const w: World = { fields: { ZZA: fields() }, closes: { ZZA: closes }, sectors: {} };
    expect(
      evaluateExpressed(
        entry,
        { family: "F1", kind: "family", max_sessions: 100 },
        sessions,
        source(sessions, w),
      ),
    ).toEqual([]);
  });

  it("an exit that reads a field the source does not have is false, not an error", () => {
    const closes = Array.from({ length: n }, (_, i) => 100 - i * 0.01);
    const w: World = { fields: { ZZA: fields() }, closes: { ZZA: closes }, sectors: {} };
    expect(() =>
      evaluateExpressed(
        entry,
        { family: "F2", kind: "family", max_sessions: 5 },
        sessions,
        source(sessions, w),
      ),
    ).not.toThrow();
  });
});

describe("determinism", () => {
  it("the same input gives the same rows", () => {
    const w: World = {
      fields: { ZZA: { rsi2: at(N, 50, { 2: 5, 7: 5 }) }, ZZB: { rsi2: at(N, 50, { 3: 5 }) } },
      closes: { ZZA: flat(N), ZZB: flat(N) },
      sectors: {},
    };
    const r = rule({ field: "rsi2", op: "<", value: 10 });
    expect(evaluateExpressed(r, hold(2), S, source(S, w))).toEqual(
      evaluateExpressed(r, hold(2), S, source(S, w)),
    );
  });
});
