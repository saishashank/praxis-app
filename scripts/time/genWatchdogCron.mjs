// Prints the dual-UTC GitHub `schedule:` lines for the YAML watchdog (M5 T12, docs/M5_design.md
// section 2 DST, D-096 decisions 11 and 14; PLT-019). GitHub cron is UTC only, so each Melbourne
// target time needs one line for daylight time (AEDT, UTC+11) and one for standard time (AEST,
// UTC+10); the first step of a scheduled run maps `github.event.schedule` plus the current
// Melbourne offset back to a slot and exits 0 on the wrong line (`slotForSchedule` below).
//   node scripts/time/genWatchdogCron.mjs [HH:MM ...]      (default 20:40 21:50)
// The output is for the Owner to paste into .github/workflows/watchdog.yml in a separate,
// Owner-approved change (PLT-015). watchdog.yml does NOT contain a `schedule:` block today.
import { fileURLToPath } from "node:url";

export const DEFAULT_TIMES = ["20:40", "21:50"];
const TZ = "Australia/Melbourne";
// One date in each regime (2026): AEST in July, AEDT in January.
const STANDARD_REF = "2026-07-15";
const DAYLIGHT_REF = "2026-01-15";

/** Offset of Melbourne from UTC in minutes on a date (noon UTC probe). */
export function offsetMinutes(date) {
  const probe = new Date(`${date}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(probe);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const local = (get("hour") % 24) * 60 + get("minute");
  return (((local - 12 * 60) % 1440) + 1440) % 1440;
}

function toUtc(time, offset) {
  const [h, m] = time.split(":").map(Number);
  const total = (((h * 60 + m - offset) % 1440) + 1440) % 1440;
  return { h: Math.floor(total / 60), m: total % 60 };
}

/** The two cron lines (daylight first, then standard) for one Melbourne time "HH:MM". */
export function cronLinesFor(time) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`bad time: ${time}`);
  return [offsetMinutes(DAYLIGHT_REF), offsetMinutes(STANDARD_REF)].map((off) => {
    const u = toUtc(time, off);
    return `${u.m} ${u.h} * * *`;
  });
}

/** All lines for the targets, sorted by hour then minute, without duplicates. */
export function cronLines(times = DEFAULT_TIMES) {
  const lines = times.flatMap((t) => cronLinesFor(t));
  return [...new Set(lines)].sort((a, b) => {
    const [am, ah] = a.split(" ").map(Number);
    const [bm, bh] = b.split(" ").map(Number);
    return ah - bh || am - bm;
  });
}

/**
 * PLT-019 guard: which target slot (Melbourne "HHMM") a scheduled run firing on `cron` at `nowMs`
 * stands for, or null when this line belongs to the other regime (the run exits 0).
 */
export function slotForSchedule(cron, nowMs, times = DEFAULT_TIMES) {
  const off = offsetMinutes(new Date(nowMs).toISOString().slice(0, 10));
  for (const t of times) {
    const u = toUtc(t, off);
    if (cron === `${u.m} ${u.h} * * *`) return t.replace(":", "");
  }
  return null;
}

/** The YAML text to paste under `on:`. */
export function renderSchedule(times = DEFAULT_TIMES) {
  return ["  schedule:", ...cronLines(times).map((c) => `    - cron: "${c}"`)].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const times = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TIMES;
  console.log(`# Melbourne ${times.join(", ")} as UTC lines (AEDT and AEST). Paste under "on:".`);
  console.log(renderSchedule(times));
}
