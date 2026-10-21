// Shared check for the Owner-visible exception files of the ZAP and dependency-audit gates
// (M8 T12, decision 38; docs/M8_design.md 2.3). Every exception has a reason, the date it was added
// and an expiry no more than 30 days later; an expired or malformed entry FAILS the gate, so an
// exception can never become permanent without someone writing it again.
// Pure, zero dependencies. The reason text is Owner-written prose and is never echoed into a
// summary (only the entry's key and expiry are), so a URL pasted into it cannot reach a log.

export const MAX_EXCEPTION_DAYS = 30; // threshold-ok: decision 38, a calendar limit not a rule value
const DAY_MS = 86_400_000; // threshold-ok: milliseconds per day
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(s) {
  if (typeof s !== "string" || !DATE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t / DAY_MS;
}

/** Today as YYYY-MM-DD (UTC). */
export const todayUtc = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * @param {unknown} file parsed JSON: { exceptions: Entry[] }
 * @param {{ today: string, keyFields: string[], keyPattern?: Record<string, RegExp> }} o
 * @returns {{ active: any[], problems: string[] }}
 *   active = valid, unexpired entries; problems = one fixed-form sentence per bad entry.
 */
export function checkExceptions(file, { today, keyFields, keyPattern = {} }) {
  const problems = [];
  const active = [];
  const list = file && typeof file === "object" ? file.exceptions : undefined;
  if (!Array.isArray(list))
    return { active, problems: ["the exception file has no exceptions list"] };
  const now = dayNumber(today);
  list.forEach((e, i) => {
    const at = `exception ${i + 1}`;
    if (!e || typeof e !== "object") {
      problems.push(`${at}: not an object`);
      return;
    }
    let bad = false;
    for (const f of keyFields) {
      const ok =
        typeof e[f] === "string" && e[f].trim() !== "" && (keyPattern[f]?.test(e[f]) ?? true);
      if (!ok) {
        problems.push(`${at}: ${f} is missing or malformed`);
        bad = true;
      }
    }
    if (typeof e.reason !== "string" || e.reason.trim().length < 10) {
      problems.push(`${at}: needs a reason (at least 10 characters)`);
      bad = true;
    }
    const added = dayNumber(e.added);
    const expires = dayNumber(e.expires);
    if (added === null || expires === null) {
      problems.push(`${at}: added and expires must be YYYY-MM-DD dates`);
      bad = true;
    } else if (expires < added || expires - added > MAX_EXCEPTION_DAYS) {
      problems.push(`${at}: expiry must be within ${MAX_EXCEPTION_DAYS} days after the added date`);
      bad = true;
    } else if (now !== null && expires < now) {
      problems.push(`${at}: expired on ${e.expires}; renew or remove it`);
      bad = true;
    }
    if (!bad) active.push(e);
  });
  return { active, problems };
}
