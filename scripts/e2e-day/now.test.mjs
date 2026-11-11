// M18 D2 (OPS-107, D-965): the --now flag of the recorded-day scripts. Refused outside the recorded
// environment, so production can never run on a simulated clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNow } from "./now.mjs";
import { run as batch1 } from "../ingest/batch1.mjs";
import { run as closeBooks } from "../arena/close-books.mjs";
import { run as signals } from "../arena/signals.mjs";

const REC = { PRAXIS_ENV: "recorded" };

test("no flag: nothing changes", () => {
  const argv = ["run", "--bars", "b.json"];
  const r = parseNow(argv, REC);
  assert.deepEqual(r, { argv, nowMs: undefined, error: null });
});

test("the flag is removed from argv and the clock starts at the instant and keeps ticking", () => {
  let real = 1_000_000;
  const r = parseNow(
    ["--date", "2026-11-12", "--now", "2026-11-12T18:10:00+11:00", "--phase", "all"],
    REC,
    () => real,
  );
  assert.equal(r.error, null);
  assert.deepEqual(r.argv, ["--date", "2026-11-12", "--phase", "all"]);
  assert.equal(r.nowMs(), Date.parse("2026-11-12T07:10:00Z"));
  real += 90_000;
  assert.equal(r.nowMs(), Date.parse("2026-11-12T07:11:30Z"));
});

test("refused unless PRAXIS_ENV=recorded (production, staging, unset)", () => {
  for (const env of [{}, { PRAXIS_ENV: "production" }, { PRAXIS_ENV: "staging" }]) {
    const r = parseNow(["--now", "2026-11-12T07:10:00Z"], env);
    assert.match(r.error, /only accepted when PRAXIS_ENV=recorded/);
    assert.equal(r.nowMs, undefined);
  }
});

test("a malformed instant is refused (date only, no zone, text, missing)", () => {
  for (const bad of ["2026-11-12", "2026-11-12T07:10:00", "tomorrow", undefined]) {
    const r = parseNow(bad === undefined ? ["--now"] : ["--now", bad], REC);
    assert.match(r.error, /ISO instant/, String(bad));
  }
});

test("batch1, close-books and signals refuse --now outside the recorded environment before touching anything", async () => {
  const lines = [];
  const out = (s) => lines.push(String(s));
  for (const [name, fn, argv] of [
    ["batch1", batch1, ["run", "--now", "2026-11-12T06:30:00Z"]],
    ["close-books", closeBooks, ["--now", "2026-11-12T06:50:00Z"]],
    ["signals", signals, ["--now", "2026-11-12T07:10:00Z"]],
  ]) {
    const code = await fn(
      argv,
      { PRAXIS_ENV: "production", TURSO_MAIN_URL: "file:/nonexistent" },
      { out },
    );
    assert.equal(code, 2, name);
  }
  assert.ok(
    lines.every((l) => /--now/.test(l)),
    lines.join("|"),
  );
});
