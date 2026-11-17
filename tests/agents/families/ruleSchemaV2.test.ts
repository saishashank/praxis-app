// @vitest-environment node
// Rule schema v2 (M22 E4; KB-085, D-1436): the three new node kinds are accepted and refused where they should be,
// a family rule stays schema v1 (v2 refused; FAMILY_SPECS byte-equal to their pre-M22 form), an expert rule is v1 or v2,
// and docs/rule_schema.md carries a v2 section. Synthetic rules only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FAMILY_SPECS,
  RULE_NODE_KINDS_V2,
  RULE_SCHEMA_VERSION,
  RULE_SCHEMA_VERSION_V2,
  renderRuleSchemaDoc,
  ruleSpecJson,
  validateExpressedRule,
  validateExpressionExit,
  validateRuleForRole,
  validateRuleSpec,
} from "@/lib/agents/families/ruleSchema";
import type { Family } from "@/lib/agents/schema";
import { ROOT } from "../../db/helpers";

const FAMILIES: Family[] = ["F1", "F2", "F3", "F4", "F5", "F6"];
const rule = (entry: unknown) => ({ schema_version: 2, entry });
const lit = { field: "close_above_sma5", op: "==", value: true };

// sha256 of ruleSpecJson(family) before M22: the family rule table is not allowed to move (D-1436)
const FAMILY_SPEC_SHA: Record<Family, string> = {
  F1: "a999a948582ab8fa7a4ac75696daae88517848cf713d2fdd319fa86721624821",
  F2: "b573acbe43596ac674c323145d2f7878a656abd669aed3a492c940df9c2c1448",
  F3: "f2d3b5f42fc7e1cf75e1854a5b5331d5891bd324322ca7617da5ff0aca00ee04",
  F4: "09f569376c19aae87691c2b73c8e96c4333d0995a2bcbefc79d0e2232fc5f5a6",
  F5: "e5535dad2afbf69eeb127f6ec1c3fb11dfd90ad44012080d6dae24f2d08fdaf2",
  F6: "d71648d8bf20909c3cd92dfdada86538a58178a5d8915e7d67548e4d6a6d1c6f",
};

describe("schema v2: the three node kinds", () => {
  it("the version constants and the node kinds", () => {
    expect(RULE_SCHEMA_VERSION).toBe(1);
    expect(RULE_SCHEMA_VERSION_V2).toBe(2);
    expect([...RULE_NODE_KINDS_V2]).toEqual(["rel_sector", "persist", "ratio"]);
  });

  it("accepts rel_sector, persist and ratio, alone and inside groups and count_of", () => {
    const nodes = [
      { rel_sector: { field: "rsi14", op: "<", value: -5 } },
      { ratio: { num: "volume_ratio", den: "rsi14", op: ">=", value: 0.05 } },
      { persist: { n: 3, m: 5, when: lit } },
      { persist: { n: 2, m: 2, when: { rel_sector: { field: "rsi2", op: ">", value: 0 } } } },
      {
        persist: { n: 1, m: 4, when: { ratio: { num: "rsi2", den: "rsi14", op: "<", value: 1 } } },
      },
      {
        logic: "AND",
        items: [
          lit,
          { rel_sector: { field: "rsi14", op: "<=", value: 0 } },
          { logic: "OR", items: [lit] },
        ],
      },
      { count_of: { n: 2, items: [lit, { field: "rsi2", op: "<", value: 10 }] } },
      lit,
    ];
    for (const n of nodes) expect(validateExpressedRule(rule(n)), JSON.stringify(n)).toEqual([]);
  });

  it("refuses what the grammar does not allow, naming the node", () => {
    const bad: [string, unknown, string][] = [
      [
        "a param reference",
        { field: "rsi2", op: "<", param: "f1_trail_atr" },
        "exactly field, op and value",
      ],
      [
        "an unknown field",
        { rel_sector: { field: "price_to_dreams", op: "<", value: 1 } },
        "unknown field",
      ],
      [
        "a boolean field in rel_sector",
        { rel_sector: { field: "close_above_sma5", op: "<", value: 1 } },
        "numeric",
      ],
      ["a position field", { field: "sessions_held", op: ">=", value: 3 }, "position field"],
      [
        "a crossing operator in rel_sector",
        { rel_sector: { field: "rsi2", op: "crosses_above", value: 1 } },
        "op is one of",
      ],
      [
        "a non-numeric ratio value",
        { ratio: { num: "rsi2", den: "rsi14", op: "<", value: "1" } },
        "value is a number",
      ],
      [
        "a ratio over a boolean",
        { ratio: { num: "close_above_sma5", den: "rsi14", op: "<", value: 1 } },
        "numeric",
      ],
      [
        "a ratio with extra keys",
        { ratio: { num: "rsi2", den: "rsi14", op: "<", value: 1, x: 1 } },
        "exactly",
      ],
      [
        "persist n above m",
        { persist: { n: 4, m: 3, when: lit } },
        "n is a whole number from 1 to m",
      ],
      ["persist m above the cap", { persist: { n: 1, m: 21, when: lit } }, "m is a whole number"],
      ["persist n zero", { persist: { n: 0, m: 3, when: lit } }, "n is a whole number"],
      [
        "persist over a group",
        { persist: { n: 1, m: 2, when: { logic: "AND", items: [lit] } } },
        "when is a condition",
      ],
      [
        "nested persist",
        { persist: { n: 1, m: 2, when: { persist: { n: 1, m: 2, when: lit } } } },
        "when is a condition",
      ],
      ["persist with a sibling key", { persist: { n: 1, m: 2, when: lit }, x: 1 }, "stands alone"],
      [
        "count_of over a rel_sector",
        { count_of: { n: 1, items: [{ rel_sector: { field: "rsi2", op: "<", value: 1 } }] } },
        "plain conditions",
      ],
      ["count_of n above the list", { count_of: { n: 3, items: [lit] } }, "n is a whole number"],
      ["an empty group", { logic: "AND", items: [] }, "at least one item"],
      ["a mixed group", { logic: "AND", items: [lit], extra: 1 }, "exactly logic and items"],
    ];
    for (const [name, node, msg] of bad) {
      const errs = validateExpressedRule(rule(node));
      expect(errs.length, name).toBeGreaterThan(0);
      expect(errs.join("|"), name).toContain(msg);
    }
  });

  it("a rule has exactly schema_version 2 and an entry, and nests at most six levels", () => {
    expect(validateExpressedRule({ schema_version: 2 })).toEqual([
      "rule has exactly schema_version and entry",
    ]);
    expect(validateExpressedRule({ schema_version: 1, entry: lit })).toEqual([
      "schema_version must be 2",
    ]);
    expect(validateExpressedRule(null)).toEqual(["rule must be an object"]);
    let deep: unknown = lit;
    for (let i = 0; i < 8; i += 1) deep = { logic: "AND", items: [deep] };
    expect(validateExpressedRule(rule(deep)).join()).toContain("nested more than");
  });
});

