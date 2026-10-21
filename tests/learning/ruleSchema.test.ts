// @vitest-environment node
// Rule schema v1 (KB-010, M6 T2): every family F1-F6 is expressible and valid, unknown fields,
// operators and keys are rejected, parameter references stay within their ch.15 bounds, AND and OR
// are never mixed at one level, the spec literals equal the registry's fixed keys, and
// docs/rule_schema.md is exactly what the generator writes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_SPEC_KEYS,
  FAMILY_PARAM_KEYS,
  FAMILY_SPECS,
  RULE_FIELDS,
  RULE_OPERATORS,
  paramBounds,
  renderRuleSchemaDoc,
  ruleSpecJson,
  validateRuleSpec,
} from "@/lib/agents/families/ruleSchema";
import type { Family } from "@/lib/agents/schema";
import { CONFIG_KEYS } from "@/lib/config/keys";
import { ROOT } from "../db/helpers";

const FAMILIES: Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
const defaults = (f: Family): Record<string, unknown> =>
  Object.fromEntries(
    FAMILY_PARAM_KEYS[f].map((k) => [
      k,
      (CONFIG_KEYS as Record<string, { default: unknown }>)[k].default,
    ]),
  );
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("rule schema: the six families", () => {
  for (const f of FAMILIES) {
    it(`${f}: the v1 spec conforms and its registry defaults are within bounds`, () => {
      expect(validateRuleSpec(FAMILY_SPECS[f])).toEqual([]);
      expect(validateRuleSpec(FAMILY_SPECS[f], defaults(f))).toEqual([]);
      expect(JSON.parse(ruleSpecJson(f))).toEqual(FAMILY_SPECS[f]);
    });
  }

  it("the declared parameters are exactly the Lane-B keys of ch.15 section 15.3, each in at least one family", () => {
    const bKeys = Object.entries(CONFIG_KEYS)
      .filter(([, d]) => d.editable === "B")
      .map(([k]) => k)
      .sort();
    expect([...ALL_SPEC_KEYS].sort()).toEqual(bKeys);
    for (const f of FAMILIES) {
      const prefix = `${f.toLowerCase()}_`;
      const own = bKeys.filter((k) => k.startsWith(prefix));
      for (const k of own) expect(FAMILY_PARAM_KEYS[f], `${f} ${k}`).toContain(k);
      expect(FAMILY_PARAM_KEYS[f]).toContain("reentry_block");
    }
    expect(FAMILY_PARAM_KEYS.F6).toContain("insider_score_weights");
    expect(FAMILY_PARAM_KEYS.F6).toContain("insider_window_sessions");
  });

  it("every family key referenced by a condition is referenced (no family key is dead weight in the entry or exits)", () => {
    for (const f of FAMILIES) {
      const text = JSON.stringify(FAMILY_SPECS[f].actions);
      const used = FAMILY_PARAM_KEYS[f].filter((k) => text.includes(`"${k}"`));
      const own = FAMILY_PARAM_KEYS[f].filter((k) => k.startsWith(`${f.toLowerCase()}_`));
      for (const k of own) expect(used, `${f} ${k}`).toContain(k);
    }
  });

  it("literals in the specs equal the registry's fixed keys", () => {
    const f2 = JSON.stringify(FAMILY_SPECS.F2.actions);
    expect(f2).toContain('"field":"net_debt_ebitda","op":"<","value":2');
    const f5 = FAMILY_SPECS.F5.actions.find((a) => a.action === "exit" && a.id === "volume-dry-up");
    expect(f5).toMatchObject({
      when: { field: "volume_ratio_dry_up_sessions", op: ">=", value: 3 },
    });
    expect(CONFIG_KEYS.f5_dry_up_sessions.default).toBe(3);
  });

  it("the specs say what spec 07 section 7.4 says: universe, gate and exits", () => {
    expect(FAMILY_SPECS.F1.universe).toEqual(["U1", "U2"]);
    expect(FAMILY_SPECS.F4.universe).toEqual(["U1"]);
    expect(FAMILY_SPECS.F5.universe).toEqual(["U2", "U3"]);
    const gate = (f: Family) => JSON.stringify(FAMILY_SPECS[f].actions[0]);
    // F4 blocks only the warm-up state; F2/F3 also allow RISK-OFF; F1/F5/F6 block RISK-OFF and SHOCK
    expect(gate("F4")).toContain('"RISK-OFF"');
    expect(gate("F2")).toContain('"RISK-OFF"');
    expect(gate("F1")).not.toContain('"RISK-OFF"');
    expect(gate("F1")).not.toContain('"SHOCK"');
    expect(gate("F2")).not.toContain('"SHOCK"');
    expect(FAMILY_SPECS.F4.actions.find((a) => a.action === "size")).toMatchObject({
      half_size_regimes: ["SHOCK"],
    });
    const exits = (f: Family) =>
      FAMILY_SPECS[f].actions
        .filter((a) => a.action === "exit")
        .map((a) => (a.action === "exit" ? `${a.kind}:${a.id}` : ""));
    expect(exits("F1")).toEqual([
      "IS:initial-stop",
      "IS:trailing-stop",
      "CS:slow-gain",
      "CS:max-hold",
    ]);
    expect(exits("F6")).toContain("CS:contributing-exit");
    // F6 consensus: count_of with the n parameter plus the (a)-or-(b) requirement
    expect(JSON.stringify(FAMILY_SPECS.F6.actions)).toContain(
      '"count_of":{"n":{"param":"f6_min_classes"}',
    );
  });
});

