// Timestamps are stored in UTC (PLT-023) and shown in Australia/Melbourne (UX). The user's time
// format preference (UX-110) only changes the hour cycle; the zone stays Melbourne.
export type TimeFormat = "24h" | "12h";

const base: Intl.DateTimeFormatOptions = {
  timeZone: "Australia/Melbourne",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
};
const FMT: Record<TimeFormat, Intl.DateTimeFormat> = {
  "24h": new Intl.DateTimeFormat("en-AU", { ...base, hourCycle: "h23" }),
  "12h": new Intl.DateTimeFormat("en-AU", { ...base, hour12: true }),
};

export function formatTime(
  value: string | Date | null,
  prefs?: { time_format?: TimeFormat } | null,
): string {
  if (!value) return "Never";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const f = FMT[prefs?.time_format === "12h" ? "12h" : "24h"];
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const clock = `${p.hour}:${p.minute}${p.dayPeriod ? ` ${p.dayPeriod.toLowerCase()}` : ""}`;
  return `${p.year}-${p.month}-${p.day} ${clock} ${p.timeZoneName}`;
}

export function formatMelbourne(iso: string | null, timeFormat: TimeFormat = "24h"): string {
  return formatTime(iso, { time_format: timeFormat });
}
