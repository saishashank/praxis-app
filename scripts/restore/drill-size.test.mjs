// V1-S5: the production-size drill script, run at a small size so CI stays fast. Local temp
// libSQL files only; synthetic rows; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ROWS, parseArgs, run } from "./drill-size.mjs";

test("defaults are production size and bounded batches", () => {
  const a = parseArgs([]);
  assert.equal(a.rows, DEFAULT_ROWS);
  assert.equal(DEFAULT_ROWS, 500_000);
  assert.ok(a.chunk >= 1 && a.chunk <= 5000);
});

test("bad options are refused", () => {
  assert.throws(() => parseArgs(["--rows", "0"]), /bad value/);
  assert.throws(() => parseArgs(["--nope", "1"]), /unknown option/);
});

test("a small synthetic drill restores in many batches with identical checksums", async () => {
  const lines = [];
  const code = await run(["--rows", "6000", "--chunk", "700"], { out: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join("\n"));
  const text = lines.join("\n");
  assert.match(text, /drill-size: PASS rows=6000 checksums identical/);
  assert.doesNotMatch(text, /SYNTH-ROW/);
});

test("a time limit that is exceeded fails the drill", async () => {
  const lines = [];
  let t = 0;
  const code = await run(["--rows", "1500", "--max-seconds", "1"], {
    out: (l) => lines.push(l),
    now: () => (t += 3000), // every reading is 3 s later: restore "took" 3 s
  });
  assert.equal(code, 1);
  assert.match(lines.join("\n"), /drill-size: FAIL/);
});
