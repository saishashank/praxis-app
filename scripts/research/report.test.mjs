// M23 R1 (D-1610): the report script writes the one format from a result JSON, anywhere outside the repo, and refuses
// a verdict outside the three words and a private path. Synthetic data only; no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeReport } from "./report.mjs";

const SHA = "c".repeat(64);
const input = (over = {}) => ({
  item: "CXA-903",
  title: "Synthetic script test",
  lineage: "zz_script",
  market: "ZZ",
  verdict: "NULL",
  hypothesis: "A synthetic hypothesis.",
  prereg: {
    file: "docs/research/prereg/CXA-903.json",
    sha256: SHA,
    commit: "1111111",
    date: "2026-11-17",
    runnerCommit: "2222222",
  },
  data: {
    sourceClass: "synthetic",
    window: "synthetic",
    universe: "synthetic",
    knownTime: "none",
    caveats: ["survivors only"],
  },
  split: { kind: "full", reason: "synthetic" },
  n: { setups: 70, sessions: 70, blocks: 22, floorSetups: 60, floorBlocks: 20, floorMet: true },
  statistic: {
    definition: "Mean excess.",
    costProfile: "P6",
    parcel: "600",
    control: "matched",
    haircut: "assumed",
  },
  result: { unit: "ppm", alpha: 0.1, rows: [{ window: "full", mean: -10, lower: -50, n: 70 }] },
  verdictReason: "the lower bound is not above zero",
  looks: [{ lineage: "zz_script", market: "ZZ", date: "2026-11-18", sha: SHA, verdict: "NULL" }],
  refusals: [],
  next: "Stays in shadow.",
  ...over,
});

function withTemp(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-report-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("writes the report to --out from a result file", () =>
  withTemp(async (dir) => {
    const result = path.join(dir, "result.json");
    const out = path.join(dir, "out", "CXA-903.md");
    writeFileSync(result, JSON.stringify(input()));
    const written = await writeReport(["--result", result, "--out", out]);
    assert.equal(written, out);
    const text = readFileSync(out, "utf8");
    assert.match(text, /^# CXA-903 Synthetic script test\n/);
    assert.match(text, /Status: NULL/);
    for (const s of [
      "Hypothesis",
      "Pre-registration",
      "Data",
      "Split",
      "n",
      "Statistic",
      "Result",
      "Verdict",
      "Looks",
      "Next",
    ]) {
      assert.ok(text.includes(`\n## ${s}\n`), s);
    }
    assert.ok(text.includes(`| zz_script | ZZ | 2026-11-18 | ${"c".repeat(12)} | NULL |`));
  }));

test("refuses a verdict outside PASS / NULL / INCONCLUSIVE and writes nothing", () =>
  withTemp(async (dir) => {
    const result = path.join(dir, "result.json");
    const out = path.join(dir, "bad.md");
    writeFileSync(result, JSON.stringify(input({ verdict: "fail" })));
    await assert.rejects(writeReport(["--result", result, "--out", out]), /verdict must be one of/);
    assert.throws(() => readFileSync(out, "utf8"));
  }));

test("refuses a private path in the text, a bad item name and bad arguments", () =>
  withTemp(async (dir) => {
    const result = path.join(dir, "result.json");
    writeFileSync(result, JSON.stringify(input({ next: "read C:/private/history/x" })));
    await assert.rejects(
      writeReport(["--result", result, "--out", path.join(dir, "a.md")]),
      /private path/,
    );
    writeFileSync(result, JSON.stringify(input({ item: "../escape" })));
    await assert.rejects(
      writeReport(["--result", result, "--out", path.join(dir, "b.md")]),
      /file-name token/,
    );
    await assert.rejects(writeReport([]), /--result/);
    await assert.rejects(writeReport(["--bogus"]), /unknown argument/);
  }));