describe("schema v2: the exit menu (D-1437)", () => {
  it("accepts a hold and a capped family exit", () => {
    expect(validateExpressionExit({ family: "F1", kind: "hold", sessions: 10 })).toEqual([]);
    expect(validateExpressionExit({ family: "F4", kind: "family", max_sessions: 60 })).toEqual([]);
  });
  it("refuses an unknown family or kind, a missing or out-of-range number and extra keys", () => {
    const bad: unknown[] = [
      { family: "F9", kind: "hold", sessions: 5 },
      { family: "F1", kind: "trail", sessions: 5 },
      { family: "F1", kind: "hold" },
      { family: "F1", kind: "hold", sessions: 0 },
      { family: "F1", kind: "hold", sessions: 251 },
      { family: "F1", kind: "hold", sessions: 2.5 },
      { family: "F1", kind: "family", max_sessions: 0 },
      { family: "F1", kind: "family", sessions: 5 },
      { family: "F1", kind: "hold", sessions: 5, extra: true },
      "hold",
    ];
    for (const x of bad)
      expect(validateExpressionExit(x).length, JSON.stringify(x)).toBeGreaterThan(0);
  });
});

describe("the loader by role (D-1436)", () => {
  it("a family accepts v1 only: its own spec passes, a v2 rule is refused", () => {
    for (const f of FAMILIES) expect(validateRuleForRole("family", FAMILY_SPECS[f])).toEqual([]);
    expect(validateRuleForRole("family", rule(lit))).toEqual(["a family rule is schema v1"]);
    expect(validateRuleSpec(rule(lit)).length).toBeGreaterThan(0); // the v1 loader refuses it too
    expect(validateRuleSpec({ ...FAMILY_SPECS.F1, schema_version: 2 }).join()).toContain(
      "schema_version must be 1",
    );
  });
  it("an expert accepts a v1 spec or a v2 rule, and nothing else", () => {
    expect(validateRuleForRole("expert", FAMILY_SPECS.F2)).toEqual([]);
    expect(
      validateRuleForRole(
        "expert",
        rule({ ratio: { num: "rsi2", den: "rsi14", op: "<", value: 2 } }),
      ),
    ).toEqual([]);
    expect(validateRuleForRole("expert", { ...rule(lit), schema_version: 3 }).join()).toContain(
      "one of 1, 2",
    );
    expect(validateRuleForRole("expert", "x")).toEqual(["spec must be an object"]);
  });
  it("FAMILY_SPECS are byte-equal to their pre-M22 form and still schema_version 1", () => {
    for (const f of FAMILIES) {
      expect(FAMILY_SPECS[f].schema_version).toBe(1);
      expect(createHash("sha256").update(ruleSpecJson(f)).digest("hex"), f).toBe(
        FAMILY_SPEC_SHA[f],
      );
    }
  });
});

describe("docs/rule_schema.md", () => {
  it("documents both versions and is the generated text", () => {
    const doc = renderRuleSchemaDoc();
    expect(doc).toContain("## Schema v2: expert rules");
    for (const k of RULE_NODE_KINDS_V2) expect(doc).toContain(`\`${k}\``);
    const file = readFileSync(path.join(ROOT, "docs", "rule_schema.md"), "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(file).toBe(doc);
    // the v2 example in the document is itself a valid v2 rule
    const json = /## Schema v2[\s\S]*?```json\n([\s\S]*?)\n```/.exec(doc)![1]!;
    expect(validateExpressedRule(JSON.parse(json))).toEqual([]);
  });
});
