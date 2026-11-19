// Tests of the seed call proposals script (M22 E3; D-1435): node --test, no network, no database; a synthetic seed
// (ZZ codes) in a temp folder outside the repository. Never private seed data.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callClaimsOf, codesOfFile, FORMAT, OUT_FILE, run } from "./call-proposals.mjs";

const seed = (extra = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "call-seed-"));
  const w = (name, v) => writeFileSync(path.join(dir, name), JSON.stringify(v));
  w("manifest.json", {
    format: "praxis-expert-seed/1",
    market: "AU",
    created_at: "2030-01-01T00:00:00Z",
  });
  w("claims.json", {
    claims: [
      { id: "C-ZZ-1", type: "call", statement: "Buy ZZA on 2030-02-04 for 20 trading days." },
      { id: "C-ZZ-2", type: "call", statement: "ZZA looks weak, a sell." },
      {
        id: "C-ZZ-3",
        type: "call",
        statement: "The index will fall from 2030-01-10 for 5 sessions.",
      },
      { id: "C-ZZ-4", type: "method", statement: "Buy ZZA on 2030-02-04 for 20 trading days." },
      { id: 5, type: "call" },
    ],
  });
  if (extra["calls.json"]) w("calls.json", extra["calls.json"]);
  return dir;
};
const capture = () => {
  const lines = [];
  return { lines, out: (s) => lines.push(s) };
};
const opts = { allowInsideRepo: true, now: () => new Date("2030-01-01T00:00:00Z") };

test("a dry run prints counts only and writes nothing", async () => {
  const dir = seed({
    "calls.json": { calls: [{ claim_id: "C-ZZ-9", market: "AU", code: "ZZA" }] },
  });
  try {
    const c = capture();
    assert.equal(await run(["--seed", dir, "--dry-run"], {}, { ...opts, out: c.out }), 0);
    assert.equal(c.lines.length, 1);
    assert.match(c.lines[0], /3 call claims, 1 complete, 1 incomplete/);
    assert.match(c.lines[0], /1 not trackable/);
    assert.match(c.lines[0], /dry run, nothing written/);
    assert.doesNotMatch(c.lines[0], /ZZA|2030|Buy/);
    assert.equal(existsSync(path.join(dir, OUT_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a universe no code is found, so nothing is complete", async () => {
  const dir = seed();
  try {
    const c = capture();
    assert.equal(await run(["--seed", dir, "--dry-run"], {}, { ...opts, out: c.out }), 0);
    assert.match(c.lines[0], /0 complete, 2 incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a universe file adds codes; a real run writes call-proposals.json beside the seed", async () => {
  const dir = seed();
  const uni = path.join(dir, "universe.txt");
  writeFileSync(uni, "# codes\nZZA\nZZB\n");
  try {
    const c = capture();
    assert.equal(await run(["--seed", dir, "--universe", uni], {}, { ...opts, out: c.out }), 0);
    const body = JSON.parse(readFileSync(path.join(dir, OUT_FILE), "utf8"));
    assert.equal(body.format, FORMAT);
    assert.equal(body.market, "AU");
    assert.deepEqual(
      body.proposals.map((p) => [p.claim_id, p.state]),
      [
        ["C-ZZ-1", "complete"],
        ["C-ZZ-2", "incomplete"],
        ["C-ZZ-3", "not_trackable"],
      ],
    );
    assert.equal(body.proposals[0].code, "ZZA");
    assert.equal(body.proposals[0].horizon_sessions, 20);
    assert.match(c.lines[0], /wrote call-proposals\.json beside the seed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses a seed folder inside the repository, a missing folder argument and unreadable files", async () => {
  const c = capture();
  assert.equal(await run(["--seed", path.resolve("tests"), "--dry-run"], {}, { out: c.out }), 1);
  assert.match(c.lines[0], /outside the repository/);
  assert.equal(await run([], {}, { out: c.out }), 1);
  const dir = mkdtempSync(path.join(tmpdir(), "call-seed-"));
  try {
    assert.equal(await run(["--seed", dir], {}, { ...opts, out: c.out }), 1);
    writeFileSync(path.join(dir, "claims.json"), "{");
    writeFileSync(path.join(dir, "manifest.json"), "{}");
    assert.equal(await run(["--seed", dir], {}, { ...opts, out: c.out }), 1);
    assert.match(c.lines.at(-1), /not readable/);
    assert.doesNotMatch(c.lines.at(-1), /\{/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codesOfFile reads JSON lists and lines; callClaimsOf skips malformed rows", () => {
  assert.deepEqual(codesOfFile('["A1","B2",3]'), ["A1", "B2"]);
  assert.deepEqual(codesOfFile("# c\nA1\r\n\nB2\n"), ["A1", "B2"]);
  assert.deepEqual(
    callClaimsOf({ claims: [{ id: "x", type: "call", statement: "s" }, null, { type: "call" }] }),
    [{ id: "x", statement: "s" }],
  );
  assert.deepEqual(callClaimsOf(null), []);
});
