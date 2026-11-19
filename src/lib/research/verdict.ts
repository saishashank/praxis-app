// The registry's one vocabulary (M23 A2; D-1602): a look ends in PASS, NULL or INCONCLUSIVE, and nothing else is stored by
// the registry. Rows written before migration 0043 carry the older words of the three first writers; they are never
// rewritten and are shown through `displayVerdict`.
export const VERDICTS = ["PASS", "NULL", "INCONCLUSIVE"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(v: unknown): v is Verdict {
  return typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
}

const LEGACY: Readonly<Record<string, Verdict>> = {
  pass: "PASS",
  fail: "NULL",
  FAIL: "NULL",
};

/**
 * The display word of a stored verdict: the three words as they are, the older words mapped (`pass` becomes PASS, `fail` and
 * `FAIL` become NULL), anything else null (never guessed).
 */
export function displayVerdict(stored: string): Verdict | null {
  if (isVerdict(stored)) return stored;
  return LEGACY[stored] ?? null;
}
