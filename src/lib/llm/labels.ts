// Exact label matching (LLM-072, D-245). A model label is accepted only when it is byte-equal to one
// of the allowed labels after JSON decode: no trim, no case folding, no prefix or substring match.
// A near miss ("bullish-ish", "Routine ") is rejected so the answer falls to the rules-only path.

/** The allowed label equal to `value`, or null. Never normalises `value`. */
export function enumLabel<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  for (const a of allowed) if (a === value) return a;
  return null;
}
