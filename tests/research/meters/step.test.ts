// @vitest-environment node
// The M3 steps (D-1720...D-1723): the fixed night runs them, they write only their own tables (a static allowlist over their
// files and a run on an empty database), no code of theirs imports a trading module, no SQL pages with OFFSET, and one failing
// part does not stop the others.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lineageName } from "@/lib/research/names";
import { MOVER_RULES } from "@/lib/research/lineages/movers";
import { LABEL_KINDS, labelLineage } from "@/lib/research/lineages/labels";
import { runResearchNight } from "@/lib/research/night";
import { labelEvalStep } from "@/lib/research/steps/labelEval";
import { metersStep } from "@/lib/research/steps/meters";
import { cleanupTempDbs, freshDb } from "../../db/helpers";

afterEach(cleanupTempDbs);
const ROOT = path.resolve(import.meta.dirname, "../../..");
const FILES = [
  "src/lib/research/meters/common.ts",
  "src/lib/research/meters/liveTested.ts",
  "src/lib/research/meters/movers.ts",
  "src/lib/research/meters/intraday.ts",
  "src/lib/research/meters/labels.ts",
  "src/lib/research/lineages/movers.ts",
  "src/lib/research/lineages/labels.ts",
  "src/lib/research/lineages/intradayStream.ts",
  "src/lib/research/steps/meters.ts",
  "src/lib/research/steps/labelEval.ts",
];
const code = (f: string): string =>
  fs
    .readFileSync(path.join(ROOT, f), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("what the M3 files write", () => {
  it("only research_meter and app_log directly (the registry gate writes the look tables)", () => {
    const WRITE =
      /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|(?<!DO\s)UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    const bad: string[] = [];
    for (const f of FILES)
      for (const m of code(f).matchAll(WRITE))
        if (!["research_meter", "app_log"].includes(m[1]!.toLowerCase())) bad.push(`${f}: ${m[0]}`);
    expect(bad).toEqual([]);
  });

  it("no OFFSET paging, and every statement of the meter files carries a rows-ok line", () => {
    for (const f of FILES) expect(code(f), f).not.toMatch(/\bOFFSET\b/i);
    for (const f of FILES.filter((x) => x.includes("/meters/"))) {
      const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!/\bsql:|db\.execute\(\{/.test(l)) return;
        const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
        expect(window, `${f}:${i + 1}`).toMatch(/rows-ok/);
      });
    }
  });

  it("no file imports an arena, pick, rule, breaker, sizing, ranking, e-mail or status writer", () => {
    for (const f of FILES)
      expect(code(f), f).not.toMatch(
        /from\s+["']@\/lib\/(arena|picks|rules|breakers?|sizing|ranking|email|mail|cortex\/(status(?!Rules)|look|gates|store\/status))/,
      );
  });
});

describe("the steps through the night seam", () => {
  it("run in the fixed order on an empty database and write only meter rows, plans and nothing else", async () => {
    const db = await freshDb("main");
    const tables = (
      await db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).rows.map((r) => String(r.name));
    const counts = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of tables)
        out[t] = Number((await db.execute(`SELECT COUNT(*) n FROM ${t}`)).rows[0]!.n);
      return out;
    };
    const before = await counts();
    const r = await runResearchNight(
      db,
      { market: "AU", d: "2031-04-08", now: "2031-04-08T12:00:00Z" },
      [metersStep, labelEvalStep],
    );
    expect(r).toEqual({ status: "ran", ran: ["meters", "labelEval"], failed: [] });
    const after = await counts();
    const moved = tables.filter((t) => after[t] !== before[t]);
    expect(moved.sort()).toEqual(["research_meter", "research_prereg"]);
    expect(after.research_meter! - before.research_meter!).toBe(21); // 12 live-tested, 6 mover rules, 3 labels
    expect(after.research_prereg! - before.research_prereg!).toBe(9); // six mover plans and three label plans
    expect(after.holdout_look).toBe(before.holdout_look);
  });

  it("a second run of the same night writes nothing new", async () => {
    const db = await freshDb("main");
    const o = { market: "AU", d: "2031-04-08", now: "2031-04-08T12:00:00Z" };
    await runResearchNight(db, o, [metersStep, labelEvalStep]);
    const a = Number((await db.execute("SELECT COUNT(*) n FROM research_meter")).rows[0]!.n);
    await runResearchNight(db, o, [metersStep, labelEvalStep]);
    expect(Number((await db.execute("SELECT COUNT(*) n FROM research_meter")).rows[0]!.n)).toBe(a);
  });

  it("is skipped for a market that is off (IN and US stay off)", async () => {
    const db = await freshDb("main");
    for (const market of ["IN", "US"]) {
      const r = await runResearchNight(
        db,
        { market, d: "2031-04-08", now: "2031-04-08T12:00:00Z" },
        [metersStep, labelEvalStep],
      );
      expect(r.status).toBe("skipped_market");
    }
    expect(Number((await db.execute("SELECT COUNT(*) n FROM research_meter")).rows[0]!.n)).toBe(0);
  });
});

describe("plain names (D-1729)", () => {
  it("every new lineage has a plain name that carries no code, and a later intraday cell is named by its quarter", () => {
    const keys = [
      ...MOVER_RULES.map((r) => r.lineage),
      ...LABEL_KINDS.map(labelLineage),
      "intraday_stream_v1",
    ];
    for (const k of keys) {
      expect(lineageName(k), k).not.toBe("An unnamed test");
      expect(lineageName(k), k).not.toMatch(/[_]|[A-Z]{3}-d|Ad/);
    }
    expect(lineageName("intraday_stream_v1_2031Q2")).toBe(
      "Intraday stream test, fresh sample from quarter 2 of 2031",
    );
    expect(lineageName("intraday_stream_v1_2031Q9")).toBe("An unnamed test");
  });
});
