// @vitest-environment node
// M22 C1 PRD-033 / AT-73 (docs/M22_design.md, task C1): the Committee is an opinion, never a decision input. Four checks:
// (i) import guard on src/lib/committee, (ii) SQL write allowlist, (iii) reverse guard (who may import the Committee and which
// files may name its tables), (iv) the database (append-only triggers, no foreign key out). The shared AT-73 proof across
// all opinion kinds is task C4's `opinionBoundary.test.ts`; this file is the Committee's own.
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

const COMMITTEE_FILES = walk(path.join(ROOT, "src/lib/committee")).sort();

const stripComments = (t: string): string =>
  t
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

const IMPORT_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;
const specifiers = (src: string): string[] =>
  [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]);

function resolveSpec(file: string, spec: string): string {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith("."))
    return posix(path.relative(ROOT, path.resolve(path.dirname(file), spec)));
  return spec;
}

describe("committee boundary (i): import guard", () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["src/lib/arena/*", /^src\/lib\/arena(\/|$)/],
    ["cortex/night", /^src\/lib\/cortex\/night(\/|$)/],
    ["cortex decision writers", /^src\/lib\/cortex\/store\/decisions(\/|$)/],
    [
      "agents (decision path)",
      /^src\/lib\/agents\/(batch2b|batch3|orderPlan|thesisBreakers|breakerNightly|forwardLedger)(\/|$)/,
    ],
    ["learning", /^src\/lib\/learning(\/|$)/],
    ["pick writers", /^src\/lib\/picks\/(store|track|generate|nightly)(\/|$)/],
    ["email", /^src\/lib\/(email|mail)(\/|$)/],
    ["rules and breakers", /^src\/lib\/(rules|breakers?|sizing|ranking)(\/|$)/],
    ["anthropic sdk", /^@anthropic-ai\//],
  ];
  // The exact neighbours the Committee uses, per area: anything else under these roots is new and must be argued for here.
  const ALLOWED_NEIGHBOURS: Record<string, string[]> = {
    "src/lib/agents/": ["src/lib/agents/params", "src/lib/agents/decisionView"],
    "src/lib/cortex/": ["src/lib/cortex/store/common"],
    "src/lib/picks/": [],
  };

  it("scans the committee modules", () => {
    const names = COMMITTEE_FILES.map(rel);
    for (const n of ["shortlist", "debate", "judge", "store", "night", "cli"])
      expect(names).toContain(`src/lib/committee/${n}.ts`);
  });

  it("no committee file imports an arena, night, decision-writer, learning, pick-writer, e-mail or rule module", () => {
    const bad: string[] = [];
    for (const f of COMMITTEE_FILES) {
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
    for (const f of COMMITTEE_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        for (const [root, ok] of Object.entries(ALLOWED_NEIGHBOURS)) {
          if (r.startsWith(root) && !ok.includes(r)) bad.push(`${rel(f)} imports ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("the steelman neighbours are the read-only ones (claim checks, pack builder, pack reader, subject line)", () => {
    const ok = new Set([
      "src/lib/steelman/claims",
      "src/lib/steelman/pack",
      "src/lib/steelman/night",
      "src/lib/steelman/store",
      "src/lib/steelman/subjects",
    ]);
    const bad: string[] = [];
    for (const f of COMMITTEE_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        if (r.startsWith("src/lib/steelman/") && !ok.has(r)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the guard catches a forbidden import (self-test)", () => {
    const sample =
      'import { runPreopen } from "@/lib/arena/preopen";\nimport { b } from "@/lib/agents/batch2b";\nimport { l } from "@/lib/learning/x";\nimport { m } from "@/lib/email/send";';
    const hits = specifiers(sample).map((s) => resolveSpec("/x.ts", s));
    expect(FORBIDDEN.filter(([, re]) => hits.some((h) => re.test(h))).map(([n]) => n)).toEqual([
      "src/lib/arena/*",
      "agents (decision path)",
      "learning",
      "email",
    ]);
  });
});

describe("committee boundary (ii): SQL write allowlist", () => {
  const ALLOWED = new Set(["committee_rating", "committee_call"]);
  const WRITE_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
  const DYNAMIC_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?![A-Za-z_])/gi;
  const EXEC_RE = /\.execute\((?!\s*(?:["'\x60]|\{\s*sql:\s*["'\x60]))/g;

  it("every INSERT, UPDATE and DELETE literal names a Committee table", () => {
    const bad: string[] = [];
    for (const f of COMMITTEE_FILES) {
      for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(WRITE_RE)) {
        if (!ALLOWED.has(m[1].toLowerCase())) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the writes are exactly the rating and the call table (the scan is not vacuous)", () => {
    const src = stripComments(
      fs.readFileSync(path.join(ROOT, "src/lib/committee/store.ts"), "utf8"),
    );
    expect([...new Set([...src.matchAll(WRITE_RE)].map((m) => m[1].toLowerCase()))].sort()).toEqual(
      ["committee_call", "committee_rating"],
    );
  });

  it("no write keyword is followed by an interpolation, and execute takes only literals", () => {
    const bad: string[] = [];
    for (const f of COMMITTEE_FILES) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(DYNAMIC_RE)) bad.push(`${rel(f)}: dynamic write ${m[0]}`);
      for (const m of src.matchAll(EXEC_RE)) {
        const tail = src.slice(m.index, m.index + 60).replace(/\s+/g, " ");
        bad.push(`${rel(f)}: non-literal execute ${tail}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no batch, transaction or multi-statement handle, and no OFFSET paging", () => {
    const bad = COMMITTEE_FILES.filter((f) => {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      return /\.(batch|transaction|executeMultiple)\(/.test(src) || /\bOFFSET\b/i.test(src);
    }).map(rel);
    expect(bad).toEqual([]);
  });

  it("opinion_track and the call log are reached only through recordOpinion and the router", () => {
    const bad = COMMITTEE_FILES.filter((f) =>
      /\b(opinion_track|llm_call|llm_cache)\b/i.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(bad).toEqual([]);
    const callers = COMMITTEE_FILES.filter((f) =>
      /\brecordOpinion\(/.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(callers).toEqual(["src/lib/committee/night.ts"]);
  });

  it("the allowlist regex flags an order, book or lesson write (self-test)", () => {
    const sql =
      "INSERT INTO arena_order (id) VALUES (1); update fill SET x = 1; DELETE FROM lesson";
    const names = [...sql.matchAll(WRITE_RE)].map((m) => m[1]);
    expect(names).toEqual(["arena_order", "fill", "lesson"]);
    expect(names.some((n) => ALLOWED.has(n))).toBe(false);
  });
});

describe("committee boundary (iii): who may import the Committee and name its tables", () => {
  const TABLES = /\b(committee_prereg|committee_rating|committee_call|committee_trial_result)\b/;
  // Modules that may name a Committee table: the guard of the frozen keys (a read) and the schema pin list; the engine
  // itself and the later M22 tasks' own files (the trial C2, the meters C4, the health lines Z).
  const TABLE_NAMERS = new Set([
    "src/lib/config/guards/committee.ts",
    "src/lib/cortex/stageTables.mjs",
  ]);
  const LATER_TASKS = [
    /^src\/lib\/committee\//,
    /^src\/lib\/health\/(committee|opinions)\.ts$/,
    /^src\/lib\/opinions\//,
    /^src\/lib\/ui\/loaders\//,
    /^src\/app\/\(app\)\//,
  ];
  const srcFiles = walk(path.join(ROOT, "src"));
  const importsCommittee = (f: string): boolean =>
    specifiers(fs.readFileSync(f, "utf8")).some((s) =>
      resolveSpec(f, s).startsWith("src/lib/committee/"),
    );

  it("nothing that decides, sizes, places, learns, ranks, picks or mails imports src/lib/committee", () => {
    const forbidden =
      /^src\/lib\/(arena|learning|cortex\/night|picks\/(store|track|generate|nightly)|agents\/(batch2b|batch3|orderPlan|thesisBreakers|breakerNightly|forwardLedger)|email|mail|rules|sizing|ranking)(\/|$|\.)/;
    const got = srcFiles
      .filter((f) => !rel(f).startsWith("src/lib/committee/") && importsCommittee(f))
      .map(rel);
    expect(got.filter((r) => forbidden.test(r))).toEqual([]);
  });

  it("the nightly scripts other than signals.mjs do not load the Committee bundle", () => {
    const bad = walk(path.join(ROOT, "scripts/arena"))
      .filter((f) => !f.endsWith("signals.mjs") && !/\.test\.mjs$/.test(f))
      .filter((f) => /lib\/committee/i.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("no module outside the Committee and its later tasks names a Committee table in code", () => {
    const bad: string[] = [];
    for (const f of srcFiles) {
      const r = rel(f);
      if (TABLE_NAMERS.has(r) || LATER_TASKS.some((re) => re.test(r))) continue;
      if (TABLES.test(stripComments(fs.readFileSync(f, "utf8")))) bad.push(r);
    }
    expect(bad).toEqual([]);
  });

  it("the Worker never imports the Committee", () => {
    const bad = walk(path.join(ROOT, "worker/src"))
      .filter((f) => /committee\//.test(fs.readFileSync(f, "utf8")))
      .map(rel);
    expect(bad).toEqual([]);
  });
});

describe("committee boundary (iv): the database", () => {
  const OWN = ["committee_prereg", "committee_rating", "committee_call", "committee_trial_result"];

  it("the ratings, calls, pre-registrations and results refuse update, and refuse delete (a call only after expiry)", async () => {
    const db = await freshDb("main");
    const r = await db.execute(
      "SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger' AND tbl_name LIKE 'committee_%'",
    );
    const names = r.rows.map((x) => String(x.name));
    for (const t of OWN) expect(names, `${t} update`).toContain(`${t}_no_update`);
    for (const t of ["committee_prereg", "committee_rating", "committee_trial_result"])
      expect(names, `${t} delete`).toContain(`${t}_no_delete`);
    expect(names).toContain("committee_call_prune_only");
  });

  it("the Committee tables have no foreign key into an order, book, rule or pick table", async () => {
    const db = await freshDb("main");
    for (const t of OWN) {
      const fk = await db.execute(`PRAGMA foreign_key_list(${t})`);
      expect(
        fk.rows.map((x) => String(x.table)).filter((x) => !OWN.includes(x)),
        t,
      ).toEqual([]);
    }
  });
});
