// Prompt-injection pre-filter (LLM-035, s11/s13). All announcement/news text is untrusted data: a
// deterministic scan replaces credential and injection phrases with "[removed]" before the text can
// reach a prompt, and reports whether anything was filtered so the call is logged. LLM output never
// triggers a side effect (the router returns text only), so the filter is one layer of two.

export const INJECTION_PHRASES_VERSION = "v1";
export const REMOVED_MARK = "[removed]";

/** Default list; the versioned config key `llm_injection_phrases` (ch.15 s15.7) replaces it when it lands. */
export const DEFAULT_INJECTION_PHRASES: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "ignore your instructions",
  "ignore the above",
  "disregard previous instructions",
  "disregard your instructions",
  "forget your instructions",
  "override your instructions",
  "you are now",
  "new instructions",
  "system prompt",
  "reveal your prompt",
  "use this api key",
  "api key:",
  "send the password",
];

/** Secret-looking tokens (provider key shapes); built from strings so the pattern text stays plain. */
const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp("\\bsk-[A-Za-z0-9_-]{16,}\\b", "g"), // threshold-ok: key-shape heuristic, not a rule
  new RegExp("\\bgsk_[A-Za-z0-9]{16,}\\b", "g"), // threshold-ok: key-shape heuristic, not a rule
  new RegExp("\\bAIza[A-Za-z0-9_-]{16,}\\b", "g"), // threshold-ok: key-shape heuristic, not a rule
];

function escapeRe(s: string): string {
  return s.replace(new RegExp("[.*+?^${}()|[\\]\\\\]", "g"), "\\$&");
}

export type FilterResult = {
  text: string;
  /** Number of phrase/secret matches replaced. */
  removed: number;
};

/** Replaces every configured phrase (case-insensitive, whitespace-tolerant) and secret-shaped token. */
export function filterInjection(
  text: string,
  phrases: readonly string[] = DEFAULT_INJECTION_PHRASES,
): FilterResult {
  let out = text;
  let removed = 0;
  const count = (): string => {
    removed += 1;
    return REMOVED_MARK;
  };
  for (const phrase of phrases) {
    const body = phrase.trim().split(new RegExp("\\s+")).map(escapeRe).join("\\s+");
    if (body === "") continue;
    out = out.replace(new RegExp(body, "gi"), count);
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, count);
  return { text: out, removed };
}

export type FilterManyResult = { texts: string[]; removed: number; filtered: boolean };

export function filterMany(
  texts: readonly string[],
  phrases: readonly string[] = DEFAULT_INJECTION_PHRASES,
): FilterManyResult {
  let removed = 0;
  const out = texts.map((t) => {
    const r = filterInjection(t, phrases);
    removed += r.removed;
    return r.text;
  });
  return { texts: out, removed, filtered: removed > 0 };
}
