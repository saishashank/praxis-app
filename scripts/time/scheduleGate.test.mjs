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

test("D-914: a scheduled run that starts hours late is skipped, a few minutes late still runs", async () => {
  const { lateMinutes, MAX_LATE_MIN } = await import("./scheduleGate.mjs");
  // the 2026-11-09 case: the 07:15 UTC line (18:15 AEDT) started at 17:31 UTC = 04:31 next day
  const LATE = Date.parse("2026-11-09T17:31:36Z");
  assert.deepEqual(gate("15 7 * * *", LATE, ["18:15"]), { run: false, slot: "", late: true });
  assert.equal(lateMinutes("1815", LATE), 616); // 04:31 is 10 h 16 min after 18:15
  const ON_TIME = Date.parse("2026-11-09T07:21:00Z"); // 18:21 AEDT
  assert.deepEqual(gate("15 7 * * *", ON_TIME, ["18:15"]), { run: true, slot: "1815" });
  const LIMIT = Date.parse("2026-11-09T11:15:00Z"); // 22:15 AEDT, exactly the limit
  assert.equal(lateMinutes("1815", LIMIT), MAX_LATE_MIN);
  assert.equal(gate("15 7 * * *", LIMIT, ["18:15"]).run, true);
});

test("D-1861: a run 12 h or more late is skipped, not read as early", async () => {
  const { lateMinutes } = await import("./scheduleGate.mjs");
  // the 2026-11-23 case: the 07:15 UTC line (18:15 AEDT) started at 19:15 UTC = 06:15 next day
  const TWELVE = Date.parse("2026-11-23T19:15:49Z");
  assert.equal(lateMinutes("1815", TWELVE), 720);
  assert.deepEqual(gate("15 7 * * *", TWELVE, ["18:15"]), { run: false, slot: "", late: true });
  const THIRTEEN = Date.parse("2026-11-23T20:20:00Z"); // 07:20 next day
  assert.equal(lateMinutes("1815", THIRTEEN), 785);
  assert.equal(gate("15 7 * * *", THIRTEEN, ["18:15"]).run, false);
  // a clock a few minutes early still runs; a run just after midnight for a 23:55 slot is 10 min late
  assert.equal(lateMinutes("1815", Date.parse("2026-11-23T07:12:00Z")), -3);
  assert.equal(lateMinutes("2355", Date.parse("2026-11-23T13:05:00Z")), 10);
  assert.equal(lateMinutes("0005", Date.parse("2026-11-23T12:58:00Z")), -7);
});
