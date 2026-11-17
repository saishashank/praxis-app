// @vitest-environment node
// M22 L1 (LLM-077, D-1403, D-1404): the bake-off index. V2-format reports (category rows) and M22-format reports (a Role
// verdicts table) are read; per role the NEWEST covering report wins, so a later FAIL withdraws an earlier PASS; a stale
// generated file fails --check; a report with no valid date stops the generator (fail closed).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndex, parseReport, render, roleResults } from "../../scripts/llm/bakeoff-index.mjs";
import { BAKEOFF_INDEX } from "@/lib/llm/bakeoffIndex.generated";
import { ROOT } from "../db/helpers";

type Check = "ok" | "FAIL";
const TRAINS_OK = "no; checked 2026-11-01";

/** A V2-format report: one section per model with category rows (the harness's own layout). */
function v2(
  head: { run: string; date: string },
  models: Record<string, { cats: Record<string, Check>; trains?: string }>,
): string {
  const L = [
    "# LLM bake-off report",
    "",
    `- Run: ${head.run}`,
    `- Date: ${head.date}`,
    "",
    "## Summary",
    "",
    "| Model | Items | JSON valid % | Invented numbers | Errors | Tokens | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const m of Object.keys(models)) L.push(`| ${m} | 50 | 100.00 | 0 | 0 | 9 | PASS |`);
  for (const [m, spec] of Object.entries(models)) {
    L.push("", `## ${m}`, "", `- trains_on_prompts: ${spec.trains ?? TRAINS_OK}`, "");
    L.push(
      "| Category | Items | Metric | Value | Threshold | Check |",
      "| --- | ---: | --- | ---: | --- | --- |",
    );
    for (const [c, k] of Object.entries(spec.cats))
      L.push(`| ${c} | 10 | json_valid_pct | 100 | >= 98 | ${k} |`);
    L.push(`| classifier | 10 | false_positives | 0 | info | - |`);
  }
  return L.join("\n") + "\n";
}

/** An M22-format report: the V2 body plus a Role verdicts table. */
function m22(
  head: { run: string; date: string },
  rows: [string, string, "PASS" | "FAIL"][],
): string {
  const L = [
    "# LLM bake-off report",
    "",
    `- Run: ${head.run}`,
    `- Date: ${head.date}`,
    "- Roster checked: 2026-11-17",
    "",
  ];
  L.push("## Role verdicts", "", "| Role | Model | Result |", "| --- | --- | --- |");
  for (const [r, m, v] of rows) L.push(`| ${r} | ${m} | ${v} |`);
  L.push("", "## Summary", "", "| Model | Result |", "| --- | --- |");
  return L.join("\n") + "\n";
}

const G = "openai/gpt-oss-120b";
const H = "openai/gpt-oss-20b";

describe("V2-format reports (category rows, D-1404)", () => {
  it("R6 = the steelman category plus injection, every check ok, trains no and dated", () => {
    const rep = parseReport(
      v2({ run: "r1", date: "2026-11-01" }, { [G]: { cats: { steelman: "ok", injection: "ok" } } }),
    )!;
    expect(roleResults(rep)).toEqual({ R6: [G] });
  });

  it("a failed check, a missing injection category, a training model or an undated value withdraws the model", () => {
    const run = (cats: Record<string, Check>, trains?: string) =>
      roleResults(parseReport(v2({ run: "r1", date: "2026-11-01" }, { [G]: { cats, trains } }))!);
    expect(run({ steelman: "FAIL", injection: "ok" })).toEqual({ R6: [] });
    expect(run({ steelman: "ok", injection: "FAIL" })).toEqual({ R6: [] });
    expect(run({ steelman: "ok" })).toEqual({}); // no injection rows: the report does not cover the role at all
    expect(
      run({ steelman: "ok", injection: "ok" }, "yes (facts only); checked 2026-11-01"),
    ).toEqual({ R6: [] });
    expect(run({ steelman: "ok", injection: "ok" }, "no; checked NOT DATED")).toEqual({ R6: [] });
  });

  it("R1 needs triage and the classifier, R2 needs three categories", () => {
    const cats = {
      triage: "ok",
      classifier: "ok",
      faithfulness: "ok",
      json_validity: "ok",
      refusal: "FAIL",
      injection: "ok",
    } as const;
    expect(
      roleResults(parseReport(v2({ run: "r", date: "2026-11-01" }, { [G]: { cats } }))!),
    ).toEqual({ R1: [G], R2: [] });
  });
});

describe("M22-format reports (Role verdicts table)", () => {
  it("reads PASS and FAIL rows per role; words and R7 are roles of their own", () => {
    const rep = parseReport(
      m22({ run: "r2", date: "2026-11-20" }, [
        ["R6", G, "PASS"],
        ["R6", H, "FAIL"],
        ["R7", G, "FAIL"],
        ["words", H, "PASS"],
        ["R9", H, "PASS"],
      ]),
    )!;
    expect(roleResults(rep)).toEqual({ R6: [G], R7: [], words: [H] });
  });
});

describe("the index (newest report wins)", () => {
  const pass = (run: string, date: string) =>
    v2({ run, date }, { [G]: { cats: { steelman: "ok", injection: "ok" } } });
  const fail = (run: string, date: string) =>
    v2({ run, date }, { [G]: { cats: { steelman: "FAIL", injection: "ok" } } });

  it("a newer FAIL supersedes an older PASS, and the older PASS stays superseded whatever the file names", () => {
    const idx = buildIndex([
      { file: "z-old.md", text: pass("r1", "2026-11-01") },
      { file: "a-new.md", text: fail("r2", "2026-11-05") },
    ]);
    expect(idx.R6).toMatchObject({
      verdict: "FAIL",
      date: "2026-11-05",
      report: "a-new.md",
      models: [],
    });
  });

  it("a newer PASS supersedes an older FAIL; the same date is ordered by run id, numerically", () => {
    const idx = buildIndex([
      { file: "a.md", text: fail("run-9", "2026-11-05") },
      { file: "b.md", text: pass("run-10", "2026-11-05") },
    ]);
    expect(idx.R6).toMatchObject({ verdict: "PASS", run: "run-10", models: [G] });
  });

  it("the same date and run: the FAIL wins (fail closed)", () => {
    const idx = buildIndex([
      { file: "a.md", text: pass("r", "2026-11-05") },
      { file: "b.md", text: fail("r", "2026-11-05") },
    ]);
    expect(idx.R6!.verdict).toBe("FAIL");
  });

  it("a report that does not cover a role does not change that role's verdict", () => {
    const idx = buildIndex([
      { file: "a.md", text: pass("r1", "2026-11-01") },
      { file: "b.md", text: m22({ run: "r2", date: "2026-11-09" }, [["R7", G, "FAIL"]]) },
    ]);
    expect(idx.R6!.verdict).toBe("PASS");
    expect(idx.R7!.verdict).toBe("FAIL");
  });

  it("files that are not bake-off reports are ignored; a report without a valid date or run stops the build", () => {
    expect(buildIndex([{ file: "AT-01.md", text: "# AT-01\n- Date: nonsense\n" }])).toEqual({});
    expect(() =>
      buildIndex([{ file: "x.md", text: "# LLM bake-off report\n- Run: r\n- Date: soon\n" }]),
    ).toThrow(/x\.md/);
    expect(() =>
      buildIndex([{ file: "y.md", text: "# LLM bake-off report\n- Date: 2026-11-01\n" }]),
    ).toThrow(/y\.md/);
  });

  it("the generated module is a fixed rendering of the index", async () => {
    const files = [{ file: "a.md", text: pass("r1", "2026-11-01") }];
    const a = await render(ROOT, files);
    expect(a).toBe(await render(ROOT, files));
    expect(a).toContain('report: "a.md"');
    expect(a).toContain("GENERATED by scripts/llm/bakeoff-index.mjs");
  });
});

describe("--check and --write (command line)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const script = path.join(ROOT, "scripts/llm/bakeoff-index.mjs");
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  function tmpRoot(): string {
    const d = mkdtempSync(path.join(os.tmpdir(), "bakeoff-"));
    dirs.push(d);
    mkdirSync(path.join(d, "docs/test-reports"), { recursive: true });
    mkdirSync(path.join(d, "src/lib/llm"), { recursive: true });
    return d;
  }

  it("the committed module is current", () => {
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });

  it("--check fails on a stale module and passes after --write", () => {
    const d = tmpRoot();
    writeFileSync(path.join(d, "src/lib/llm/bakeoffIndex.generated.ts"), "// old\n");
    expect(run(["--check", "--root", d]).status).toBe(1);
    writeFileSync(
      path.join(d, "docs/test-reports/r.md"),
      v2({ run: "r1", date: "2026-11-01" }, { [G]: { cats: { steelman: "ok", injection: "ok" } } }),
    );
    expect(run(["--write", "--root", d]).status).toBe(0);
    expect(run(["--check", "--root", d]).status).toBe(0);
    expect(readFileSync(path.join(d, "src/lib/llm/bakeoffIndex.generated.ts"), "utf8")).toContain(
      G,
    );
    // a report added later makes the module stale again
    writeFileSync(
      path.join(d, "docs/test-reports/s.md"),
      v2(
        { run: "r2", date: "2026-11-02" },
        { [G]: { cats: { steelman: "FAIL", injection: "ok" } } },
      ),
    );
    expect(run(["--check", "--root", d]).status).toBe(1);
  });

  it("a report without a date fails the run (exit 1) and a bad mode is a usage error (exit 2)", () => {
    const d = tmpRoot();
    writeFileSync(path.join(d, "docs/test-reports/bad.md"), "# LLM bake-off report\n- Run: r\n");
    expect(run(["--write", "--root", d]).status).toBe(1);
    expect(run(["--bogus"]).status).toBe(2);
  });
});

describe("the committed index", () => {
  it("has a verdict only for roles the harness knows, each PASS with models and each FAIL with none", () => {
    for (const [role, v] of Object.entries(BAKEOFF_INDEX)) {
      expect(["R1", "R2", "R6", "R7", "words"], role).toContain(role);
      expect(v!.verdict === "PASS" ? v!.models.length > 0 : v!.models.length === 0, role).toBe(
        true,
      );
    }
  });
});
