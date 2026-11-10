// GL-07 (O-52): first step of a scheduled run of watchdog.yml / ingest-batch1.yml. GitHub cron is UTC
// only, so each Melbourne target has one line per DST regime (`genWatchdogCron.mjs`); the line of the
// other regime must be a no-op (PLT-019). This maps `github.event.schedule` plus the current
// Melbourne offset back to a slot with `slotForSchedule` and writes `run` and `slot` to
// GITHUB_OUTPUT. A dispatch (no SCHEDULE_CRON) always runs.
//   env: SCHEDULE_CRON (the schedule line, empty on dispatch), GITHUB_OUTPUT (optional)
//   node scripts/time/scheduleGate.mjs HH:MM [HH:MM ...]
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { offsetMinutes, slotForSchedule } from "./genWatchdogCron.mjs";

/**
 * D-914: GitHub can start a scheduled run hours late (the 07:15 UTC Batch-1 line of 2026-11-09 started
 * at 17:31 UTC, after midnight in Sydney, and failed on the next day's empty date). A run that starts
 * more than this long after its Melbourne time is skipped: the Worker dispatch it backs up has run or
 * failed visibly by then, and a run against the wrong day only turns System Health red.
 */
export const MAX_LATE_MIN = 240;

/** Minutes the run at `nowMs` starts after the Melbourne time "HHMM" (wrapping at midnight). */
export function lateMinutes(slot, nowMs) {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const off = offsetMinutes(date);
  const utcMin = Math.floor(nowMs / 60000) % 1440;
  const localNow = (((utcMin + off) % 1440) + 1440) % 1440;
  const slotMin = Number(slot.slice(0, 2)) * 60 + Number(slot.slice(2, 4));
  let late = localNow - slotMin;
  if (late > 720) late -= 1440;
  if (late < -720) late += 1440;
  return late;
}

/**
 * @returns {{ run: boolean, slot: string, late?: boolean }} slot is "" on dispatch and on a skipped
 *   run; `late` marks a run skipped for starting more than MAX_LATE_MIN after its time.
 */
export function gate(cron, nowMs, times) {
  if (!cron) return { run: true, slot: "" };
  const slot = slotForSchedule(cron, nowMs, times);
  if (slot === null) return { run: false, slot: "" };
  if (lateMinutes(slot, nowMs) > MAX_LATE_MIN) return { run: false, slot: "", late: true };
  return { run: true, slot };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const times = process.argv.slice(2);
  if (times.length === 0) {
    console.log("schedule-gate: failed (usage: scheduleGate.mjs HH:MM [HH:MM ...])");
    process.exit(1);
  }
  const g = gate(process.env.SCHEDULE_CRON ?? "", Date.now(), times);
  console.log(
    g.run
      ? `schedule-gate: run slot=${g.slot || "dispatch"}`
      : g.late
        ? `schedule-gate: skipped (started more than ${MAX_LATE_MIN} min after its time)`
        : "schedule-gate: skipped (the other DST regime's line)",
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${g.run}\nslot=${g.slot}\n`);
  }
}
