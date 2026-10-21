// Deterministic formatting helpers for the email templates (no clock reads, no locale APIs).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-10-19" -> "Mon 19 Oct 2026". Throws on a malformed date. */
export function dateLabel(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`bad date ${d}`);
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Integer cents -> "1,234.56" (no currency, no sign). */
export function amount(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${group(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, "0")}`;
}

/** "AUD 1,234.56" or, when signed, "AUD +1,234.56" / "AUD -1,234.56" (sign is never colour-only). */
export function money(cents: number, currency: string, signed = false): string {
  const sign = cents < 0 ? "-" : signed && cents > 0 ? "+" : "";
  return `${currency} ${sign}${amount(cents)}`;
}

export function pct(v: number, digits = 1, signed = false): string {
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

/** Text glyph bar for a 0..100 value (EML-013 "simple text glyph bars"). */
export function glyphBar(percent: number, width = 10): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((clamped / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Tone for a signed amount: sign is also printed, so colour is never the only cue. */
export function toneOf(cents: number): "pos" | "neg" | undefined {
  return cents > 0 ? "pos" : cents < 0 ? "neg" : undefined;
}
