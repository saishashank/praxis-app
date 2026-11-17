// @vitest-environment node
// M22 C4 PRD-033 / AT-73 (docs/M22_design.md, task C4; D-1428, D-1447): no opinion reaches trading. The shared proof across
// every opinion kind (steelman, Committee, reflections, MiniLM shadow, regime reading, call proposals), in five parts:
// (i) no arena, ranking, sizing, pick, rule, breaker, alert, intraday, sentinel, e-mail or learning module imports
//     `src/lib/opinions` or `src/lib/committee`;
// (ii) no such module names an opinion table (the namers are an exact, argued list: a new reader fails here);
// (iii) the opinions folder imports nothing that decides, writes only the request table and the log, and is imported only by
//      the Committee page loader and the health line;
// (iv) there is no approve path: no route, action or exported name touches the request table or approves an opinion;
// (v) the database: the request table is append-only with no foreign key out.
// The Committee's own file is tests/security/committeeBoundary.test.ts; this one adds the other kinds and the meters.
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
    } else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.(ts|tsx|mjs)$/.test(e.name))
      out.push(full);
  }
  return out;
};

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

const SRC = walk(path.join(ROOT, "src"));
const SCRIPTS = walk(path.join(ROOT, "scripts"));
const WORKER = walk(path.join(ROOT, "worker/src"));
const code = (f: string): string => stripComments(fs.readFileSync(f, "utf8"));

/** Everything that decides, sizes, ranks, places, picks, alerts, learns or mails. */
const DECIDERS =
  /^src\/lib\/(arena|learning|ranking|sizing|rules|breakers?|email|mail|alerts|intraday|sentinel|cortex\/night|cortex\/store\/decisions|picks\/(store|track|generate|nightly)|agents\/(batch2b|batch3|orderPlan|thesisBreakers|breakerNightly|forwardLedger))(\/|$|\.)/;

/** The opinion tables: what an opinion is written to or tracked in. */
const TABLES =
  /\b(opinion_track|opinion_promotion_request|committee_(prereg|rating|call|trial_result)|pick_reflection|minilm_shadow|regime_alt_reading|alt_input_point|expert_call_proposal|expert_call_confirm)\b/;

