// GL-07: the schedule gate runs only the cron line of the current DST regime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronLinesFor } from "./genWatchdogCron.mjs";
import { gate } from "./scheduleGate.mjs";

const SUMMER = Date.parse("2026-01-15T10:40:00Z"); // AEDT
const WINTER = Date.parse("2026-07-15T10:40:00Z"); // AEST

test("dispatch always runs", () => {
  assert.deepEqual(gate("", SUMMER, ["20:40"]), { run: true, slot: "" });
});

test("only the line of the current regime runs, the other is a no-op", () => {
  const [daylight, standard] = cronLinesFor("20:40");
  assert.deepEqual(gate(daylight, SUMMER, ["20:40", "21:50"]), { run: true, slot: "2040" });
  assert.equal(gate(standard, SUMMER, ["20:40", "21:50"]).run, false);
  assert.deepEqual(gate(standard, WINTER, ["20:40", "21:50"]), { run: true, slot: "2040" });
  assert.equal(gate(daylight, WINTER, ["20:40", "21:50"]).run, false);
});

test("an unknown line never runs", () => {
  assert.equal(gate("1 2 * * *", SUMMER, ["20:40"]).run, false);
});

test("the Batch-1 fallback lines are 07:15 and 08:15 UTC for 18:15 Melbourne", () => {
  assert.deepEqual(cronLinesFor("18:15"), ["15 7 * * *", "15 8 * * *"]);
  assert.deepEqual(gate("15 7 * * *", SUMMER, ["18:15"]), { run: true, slot: "1815" });
  assert.equal(gate("15 7 * * *", WINTER, ["18:15"]).run, false);
});
