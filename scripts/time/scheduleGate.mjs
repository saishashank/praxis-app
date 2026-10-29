// GL-07 (O-52): first step of a scheduled run of watchdog.yml / ingest-batch1.yml. GitHub cron is UTC
// only, so each Melbourne target has one line per DST regime (`genWatchdogCron.mjs`); the line of the
// other regime must be a no-op (PLT-019). This maps `github.event.schedule` plus the current
// Melbourne offset back to a slot with `slotForSchedule` and writes `run` and `slot` to
// GITHUB_OUTPUT. A dispatch (no SCHEDULE_CRON) always runs.
//   env: SCHEDULE_CRON (the schedule line, empty on dispatch), GITHUB_OUTPUT (optional)
//   node scripts/time/scheduleGate.mjs HH:MM [HH:MM ...]
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { slotForSchedule } from "./genWatchdogCron.mjs";

/** @returns {{ run: boolean, slot: string }} slot is "" on dispatch and on a skipped run. */
export function gate(cron, nowMs, times) {
  if (!cron) return { run: true, slot: "" };
  const slot = slotForSchedule(cron, nowMs, times);
  return slot === null ? { run: false, slot: "" } : { run: true, slot };
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
      : "schedule-gate: skipped (the other DST regime's line)",
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `run=${g.run}\nslot=${g.slot}\n`);
  }
}