describe("opinion boundary (i): who may import the opinion folders", () => {
  const importsOf = (f: string): string[] =>
    specifiers(fs.readFileSync(f, "utf8")).map((s) => resolveSpec(f, s));

  it("scans a real set of deciding modules (not vacuous)", () => {
    const deciders = SRC.map(rel).filter((r) => DECIDERS.test(r));
    expect(deciders.length).toBeGreaterThan(20);
  });

  it("no deciding module imports src/lib/opinions or src/lib/committee", () => {
    const bad: string[] = [];
    for (const f of SRC) {
      if (!DECIDERS.test(rel(f))) continue;
      for (const r of importsOf(f))
        if (/^src\/lib\/(opinions|committee)(\/|$)/.test(r)) bad.push(`${rel(f)} imports ${r}`);
    }
    expect(bad).toEqual([]);
  });

  it("the nightly arena scripts load neither folder (the Committee's own entry is the one allowed bundle)", () => {
    const bad = SCRIPTS.filter(
      (f) => /^scripts\/arena\//.test(rel(f)) && !f.endsWith("signals.mjs"),
    )
      .filter((f) => /lib\/(opinions|committee)\b/.test(code(f)))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("the Worker never imports either folder", () => {
    const bad = WORKER.filter((f) => /lib\/(opinions|committee)\b/.test(code(f))).map(rel);
    expect(bad).toEqual([]);
  });

  it("the guard catches a deciding module that imports the folder (self-test)", () => {
    expect(DECIDERS.test("src/lib/picks/generate.ts")).toBe(true);
    expect(DECIDERS.test("src/lib/arena/preopen.ts")).toBe(true);
    expect(DECIDERS.test("src/lib/health/opinions.ts")).toBe(false);
    expect(
      specifiers('import { x } from "@/lib/opinions/meter";').map((s) => resolveSpec("/x.ts", s)),
    ).toEqual(["src/lib/opinions/meter"]);
  });
});

describe("opinion boundary (ii): who names an opinion table", () => {
  // Exactly the modules that write, track, settle or display an opinion, each argued for. Anything else is new and fails.
  const NAMERS = new Set([
    // the Committee engine and its trial (C1, C2) and the guard of its frozen keys
    "src/lib/committee/night.ts",
    "src/lib/committee/outcomes.ts",
    "src/lib/committee/prereg.ts",
    "src/lib/committee/store.ts",
    "src/lib/committee/trial.ts",
    "src/lib/config/guards/committee.ts",
    // the Cortex's opinion hook, the schema pin list and the sentence that cites it
    "src/lib/cortex/angles/d10.ts",
    "src/lib/cortex/stageTables.mjs",
    "src/lib/cortex/store/common.ts",
    "src/lib/cortex/store/labels.ts",
    // the call proposals and the Owner's confirmation (E3)
    "src/lib/experts/callEngine.mjs",
    "src/lib/experts/callProposals.ts",
    "src/lib/experts/review.ts",
    // the health lines (read-only)
    "src/lib/health/committee.ts",
    "src/lib/health/minilm.ts",
    "src/lib/health/opinions.ts",
    // the drop order names the reflection budget
    "src/lib/llm/dropOrder.ts",
    "src/lib/llm/minilm/shadow.ts",
    // this task
    "src/lib/opinions/meter.ts",
    "src/lib/opinions/promotion.ts",
    // the steelman and the reflections (C3)
    "src/lib/steelman/reflect.ts",
    "src/lib/steelman/reflectRead.ts",
    // the pages that display them
    "src/lib/ui/loaders/committee.ts",
    "src/lib/ui/loaders/cortex.ts",
  ]);

  it("no module names an opinion table unless it is on the argued list", () => {
    const bad: string[] = [];
    for (const f of [...SRC, ...SCRIPTS, ...WORKER]) {
      const r = rel(f);
      if (r === "scripts/db/gen-market-guard.mjs") continue; // derives the guard list from the schema
      if (TABLES.test(code(f)) && !NAMERS.has(r)) bad.push(r);
    }
    expect(bad).toEqual([]);
  });

  it("no module on the list sits among the deciders", () => {
    expect([...NAMERS].filter((r) => DECIDERS.test(r))).toEqual([]);
  });

  it("every module on the list still exists and still names a table (the list is not stale)", () => {
    const stale = [...NAMERS].filter(
      (r) => !fs.existsSync(path.join(ROOT, r)) || !TABLES.test(code(path.join(ROOT, r))),
    );
    // the guard of the frozen keys and the drop order name a table only in a comment or a word: allowed to be quiet
    expect(
      stale.filter((r) => !/guards\/committee|dropOrder|cortex\/store\/common/.test(r)),
    ).toEqual([]);
  });

  it("the Committee page loader is the only loader that shows a Committee rating, and no card, pick, review or mail loader names a table", () => {
    const loaders = SRC.filter((f) => /^src\/lib\/(ui\/loaders|review|view|email)\//.test(rel(f)))
      .filter((f) => TABLES.test(code(f)))
      .map(rel)
      .sort();
    expect(loaders).toEqual(["src/lib/ui/loaders/committee.ts", "src/lib/ui/loaders/cortex.ts"]);
  });
});

describe("opinion boundary (iii): the opinions folder", () => {
  const FILES = walk(path.join(ROOT, "src/lib/opinions")).sort();
  const WRITE_RE =
    /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

  it("scans the folder", () => {
    expect(FILES.map(rel)).toEqual([
      "src/lib/opinions/cli.ts",
      "src/lib/opinions/meter.ts",
      "src/lib/opinions/promotion.ts",
      "src/lib/opinions/view.ts",
    ]);
  });

  it("imports nothing that decides", () => {
    const bad: string[] = [];
    for (const f of FILES)
      for (const s of specifiers(fs.readFileSync(f, "utf8"))) {
        const r = resolveSpec(f, s);
        if (DECIDERS.test(r) || /^@anthropic-ai\//.test(r)) bad.push(`${rel(f)} imports ${s}`);
      }
    expect(bad).toEqual([]);
  });

  it("writes only the request table and the log line, in one file, and nothing else", () => {
    const writes: Record<string, string[]> = {};
    for (const f of FILES)
      for (const m of code(f).matchAll(WRITE_RE)) (writes[rel(f)] ??= []).push(m[1].toLowerCase());
    expect(writes).toEqual({
      "src/lib/opinions/promotion.ts": ["opinion_promotion_request", "app_log"],
    });
  });

  it("uses no batch, transaction, multi-statement handle or OFFSET", () => {
    const bad = FILES.filter((f) =>
      /\.(batch|transaction|executeMultiple)\(|\bOFFSET\b/i.test(code(f)),
    ).map(rel);
    expect(bad).toEqual([]);
  });

  it("is imported only by the Committee page loader and the health line", () => {
    const importers = [...SRC, ...SCRIPTS]
      .filter((f) => !rel(f).startsWith("src/lib/opinions/"))
      .filter((f) =>
        specifiers(fs.readFileSync(f, "utf8")).some((s) =>
          /^src\/lib\/opinions(\/|$)/.test(resolveSpec(f, s)),
        ),
      )
      .map(rel)
      .sort();
    expect(importers).toEqual(["src/lib/health/opinions.ts", "src/lib/ui/loaders/committee.ts"]);
  });
});

describe("opinion boundary (iv): no approve path", () => {
  it("no route, action or page names the request table or imports the promotion module", () => {
    const bad = SRC.filter((f) => rel(f).startsWith("src/app/"))
      .filter((f) => /opinion_promotion_request|lib\/opinions\/promotion/.test(code(f)))
      .map(rel);
    expect(bad).toEqual([]);
  });

  it("no exported name approves, accepts, rejects or promotes an opinion", () => {
    const bad: string[] = [];
    const NAME =
      /export\s+(?:async\s+)?(?:function|const)\s+(\w*(?:approve|accept|promote|grant)\w*(?:Opinion|Promotion|Request)\w*|\w*(?:Opinion|Promotion)\w*(?:approve|accept|promote|grant)\w*)\b/i;
    for (const f of [...SRC, ...SCRIPTS]) {
      const m = NAME.exec(code(f));
      if (m) bad.push(`${rel(f)}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it("the page section shows words only: no form, button or action in the meters", () => {
    const page = fs.readFileSync(
      path.join(ROOT, "src/app/(app)/strategies/experiments/committee/page.tsx"),
      "utf8",
    );
    const section = page.slice(page.indexOf('data-testid="opinion-meters"'));
    expect(section).not.toMatch(/<(button|form|input|select)\b|action=|onClick|"use server"/);
  });
});

describe("opinion boundary (v): the database", () => {
  it("the request table is append-only, one row per market and kind, with no foreign key out", async () => {
    const db = await freshDb("main");
    const t = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'opinion_promotion_request'",
      )
    ).rows.map((x) => String(x.name));
    expect(t).toContain("opinion_promotion_request_no_update");
    expect(t).toContain("opinion_promotion_request_no_delete");
    expect((await db.execute("PRAGMA foreign_key_list(opinion_promotion_request)")).rows).toEqual(
      [],
    );
    const pk = (await db.execute("PRAGMA table_info(opinion_promotion_request)")).rows
      .filter((c) => Number(c.pk) > 0)
      .map((c) => String(c.name))
      .sort();
    expect(pk).toEqual(["kind", "market"]);
  });

  it("opinion_track settles once and is never deleted", async () => {
    const db = await freshDb("main");
    const t = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'opinion_track'",
      )
    ).rows.map((x) => String(x.name));
    expect(t).toEqual(
      expect.arrayContaining(["opinion_track_guard_update", "opinion_track_no_delete"]),
    );
  });
});
