// @vitest-environment node
// M23 A2 (PRD-033, D-1614): the research modules read and record, they never decide. Import guard over src/lib/research: no
// arena, ranking, pick, rule, breaker, sizing, order, family-status or e-mail module, no model SDK. The registry files
// write only registry tables and the log.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
};
const FILES = walk(path.join(ROOT, "src/lib/research")).sort();

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const specifiers = (src: string): string[] =>
  [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2]!);
const resolveSpec = (file: string, spec: string): string =>
  spec.startsWith("@/")
    ? `src/${spec.slice(2)}`
    : spec.startsWith(".")
      ? posix(path.relative(ROOT, path.resolve(path.dirname(file), spec)))
      : spec;

// The one vetted arena neighbour: the pure cost-profile arithmetic (R1 `costs.ts`), no state and no write.
const ALLOWED_NEIGHBOURS = new Set(["src/lib/arena/costs"]);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["arena", /^src\/lib\/arena(\/|$)/],
  ["picks", /^src\/lib\/picks(\/|$)/],
  ["rules, breakers, sizing, ranking", /^src\/lib\/(rules|breakers?|sizing|ranking)(\/|$)/],
  ["email", /^src\/lib\/(email|mail)(\/|$)/],
  ["anthropic sdk", /^@anthropic-ai\//],
];

describe("research boundary (M23 A2)", () => {
  it("scans the research modules (not vacuous)", () => {
    const names = FILES.map((f) => posix(path.relative(ROOT, f)));
    for (const n of ["registry", "verdict", "names", "ledgerFile", "view"])
      expect(names).toContain(`src/lib/research/${n}.ts`);
  });

  it("no research file imports an arena, pick, rule, breaker, sizing, ranking, e-mail or model module", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        if (ALLOWED_NEIGHBOURS.has(r)) continue;
        for (const [name, re] of FORBIDDEN)
          if (re.test(r)) bad.push(`${posix(path.relative(ROOT, f))} imports ${spec} (${name})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the registry files write only registry tables and the log", () => {
    const ALLOWED = new Set([
      "research_prereg",
      "holdout_look",
      "research_result",
      "holdout_look_refusal",
      "app_log",
    ]);
    const WRITE =
      /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    const bad: string[] = [];
    for (const n of ["registry", "view", "ledgerFile", "names", "verdict", "steps/lookSync"]) {
      const src = fs
        .readFileSync(path.join(ROOT, `src/lib/research/${n}.ts`), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      for (const m of src.matchAll(WRITE))
        if (!ALLOWED.has(m[1]!.toLowerCase())) bad.push(`${n}: ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
});
