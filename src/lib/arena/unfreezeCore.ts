// Cohort recovery after a fatal ARN-101 verdict (V1-S1, D-680..D-683). Pure part: the marker the
// close-the-books query honours and the input check. The writer is `unfreeze.ts` (Owner-only, audit
// first); nothing here touches a database, so closeBooks.ts can import it without a cycle.
//
// A fatal verdict is a `nav_daily` row with `invariants_ok = 0`; that table is append-only, so the
// verdict can never be edited. A cohort stays frozen while it has such a row dated AFTER the newest
// `cohort_event` of kind `data_event` whose detail has `type = 'invariants_cleared'` (its `through_d`
// is the newest bad day the Owner has cleared). No new event kind is needed (the kind list is a CHECK
// constraint; `data_event` is the existing "data correction touched the cohort" row, ch.06).

export const INVARIANTS_CLEARED = "invariants_cleared";
/** Longest cause the Owner may type; kept short because it goes into the audit row and the event. */
export const CLEAR_CAUSE_MAX = 300; // threshold-ok: characters

export type ClearInput = { cohortId: unknown; cause: unknown; confirm: unknown };
export type ParsedClear = { cohortId: string; cause: string };

const printable = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return false; // threshold-ok: ASCII control characters
  }
  return true;
};

/** Pure validation (no I/O): a cohort id, a non-empty printable cause, and the explicit confirmation. */
export function parseClearInput(
  b: ClearInput,
): { ok: true; value: ParsedClear } | { ok: false; error: "invalid" | "confirmation_required" } {
  const { cohortId, cause } = b;
  if (typeof cohortId !== "string" || cohortId.length === 0 || cohortId.length > 80) {
    return { ok: false, error: "invalid" }; // threshold-ok: id length guard
  }
  if (!printable(cohortId) || cohortId.includes(" ")) return { ok: false, error: "invalid" };
  if (typeof cause !== "string") return { ok: false, error: "invalid" };
  const text = cause.trim();
  if (text.length === 0 || text.length > CLEAR_CAUSE_MAX || !printable(text)) {
    return { ok: false, error: "invalid" };
  }
  if (b.confirm !== true) return { ok: false, error: "confirmation_required" };
  return { ok: true, value: { cohortId, cause: text } };
}