describe("rule schema: rejections at load", () => {
  const f1 = () =>
    clone(FAMILY_SPECS.F1) as unknown as Record<string, unknown> & {
      actions: { when: unknown }[];
      params: string[];
    };
  const enterOf = (s: ReturnType<typeof f1>) =>
    s.actions.find((a) => (a as unknown as { action: string }).action === "enter") as unknown as {
      when: { items: Record<string, unknown>[] };
    };

  it("rejects an unknown field", () => {
    const s = f1();
    enterOf(s).when.items[1] = { field: "price_to_dreams", op: ">=", value: 1 };
    expect(validateRuleSpec(s)).toEqual([expect.stringContaining("unknown field price_to_dreams")]);
  });

  it("rejects an unknown operator, and crosses_* on a non-numeric field", () => {
    const s = f1();
    enterOf(s).when.items[1] = { field: "volume_ratio", op: "approx", value: 1 };
    expect(validateRuleSpec(s)).toEqual([expect.stringContaining("unknown operator approx")]);
    const t = f1();
    enterOf(t).when.items[3] = { field: "adv_filter_ok", op: "crosses_above", value: true };
    expect(validateRuleSpec(t).join()).toContain("needs a numeric field");
    for (const op of RULE_OPERATORS) {
      const u = f1();
      enterOf(u).when.items[1] = { field: "volume_ratio", op, value: 1 };
      expect(validateRuleSpec(u), op).toEqual([]);
    }
  });

  it("rejects wrong value types and a condition with both or neither of value and param", () => {
    const s = f1();
    enterOf(s).when.items[1] = { field: "volume_ratio", op: ">=", value: "high" };
    expect(validateRuleSpec(s).join()).toContain("compares with a number");
    const t = f1();
    enterOf(t).when.items[3] = { field: "adv_filter_ok", op: "==", value: 1 };
    expect(validateRuleSpec(t).join()).toContain("true or false");
    const u = f1();
    enterOf(u).when.items[1] = {
      field: "volume_ratio",
      op: ">=",
      value: 1,
      param: "f1_volume_ratio_min",
    };
    expect(validateRuleSpec(u).join()).toContain("exactly field, op");
    const v = f1();
    enterOf(v).when.items[1] = { field: "volume_ratio", op: ">=" };
    expect(validateRuleSpec(v).join()).toContain("exactly field, op");
  });

  it("rejects a param reference that is undeclared, unknown or unbounded", () => {
    const s = f1();
    enterOf(s).when.items[1] = { field: "volume_ratio", op: ">=", param: "f2_stop_atr" };
    expect(validateRuleSpec(s).join()).toContain("not declared");
    const t = f1();
    t.params = [...t.params, "alpha"];
    enterOf(t).when.items[1] = { field: "volume_ratio", op: ">=", param: "alpha" };
    const errs = validateRuleSpec(t).join();
    expect(errs).toContain("alpha is not a Lane-B key");
  });

  it("rejects parameter values outside the ch.15 bounds, accepts the bounds themselves", () => {
    const base = defaults("F1");
    const [lo, hi] = paramBounds("f1_volume_ratio_min")!;
    expect(validateRuleSpec(FAMILY_SPECS.F1, { ...base, f1_volume_ratio_min: lo })).toEqual([]);
    expect(validateRuleSpec(FAMILY_SPECS.F1, { ...base, f1_volume_ratio_min: hi })).toEqual([]);
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, { ...base, f1_volume_ratio_min: hi + 0.1 }).join(),
    ).toContain("outside bounds");
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, { ...base, f1_volume_ratio_min: lo - 0.1 }).join(),
    ).toContain("outside bounds");
    expect(
      validateRuleSpec(FAMILY_SPECS.F1, { ...base, f1_volume_ratio_min: "1.5" }).join(),
    ).toContain("no numeric value");
  });

  it("rejects a group that mixes logic or has extra keys, and an empty group", () => {
    const s = f1();
    enterOf(s).when = { logic: "AND", items: [], extra: 1 } as never;
    expect(validateRuleSpec(s).join()).toContain("exactly logic and items");
    const t = f1();
    (enterOf(t).when as unknown as Record<string, unknown>).or = [];
    expect(validateRuleSpec(t).join()).toContain("never mixed");
    const u = f1();
    enterOf(u).when = { logic: "AND", items: [] } as never;
    expect(validateRuleSpec(u).join()).toContain("at least one item");
    const v = f1();
    enterOf(v).when = {
      logic: "XOR",
      items: [{ field: "volume_ratio", op: ">", value: 1 }],
    } as never;
    expect(validateRuleSpec(v).join()).toContain("AND or OR");
  });

  it("count_of: n within 1..items, or a bounded param; only conditions inside", () => {
    const f6 = () =>
      clone(FAMILY_SPECS.F6) as unknown as {
        actions: { when: { items: { count_of: { n: unknown; items: unknown[] } }[] } }[];
      };
    const countOf = (s: ReturnType<typeof f6>) => s.actions[1]!.when.items[0]!.count_of;
    const a = f6();
    countOf(a).n = 0;
    expect(validateRuleSpec(a).join()).toContain("whole number from 1");
    const b = f6();
    countOf(b).n = 5;
    expect(validateRuleSpec(b).join()).toContain("whole number from 1");
    const c = f6();
    countOf(c).n = 2;
    expect(validateRuleSpec(c)).toEqual([]);
    const d = f6();
    countOf(d).items[0] = { logic: "AND", items: [] };
    expect(validateRuleSpec(d).join()).toContain("conditions only");
    expect(
      validateRuleSpec(FAMILY_SPECS.F6, { ...defaults("F6"), f6_min_classes: 5 }).join(),
    ).toContain("outside bounds");
  });

  it("rejects bad top-level shape, actions, universe, family, rank and counts of enter/size", () => {
    expect(validateRuleSpec(null)).toEqual(["spec must be an object"]);
    expect(validateRuleSpec({}).join()).toContain("exactly schema_version");
    const s = f1() as unknown as Record<string, unknown>;
    s.family = "F9";
    expect(validateRuleSpec(s).join()).toContain("unknown family");
    const t = f1() as unknown as Record<string, unknown>;
    t.universe = ["U9"];
    expect(validateRuleSpec(t).join()).toContain("universe");
    const u = f1() as unknown as Record<string, unknown>;
    u.rank = { field: "nope", order: "up" };
    expect(validateRuleSpec(u).join()).toContain("rank: unknown field nope");
    const v = f1();
    v.actions = v.actions.filter((a) => (a as unknown as { action: string }).action !== "enter");
    expect(validateRuleSpec(v).join()).toContain("exactly one enter");
    const w = f1();
    w.actions.push({ action: "teleport" } as never);
    expect(validateRuleSpec(w).join()).toContain("unknown action teleport");
    const x = f1();
    x.actions = x.actions.filter((a) => (a as unknown as { action: string }).action !== "size");
    expect(validateRuleSpec(x).join()).toContain("exactly one size");
    const y = f1() as unknown as Record<string, unknown>;
    y.schema_version = 2;
    expect(validateRuleSpec(y).join()).toContain("schema_version");
  });

  it("a spec with a missing or extra family key is rejected", () => {
    const s = f1();
    s.params = s.params.filter((k) => k !== "f1_trail_atr");
    expect(validateRuleSpec(s).join()).toContain("missing f1_trail_atr");
    const t = f1();
    t.params = [...t.params, "f2_stop_atr"];
    expect(validateRuleSpec(t).join()).toContain("not a key of F1");
  });

  it("nesting deeper than 6 levels is refused", () => {
    let node: unknown = { field: "volume_ratio", op: ">", value: 1 };
    for (let i = 0; i < 8; i += 1) node = { logic: "AND", items: [node] };
    const s = f1();
    enterOf(s).when = node as never;
    expect(validateRuleSpec(s).join()).toContain("nested more than 6");
  });
});

describe("rule schema: vocabulary and the generated reference", () => {
  it("the field vocabulary is unique and enumerated types are complete", () => {
    const names = RULE_FIELDS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of RULE_FIELDS)
      if (f.type === "enum") expect((f.values ?? []).length, f.name).toBeGreaterThan(1);
  });

  it("docs/rule_schema.md is exactly the generated text", () => {
    const file = readFileSync(path.join(ROOT, "docs", "rule_schema.md"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(file).toBe(renderRuleSchemaDoc());
  });
});
