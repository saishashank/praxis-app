// What the session JWT carries: uid, session_version, sign-in time, recovery flag. Nothing else.
export type Claims = { uid: number; sv: number; si: number; rec: boolean };

// Absolute cap (SEC-010): Auth.js may re-issue the cookie, but `si` never moves, so a session
// is refused 14 days (config) after the actual sign-in.
export function parseClaims(raw: unknown, nowSec: number, maxAgeSec: number): Claims | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { uid, sv, si } = r;
  if (!Number.isSafeInteger(uid) || (uid as number) < 1) return null;
  if (!Number.isSafeInteger(sv) || (sv as number) < 1) return null;
  if (!Number.isSafeInteger(si)) return null;
  const age = nowSec - (si as number);
  if (age < -60 || age > maxAgeSec) return null;
  return { uid: uid as number, sv: sv as number, si: si as number, rec: r.rec === true };
}
