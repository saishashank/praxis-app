// M8 T18: the CI minutes table (decision 49, BLD-023, TST-132). Fixture only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTable, parseRuns, renderTable } from "./minutes-table.mjs";

const run = (name, start, end, conclusion = "success", status = "completed") => ({
  name,
  status,
  conclusion,
  run_started_at: start,
  updated_at: end,
  html_url: "https://example.test/secret/run",
  head_branch: "private-branch",
});
const page1 = {
  total_count: 4,
  workflow_runs: [
    run("ci", "2026-10-20T10:00:00Z", "2026-10-20T10:12:30Z"),
    run("ci", "2026-10-20T11:00:00Z", "2026-10-20T11:08:00Z", "failure"),
  ],
};
const page2 = {
  total_count: 4,
  workflow_runs: [
    run("backup", "2026-10-21T02:00:00Z", "2026-10-21T02:03:00Z"),
    run("ci", "2026-10-21T03:00:00Z", "2026-10-21T03:05:00Z", null, "in_progress"),
  ],
};

test("parses one object, an array of pages and glued gh --paginate pages", () => {
  assert.equal(parseRuns(JSON.stringify(page1)).length, 2);
  assert.equal(parseRuns(JSON.stringify([page1, page2])).length, 4);
  assert.equal(parseRuns(`${JSON.stringify(page1)}\n${JSON.stringify(page2)}`).length, 4);
  assert.deepEqual(parseRuns(""), []);
  assert.throws(() => parseRuns("not json {"));
});

test("sums completed runs per workflow, skips unfinished ones, sorts by minutes", () => {
  const t = buildTable(parseRuns(`${JSON.stringify(page1)}${JSON.stringify(page2)}`));
  assert.deepEqual(
    t.rows.map((r) => r.name),
    ["ci", "backup"],
  );
  const ci = t.rows[0];
  assert.equal(ci.runs, 2);
  assert.equal(ci.success, 1);
  assert.equal(ci.failure, 1);
  assert.equal(ci.minutes, 20.5);
  assert.equal(ci.max, 12.5);
  assert.equal(t.totals.runs, 3);
  assert.equal(t.totals.minutes, 23.5);
  assert.equal(t.totals.skipped, 1);
  assert.equal(t.totals.from, "2026-10-20");
  assert.equal(t.totals.to, "2026-10-21");
});

test("the rendered table has the totals line and no URL or branch text", () => {
  const out = renderTable(buildTable(parseRuns(JSON.stringify([page1, page2]))));
  assert.match(out, /^\| Workflow \| Runs/);
  assert.match(out, /\| ci \| 2 \| 1 \| 1 \| 0 \| 20\.5 \| 10\.3 \| 12\.5 \| 87\.2 % \|/);
  assert.match(out, /\*\*Total\*\* \| 3/);
  assert.doesNotMatch(out, /example\.test|private-branch|https?:/);
});

test("an empty input renders without dividing by zero", () => {
  const out = renderTable(buildTable([]));
  assert.match(out, /no completed runs/);
});
