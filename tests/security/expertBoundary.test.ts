// @vitest-environment node
// M13-lite PRD-035 / D-525 (docs/M13L_design.md): expert material is a hypothesis source, never a decision
// input. Five checks: (i) reverse import guard (who may import src/lib/experts), (ii) forward import guard
// (what src/lib/experts may import), (iii) SQL write allowlist = the expert tables, with the one path out
// being createChallenger, (iv) no network and no model in src/lib/experts, (v) the database triggers and
// fixture rules (ZZ names, example.test hosts). The replay hash with expert data present versus absent is
// tests/acceptance/v2/at41Replay.test.ts.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXPERT_TABLES } from "@/lib/experts/types";
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

const EXPERT_FILES = walk(path.join(ROOT, "src/lib/experts")).sort();

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

const importsExperts = (f: string): boolean =>
  specifiers(fs.readFileSync(f, "utf8")).some((s) => {
    const r = resolveSpec(f, s);
    return r === "src/lib/experts" || r.startsWith("src/lib/experts/");
  });

describe("expert boundary (i): who may import src/lib/experts", () => {
  // Trading, ranking, sizing and learning-core code. The one entry is the weekly stage wiring.
  const TRADING_DIRS = [
    "src/lib/arena",
    "src/lib/agents",
    "src/lib/cortex",
    "src/lib/learning",
    "src/lib/replay",
    "src/lib/stats",
    "src/lib/money",
    "src/lib/config",
    "src/lib/llm",
    "src/lib/data",
    "src/lib/picks",
    "src/lib/steelman",
    "src/lib/intraday",
    "worker",
    "scripts",
  ];
  const WIRING = new Set([
    "src/lib/replay/learningMode.ts", // registers expertsStage in the weekly learning run (D-608)
  ]);
  // Readers: the KB mirror, the pages and their loaders. Nothing that decides, sizes or places.
  const READERS = new Set(["src/lib/kb/documents.ts", "src/lib/kb/mapping.ts"]);
  const isReaderPath = (f: string): boolean =>
    f.startsWith("src/app/") || f.startsWith("src/lib/ui/");

  const files = [
    ...walk(path.join(ROOT, "src")),
    ...walk(path.join(ROOT, "worker")),
    ...walk(path.join(ROOT, "scripts")),
  ];
  const importers = files
    .map(rel)
    .filter((f) => !f.startsWith("src/lib/experts/"))
    .filter((f) => importsExperts(path.join(ROOT, f)));

  it("finds the known importers (the scan is not vacuous)", () => {
    expect(importers).toContain("src/lib/replay/learningMode.ts");
    expect(importers).toContain("src/lib/kb/documents.ts");
    expect(importers).toContain("src/lib/kb/mapping.ts");
  });

  it("no trading, ranking, sizing or learning module imports the experts except the stage wiring", () => {
    const bad = importers.filter(
      (f) => TRADING_DIRS.some((d) => f.startsWith(`${d}/`)) && !WIRING.has(f),
    );
    expect(bad).toEqual([]);
  });

  it("every importer is the wiring, a KB reader, or a page or loader", () => {
    const bad = importers.filter((f) => !WIRING.has(f) && !READERS.has(f) && !isReaderPath(f));
    expect(bad).toEqual([]);
  });

  it("the wiring imports only the weekly stage", () => {
    const text = fs.readFileSync(path.join(ROOT, "src/lib/replay/learningMode.ts"), "utf8");
    const named = specifiers(text).filter((s) => s.includes("experts"));
    expect(named).toEqual(["@/lib/experts/weeklyStage"]);
  });

  it("the Worker and the nightly scripts never load the experts", () => {
    const bad = [...walk(path.join(ROOT, "worker")), ...walk(path.join(ROOT, "scripts/arena"))]
      .filter((f) => /lib\/experts/.test(stripComments(fs.readFileSync(f, "utf8"))))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("the guard catches a trading importer (self-test)", () => {
    const sample = 'import { x } from "@/lib/experts/store";';
    const hits = specifiers(sample).map((s) => resolveSpec("/x.ts", s));
    expect(hits).toEqual(["src/lib/experts/store"]);
    expect(TRADING_DIRS.some((d) => "src/lib/arena/preopen.ts".startsWith(`${d}/`))).toBe(true);
  });
});

describe("expert boundary (ii): what src/lib/experts may import", () => {
  // The exact outside modules the experts use. Anything else is new and must be argued for here.
  const ALLOWED_OUTSIDE = new Set([
    "@libsql/client",
    // reads and statistics
    "src/lib/stats/splits",
    "src/lib/stats/stationaryBootstrap",
    "src/lib/stats/rng",
    "src/lib/stats/multiplicity",
    "src/lib/stats/bootstrap",
    "src/lib/stats/binomial",
    "src/lib/agents/schema",
    "src/lib/agents/families/ruleSchema",
    "src/lib/agents/families/constants",
    "src/lib/replay/ledger",
    "src/lib/arena/cohort", // canonicalJson and sha256Hex only
    "src/lib/cortex/store/common", // the Exec type
    // the weekly run's own context and the read helpers of the challenger lifecycle
    "src/lib/learning/weeklyStages",
    "src/lib/learning/weeklyRun",
    "src/lib/learning/promotion", // budgetTotalFor (read)
    "src/lib/learning/challengerLifecycle", // createChallenger (proposals.ts only), incumbentOf, loadChallenger
    // paper calls (D-524, D-640): the benchmark and window helpers and bar maths, nothing that ranks
    "src/lib/picks/benchmark",
    "src/lib/picks/vsMarket",
    "src/lib/data/calendar",
    "src/lib/money/micro",
    "src/lib/money/rational",
    "src/lib/money/round",
    // the KB mirror (D-523)
    "src/lib/kb/documents",
    "src/lib/kb/render",
    "src/lib/config/store", // getConfig for expert_min_scored
  ]);
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["arena orders and fills", /^src\/lib\/arena\/(?!cohort$)/],
    ["night and decision writers", /^src\/lib\/cortex\/(night|store\/decisions)(\/|$)/],
    [
      "agents (decision path)",
      /^src\/lib\/agents\/(batch2b|batch3|orderPlan|thesisBreakers|breakerNightly)(\/|$)/,
    ],
    ["pick writers", /^src\/lib\/picks\/(store|track|generate|nightly)(\/|$)/],
    ["llm", /^src\/lib\/llm(\/|$)/],
    ["anthropic sdk", /^@anthropic-ai\//],
  ];

  it("scans the expert modules", () => {
    const names = EXPERT_FILES.map(rel);
    for (const n of ["store", "screen", "proposals", "calls", "kbDocs", "weeklyStage"]) {
      expect(names).toContain(`src/lib/experts/${n}.ts`);
    }
  });

  it("imports only the vetted outside modules", () => {
    const bad: string[] = [];
    for (const f of EXPERT_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        if (r.startsWith("src/lib/experts/")) continue;
        if (!ALLOWED_OUTSIDE.has(r)) bad.push(`${rel(f)} imports ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("imports no order, fill, night, decision-writer, pick-writer or model module", () => {
    const bad: string[] = [];
    for (const f of EXPERT_FILES) {
      for (const spec of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, spec);
        for (const [name, re] of FORBIDDEN) {
          if (re.test(r)) bad.push(`${rel(f)} imports ${spec} (${name})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("createChallenger is called from proposals.ts only: the one path from a cluster to trading", () => {
    const callers = EXPERT_FILES.filter((f) =>
      /\bcreateChallenger\(/.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(callers).toEqual(["src/lib/experts/proposals.ts"]);
  });

  it("only calls.ts reaches the picks folder, and only for the benchmark and window helpers", () => {
    const got = EXPERT_FILES.flatMap((f) =>
      specifiers(fs.readFileSync(f, "utf8"))
        .map((s) => resolveSpec(f, s))
        .filter((r) => r.startsWith("src/lib/picks/"))
        .map((r) => `${rel(f)} -> ${r}`),
    ).sort();
    expect(got).toEqual([
      "src/lib/experts/calls.ts -> src/lib/picks/benchmark",
      "src/lib/experts/calls.ts -> src/lib/picks/vsMarket",
    ]);
  });

  it("the guard catches a forbidden import (self-test)", () => {
    const sample =
      'import { a } from "@/lib/arena/preopen";\nimport { b } from "@/lib/llm/router";\nimport { c } from "@/lib/arena/cohort";';
    const hits = specifiers(sample).map((s) => resolveSpec("/x.ts", s));
    expect(FORBIDDEN.filter(([, re]) => hits.some((h) => re.test(h))).map(([n]) => n)).toEqual([
      "arena orders and fills",
      "llm",
    ]);
  });
});

describe("expert boundary (iii): SQL write allowlist", () => {
  const WRITES = new Set<string>(EXPERT_TABLES);
  // What the experts may read besides their own tables: the challenger event log (F7 gate), the bars and the
  // universe snapshot (paper calls).
  const READS = new Set<string>([
    ...EXPERT_TABLES,
    "challenger_event",
    "price_bar",
    "universe_snapshot",
  ]);
  const WRITE_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const READ_RE = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g;
  const DYNAMIC_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(?![A-Za-z_])/g;

  it("every INSERT, UPDATE and DELETE literal names an expert table", () => {
    const bad: string[] = [];
    for (const f of EXPERT_FILES) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(WRITE_RE)) {
        if (!WRITES.has(m[1])) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("some write literal is found for every table the code writes (the scan is not vacuous)", () => {
    const names = new Set<string>();
    for (const f of EXPERT_FILES) {
      for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(WRITE_RE)) names.add(m[1]);
    }
    for (const t of [
      "claim",
      "claim_status",
      "screening_run",
      "screening_result",
      "expert_proposal",
    ]) {
      expect(names.has(t), t).toBe(true);
    }
    expect(names.size).toBeGreaterThan(8);
  });

  it("every FROM and JOIN names an expert table or one of three read-only tables", () => {
    const bad: string[] = [];
    for (const f of EXPERT_FILES) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const m of src.matchAll(READ_RE)) {
        if (!READS.has(m[1])) bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no write keyword is followed by an interpolation", () => {
    const bad: string[] = [];
    for (const f of EXPERT_FILES) {
      for (const m of stripComments(fs.readFileSync(f, "utf8")).matchAll(DYNAMIC_RE)) {
        bad.push(`${rel(f)}: dynamic write ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the only write outside the expert tables is syncDocuments, called from the stage file", () => {
    const callers = EXPERT_FILES.filter((f) =>
      /\bsyncDocuments\(/.test(stripComments(fs.readFileSync(f, "utf8"))),
    ).map(rel);
    expect(callers).toEqual(["src/lib/experts/weeklyStage.ts"]);
  });

  it("the allowlist regex flags an order, book, rule or lesson write (self-test)", () => {
    const sql =
      "INSERT INTO arena_order (id) VALUES (1); UPDATE fill SET x = 1; DELETE FROM lesson; INSERT INTO rule_version (id) VALUES (2)";
    const names = [...sql.matchAll(WRITE_RE)].map((m) => m[1]);
    expect(names).toEqual(["arena_order", "fill", "lesson", "rule_version"]);
    expect(names.some((n) => WRITES.has(n))).toBe(false);
  });
});

describe("expert boundary (iv): no network and no model", () => {
  it("src/lib/experts has no fetch, no HTTP client, no model client", () => {
    const re =
      /\bfetch\s*\(|\bXMLHttpRequest\b|node:https?["']|\baxios\b|\bWebSocket\b|@anthropic-ai|@\/lib\/llm|\bmessages\.create\b/;
    const bad = EXPERT_FILES.filter((f) => re.test(stripComments(fs.readFileSync(f, "utf8")))).map(
      rel,
    );
    expect(bad).toEqual([]);
  });

  it("the importer and validator only read a local folder (no fetch either)", () => {
    const bad = ["scripts/experts/import.mjs", "scripts/experts/validate.mjs"]
      .filter((f) =>
        /\bfetch\s*\(|node:https?["']/.test(
          stripComments(fs.readFileSync(path.join(ROOT, f), "utf8")),
        ),
      )
      .map((f) => f);
    expect(bad).toEqual([]);
  });
});

describe("expert boundary (v): the database and the fixtures", () => {
  it("every expert table refuses an UPDATE or DELETE it should not allow, and no table points into the book", async () => {
    const db = await freshDb("main");
    const EXPECT_FK_FREE = EXPERT_TABLES;
    for (const t of EXPECT_FK_FREE) {
      const fk = await db.execute(`PRAGMA foreign_key_list(${t})`);
      const targets = fk.rows.map((x) => String(x.table));
      expect(
        targets.filter((x) => !(EXPERT_TABLES as readonly string[]).includes(x)),
        t,
      ).toEqual([]);
    }
    const r = await db.execute(
      "SELECT tbl_name, COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('expert_call','expert_call_outcome','screening_run','screening_result','expert_proposal','claim_revision','claim_status') GROUP BY tbl_name",
    );
    const n = Object.fromEntries(r.rows.map((x) => [String(x.tbl_name), Number(x.n)]));
    for (const t of [
      "expert_call",
      "expert_call_outcome",
      "screening_run",
      "screening_result",
      "expert_proposal",
      "claim_revision",
      "claim_status",
    ]) {
      expect(n[t], t).toBeGreaterThanOrEqual(2); // update and delete are refused
    }
  });

  it("an outcome needs a tracked call and a call needs a call claim (triggers)", async () => {
    const db = await freshDb("main");
    await expect(
      db.execute(
        "INSERT INTO expert_call_outcome (claim_id, state, index_code, basis, settled_d) VALUES ('C-NONE', 'no_bars', 'AXJO', 'none', '2030-01-01')",
      ),
    ).rejects.toThrow(/tracked call/);
    await expect(
      db.execute(
        "INSERT INTO expert_call (claim_id, market, code, direction, call_d, horizon_sessions, tracked, created_at) VALUES ('C-NONE', 'AU', 'ZZA', 'long', '2030-01-01', 5, 1, 'x')",
      ),
    ).rejects.toThrow(/claim of type call/);
  });

  // Fixture rules (D-521, SEC-110): every fixture expert is a "ZZ " name and every URL in expert fixtures is
  // on example.test (WP6's e2e seed host zz-e2e.example.test is a subdomain of it).
  const FIXTURE_DIRS = ["tests/experts", "e2e"];
  const fixtureFiles = FIXTURE_DIRS.flatMap((d) => walk(path.join(ROOT, d))).filter(
    (f) => /(zz|seed|fixture)/i.test(path.basename(f)) || rel(f).startsWith("tests/experts/"),
  );
  // a template-literal host (`zz${n}.example.test`) counts with its interpolation replaced
  const URL_RE = /https?:\/\/((?:[A-Za-z0-9.-]|\$\{[^}]*\})+)/g;

  it("fixture URLs in the expert tests are on example.test", () => {
    const bad: string[] = [];
    for (const f of fixtureFiles) {
      if (!/experts?/i.test(rel(f))) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(URL_RE)) {
        const host = m[1].replace(/\$\{[^}]*\}/g, "x").toLowerCase();
        if (host === "example.test" || host.endsWith(".example.test")) continue;
        // a documentation URL inside a comment is not a fixture
        const line = src.slice(src.lastIndexOf("\n", m.index) + 1, src.indexOf("\n", m.index));
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        bad.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
    expect(fixtureFiles.length).toBeGreaterThan(3);
  });

  it("every fixture expert name starts with 'ZZ '", () => {
    const seed = fs.readFileSync(path.join(ROOT, "tests/experts/zzSeed.ts"), "utf8");
    const names = [...seed.matchAll(/\bname:\s*`([^`]+)`/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !n.startsWith("ZZ "))).toEqual([]);
    const e2e = walk(path.join(ROOT, "e2e")).filter((f) => /expert/i.test(rel(f)));
    for (const f of e2e) {
      const names2 = [...fs.readFileSync(f, "utf8").matchAll(/\bname:\s*["'`]([^"'`]+)["'`]/g)]
        .map((m) => m[1])
        .filter((n) => /expert/i.test(n));
      expect(
        names2.filter((n) => !n.startsWith("ZZ ")),
        rel(f),
      ).toEqual([]);
    }
  });
});
