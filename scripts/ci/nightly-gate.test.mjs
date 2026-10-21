// M8 T12: the nightly gate and green-streak rules (decision 21) with a stubbed GitHub API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_GREENS, main, shouldRun, streakOf } from "./nightly-gate.mjs";

test("three consecutive green nights are required (AT-31, decision 21)", () => {
  assert.equal(REQUIRED_GREENS, 3);
});

test("a dispatch always runs; a scheduled night runs only when main moved", () => {
  const base = { lastGreenAt: "2026-10-20T15:37:00Z", mainCommittedAt: "2026-10-21T01:00:00Z" };
  assert.equal(
    shouldRun({ event: "workflow_dispatch", ...base, mainCommittedAt: "2026-10-01T00:00:00Z" }).run,
    true,
  );
  assert.equal(shouldRun({ event: "schedule", ...base }).run, true);
  assert.equal(
    shouldRun({ event: "schedule", ...base, mainCommittedAt: "2026-10-20T10:00:00Z" }).run,
    false,
  );
  assert.equal(
    shouldRun({ event: "schedule", lastGreenAt: null, mainCommittedAt: "2026-10-20T10:00:00Z" })
      .run,
    true,
  );
  assert.equal(shouldRun({ event: "schedule", ...base, mainCommittedAt: null }).run, false);
});

test("the streak counts green staging jobs, ignores skipped nights and stops at a red one", () => {
  const r = (stagingResult) => ({ createdAt: "x", stagingResult });
  assert.deepEqual(streakOf([r("success"), r("success")], "success"), { greens: 3, broken: false });
  assert.deepEqual(streakOf([r("skipped"), r("success"), r(null), r("success")], "success"), {
    greens: 3,
    broken: false,
  });
  assert.deepEqual(streakOf([r("success"), r("failure"), r("success")], "success"), {
    greens: 2,
    broken: true,
  });
  assert.deepEqual(streakOf([r("success")], "failure"), { greens: 0, broken: true });
  assert.deepEqual(streakOf([r("success"), r("cancelled")], null), { greens: 1, broken: true });
  assert.deepEqual(streakOf([], null), { greens: 0, broken: false });
});

function stub({ runs, jobs, head }) {
  return async (url) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, json: async () => body });
    if (u.includes("/actions/workflows/nightly.yml/runs")) return ok({ workflow_runs: runs });
    const m = /\/actions\/runs\/(\d+)\/jobs/.exec(u);
    if (m) return ok({ jobs: jobs[m[1]] ?? [] });
    if (u.endsWith("/commits/main")) return ok({ commit: { committer: { date: head } } });
    return { ok: false, json: async () => ({}) };
  };
}

test("gate writes run=false when nothing changed and run=true when main moved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nightly-"));
  try {
    const f = stub({
      runs: [{ id: 5, created_at: "2026-10-20T15:37:00Z" }],
      jobs: { 5: [{ name: "staging", conclusion: "success" }] },
      head: "2026-10-20T10:00:00Z",
    });
    const output = path.join(dir, "out");
    const env = {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_OUTPUT: output,
    };
    const lines = [];
    assert.equal(await main(["gate"], env, f, (s) => lines.push(s)), 0);
    assert.match(readFileSync(output, "utf8"), /run=false/);
    const moved = stub({
      runs: [{ id: 5, created_at: "2026-10-20T15:37:00Z" }],
      jobs: { 5: [{ name: "staging", conclusion: "success" }] },
      head: "2026-10-21T02:00:00Z",
    });
    await main(["gate"], env, moved, (s) => lines.push(s));
    assert.match(readFileSync(output, "utf8"), /run=true/);
    assert.doesNotMatch(lines.join("\n"), /https?:|o\/r|2026-/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streak writes the count to the summary and survives an unreadable history with exit 2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nightly-"));
  try {
    const summary = path.join(dir, "sum");
    const f = stub({
      runs: [
        { id: 4, created_at: "a" },
        { id: 3, created_at: "b" },
      ],
      jobs: {
        4: [{ name: "staging", conclusion: "success" }],
        3: [{ name: "staging", conclusion: "success" }],
      },
      head: "x",
    });
    const env = {
      GITHUB_TOKEN: "t",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "9",
      GITHUB_STEP_SUMMARY: summary,
    };
    assert.equal(await main(["streak", "success"], env, f, () => {}), 0);
    assert.match(readFileSync(summary, "utf8"), /streak on staging: 3 of 3/);
    const lines = [];
    const down = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await main(["streak", "success"], env, down, (s) => lines.push(s)), 2);
    assert.equal(await main(["gate"], {}, f, (s) => lines.push(s)), 2);
    assert.doesNotMatch(lines.join("\n"), /https?:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
