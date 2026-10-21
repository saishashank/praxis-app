// Display formatting for the UI view models (M7 T2; docs/M7_design.md 2.7, 4.1; UXN-001, UX-102).
// Pure, deterministic, no locale APIs and no clock reads, so the same value renders the same way on
// the server, in a test and in a screenshot. A missing or non-finite value is shown as "n/a", never
// as 0 or a blank (honest numbers, UX-041). Money is stored as integer cents or micro-AUD (`*_micro`)
// and ratios as ppm; this module is the only place those units become text.

export const MISSING = "n/a";

const MICRO_PER_CENT = 10_000n; // threshold-ok: micro-AUD to cents
const CENTS_PER_UNIT = 100; // threshold-ok: unit conversion
const PPM_PER_PERCENT = 10_000; // threshold-ok: unit conversion
const DIGITS_GROUP = 3; // threshold-ok: thousands grouping

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % DIGITS_GROUP === 0) out += ",";
    out += digits[i];
  }
  return out;
}

export type SignStyle = "minus" | "always";

function withSign(negative: boolean, zero: boolean, body: string, style: SignStyle): string {
  if (zero) return body;
  if (negative) return `-${body}`;
  return style === "always" ? `+${body}` : body;
}

/** Integer cents -> "A$1,234.56". The sign is part of the text (UXN-001); "-0.00" never appears. */
export function formatCents(
  cents: number | null | undefined,
  o: { currency?: string; sign?: SignStyle } = {},
): string {
  if (!isFiniteNumber(cents)) return MISSING;
  const abs = Math.abs(Math.round(cents));
  const body = `${o.currency ?? "A$"}${group(String(Math.floor(abs / CENTS_PER_UNIT)))}.${String(abs % CENTS_PER_UNIT).padStart(2, "0")}`;
  return withSign(cents < 0, abs === 0, body, o.sign ?? "minus");
}

/** Micro-AUD (a decimal string, bigint or integer number) -> "A$1,234.56", rounded half away from zero. */
export function formatMicro(
  micro: string | bigint | number | null | undefined,
  o: { sign?: SignStyle } = {},
): string {
  if (micro === null || micro === undefined) return MISSING;
  let v: bigint;
  try {
    if (typeof micro === "number") {
      if (!Number.isSafeInteger(micro)) return MISSING;
      v = BigInt(micro);
    } else if (typeof micro === "string") {
      if (!/^-?\d{1,30}$/.test(micro)) return MISSING;
      v = BigInt(micro);
    } else {
      v = micro;
    }
  } catch {
    return MISSING;
  }
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const cents = (abs + MICRO_PER_CENT / 2n) / MICRO_PER_CENT;
  const whole = cents / BigInt(CENTS_PER_UNIT);
  const frac = cents % BigInt(CENTS_PER_UNIT);
  const body = `A$${group(whole.toString())}.${frac.toString().padStart(2, "0")}`;
  return withSign(neg, cents === 0n, body, o.sign ?? "minus");
}

/** A percentage value (12.3456) -> "12.35%". */
export function formatPercent(
  v: number | null | undefined,
  o: { digits?: number; sign?: SignStyle } = {},
): string {
  if (!isFiniteNumber(v)) return MISSING;
  const digits = o.digits ?? 2; // threshold-ok: display precision
  const text = Math.abs(v).toFixed(digits);
  const zero = Number(text) === 0;
  return withSign(v < 0, zero, `${text}%`, o.sign ?? "minus");
}

/** Parts per million -> percent text ("12,500 ppm" -> "1.25%"). */
export function formatPpm(
  ppm: number | null | undefined,
  o: { digits?: number; sign?: SignStyle } = {},
): string {
  return isFiniteNumber(ppm) ? formatPercent(ppm / PPM_PER_PERCENT, o) : MISSING;
}

export function formatCount(n: number | null | undefined): string {
  if (!isFiniteNumber(n)) return MISSING;
  const abs = Math.abs(Math.round(n));
  return withSign(n < 0, abs === 0, group(String(abs)), "minus");
}

/** Gain/loss glyph for colour-independent cues (UXN-001): up, down or flat. */
export function gainLossGlyph(v: number | null | undefined): "▲" | "▼" | "–" {
  if (!isFiniteNumber(v) || v === 0) return "–";
  return v > 0 ? "▲" : "▼";
}

/** "gain", "loss", "no change" or "not available": the words for an aria-label. */
export function gainLossWord(v: number | null | undefined): string {
  if (!isFiniteNumber(v)) return "not available";
  if (v === 0) return "no change";
  return v > 0 ? "gain" : "loss";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDate(d: string): Date | null {
  const m = DATE_RE.exec(d);
  if (!m) return null;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Reject 2026-02-31 style dates that Date would roll over.
  return t.getUTCFullYear() === Number(m[1]) &&
    t.getUTCMonth() === Number(m[2]) - 1 &&
    t.getUTCDate() === Number(m[3])
    ? t
    : null;
}

/** "2026-10-19" -> "Mon 19 Oct 2026"; anything that is not a calendar date -> "n/a". */
export function formatDate(d: string | null | undefined): string {
  const t = typeof d === "string" ? utcDate(d) : null;
  if (t === null) return MISSING;
  return `${DAYS[t.getUTCDay()]} ${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
}

/** ISO 8601 week of a calendar date: "2026-10-19" -> "2026-W43". Used to blur trade dates (UX-009). */
export function isoWeek(d: string): string | null {
  const t = utcDate(d);
  if (t === null) return null;
  const day = t.getUTCDay() || 7; // Monday = 1 .. Sunday = 7  (threshold-ok: weekday numbers)
  const thursday = new Date(t.getTime());
  thursday.setUTCDate(t.getUTCDate() + 4 - day); // threshold-ok: ISO week rule
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7); // threshold-ok: days per week
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Truncate with an ellipsis; never splits a surrogate pair. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
