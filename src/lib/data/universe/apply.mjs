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
//    cleared); delisted rows are never deleted (DAT-130). EXCEPT a suspected code reuse (V1-S7,
//    ARN-082, D-685): the code is back after more than REUSE_GAP_DAYS delisted, or under a materially
//    different name after more than RENAME_GAP_DAYS. `instrument` is one row per (market, code) and every price history is
//    keyed by it, so reactivating would splice two companies into one history. Such a code is
//    QUARANTINED: it stays delisted (so no tier, no entry, no new snapshot row) with the reason
//    `code_reuse_suspected:<old reason>`, and an S2 incident asks the Owner to decide. The Owner confirms
//    a genuine relisting of the same company with `confirmRelisting` (delist_reason becomes
//    `relist_confirmed:...`); the next import then reactivates it as before.
//  - applying the plan twice for one Sydney date is prevented by the caller (success run record
//    keyed by market and date); the plan itself is a pure function of its inputs.

export const MISSING_TO_DELIST = 2;
/** The file must hold at least this share of the previous active count (strictly less rejects). */
export const SHRINK_MIN_PERCENT = 80;
export const DELIST_REASON = "absent_from_listed_companies";
/** A code delisted for longer than this and then listed again is treated as a different entity (D-685). */
export const REUSE_GAP_DAYS = 365;
/** ... or, under a different name, after more than this many days (a quick rename is not a new entity). */
export const RENAME_GAP_DAYS = 30;
export const REUSE_SUSPECTED = "code_reuse_suspected";
export const RELIST_CONFIRMED = "relist_confirmed";

const NAME_NOISE = new Set([
  "LIMITED",
  "LTD",
  "PTY",
  "NL",
  "THE",
  "CORPORATION",
  "CORP",
  "INC",
  "PLC",
]);
/** Upper case, punctuation to spaces, legal-form words dropped: "BHP Group Limited" ~ "BHP GROUP". */
export function normaliseName(name) {
  return String(name)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !NAME_NOISE.has(w))
    .join(" ");
}

const dayNumber = (d) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

/** Why a returning delisted code looks like a different company, or null (V1-S7). */
export function reuseSuspicion(e, row, today) {
  const reason = e.delistReason ?? null;
  if (reason !== null && reason.startsWith(RELIST_CONFIRMED)) return null; // the Owner confirmed it
  if (e.delistedOn === null) return null;
  const gap = dayNumber(today) - dayNumber(e.delistedOn);
  if (gap > REUSE_GAP_DAYS) return "long_gap";
  // a rename right after a short absence (a glitchy file, a name change) is the same company
  if (gap > RENAME_GAP_DAYS && normaliseName(e.name) !== normaliseName(row.name)) {
    return "name_changed";
  }
  return null;
}

/**
 * @typedef {{ code: string, name: string, industry: string | null,
 *   delistedOn: string | null, missingCount: number, delistReason?: string | null }} ExistingInstrument
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
  /** @type {{ code: string, name: string, oldName: string, delistedOn: string | null, priorReason: string | null, why: string }[]} */
  const quarantined = [];
  /** @type {string[]} */ const seenAgain = [];
  /** @type {{ code: string, missingCount: number }[]} */ const missing = [];
  /** @type {string[]} */ const delists = [];
  let unchanged = 0;

  for (const r of file) {
    const e = known.get(r.code);
    if (e === undefined) {
      inserts.push(r);
    } else if (e.delistedOn !== null) {
      const why = reuseSuspicion(e, r, today);
      if (why === null) reactivations.push(r);
      else {
        quarantined.push({
          code: r.code,
          name: r.name,
          oldName: e.name,
          delistedOn: e.delistedOn,
          priorReason: e.delistReason ?? null,
          why,
        });
      }
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
    quarantined,
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
