// Fixed texts and small pure helpers of the News page (UXN-035, UXN-038, UXN-158, UXN-160). No server
// imports, so client islands can use them.

export type Polarity = -1 | 0 | 1 | null;

/** The tag is our own rule-based classification and says so (UXN-158). */
export function polarityLabel(p: Polarity): string {
  if (p === null) return "Not assessed yet";
  if (p > 0) return "Good for our trades · rule-based";
  if (p < 0) return "Bad for our trades · rule-based";
  return "Neutral for our trades · rule-based";
}

export const POLARITY_HOW =
  "Rule-based: our announcement rules set this tag from the kind of announcement (for example results, guidance, a takeover or a trading halt). It is not a prediction and not a third-party sentiment score.";

export const MATERIALITY_WORD = ["not important", "minor", "important", "very important"] as const;
export function materialityLabel(m: number | null): string {
  if (m === null) return "Importance not assessed yet";
  return `Importance: ${MATERIALITY_WORD[Math.min(Math.max(m, 0), 3)]}`; // threshold-ok: materiality scale 0..3
}

export const SOURCE_LINE = "Source: exchange announcement";
export const NO_SUMMARY = "Summary not written yet.";
export const HELD_TAG = "Held by our strategies";

const WEEK_RE = /^\d{4}-W\d{2}$/;
const MELBOURNE = "Australia/Melbourne";

/** An ISO week stays as "Week 2026-W43"; a timestamp becomes Melbourne time. */
export function whenText(v: string): string {
  if (WEEK_RE.test(v)) return `Week ${v}`;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return "n/a";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(t));
}

// ---- snooze options (UXN-160: 1 hour, 4 hours, until tomorrow) -------------------------------------

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

/** D-200: the short text under a headline; nothing when it would only repeat the headline. */
export function shortText(n: {
  summary: string | null;
  type: string | null;
  title: string;
}): string | null {
  const t = n.summary ?? n.type;
  if (!t) return null;
  const same = (a: string) => a.trim().toLowerCase();
  return same(t) === same(n.title) ? null : t;
}
