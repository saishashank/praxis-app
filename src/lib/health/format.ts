// Timestamps are stored in UTC (PLT-023) and shown in the Owner zone, Melbourne (UX). The user's time
// format preference (UX-110) only changes the hour cycle; the zone stays Melbourne. A market whose zone
// has a different offset from Melbourne at that instant shows both (UXN-313, D-1002): `formatMarketTime`.
import { OWNER_TZ } from "@/lib/market/profileCore.mjs";

export type TimeFormat = "24h" | "12h";

const base: Intl.DateTimeFormatOptions = {
  timeZone: OWNER_TZ,
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

function offsetMinutes(tz: string, at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((x) => x.type === "timeZoneName")?.value;
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(part ?? "");
  if (m === null) return 0;
  if (m[1] === undefined) return 0;
  const total = Number(m[2]) * 60 + Number(m[3]); // threshold-ok: minutes per hour
  return m[1] === "-" ? -total : total;
}

/**
 * An instant for a market (UXN-313, D-1002): when the market zone has the same UTC offset as the Owner
 * zone (Melbourne) at that instant, the single Melbourne form of `formatTime` (so an AU market, whose zone
 * is Sydney, is unchanged to the byte); otherwise "<date> HH:MM <zone> · HH:MM Melbourne".
 */
export function formatMarketTime(
  value: string | Date | null,
  marketTz: string,
  prefs?: { time_format?: TimeFormat } | null,
): string {
  if (!value) return "Never";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "Unknown";
  if (offsetMinutes(marketTz, d) === offsetMinutes(OWNER_TZ, d)) return formatTime(d, prefs);
  const hour12 = prefs?.time_format === "12h";
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: marketTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
    ...(hour12 ? { hour12: true } : { hourCycle: "h23" as const }),
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const clock = `${p.hour}:${p.minute}${p.dayPeriod ? ` ${p.dayPeriod.toLowerCase()}` : ""}`;
  const own = FMT[hour12 ? "12h" : "24h"];
  const q = Object.fromEntries(own.formatToParts(d).map((x) => [x.type, x.value]));
  const ownClock = `${q.hour}:${q.minute}${q.dayPeriod ? ` ${q.dayPeriod.toLowerCase()}` : ""}`;
  return `${p.year}-${p.month}-${p.day} ${clock} ${p.timeZoneName} · ${ownClock} Melbourne`;
}
