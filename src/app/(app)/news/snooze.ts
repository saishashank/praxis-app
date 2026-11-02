// Snooze choices and the snooze-until calculation of the News alert actions (UXN-160). Kept apart from
// text.ts so the client island AlertActions does not pull the other fixed texts into the first load.

const MELBOURNE = "Australia/Melbourne";

export const SNOOZE_CHOICES = ["1h", "4h", "tomorrow"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];
export const SNOOZE_LABEL: Record<SnoozeChoice, string> = {
  "1h": "Snooze 1 hour",
  "4h": "Snooze 4 hours",
  tomorrow: "Snooze until tomorrow",
};

const HOUR_MS = 3_600_000; // threshold-ok: unit conversion
const STEP_MS = 900_000; // threshold-ok: 15-minute search step
const WAKE_HOUR = 7; // threshold-ok: "until tomorrow" ends at 07:00 Melbourne
const SEARCH_STEPS = 4 * 52; // threshold-ok: search window of 52 hours

function melbourneParts(t: number): { d: string; h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "0";
  return {
    d: `${get("year")}-${get("month")}-${get("day")}`,
    h: Number(get("hour")),
    m: Number(get("minute")),
  };
}

/** ISO instant for a snooze choice; "tomorrow" is the next 07:00 Melbourne time on a later calendar day. */
export function snoozeUntil(choice: SnoozeChoice, now: Date): string {
  if (choice === "1h") return new Date(now.getTime() + HOUR_MS).toISOString();
  if (choice === "4h") return new Date(now.getTime() + 4 * HOUR_MS).toISOString(); // threshold-ok: 4 hours
  const today = melbourneParts(now.getTime()).d;
  let t = Math.ceil(now.getTime() / STEP_MS) * STEP_MS;
  for (let i = 0; i < SEARCH_STEPS; i += 1, t += STEP_MS) {
    const p = melbourneParts(t);
    if (p.d > today && p.h === WAKE_HOUR && p.m === 0) return new Date(t).toISOString();
  }
  return new Date(now.getTime() + 24 * HOUR_MS).toISOString(); // threshold-ok: fallback, one day
}
