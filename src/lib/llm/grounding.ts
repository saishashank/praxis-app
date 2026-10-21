// Numeric grounding (LLM-034): every number, date and ticker in an LLM answer must be traceable to
// the context pack the model was given; otherwise the answer is rejected. LLMs never supply prices,
// returns or statistics from memory. Signs are ignored (a "fall of 3.2" may quote "-3.2"); numbers
// compare by value after stripping thousands separators and trailing zeros.

const DATE_RE = "\\b\\d{4}-\\d{2}-\\d{2}\\b";
const NUMBER_RE = "(?<![A-Za-z0-9_.])\\d[\\d,]*(?:\\.\\d+)?";
const TICKER_RE = "\\b[A-Z]{3,5}\\b";

/** Uppercase words that are not tickers; extend per call through `ignoreUppercase`. */
export const DEFAULT_IGNORED_UPPERCASE: readonly string[] = [
  "ASX", "AUD", "USD", "CEO", "CFO", "EPS", "ETF", "IPO", "NPAT", "EBIT", "EBITDA", "RBA", "ASIC",
  "JSON", "NULL", "THE", "AND", "FOR", "NOT",
]; // prettier-ignore

export type GroundingResult = {
  ok: boolean;
  /** Offending items, e.g. "number:12.5", "date:2026-01-02", "ticker:XYZ". */
  missing: string[];
};

export function normalizeNumber(raw: string): string {
  let s = raw.replace(new RegExp(",", "g"), "");
  if (s.includes(".")) s = s.replace(new RegExp("0+$"), "").replace(new RegExp("\\.$"), "");
  s = s.replace(new RegExp("^0+(?=\\d)"), "");
  return s;
}

/** All string and number leaves of a JSON value, as text. */
export function leafTexts(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "bigint") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) leafTexts(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) leafTexts(v, out);
  }
  return out;
}

type Claims = { dates: Set<string>; numbers: Set<string>; tickers: Set<string> };

function extract(texts: readonly string[], ignored: ReadonlySet<string>): Claims {
  const claims: Claims = { dates: new Set(), numbers: new Set(), tickers: new Set() };
  for (const text of texts) {
    for (const m of text.matchAll(new RegExp(DATE_RE, "g"))) claims.dates.add(m[0]);
    const noDates = text.replace(new RegExp(DATE_RE, "g"), " ");
    for (const m of noDates.matchAll(new RegExp(NUMBER_RE, "g"))) {
      claims.numbers.add(normalizeNumber(m[0]));
    }
    for (const m of noDates.matchAll(new RegExp(TICKER_RE, "g"))) {
      if (!ignored.has(m[0])) claims.tickers.add(m[0]);
    }
  }
  return claims;
}

/**
 * Checks `output` (any JSON value) against `context` (the facts and any untrusted text that were
 * actually placed in the prompt). Numeric leaves of the context count as written.
 */
export function checkGrounding(
  output: unknown,
  context: unknown,
  ignoreUppercase: readonly string[] = DEFAULT_IGNORED_UPPERCASE,
): GroundingResult {
  const ignored = new Set(ignoreUppercase);
  const have = extract(leafTexts(context), new Set());
  const want = extract(leafTexts(output), ignored);
  const missing: string[] = [];
  for (const d of want.dates) if (!have.dates.has(d)) missing.push(`date:${d}`);
  for (const n of want.numbers) if (!have.numbers.has(n)) missing.push(`number:${n}`);
  for (const t of want.tickers) if (!have.tickers.has(t)) missing.push(`ticker:${t}`);
  missing.sort();
  return { ok: missing.length === 0, missing };
}
