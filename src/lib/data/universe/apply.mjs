// Universe apply rules (M2 T11, D-067). Pure: the existing instruments and today's parsed file in,
// a plan out; no I/O, so the GitHub Actions side could reuse it. Opus reviews every line.
//
// Rules:
//  - new code -> insert (active, listed_on = today).
//  - existing active code -> update name / industry only when one of them changed.
//  - active code absent from the file -> missing_count + 1; the code is marked delisted
//    (delisted_on = today) only when it reaches MISSING_TO_DELIST (2) consecutive successful
//    imports, so one bad file can never delist anything. A code that is present again resets to 0.
//  - shrink guard: if the file has fewer than 80 % of the previous active count the WHOLE import is
//    rejected (`suspicious_shrink`) and nothing changes, not even the missing counters.
//  - a delisted code that appears in the file again is reactivated (delisted_on, delist_reason
//    cleared); delisted rows are never deleted (DAT-130).
//  - applying the plan twice for one Sydney date is prevented by the caller (success run record
//    keyed by market and date); the plan itself is a pure function of its inputs.

export const MISSING_TO_DELIST = 2;
/** The file must hold at least this share of the previous active count (strictly less rejects). */
export const SHRINK_MIN_PERCENT = 80;
export const DELIST_REASON = "absent_from_listed_companies";

/**
 * @typedef {{ code: string, name: string, industry: string | null,
 *   delistedOn: string | null, missingCount: number }} ExistingInstrument
 * @typedef {{ code: string, name: string, industry: string | null }} FileRow
 */

/**
 * @param {{ existing: readonly ExistingInstrument[], file: readonly FileRow[], today: string }} a
 */
export function planUniverse({ existing, file, today }) {
  const inFile = new Map(file.map((r) => [r.code, r]));
  const known = new Map(existing.map((e) => [e.code, e]));
  const prevActive = existing.filter((e) => e.delistedOn === null).length;

  if (prevActive > 0 && file.length * 100 < SHRINK_MIN_PERCENT * prevActive) {
    return {
      ok: false,
      error: "suspicious_shrink",
      prevActive,
      fileCount: file.length,
    };
  }

  /** @type {FileRow[]} */ const inserts = [];
  /** @type {FileRow[]} */ const updates = [];
  /** @type {FileRow[]} */ const reactivations = [];
  /** @type {string[]} */ const seenAgain = [];
  /** @type {{ code: string, missingCount: number }[]} */ const missing = [];
  /** @type {string[]} */ const delists = [];
  let unchanged = 0;

  for (const r of file) {
    const e = known.get(r.code);
    if (e === undefined) {
      inserts.push(r);
    } else if (e.delistedOn !== null) {
      reactivations.push(r);
    } else {
      if (e.missingCount > 0) seenAgain.push(r.code);
      if (e.name !== r.name || e.industry !== r.industry) updates.push(r);
      else unchanged++;
    }
  }
  for (const e of existing) {
    if (e.delistedOn !== null || inFile.has(e.code)) continue;
    const n = e.missingCount + 1;
    if (n >= MISSING_TO_DELIST) delists.push(e.code);
    else missing.push({ code: e.code, missingCount: n });
  }

  return {
    ok: true,
    today,
    inserts,
    updates,
    reactivations,
    seenAgain,
    missing,
    delists,
    counts: {
      file: file.length,
      prevActive,
      inserted: inserts.length,
      updated: updates.length,
      unchanged,
      reactivated: reactivations.length,
      missingOnce: missing.length,
      delisted: delists.length,
    },
  };
}
