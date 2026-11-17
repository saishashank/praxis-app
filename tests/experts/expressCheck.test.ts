// @vitest-environment node
// scripts/experts/express-check.mjs (M22 E4; KB-085, D-1437): validates every expression of the private seed and prints
// counts and K-ids by outcome; never a name, a rule or a text; a shortfall against the target of 20 is reported, not an
// error. Synthetic ZZ seed only.
import { afterEach, describe, expect, it } from "vitest";
import { validateExpressedRule, validateExpressionExit } from "@/lib/agents/families/ruleSchema";
import { checkExpressions, run, TARGET_EXPRESSED } from "../../scripts/experts/express-check.mjs";
import { type SeedFiles, writeSeed } from "./zzSeed";
import { type SeedFilesV2, zzSeedV2 } from "./zzExpress";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const schema = { validateExpressedRule, validateExpressionExit };

async function go(files: SeedFilesV2, extra: string[] = []) {
  const a = writeSeed(files as unknown as SeedFiles);
  cleanups.push(a.cleanup);
  const lines: string[] = [];
  const code = await run(["--seed", a.dir, ...extra], {}, { out: (s) => lines.push(s), schema });
  return { code, text: lines.join("\n") };
}

describe("express-check", () => {
  it("prints the counts and the K-ids by outcome, reports the shortfall and exits 0", async () => {
    const r = await go(zzSeedV2());
    expect(r.code).toBe(0);
    expect(r.text).toContain("clusters 5; expressed 2; parked 2");
    expect(r.text).toContain('{"overlay_only":1,"not_testable":1}');
    expect(r.text).toContain("not yet addressed 1");
    expect(r.text).toContain(
      `target of ${TARGET_EXPRESSED} expressed: short by ${TARGET_EXPRESSED - 2}`,
    );
    expect(r.text).toContain("expressed: K-ZZ2 K-ZZ3");
    expect(r.text).toContain("parked overlay_only: K-ZZ4");
    expect(r.text).toContain("parked not_testable: K-ZZ5");
    expect(r.text).toContain("not yet addressed: K-ZZ1");
    // counts and ids only: no name, no rule, no text
    expect(r.text).not.toMatch(/ZZ cluster|rsi2|oscillator|pre-registration|schema_version/);
  });

  it("the newest version of a cluster decides its outcome", async () => {
    const f = zzSeedV2();
    f["expressions.json"].expressions.push({
      cluster_id: "K-ZZ2",
      version: 2,
      outcome: "parked",
      park_reason: "duplicate",
      reason: "ZZ same rule as another cluster",
    });
    const r = await go(f);
    expect(r.code).toBe(0);
    expect(r.text).toContain("expressed 1; parked 3");
    expect(r.text).toContain("parked duplicate: K-ZZ2");
  });

  it("meets the target when enough clusters are expressed", () => {
    const base = zzSeedV2();
    const clusters = Array.from({ length: 22 }, (_, i) => ({
      id: `K-${i + 1}`,
      testability: "testable_eod",
    }));
    const data = {
      "clusters.json": { clusters },
      "expressions.json": {
        expressions: clusters.map((k) => ({
          ...base["expressions.json"].expressions[0]!,
          cluster_id: k.id,
        })),
      },
    };
    const r = checkExpressions(data, schema);
    expect(r.errors).toEqual([]);
    expect(r.expressed).toHaveLength(22);
  });

  it("rejects an invalid rule or exit, naming the entry and the rule but never the value", async () => {
    const f = zzSeedV2();
    f["expressions.json"].expressions[0]!.rule = {
      schema_version: 2,
      entry: { rel_sector: { field: "price_to_dreams", op: "<", value: 1 } },
    };
    f["expressions.json"].expressions[1]!.exit = { family: "F1", kind: "hold", sessions: 0 };
    const r = await go(f);
    expect(r.code).toBe(1);
    expect(r.text).toContain(
      "expressions.json: expressions[0].rule: entry.rel_sector: unknown field",
    );
    expect(r.text).toContain(
      "expressions.json: expressions[1].exit: exit: sessions is a whole number",
    );
  });

  it("an expressed cluster must be end-of-day testable and carry a pre-registration text", async () => {
    const f = zzSeedV2();
    f["expressions.json"].expressions[0]!.cluster_id = "K-ZZ5"; // not testable
    f["expressions.json"].expressions.pop(); // its parked entry, so the cluster is not listed twice
    f["expressions.json"].expressions[1]!.preregistration = "   ";
    const r = await go(f);
    expect(r.code).toBe(1);
    expect(r.text).toContain(
      "expressions[0].cluster_id: an expressed cluster must be end-of-day testable",
    );
    expect(r.text).toContain("expressions[1].preregistration: text required");
  });

  it("refuses a seed folder inside the repository, a missing folder, no folder and a seed without expressions.json", async () => {
    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await run(["--seed", "tests/experts"], {}, { out, schema })).toBe(1);
    expect(lines.pop()).toMatch(/outside the repository/);
    expect(await run([], {}, { out, schema })).toBe(1);
    expect(lines.pop()).toMatch(/usage/);
    expect(await run(["--seed", "D:\\zz-does-not-exist-xyz"], {}, { out, schema })).toBe(1);
    expect(lines.pop()).toMatch(/not found/);
    const f = zzSeedV2() as Partial<SeedFilesV2>;
    delete f["expressions.json"];
    const r = await go(f as SeedFilesV2);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/expressions\.json is missing/);
  });

  it("a shape error in the seed is rejected before any rule is read", async () => {
    const f = zzSeedV2();
    f["expressions.json"].expressions[0]!.extra = "ZZ-SECRET";
    const r = await go(f);
    expect(r.code).toBe(1);
    expect(r.text).toContain("expressions[0].extra: unknown key");
    expect(r.text).not.toContain("ZZ-SECRET");
  });
});
