// @vitest-environment node
// M11-lite PRD-033 / D-494 (docs/M11L_design.md): the steelman is an opinion, never a decision input.
// Four checks: (i) import guard on src/lib/steelman, (ii) SQL write allowlist, (iii) reverse guard (who
// may import the steelman, and which files may name its tables), (iv) the database: append-only
// triggers on the steelman tables and no foreign key out of them. The replay hash with the stage on
// versus off is tests/acceptance/v2/at32Steelman.test.ts.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDbs, freshDb } from "../db/helpers";

afterEach(cleanupTempDbs);

const ROOT = path.resolve(import.meta.dirname, "../..");
const posix = (p: string) => p.split(path.sep).join("/");
const rel = (f: string) => posix(path.relative(ROOT, f));

const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== ".next") walk(full, out);
    } else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
};

const STEELMAN_FILES = walk(path.join(ROOT, "src/lib/steelman")).sort();

const stripComments = (t: string): string =>
  t
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const specifiers = (src: string): string[] =>
  [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]);

/** Repo-relative path (no extension) of a specifier, or the bare package name. */
function resolveSpec(file: string, spec: string): string {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith("."))
    return posix(path.relative(ROOT, path.resolve(path.dirname(file), spec)));
  return spec;
}

describe("steelman boundary (i): import guard", () => {
  // Modules that decide, size, place, learn or pick. The steelman may import none of their writers.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["src/lib/arena/*", /^src\/lib\/arena(\/|$)/],
    ["cortex/night", /^src\/lib\/cortex\/night(\/|$)/],
    ["cortex decision writers", /^src\/lib\/cortex\/store\/decisions(\/|$)/],
    [
      "agents (decision path)",
      /^src\/lib\/agents\/(batch2b|batch3|orderPlan|thesisBreakers|breakerNightly)(\/|$)/,
    ],
    ["learning", /^src\/lib\/learning(\/|$)/],
    ["pick writers", /^src\/lib\/picks\/(store|track|generate|nightly)(\/|$)/],
    ["anthropic sdk", /^@anthropic-ai\//],
  ];
  // The exact neighbours the steelman does use, per area: anything else under these roots is new and
  // must be argued for here.
  const ALLOWED_NEIGHBOURS: Record<string, string[]> = {
    "src/lib/agents/": ["src/lib/agents/params", "src/lib/agents/decisionView"],
    "src/lib/picks/": ["src/lib/picks/factors"],
    "src/lib/cortex/": ["src/lib/cortex/store/common", "src/lib/cortex/store/labels"],
  };

  it("scans the steelman modules", () => {
    const names = STEELMAN_FILES.map(rel);
    expect(names).toContain("src/lib/steelman/night.ts");
    expect(names).toContain("src/lib/steelman/write.ts");
    expect(names).toContain("src/lib/steelman/store.ts");
    expect(names).toContain("src/lib/steelman/cli.ts");
  });

  it("no steelman file imports an arena, night, decision-writer, learning or pick-writer module", () => {
    const bad: string[] = [];
    for (const f of STEELMAN_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        for (const [name, re] of FORBIDDEN) {
          if (re.test(r)) bad.push(`${rel(f)} imports ${spec} (${name})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the agents, picks and cortex neighbours are exactly the vetted ones", () => {
    const bad: string[] = [];
    for (const f of STEELMAN_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        for (const [root, ok] of Object.entries(ALLOWED_NEIGHBOURS)) {
          if (r.startsWith(root) && !ok.includes(r)) bad.push(`${rel(f)} imports ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the guard catches a forbidden import (self-test)", () => {
    const sample =
      'import { runPreopen } from "@/lib/arena/preopen";\nimport { b } from "@/lib/agents/batch2b";\nimport { l } from "@/lib/learning/x";';
    const hits = specifiers(sample).map((s) => resolveSpec("/x.ts", s));
    expect(FORBIDDEN.filter(([, re]) => hits.some((h) => re.test(h))).map(([n]) => n)).toEqual([
      "src/lib/arena/*",
      "agents (decision path)",
      "learning",
    ]);
  });
});

describe("steelman boundary (ii): SQL write allowlist", () => {
  const ALLOWED = new Set([
    "steelman_pack",
    "steelman_point",
    "steelman_night",
    "steelman_suggestion",
    "pick_reflection",
  ]);
  const WRITE_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  const DYNAMIC_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?![A-Za-z_])/gi;
  const EXEC_RE = /\.execute\((?!\s*(?:["'\x60]|\{\s*sql:\s*["'\x60]))/g;

  it("every INSERT, UPDATE and DELETE literal names a steelman table", () => {
    const bad: string[] = [];
    for (const f of STEELMAN_FILES) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(WRITE_RE)) {
        if (!ALLOWED.has(m[1].toLowerCase())) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("some write literal is actually found (the scan is not vacuous)", () => {
    const src = stripComments(
      fs.readFileSync(path.join(ROOT, "src/lib/steelman/store.ts"), "utf8"),
    );
    const names = new Set([...src.matchAll(WRITE_RE)].map((m) => m[1].toLowerCase()));
    expect([...names].sort()).toEqual([
      "steelman_night",
      "steelman_pack",
      "steelman_point",
      "steelman_suggestion",
    ]);
  });

  it("no write keyword is followed by an interpolation, and execute takes only literals", () => {
    const bad: string[] = [];
    for (const f of STEELMAN_FILES) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(DYNAMIC_RE)) bad.push(`${rel(f)}: dynamic write ${m[0]}`);
      for (const m of src.matchAll(EXEC_RE)) {
        const tail = src.slice(m.index, m.index + 60).replace(/\s+/g, " ");
        bad.push(`${rel(f)}: non-literal execute ${tail}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the store writes only through `execute` (no batch, no transaction handle)", () => {
    const bad = STEELMAN_FILES.filter((f) =>
      /\.(batch|transaction|executeMultiple)\(/.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(bad).toEqual([]);
  });

  it("opinion_track, llm_call and llm_cache are never named in a steelman file", () => {
    // opinion_track only through recordOpinion / settleRecordedOpinion (src/lib/llm/textLabels);
    // llm_call and llm_cache only through the router's own store.
    const bad = STEELMAN_FILES.filter((f) =>
      /\b(opinion_track|llm_call|llm_cache)\b/i.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(bad).toEqual([]);
  });

  it("recordOpinion and settleRecordedOpinion are called only from the stage files", () => {
    const callers = STEELMAN_FILES.filter((f) =>
      /\b(recordOpinion|settleRecordedOpinion)\(/.test(stripComments(fs.readFileSync(f, "utf8"))),
    )
      .map(rel)
      .sort();
    expect(callers).toEqual([
      "src/lib/steelman/night.ts",
      "src/lib/steelman/opinion.ts",
      "src/lib/steelman/write.ts",
    ]);
  });

  it("the allowlist regex flags an order, book or lesson write (self-test)", () => {
    const sql =
      "INSERT INTO arena_order (id) VALUES (1); update fill SET x = 1; DELETE FROM lesson";
    const names = [...sql.matchAll(WRITE_RE)].map((m) => m[1]);
    expect(names).toEqual(["arena_order", "fill", "lesson"]);
    expect(names.some((n) => ALLOWED.has(n))).toBe(false);
  });
});

describe("steelman boundary (iii): who may import the steelman and name its tables", () => {
  // The readers and the one stage: the card page, /review, the health line, the review line, and the
  // nightly orchestrator. Nothing that decides, sizes, places, learns or picks is on the list.
  const IMPORTERS = new Set([
    "src/app/(app)/cards/[id]/Steelman.tsx",
    "src/app/(app)/review/DismissForm.tsx",
    "src/app/(app)/review/Suggestions.tsx",
    "src/app/(app)/review/actions.ts",
    "src/app/(app)/review/page.tsx",
    "src/lib/health/steelman.ts",
    "src/lib/review/sections.ts",
    "src/lib/ui/loaders/cards.ts",
  ]);
  const TABLES =
    /\b(steelman_pack|steelman_point|steelman_night|steelman_suggestion|pick_reflection)\b/;
  const TABLE_NAMERS = new Set([
    "src/lib/config/keys.ts", // config key names that contain the words only
    "src/lib/llm/dropOrder.ts",
  ]);

  const srcFiles = walk(path.join(ROOT, "src"));
  const importsSteelman = (f: string): boolean =>
    specifiers(fs.readFileSync(f, "utf8")).some((s) =>
      resolveSpec(f, s).startsWith("src/lib/steelman/"),
    );

  it("only the readers import src/lib/steelman", () => {
    const got = srcFiles
      .filter((f) => !rel(f).startsWith("src/lib/steelman/") && importsSteelman(f))
      .map(rel);
    expect(got.filter((f) => !IMPORTERS.has(f))).toEqual([]);
    expect(got.length).toBeGreaterThan(3); // the scan finds the known readers
  });

  it("the nightly scripts other than signals.mjs do not load the steelman bundle", () => {
    const bad = walk(path.join(ROOT, "scripts/arena"))
      .filter((f) => !f.endsWith("signals.mjs") && !/\.test\.mjs$/.test(f))
      .filter((f) => /steelman/i.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("no module outside the steelman names a steelman table in code", () => {
    const bad: string[] = [];
    for (const f of srcFiles) {
      const r = rel(f);
      if (r.startsWith("src/lib/steelman/") || TABLE_NAMERS.has(r)) continue;
      if (TABLES.test(stripComments(fs.readFileSync(f, "utf8")))) bad.push(r);
    }
    expect(bad).toEqual([]);
  });

  it("the Worker never imports the steelman", () => {
    const bad = walk(path.join(ROOT, "worker/src"))
      .filter((f) => /steelman\//.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    expect(bad).toEqual([]);
  });
});

describe("steelman boundary (iv): the database", () => {
  const OWN = [
    "steelman_pack",
    "steelman_point",
    "steelman_night",
    "steelman_suggestion",
    "pick_reflection",
  ];

  it("the steelman triggers sit on the steelman tables only", async () => {
    const db = await freshDb("main");
    const r = await db.execute(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'steelman%' OR name LIKE 'pick_reflection%')",
    );
    expect([...new Set(r.rows.map((x) => String(x.tbl_name)))].sort()).toEqual([...OWN].sort());
  });

  it("the packs, points and nights are append-only", async () => {
    const db = await freshDb("main");
    const r = await db.execute(
      "SELECT tbl_name, COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('steelman_pack','steelman_point','steelman_night') GROUP BY tbl_name",
    );
    const n = Object.fromEntries(r.rows.map((x) => [String(x.tbl_name), Number(x.n)]));
    for (const t of ["steelman_pack", "steelman_point", "steelman_night"]) {
      expect(n[t], t).toBeGreaterThanOrEqual(2); // update and delete are refused
    }
  });

  it("the steelman tables have no foreign key into an order, book or rule table", async () => {
    const db = await freshDb("main");
    for (const t of OWN) {
      const fk = await db.execute(`PRAGMA foreign_key_list(${t})`);
      const targets = fk.rows.map((x) => String(x.table));
      expect(
        targets.filter((x) => !OWN.includes(x)),
        t,
      ).toEqual([]);
    }
  });
});
